import { and, arrayContains, eq } from "drizzle-orm";
import { getStatsBudget, listRuns, type IdentityHeaders } from "@distribute/runs-client";
import { db } from "../db/index.js";
import { campaigns } from "../db/schema.js";
import {
  fetchFunnelBudgets,
  legKeylessFundedCeilings,
} from "./funnel-budget-client.js";
import { buildProvisioningIdentity } from "./provisioning-identity.js";
import { isOutboundSalesFeature, isSalesFunnelFeature } from "./sales-outreach-campaign.js";
import { toFunnelKey } from "./sales-funnel-vocabulary.js";
import { acquisitionChannelForFeature } from "./campaign-identity.js";
import { fundingFromBudgets } from "./campaign-funding.js";
import { adoptFunnellessAncestorsSafely } from "./funnel-ancestor-adoption.js";
import { adoptOfferForPairSafely } from "./campaign-offer-adoption.js";

// A campaign that did not get this brand's turn re-checks on the next active tick. The turn is
// re-ranked from scratch every tick, so this is a "wait your turn", not a backoff. EVERY alive
// campaign of the brand is in the running every tick: none is ever held out because another one
// covers its funnel.
export const FUNNEL_TURN_DEFER_MS = 60_000; // 1 min

/**
 * How long a campaign the customer funds NOTHING for waits before it is looked at again.
 *
 * A held campaign is not waiting its turn, it is waiting for money, and money changes when a
 * person edits their funnels — hours or days apart, not minutes. Re-checking it at the turn
 * cadence would be one billing read per held brand per minute, forever, for a state that almost
 * never moves; the 27 brands held today would be ~39k reads a day answering "still nothing".
 *
 * It is also the WHOLE latency of the feature: funding a funnel makes its campaign eligible
 * within this window, with no manual step. Ten minutes is the same cadence the resume sweep runs
 * at, and for the same reason — the customer is owed that it works without them, not that it
 * works within the minute.
 */
export const FUNDING_RECHECK_MS = 10 * 60_000; // 10 min

/**
 * The campaign columns the turn planner reads. Structurally a subset of what the scheduler's
 * claim already returns, so the planner never needs its own query.
 */
