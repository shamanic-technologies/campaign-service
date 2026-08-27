import { db } from "../db/index.js";
import { campaigns } from "../db/schema.js";
import { eq, and, lte, isNotNull, isNull } from "drizzle-orm";
import { executeCampaignWorkflow } from "./workflows.js";
import { resolveWorkflowSlugForTrigger } from "./features-workflow-projection-client.js";
import { listRuns } from "@distribute/runs-client";
import {
  planFunnelTurns,
  provisionFundedPairsForQuietBrands,
  FUNDING_SWEEP_INTERVAL_MS,
} from "./funnel-campaigns.js";
import { resumeServeableCampaigns } from "./campaign-resume.js";
import { ensureCampaignRunId } from "./trigger-run.js";

// Cadence while a campaign is actively running (a run is in-flight). At this
// rate the scheduler catches /end-run reschedules and stuck-run detection.
export const ACTIVE_INTERVAL_MS = 60_000; // 1 minute

// Hard ceiling on how long the scheduler sleeps between ticks. Two reasons:
//   1. setTimeout delays above ~2^31 ms (~24.8 days) overflow int32 and fire
//      immediately — a far-future nextRunAt must be bounded.
//   2. Safety backstop: if a future code path marks a campaign "ongoing"
//      without calling wakeScheduler(), the hourly re-check still picks it up
//      instead of stranding it forever.
// Cost of one wake/hour while fully idle is negligible (~0.30 $/month) and lets
// Neon's compute suspend (5-min idle timeout) for ~55 of every 60 minutes.
export const IDLE_MAX_MS = 60 * 60_000; // 1 hour

// A run is considered "fresh" (campaign actively executing) if it started within this window.
// Older running rows are treated as orphans (workflow died without /end-run).
//
// MUST be strictly greater than the longest legitimate flow duration. lead-service's
// buffer/next fill can run up to ~10min (PULL_NEXT_TIMEOUT_MS=600s), and the wrapping
// `lead-service/lead-serve` run has been observed at 755s in prod — so the old 10min
// (= 600s) value left a legit long fill sitting right at the orphan boundary, where
// claimStuckCampaigns could misclassify it as stuck and re-fire mid-fill (→ lead-service
// 409 "Concurrent buffer/next" storms). 15min gives margin above the observed max.
const STUCK_RUN_FRESHNESS_THRESHOLD_MS = 15 * 60_000; // 15 minutes

/**
 * Is a flow genuinely alive for this campaign right now?
 *
 * True when runs-service has ANY `running` run tagged with this campaignId that
 * started within the freshness window — regardless of which service/taskName
 * created it.
 *
 * Why campaignId-scoped and NOT (serviceName="campaign-service", taskName=campaignId):
 * the campaign-service parent run is an ephemeral ~2s marker (start-run → end-run
 * within seconds), NOT an enclosing span. The real work — lead-service buffer/next —
 * runs up to ~12min in a separate `lead-service/lead-serve` run that is NOT linked
 * under the marker (no parent_run_id funnel). Scoping the inflight check to the marker
 * saw a corpse and re-fired mid-fill, colliding with the still-running buffer/next
 * → lead-service rejects the duplicate with 409 → windmill job hard-fails. Scoping to
 * campaignId + running + freshness sees the genuinely-live descendant instead.
 *
 * The freshness bound preserves orphan recovery: a run still marked `running` past the
 * threshold (workflow died without /end-run) no longer counts as alive, so the campaign
 * is re-claimed/re-fired.
 */
async function hasLiveRunForCampaign(
  orgId: string,
  campaignId: string,
  freshnessCutoff: Date,
): Promise<boolean> {
  const { runs } = await listRuns({
    orgId,
    campaignId,
    status: "running",
    startedAfter: freshnessCutoff.toISOString(),
    limit: 1,
  });
  return runs.length > 0;
}

/**
 * Find all ongoing campaigns whose nextRunAt has passed,
 * atomically claim them (clear nextRunAt), and re-trigger their workflow.
 *
 * Uses UPDATE ... RETURNING to atomically claim campaigns, preventing
 * duplicate triggers from overlapping ticks or multiple service instances.
 */
