import { and, arrayContains, desc, eq } from "drizzle-orm";
import { getStatsBudget, listRuns, type IdentityHeaders } from "@distribute/runs-client";
import { db } from "../db/index.js";
import { campaigns } from "../db/schema.js";
import { fetchFunnelBudgets, fundedFunnels, type FunnelBudget } from "./funnel-budget-client.js";
import { fetchDeclaredSalesFunnels, type DeclaredSalesFunnel } from "./brand-sales-funnels-client.js";
import { isSalesOutreachFeature } from "./sales-outreach-campaign.js";

// A campaign that did not get this brand's turn re-checks on the next active tick. The turn is
// re-ranked from scratch every tick, so this is a "wait your turn", not a backoff.
export const FUNNEL_TURN_DEFER_MS = 60_000; // 1 min

// A campaign superseded by the brand's funnel campaigns (the pre-funnel, funnelKey=NULL one) is
// not deleted or stopped — the customer may clear their per-funnel ceilings at any moment and
// fall back to one brand-level pot. It just re-checks lazily instead of every minute.
export const SUPERSEDED_DEFER_MS = 15 * 60_000; // 15 min

/**
 * The campaign columns the turn planner reads. Structurally a subset of what the scheduler's
 * claim already returns, so the planner never needs its own query.
 */
export interface ClaimedFunnelCampaign {
  id: string;
  orgId: string;
  createdByUserId: string | null;
  workflowSlug: string;
  brandIds: string[] | null;
  featureSlug: string | null;
  funnelKey: string | null;
}

/** One funnel campaign in the running to take the brand's next turn. */
export interface FunnelTurnCandidate {
  campaignId: string;
  funnelKey: string;
  /** Committed spend today for THIS campaign — i.e. for this funnel — in cents. */
  spentCents: number;
  /** This funnel's own daily ceiling, in cents. Always > 0 (a zero ceiling is not funded). */
  ceilingCents: number;
}

/**
 * Which funded funnel goes next: the one with the lowest ratio of what it has already spent
 * today to what it is allowed to spend today.
 *
 * NOT a fixed order and NOT "the primary funnel first". A fixed order starves whatever sits
 * last — if the first funnel can absorb the whole day, the others never run, and that shows up
 * in no log at all, only in a funnel that mysteriously never spends. Ranking on the ratio fills
 * every funnel at the same pace RELATIVE to what it can absorb, and a funnel at its ceiling
 * yields its turn with no special case: its ratio is >= 1, so it is simply not a candidate.
 *
 * Returns null when every funded funnel is at its ceiling — nothing runs until they reset.
 * Ties break on funnelKey so the choice is deterministic rather than insertion-ordered.
 */
export function selectLowestFillRatio(candidates: FunnelTurnCandidate[]): string | null {
  let bestId: string | null = null;
  let bestRatio = Infinity;
  let bestKey = "";

  for (const c of candidates) {
    if (!(c.ceilingCents > 0)) continue; // not funded — never run
    const ratio = c.spentCents / c.ceilingCents;
    if (ratio >= 1) continue; // at its ceiling: stops and yields to another funded funnel
    if (ratio < bestRatio || (ratio === bestRatio && c.funnelKey < bestKey)) {
      bestRatio = ratio;
      bestKey = c.funnelKey;
      bestId = c.campaignId;
    }
  }

  return bestId;
}

/**
 * Plan which of the claimed campaigns may fire this tick.
 *
 * Returns the campaigns that must NOT fire, each with the time it should be re-checked. A
 * campaign absent from the map fires — so every non-sales campaign, and every brand with no
 * per-funnel funding, is untouched and behaves exactly as it does today.
 *
 * Three things happen per brand, in this order:
 *   1. Provision — every funded funnel of the brand gets its own campaign (created on the spot,
 *      due immediately, so the next tick can claim it).
 *   2. Serialize — at most ONE run in flight per BRAND. This is the deliberate constraint that
 *      keeps funnels from running concurrently; removing it is what unlocks parallelism later,
 *      and nothing else has to be undone for that. It is not a lock: the same runs-service
 *      liveness read the per-campaign guard already uses, widened to the brand.
 *   3. Rank — the funded funnel with the lowest spent/ceiling ratio takes the turn.
 *
 * Fail-SOFT throughout: any unreadable budget, funnel set or spend leaves the brand on today's
 * behaviour rather than blocking it. The per-funnel CEILING is enforced fail-CLOSED in
 * gate-check, which is where spend control belongs — this is turn-taking, an optimization.
 */