export interface ClaimedFunnelCampaign {
  id: string;
  orgId: string;
  createdByUserId: string | null;
  /**
   * This campaign's ancestor run — what the provisioning reads state as their `x-run-id`, and what
   * a trigger hands workflow-service. NULL until `ensureCampaignRunId` establishes one; never a
   * minted uuid, which runs-service refuses.
   */
  parentRunId: string | null;
  /**
   * The DAG this campaign runs. NULL for a campaign whose channel the CUSTOMER operates — there is
   * none, on purpose. The scheduler never claims such a row, so one never reaches the planner; the
   * type states the absence rather than pretending every campaign has a workflow.
   */
  workflowSlug: string | null;
  brandIds: string[] | null;
  featureSlug: string | null;
  funnelKey: string | null;
  /** The mirror of this campaign's funnel ceiling. Stated → it IS the ceiling this campaign runs on. */
  dailyBudgetCents: number | null;
  /**
   * The offer this campaign sells — brand-service's id, carried and never derived. It is what
   * makes "which funnels are sold here?" a question with ONE answer on a brand selling several
   * offers. NULL is the pre-offer population and keeps the brand-keyed read it has always had.
   */
  offerId?: string | null;
  /**
   * The single funnel LEG this campaign was bought for — features-service's identifier, carried
   * and never derived. NULL is the pre-leg population and paces on the offer figure exactly as it
   * always did.
   */
  legKey?: string | null;
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
 * Four things happen per brand, in this order:
 *   0. Hold — a campaign the customer funds nothing for does not run. This is the ONLY thing that
 *      holds a brand's sales campaigns now: `brand_pause` is gone, and funding says it instead.
 *      Fail-CLOSED (an unreadable answer holds), because the gate refuses to spend on a ceiling
 *      it cannot read anyway, so firing would only burn a run.
 *   1. Provision — every funded funnel of the brand gets its own campaign (created on the spot,
 *      due immediately, so the next tick can claim it).
 *   2. Serialize — at most ONE run in flight per brand ACROSS ITS SALES CAMPAIGNS. This is the
 *      deliberate constraint that keeps funnels from running concurrently; removing it is what
 *      unlocks parallelism later, and nothing else has to be undone for that. It is not a lock:
 *      the same runs-service liveness read the per-campaign guard already uses, asked of each of
 *      the brand's sales campaigns. It deliberately does NOT count the brand's PR / AI-visibility
 *      / hiring / VC runs — those share neither leads nor sending accounts, and counting them
 *      stopped a brand's sales outreach outright (see hasLiveRunForBrandCohort), and it counts
 *      only the campaigns of the SAME cohort — a paid-reach run and a cold-email run share
 *      neither leads nor mailboxes, so neither holds the other.
 *   3. Rank — the funded funnel with the lowest spent/ceiling ratio takes the turn.
 *
 * Turn-taking is fail-SOFT (it only reorders work already allowed); the HOLD is fail-CLOSED, and
 * so is the per-funnel CEILING in gate-check, which is where spend control belongs.
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
    if (!isSalesFunnelFeature(c.featureSlug)) continue;
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
      // A planning failure is not a licence to spend: hold the group and say so. The gate would
      // refuse these runs anyway (it fail-closes on the same unreadable ceilings), so firing them
      // buys nothing and costs a run each.
      console.warn(`[campaign-service] funnel turn planning failed for campaign ${group[0]?.id} — holding the brand:`, err);
      for (const c of group) deferred.set(c.id, new Date(now.getTime() + FUNDING_RECHECK_MS));
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
    workflowSlug: seed.workflowSlug ?? undefined,
  };

  const heldAt = new Date(now.getTime() + FUNDING_RECHECK_MS);

  const budgets = await fetchFunnelBudgets(brandId, identity);
  // Fail-CLOSED. An unreadable ceiling is not "spend freely for a tick": the gate refuses the run
  // on the very same read, so firing it only burns a run and re-asks in a minute.
  if (!budgets.ok) {
    for (const c of group) deferred.set(c.id, heldAt);
    return;
  }

  // A funded ceiling that names NO leg is a DISAGREEMENT, not a coarser statement.
  //
  // A customer buys a LEG of a sales funnel and a campaign states the single leg it was bought
  // for; billing stores its ceilings at that grain and states the leg on every ceiling that has a
  // campaign. Money arriving here without one cannot be matched to a campaign at the grain it was
  // set at, and that is exactly the mismatch that let one identity grow two campaigns. It is
  // therefore neither defaulted to a coarser figure nor passed over: it is reported, naming the
  // ceiling, and nothing is created or started from it.
  //
  // It does not hold the brand. The disagreement is about a ceiling that has no campaign — holding
  // would stop the brand's live campaigns for a fault that is not theirs.
  reportLegKeylessCeilings(orgId, brandId, legKeylessFundedCeilings(budgets), now);

  // Attribution only — neither of these creates a campaign, starts one, or changes a status.
  // Nothing about money reaches them: they state which OFFER a campaign already running sells,
  // and which FUNNEL its own stopped ancestors belong to, so its history lands in the totals the
  // customer reads. Both are fail-soft and both are a no-op on an ordinary tick.
  const provisioning = await buildProvisioningIdentity(seed, brandId);
  if (provisioning) {
    await adoptOfferForPairSafely({ orgId, brandId }, provisioning, now);
  }
  for (const channel of new Set(
    group
      .map((c) => acquisitionChannelForFeature(c.featureSlug))
      .filter((ch): ch is string => !!ch),
  )) {
    await adoptFunnellessAncestorsSafely({ orgId, brandId, acquisitionChannel: channel }, now);
  }

  // (0) The hold. A campaign the customer funds nothing for waits for money, not for a turn — so
  // it is out of the running entirely and re-checked on the funding cadence. This is the only
  // thing that holds a brand's sales campaigns now.
  //
  // EVERY funded campaign of the brand is in the running, every tick. There is no campaign held
  // out because another one covers its funnel: each is ranked on what IT has already spent today
  // against the ceiling that actually binds IT, so nothing starves and nothing overspends.
  const candidates: FunnelTurnCandidate[] = [];
  const cohortOf = new Map<string, string>();
  for (const c of group) {
    const verdict = fundingFromBudgets(c, budgets);
    if (!verdict.funded) {
      deferred.set(c.id, heldAt);
      continue;
    }
    cohortOf.set(c.id, serializationCohort(c.featureSlug));
    // A row written before the rename still carries the pre-rename spelling until migration 0043
    // reaches it — and a mixed fleet must rank on one vocabulary or a funnel silently loses its
    // ceiling and never takes a turn.
    candidates.push({
      campaignId: c.id,
      funnelKey: toFunnelKey(c.funnelKey) ?? "",
      // The campaign's OWN feature, never the seed's: the spend read filters on it, so asking
      // runs-service for a Google Ads campaign's spend under the seed's cold-email slug answers
      // ZERO — the ad campaign then reads as perfectly empty and takes every turn, forever.
      spentCents: await spentTodayCents(orgId, c.id, c.featureSlug ?? featureSlug),
      ceilingCents: verdict.ceilingCents,
    });
  }

  if (candidates.length === 0) return;

  // Serial WITHIN A COHORT, and a cohort is what actually shares something: the outbound
  // cold-email channels share the brand's lead population and its sending accounts, so two of
  // their runs at once would contact the same people from the same mailboxes. A paid-reach
  // channel shares neither with them — it buys impressions — so serializing it behind cold email
  // would hold a funded Google Ads campaign for a reason that is not true of it, every tick,
  // showing up in no log at all. That is the same mistake `hasLiveRunForBrandCohort` was written to
  // undo one level up, where a brand's PR runs were holding its sales outreach.
  //
  // Concurrency INSIDE a cohort still needs the lead-de-duplication and sending-account audit
  // nobody has done, so it stays serial; a paid channel is serial against ITSELF for the same
  // conservatism (one live run per external ad account per brand).
  const cohorts = new Map<string, FunnelTurnCandidate[]>();
  for (const c of candidates) {
    const key = cohortOf.get(c.campaignId)!;
    const bucket = cohorts.get(key);
    if (bucket) bucket.push(c);
    else cohorts.set(key, [c]);
  }

  for (const [cohort, members] of cohorts) {
    await planOneCohort(orgId, brandId, cohort, members, now, deferred);
  }
}