export async function reRunDueCampaigns(): Promise<number> {
  const now = new Date();

  // Atomic claim: UPDATE + RETURNING ensures only one instance/tick processes each campaign.
  // PostgreSQL row-level locks prevent two concurrent UPDATEs from claiming the same row.
  const dueCampaigns = await db
    .update(campaigns)
    .set({ nextRunAt: null, updatedAt: now })
    .where(
      and(
        eq(campaigns.status, "ongoing"),
        // A campaign with no workflow has no DAG to run — its channel is operated by the
        // CUSTOMER's own team, off-platform. It is never claimed, so it never takes a turn, never
        // triggers an execution and never spends. It exists to be a scope for the work they do
        // themselves. NOT a filter on a list of slugs: the row states the absence, and the
        // catalogue decided it at provisioning time.
        isNotNull(campaigns.workflowSlug),
        isNotNull(campaigns.nextRunAt),
        lte(campaigns.nextRunAt, now),
      ),
    )
    .returning({
      id: campaigns.id,
      orgId: campaigns.orgId,
      createdByUserId: campaigns.createdByUserId,
      parentRunId: campaigns.parentRunId,
      workflowSlug: campaigns.workflowSlug,
      brandIds: campaigns.brandIds,
      featureSlug: campaigns.featureSlug,
      activeGoalId: campaigns.activeGoalId,
      brandProfileId: campaigns.brandProfileId,
      audienceId: campaigns.audienceId,
      funnelKey: campaigns.funnelKey,
      dailyBudgetCents: campaigns.dailyBudgetCents,
      // The offer this campaign sells. The turn planner asks brand-service for the funnels of THAT
      // offer — the only grain with one answer on a brand selling several.
      offerId: campaigns.offerId,
    });

  if (dueCampaigns.length === 0) return 0;

  // Per-funnel funding + turn-taking. HOLDS every sales campaign the customer funds nothing for
  // (the only hold there is now that `brand_pause` is gone), provisions a campaign for every
  // funded funnel of each brand, holds the brand to ONE run in flight, and hands the turn to the
  // funded funnel with the lowest spent-today/ceiling ratio. Campaigns absent from the map fire
  // as they always have — every non-sales campaign is untouched.
  const funnelDefers = await planFunnelTurns(dueCampaigns, now);

  for (const campaign of dueCampaigns) {
    try {
      const funnelDefer = funnelDefers.get(campaign.id);
      if (funnelDefer) {
        await db
          .update(campaigns)
          .set({ nextRunAt: funnelDefer, updatedAt: new Date() })
          .where(eq(campaigns.id, campaign.id));
        // Not logged: this fires every tick for every funnel that did not take its brand's
        // turn, across every client. The decision is observable in the persisted nextRunAt.
        continue;
      }

      const missingFields: string[] = [];
      if (!campaign.brandIds || campaign.brandIds.length === 0) missingFields.push("brandIds");
      if (!campaign.createdByUserId) missingFields.push("createdByUserId");
      if (!campaign.featureSlug) missingFields.push("featureSlug");
      if (missingFields.length > 0) {
        console.warn(`[campaign-service] Campaign ${campaign.id} missing required fields for workflow execution: ${missingFields.join(", ")} — skipping re-run`);
        continue;
      }

      // Sequential-runs invariant: never fire a new flow while a prior one is still alive.
      // Checks ANY running run for the campaign (not the ephemeral campaign-service marker),
      // so the genuinely-long lead-service buffer/next fill is seen. Without this, /end-run's
      // immediate re-trigger fires a second flow mid-fill → lead-service 409 storm.
      const freshnessCutoff = new Date(now.getTime() - STUCK_RUN_FRESHNESS_THRESHOLD_MS);
      const alive = await hasLiveRunForCampaign(campaign.orgId, campaign.id, freshnessCutoff);
      if (alive) {
        const rescheduledAt = new Date(now.getTime() + 60_000);
        await db
          .update(campaigns)
          .set({ nextRunAt: rescheduledAt, updatedAt: new Date() })
          .where(eq(campaigns.id, campaign.id));
        // No log here on purpose. This in-flight skip + reschedule fires every ~60s for
        // EVERY campaign with a live run (a long fill re-checks ~12×/run), across every
        // client — logging it (even at info) spams the logs minute-by-minute for a routine
        // dedup. The decision is already observable via the persisted nextRunAt in DB.
        continue;
      }

      const brandIdCsv = campaign.brandIds!.join(",");
      const userId = campaign.createdByUserId!;
      const featureSlug = campaign.featureSlug!;

      // Still no per-execution run here — /start-run in the workflow DAG creates that one, and
      // creating a second campaign-tagged run at trigger time is what produced orphan runs
      // invisible to gate-check. What this DOES establish is the campaign's ANCESTOR run, which
      // must exist: workflow-service turns the x-run-id we send into the parentRunId of the run it
      // creates, and that column carries a foreign key. A campaign that never stored one used to
      // be handed a minted uuid, so every one of its executions was refused before the DAG began.
      // See ensureCampaignRunId — the anchor is created once and persisted, never per tick.
      const runId = await ensureCampaignRunId(campaign);

      // Thompson-pick the workflow for THIS run (varies run-to-run) BEFORE execute.
      // Falls back to the configured slug on any failure (see
      // resolveWorkflowSlugForTrigger) — selection never blocks a run.
      try {
        const workflowSlug = await resolveWorkflowSlugForTrigger({
          featureSlug,
          primaryBrandId: campaign.brandIds![0],
          identity: {
            orgId: campaign.orgId,
            userId,
            runId,
            campaignId: campaign.id,
            brandId: brandIdCsv,
            workflowSlug: campaign.workflowSlug!,
            featureSlug,
          },
          // The claim above filters out the workflow-less rows, so this is always a real slug.
          fallbackSlug: campaign.workflowSlug!,
          // Price the pick on the funnel the campaign STATES — the only word that separates the
          // two meeting funnels. A campaign that states one is never goal-arbitrated.
          funnelKey: campaign.funnelKey,
        });
        await executeCampaignWorkflow(workflowSlug, {
          campaignId: campaign.id,
          orgId: campaign.orgId,
          brandId: brandIdCsv,
          userId,
          runId,
          featureSlug,
          activeGoalId: campaign.activeGoalId,
          brandProfileId: campaign.brandProfileId,
          audienceId: campaign.audienceId,
        });
      } catch (err) {
        console.error(`[campaign-service] Failed to re-trigger campaign ${campaign.id}:`, err);
      }
    } catch (err) {
      console.error(`[campaign-service] Error processing campaign ${campaign.id}:`, err);
    }
  }

  return dueCampaigns.length;
}

