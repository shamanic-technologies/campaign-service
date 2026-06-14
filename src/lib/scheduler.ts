import { db } from "../db/index.js";
import { campaigns } from "../db/schema.js";
import { eq, and, lte, isNotNull, isNull } from "drizzle-orm";
import { executeCampaignWorkflow } from "./workflows.js";
import { listRuns } from "@distribute/runs-client";

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
 * under the marker (no parent_run_id chain). Scoping the inflight check to the marker
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
    });

  if (dueCampaigns.length === 0) return 0;

  for (const campaign of dueCampaigns) {
    try {
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

      // Do NOT create a run here — /start-run in the workflow DAG creates it.
      // Creating one here with a different taskName caused orphan runs that were
      // invisible to gate-check and never cleaned up.
      const runId = campaign.parentRunId || crypto.randomUUID();

      executeCampaignWorkflow(campaign.workflowSlug, {
        campaignId: campaign.id,
        orgId: campaign.orgId,
        brandId: brandIdCsv,
        userId,
        runId,
        featureSlug,
      }).catch((err) => {
        console.error(`[campaign-service] Failed to re-trigger campaign ${campaign.id}:`, err);
      });
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

  const candidates = await db.query.campaigns.findMany({
    where: and(
      eq(campaigns.status, "ongoing"),
      isNull(campaigns.nextRunAt),
    ),
    columns: { id: true, orgId: true },
  });

  if (candidates.length === 0) return 0;

  let claimedCount = 0;

  for (const candidate of candidates) {
    // Same definition of "alive" as reRunDueCampaigns: ANY running run for the
    // campaign within the freshness window, regardless of which service owns it.
    const alive = await hasLiveRunForCampaign(candidate.orgId, candidate.id, freshnessCutoff);

    if (alive) {
      // Fresh run in flight → campaign is alive, not stuck.
      continue;
    }

    const claimed = await db
      .update(campaigns)
      .set({ nextRunAt: now, updatedAt: now })
      .where(
        and(
          eq(campaigns.id, candidate.id),
          eq(campaigns.status, "ongoing"),
          isNull(campaigns.nextRunAt),
        ),
      )
      .returning({ id: campaigns.id });

    if (claimed.length > 0) {
      claimedCount++;
      console.log(`[campaign-service] Claimed stuck campaign ${candidate.id} (no fresh run in last ${STUCK_RUN_FRESHNESS_THRESHOLD_MS / 60_000}min)`);
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
 *   - Any in-flight (nextRunAt=NULL) → ACTIVE_INTERVAL_MS. A run is executing
 *     (or possibly stuck); poll at the active cadence to catch /end-run + stuck.
 *   - All waiting (future nextRunAt) → sleep until the soonest due time, floored
 *     to avoid a busy-spin and capped at IDLE_MAX_MS.
 *
 * Pure (no DB / no clock side-effect) so the cadence logic is trivially testable.
 */
export function computeNextDelayMs(
  ongoing: Array<{ nextRunAt: Date | null }>,
  now: number = Date.now(),
): number {
  if (ongoing.length === 0) return IDLE_MAX_MS;
  if (ongoing.some((c) => c.nextRunAt === null)) return ACTIVE_INTERVAL_MS;
  const soonest = Math.min(...ongoing.map((c) => c.nextRunAt!.getTime()));
  const delay = soonest - now;
  return Math.min(Math.max(delay, 1_000), IDLE_MAX_MS);
}

/** Load the ongoing-campaign snapshot used to pick the next tick delay. */
async function loadOngoingSnapshot(): Promise<Array<{ nextRunAt: Date | null }>> {
  return db.query.campaigns.findMany({
    where: eq(campaigns.status, "ongoing"),
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
      await claimStuckCampaigns();
      await reRunDueCampaigns();
    } catch (err) {
      console.error("[campaign-service] Scheduler tick error:", err);
    }

    let delayMs = ACTIVE_INTERVAL_MS;
    try {
      delayMs = computeNextDelayMs(await loadOngoingSnapshot());
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