/**
 * The runs that must not overlap this campaign's: the campaigns of the brand it genuinely shares
 * something with.
 *
 * The three outbound cold-email channels are ONE cohort — same leads, same mailboxes, whichever
 * offer they carry. Every other channel is its own, keyed on the acquisition channel it already
 * states, so a paid-reach campaign is serial against itself and against nothing else.
 */
export function serializationCohort(featureSlug: string | null | undefined): string {
  if (isOutboundSalesFeature(featureSlug)) return "outbound_cold_email";
  return acquisitionChannelForFeature(featureSlug) ?? "unknown_channel";
}

async function planOneCohort(
  orgId: string,
  brandId: string,
  cohort: string,
  candidates: FunnelTurnCandidate[],
  now: Date,
  deferred: Map<string, Date>,
): Promise<void> {
  if (await hasLiveRunForBrandCohort(orgId, brandId, cohort, now)) {
    for (const c of candidates) {
      deferred.set(c.campaignId, new Date(now.getTime() + FUNNEL_TURN_DEFER_MS));
    }
    return;
  }

  const winner = selectLowestFillRatio(candidates);
  // Every funded pair is at its ceiling. What re-opens it is NOT only the day rollover: a customer
  // who raises a ceiling at 14:57 has bought headroom that exists the moment they buy it. The defer
  // is written ONCE, from the ceiling current at this instant, and nothing else looks at an ongoing
  // campaign deferred to tomorrow — not the claim (`next_run_at <= now()`), not `claimStuckCampaigns`
  // (`next_run_at IS NULL`), not the resume sweep (stopped rows only). So parking on the rollover
  // makes the raise land the NEXT DAY, with real funded headroom unused (prod 2026-08-23, brand
  // 75d7e3e8: $39.13 of a $40 ceiling, raised to $50 at 14:57, zero runs after 13:24).
  //
  // Bounded by the funding cadence instead — the same figure and the same argument as
  // FUNDING_RECHECK_MS, whose promise ("funding a funnel makes its campaign eligible within this
  // window, with no manual step") held for a campaign funded from ZERO and not for one funded MORE.
  // Same rule, missing branch. A brand STILL at its ceiling simply re-ranks and defers again: no run
  // fires, no spend, and the gate is untouched. Ten minutes before midnight the rollover is the
  // nearer of the two and wins, so the day reset is never overshot.
  const reset =
    winner === null
      ? new Date(Math.min(nextDayStart(now).getTime(), now.getTime() + FUNDING_RECHECK_MS))
      : null;

  for (const c of candidates) {
    if (c.campaignId === winner) continue;
    deferred.set(c.campaignId, reset ?? new Date(now.getTime() + FUNNEL_TURN_DEFER_MS));
  }
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
// window, whichever service owns it), widened from the campaign to the brand's SALES campaigns.
const LIVE_RUN_FRESHNESS_MS = 15 * 60_000;

/**
 * Is one of this brand's campaigns OF THIS COHORT running right now?
 *
 * Asked campaign by campaign, and that is the whole point: a brand-wide `listRuns({ brandId })`
 * also counts the runs of the brand's PR, AI-visibility, hiring and VC campaigns, which are tagged
 * with the same brand. A brand whose PR outreach ticks continuously — 736 completed runs in one
 * morning, one always in flight — then reads as permanently busy, so EVERY sales campaign of that
 * brand is deferred 60s, every tick, forever. That is not a slowdown: it is a full stop, and it
 * shows up in no log at all because the defer is the routine path. It halted brand
 * f4d73dab-1f9d-49b2-b16e-63ecde76a5eb outright (prod, 2026-08-02).
 *
 * The constraint this serialization exists for is about channels sharing LEADS and SENDING
 * ACCOUNTS. A PR pitch shares neither, so it was never meant to hold a sales funnel back — and
 * neither is a paid-reach campaign, which buys impressions and touches no mailbox. So the question
 * is asked per cohort (see serializationCohort), not per family: counting a cold-email run against
 * a Google Ads campaign would be the same mistake one level down.
 *
 * The candidate set is read from the DB rather than from the campaigns claimed this tick: the one
 * that is actually running is precisely the one NOT claimed (its nextRunAt is null while in
 * flight), so a group-scoped check would be blind to it.
 */
export async function hasLiveRunForBrandCohort(
  orgId: string,
  brandId: string,
  cohort: string,
  now: Date,
): Promise<boolean> {
  const alive = await db.query.campaigns.findMany({
    where: and(
      eq(campaigns.orgId, orgId),
      eq(campaigns.status, "ongoing"),
      arrayContains(campaigns.brandIds, [brandId]),
    ),
    columns: { id: true, featureSlug: true },
  });

  const startedAfter = new Date(now.getTime() - LIVE_RUN_FRESHNESS_MS).toISOString();
  for (const c of alive) {
    if (!isSalesFunnelFeature(c.featureSlug)) continue;
    if (serializationCohort(c.featureSlug) !== cohort) continue;
    const { runs } = await listRuns({
      orgId,
      campaignId: c.id,
      status: "running",
      startedAfter,
      limit: 1,
    });
    if (runs.length > 0) return true;
  }
  return false;
}

/**
 * How long the same leg-less ceiling waits before it is reported again.
 *
 * The disagreement is real and has to be visible, but it does not move between ticks — a person
 * fixes it by setting the money at the grain a campaign is bought at. Reporting it once per tick
 * would be one error line per brand per minute for a state that changes hours or days apart, which
 * is how a real signal gets buried. Same figure and same argument as FUNDING_RECHECK_MS.
 */
export const LEG_KEYLESS_CEILING_REPORT_MS = 10 * 60_000; // 10 min

/** In-process, so a restart reports every one of them again — which is the right direction. */
const lastLegKeylessReportAt = new Map<string, number>();

/** Test seam: forget what has already been reported. */
export function resetLegKeylessCeilingReports(): void {
  lastLegKeylessReportAt.clear();
}

/**
 * Say, by name, that a funded ceiling states no leg.
 *
 * Not a warning and not a skip: this is the error that the two sides disagree about what one
 * campaign is. Nothing is defaulted, nothing is provisioned, and no pacing decision reads it.
 */
export function reportLegKeylessCeilings(
  orgId: string,
  brandId: string,
  ceilings: ReturnType<typeof legKeylessFundedCeilings>,
  now: Date,
): void {
  for (const c of ceilings) {
    const key = `${orgId}::${brandId}::${c.funnelKey}::${c.featureSlug ?? ""}::${c.offerId ?? ""}::${c.grain}`;
    const last = lastLegKeylessReportAt.get(key) ?? 0;
    if (now.getTime() - last < LEG_KEYLESS_CEILING_REPORT_MS) continue;
    lastLegKeylessReportAt.set(key, now.getTime());
    console.error(
      `[campaign-service] FUNDED CEILING STATES NO LEG — org ${orgId}, brand ${brandId}, funnel ${c.funnelKey}, channel ${c.featureSlug ?? "(none stated)"}, offer ${c.offerId ?? "(none stated)"}, ${c.dailyBudgetCents} cents/day, read at billing's "${c.grain}" grain. A campaign is bought for ONE leg, so money that names none cannot be matched to a campaign at the grain it was set at: billing and campaign-service disagree about what one campaign is. Nothing is created, started or paced from this ceiling.`,
    );
  }
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