export async function planFunnelTurns(
  claimed: ClaimedFunnelCampaign[],
  now: Date = new Date(),
): Promise<Map<string, Date>> {
  const deferred = new Map<string, Date>();

  // Only the sales-outreach family funds per funnel. Everything else keeps its own pacing and
  // its own per-campaign serialization, untouched.
  const groups = new Map<string, ClaimedFunnelCampaign[]>();
  for (const c of claimed) {
    if (!isSalesOutreachFeature(c.featureSlug)) continue;
    const brandId = c.brandIds?.[0];
    if (!brandId) continue;
    const key = `${c.orgId}::${brandId}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(c);
    else groups.set(key, [c]);
  }

  for (const group of groups.values()) {
    try {
      await planOneBrand(group, now, deferred);
    } catch (err) {
      // A planning failure must never strand a brand: leave the group to fire on today's
      // behaviour (per-campaign serialization + the gate's own ceiling enforcement).
      console.warn(`[campaign-service] funnel turn planning failed for campaign ${group[0]?.id}:`, err);
    }
  }

  return deferred;
}

async function planOneBrand(
  group: ClaimedFunnelCampaign[],
  now: Date,
  deferred: Map<string, Date>,
): Promise<void> {
  const seed = group[0];
  const orgId = seed.orgId;
  const brandId = seed.brandIds![0];
  const featureSlug = seed.featureSlug!;

  const identity: IdentityHeaders = {
    orgId,
    userId: seed.createdByUserId ?? undefined,
    campaignId: seed.id,
    brandId,
    workflowSlug: seed.workflowSlug,
  };

  const budgets = await fetchFunnelBudgets(brandId, identity);
  // Unreadable ceilings → today's behaviour. gate-check fail-closes on the same read, so an
  // outage cannot turn into overspend; it just cannot improve turn-taking either.
  if (!budgets.ok) return;

  const funded = fundedFunnels(budgets);
  // A brand that has never set per-funnel ceilings behaves EXACTLY as it does today: billing
  // still answers its brand-level budget and the pre-funnel campaign paces on it.
  if (funded.length === 0) return;

  const declared = await fetchDeclaredSalesFunnels(brandId, identity);
  await ensureFundedFunnelCampaigns({ seed, brandId, featureSlug, funded, declared, now });

  // Serial, for now: at most one run in flight per brand. Running funnels concurrently needs an
  // audit of lead de-duplication and of sending-account load that nobody has done, so it is
  // deliberately out of scope — delete this block and the funnels run in parallel.
  if (await hasLiveRunForBrand(orgId, brandId, now)) {
    for (const c of group) deferred.set(c.id, new Date(now.getTime() + FUNNEL_TURN_DEFER_MS));
    return;
  }

  const ceilingByFunnel = new Map(funded.map((f) => [f.funnelKey, f.dailyBudgetCents]));

  // The pre-funnel campaign is superseded while funded funnels exist: its money has been
  // allocated per funnel, so letting it run on the brand-level sum would let one campaign spend
  // the whole day's allowance across every funnel at once.
  const contenders: ClaimedFunnelCampaign[] = [];
  for (const c of group) {
    if (c.funnelKey && ceilingByFunnel.has(c.funnelKey)) contenders.push(c);
    else deferred.set(c.id, new Date(now.getTime() + SUPERSEDED_DEFER_MS));
  }
  if (contenders.length === 0) return;

  const candidates: FunnelTurnCandidate[] = [];
  for (const c of contenders) {
    candidates.push({
      campaignId: c.id,
      funnelKey: c.funnelKey!,
      spentCents: await spentTodayCents(orgId, c.id, featureSlug),
      ceilingCents: ceilingByFunnel.get(c.funnelKey!)!,
    });
  }

  const winner = selectLowestFillRatio(candidates);

  if (winner === null) {
    // Every funded funnel is at its ceiling — nothing runs until the ceilings reset.
    const reset = nextDayStart(now);
    for (const c of contenders) deferred.set(c.id, reset);
    return;
  }

  for (const c of contenders) {
    if (c.id !== winner) deferred.set(c.id, new Date(now.getTime() + FUNNEL_TURN_DEFER_MS));
  }
}

/**
 * Give every funded funnel of the brand its own campaign, so the money spent on a funnel is
 * attributable to it. A campaign already carries a goal and already has costs attributed to it,
 * which is why one campaign per funnel answers "how much did this funnel spend today" without
 * inventing a new attribution dimension.
 *
 * The campaign carries the funnel's OWN goal, which is also what stops it being goal-arbitrated:
 * a campaign that states its own goal is never arbitrated, so features-service keeps answering
 * the best workflow and the per-audience evidence — scoped to the funnel being run — and stops
 * being the thing that chooses which funnel runs. The customer's funding decides that.
 *
 * A funnel billing funds but brand-service does not declare (or declares inactive) is skipped:
 * there is no goal to pace it on, and a switched-off funnel must never be worked.
 */
async function ensureFundedFunnelCampaigns({
  seed,
  brandId,
  featureSlug,
  funded,
  declared,
  now,
}: {
  seed: ClaimedFunnelCampaign;
  brandId: string;
  featureSlug: string;
  funded: FunnelBudget[];
  declared: DeclaredSalesFunnel[] | null;
  now: Date;
}): Promise<void> {
  // No readable funnel declaration → no goal to pace a new campaign on. Provisioning waits;
  // whatever campaigns already exist keep running.
  if (!declared || declared.length === 0) return;
  if (!seed.createdByUserId) return; // no recipient/owner to attribute a new campaign to

  const goalByFunnel = new Map(declared.map((f) => [f.funnelKey, f.goal]));

  for (const f of funded) {
    const goal = goalByFunnel.get(f.funnelKey);
    if (!goal) continue;

    const existing = await db.query.campaigns.findFirst({
      where: and(
        eq(campaigns.orgId, seed.orgId),
        eq(campaigns.featureSlug, featureSlug),
        eq(campaigns.funnelKey, f.funnelKey),
        arrayContains(campaigns.brandIds, [brandId]),
      ),
      orderBy: [desc(campaigns.createdAt)],
    });
    if (existing) {
      // A funnel the customer re-funded after switching it off resumes rather than duplicating.
      if (existing.status !== "ongoing") {
        await db
          .update(campaigns)
          .set({ status: "ongoing", nextRunAt: now, updatedAt: now })
          .where(and(eq(campaigns.id, existing.id), eq(campaigns.orgId, seed.orgId)));
      }
      continue;
    }

    // Deterministic name: uniq_campaigns_org_name is the only uniqueness Postgres can enforce
    // here (brand_ids is a text[], so no unique index can span it), which makes a duplicate
    // provision a constraint violation rather than a second campaign for the same funnel.
    const name = funnelCampaignName(featureSlug, brandId, f.funnelKey);

    try {
      await db.insert(campaigns).values({
        orgId: seed.orgId,
        createdByUserId: seed.createdByUserId,
        name,
        workflowSlug: seed.workflowSlug,
        brandIds: [brandId],
        featureSlug,
        funnelKey: f.funnelKey,
        // The funnel's own goal — forwarded verbatim from brand-service, never mapped.
        goal,
        featureInputs: null,
        status: "ongoing",
        nextRunAt: now,
        updatedAt: now,
      });
    } catch (err) {
      // Two ticks (or two instances) racing the same funnel both SELECT nothing and both
      // INSERT; the unique name index rejects the loser. That is the intended outcome, not a
      // fault — the winner's campaign is the one campaign for this funnel.
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes("uniq_campaigns_org_name")) throw err;
    }
  }
}

export function funnelCampaignName(featureSlug: string, brandId: string, funnelKey: string): string {
  return `${featureSlug} - ${brandId} - ${funnelKey}`;
}

/**
 * Committed spend today for ONE campaign — which, for a funnel campaign, IS that funnel's spend
 * today. The cost ledger is already keyed on campaignId, so no per-funnel spend figure is
 * invented here.
 *
 * Same net-committed basis the gate paces on: actual + provisioned, post-usage-discount. A
 * failed read reports 0 so an unreadable spend never silently parks a funnel; the gate is what
 * refuses to spend past an unreadable ceiling.
 */
async function spentTodayCents(orgId: string, campaignId: string, featureSlug: string): Promise<number> {
  try {
    const budget = await getStatsBudget({
      orgId,
      campaignId,
      featureSlug,
      windows: [{ label: "today", since: startOfToday().toISOString() }],
    });
    const today = budget.windows.find((w) => w.label === "today");
    if (!today) return 0;
    return parseFloat(today.netTotalCostInUsdCents ?? today.totalCostInUsdCents) || 0;
  } catch {
    return 0;
  }
}

// Same "alive" definition the per-campaign guard uses (any running run within the freshness
// window, whichever service owns it), widened from the campaign to the BRAND. Runs are tagged
// with the campaign's brandId CSV, which for a funnel campaign is the single brand.
const LIVE_RUN_FRESHNESS_MS = 15 * 60_000;

async function hasLiveRunForBrand(orgId: string, brandId: string, now: Date): Promise<boolean> {
  const { runs } = await listRuns({
    orgId,
    brandId,
    status: "running",
    startedAfter: new Date(now.getTime() - LIVE_RUN_FRESHNESS_MS).toISOString(),
    limit: 1,
  });
  return runs.length > 0;
}

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function nextDayStart(now: Date): Date {
  const d = new Date(now.getTime());
  d.setDate(d.getDate() + 1);
  d.setHours(0, 0, 0, 0);
  return d;
}