/**
 * Heartbeat: detect ongoing campaigns whose workflow died without calling /end-run.
 *
 * State `(status=ongoing, nextRunAt=NULL)` is shared by two cases:
 *   1. Campaign currently running (cleared by reRunDueCampaigns at claim time)
 *   2. Campaign whose workflow process died mid-run (no /end-run call ever happened)
 *
 * runs-service is the oracle: if a fresh `running` run exists for the campaign,
 * it's case 1 — leave it alone. Otherwise it's case 2 — set nextRunAt=now so the
 * next reRunDueCampaigns tick picks it up.
 */
export async function claimStuckCampaigns(): Promise<number> {
  const now = new Date();
  const freshnessCutoff = new Date(now.getTime() - STUCK_RUN_FRESHNESS_THRESHOLD_MS);

  const ongoingCampaigns = await db.query.campaigns.findMany({
    where: and(
      eq(campaigns.status, "ongoing"),
      // (status=ongoing, nextRunAt=NULL) is the PERMANENT resting state of a campaign whose
      // channel the customer operates — there is nothing to run, so nothing is stuck. Claiming it
      // here would set nextRunAt=now every tick forever for a campaign that must never fire.
      isNotNull(campaigns.workflowSlug),
      isNull(campaigns.nextRunAt),
    ),
    columns: { id: true, orgId: true },
  });

  if (ongoingCampaigns.length === 0) return 0;

  let claimedCount = 0;

  for (const campaign of ongoingCampaigns) {
    // Same definition of "alive" as reRunDueCampaigns: ANY running run for the
    // campaign within the freshness window, regardless of which service owns it.
    const alive = await hasLiveRunForCampaign(campaign.orgId, campaign.id, freshnessCutoff);

    if (alive) {
      // Fresh run in flight → campaign is alive, not stuck.
      continue;
    }

    const claimed = await db
      .update(campaigns)
      .set({ nextRunAt: now, updatedAt: now })
      .where(
        and(
          eq(campaigns.id, campaign.id),
          eq(campaigns.status, "ongoing"),
          isNull(campaigns.nextRunAt),
        ),
      )
      .returning({ id: campaigns.id });

    if (claimed.length > 0) {
      claimedCount++;
      console.log(`[campaign-service] Claimed stuck campaign ${campaign.id} (no fresh run in last ${STUCK_RUN_FRESHNESS_THRESHOLD_MS / 60_000}min)`);
    }
  }

  return claimedCount;
}

/**
 * Pure decision: how long until the next scheduler tick should run, given the
 * current snapshot of ongoing campaigns.
 *
 *   - No ongoing campaigns        → IDLE_MAX_MS. Nothing to poll; the Neon
 *     compute can suspend. A new campaign wakes the scheduler via wakeScheduler().
 *   - Any in-flight (nextRunAt=NULL) → poll at the active cadence to catch
 *     /end-run + stuck, but never sleep past a sooner scheduled nextRunAt.
 *   - Waiting campaigns (future nextRunAt) → sleep until the soonest due time,
 *     floored to avoid a busy-spin and capped at IDLE_MAX_MS.
 *
 * Pure (no DB / no clock side-effect) so the cadence logic is trivially testable.
 */
export function computeNextDelayMs(
  ongoing: Array<{ nextRunAt: Date | null }>,
  now: number = Date.now(),
): number {
  if (ongoing.length === 0) return IDLE_MAX_MS;

  const hasInFlight = ongoing.some((c) => c.nextRunAt === null);
  const scheduledTimes = ongoing
    .map((c) => c.nextRunAt?.getTime())
    .filter((time): time is number => typeof time === "number" && Number.isFinite(time));

  if (scheduledTimes.length === 0) return ACTIVE_INTERVAL_MS;

  const soonest = Math.min(...scheduledTimes);
  const scheduledDelay = Math.min(Math.max(soonest - now, 1_000), IDLE_MAX_MS);
  return hasInFlight ? Math.min(scheduledDelay, ACTIVE_INTERVAL_MS) : scheduledDelay;
}

/** Load the ongoing-campaign snapshot used to pick the next tick delay. */
async function loadOngoingSnapshot(): Promise<Array<{ nextRunAt: Date | null }>> {
  return db.query.campaigns.findMany({
    // A held campaign carries a nextRunAt on the funding cadence rather than being absent from
    // this snapshot, so a brand that funds nothing sleeps for ten minutes at a time instead of
    // pinning the 60s active cadence — and is still looked at without anyone asking.
    // A campaign with no workflow rests at nextRunAt=NULL forever. Counting it would read as
    // "something is in flight" and pin the 60s active cadence for a service with nothing to do.
    where: and(eq(campaigns.status, "ongoing"), isNotNull(campaigns.workflowSlug)),
    columns: { nextRunAt: true },
  });
}

let timer: ReturnType<typeof setTimeout> | null = null;
let isRunning = false;
let started = false;

function scheduleNext(delayMs: number): void {
  if (!started) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    void tick();
  }, delayMs);
}

/**
 * One scheduler tick: detect stuck campaigns, re-fire due ones, then pick and
 * schedule the next tick delay from the resulting ongoing-campaign state.
 *
 * The concurrency guard makes overlapping ticks (when processing takes longer
 * than the scheduled delay) a no-op — the in-flight tick reschedules on its way
 * out, so exactly one live timer survives.
 */
async function tick(): Promise<void> {
  if (!started || isRunning) return;
  isRunning = true;
  try {
    try {
      // Bring back the campaigns that ran out of people to contact and now have people again,
      // BEFORE the claim — a campaign resumed here is due immediately, so it takes its turn on
      // this very tick instead of waiting for the next one. Throttled to its own cadence
      // (RESUME_SWEEP_INTERVAL_MS), so a 60s tick does not turn into a 60s fan-out.
      await resumeServeableCampaigns();
      // A brand nothing will claim soon — every campaign stopped, or every campaign parked past the
      // sweep horizon — is invisible to the claim path below, so nothing would notice that its owner
      // funded a channel. Asked on its own cadence, before the claim, so a campaign stood up here
      // takes its turn on this very tick.
      await provisionFundedPairsForQuietBrands();
      await claimStuckCampaigns();
      await reRunDueCampaigns();
    } catch (err) {
      console.error("[campaign-service] Scheduler tick error:", err);
    }

    let delayMs = ACTIVE_INTERVAL_MS;
    try {
      delayMs = computeNextDelayMs(await loadOngoingSnapshot());
      // Both sweeps that bring a campaign BACK — the exhaustion resume and the funding
      // provisioner — act on campaigns that are NOT ongoing, so they are invisible to the
      // snapshot above: a brand with nothing running yields an empty snapshot, sleeps the full
      // idle hour, and neither sweep gets to run more than hourly however willing it is. Never
      // sleep past their shared cadence. The cost of being wrong is one snapshot query per ten
      // minutes on a fully idle service; the cost of not doing it is that funding a funnel takes
      // an hour to mean anything.
      delayMs = Math.min(delayMs, FUNDING_SWEEP_INTERVAL_MS);
    } catch (err) {
      console.error("[campaign-service] Scheduler delay computation error:", err);
    }
    scheduleNext(delayMs);
  } finally {
    isRunning = false;
  }
}

/**
 * Wake the scheduler to run a tick promptly. Call after any write that makes a
 * campaign schedulable (create, activate, /end-run reschedule) so re-runs fire
 * without waiting out the current sleep — and so the scheduler resumes from a
 * deep idle sleep the moment work appears.
 *
 * No-op when the scheduler isn't running (e.g. unit tests, NODE_ENV=test) so it
 * never strands a dangling timer.
 */
export function wakeScheduler(): void {
  if (!started) return;
  scheduleNext(0);
}

/**
 * Start the scheduler. Returns a cleanup function that stops it.
 *
 * Self-rescheduling setTimeout (not a fixed setInterval): each tick picks its
 * own next delay so an idle service stops querying Postgres and lets the Neon
 * compute suspend, while an active one keeps the 60s cadence.
 */
export function startScheduler(): () => void {
  started = true;
  console.log(`[campaign-service] Scheduler starting (active=${ACTIVE_INTERVAL_MS}ms, idleMax=${IDLE_MAX_MS}ms)`);
  scheduleNext(0);

  return () => {
    started = false;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
}
