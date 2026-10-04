import { and, arrayContains, eq } from "drizzle-orm";
import { listRuns, type IdentityHeaders } from "@distribute/runs-client";
import { db } from "../db/index.js";
import { campaigns } from "../db/schema.js";
import {
  fetchCampaignBudgets,
  legKeylessFundedCeilings,
} from "./campaign-budget-client.js";
import { buildProvisioningIdentity } from "./provisioning-identity.js";
import { isOutboundSalesFeature, isSalesFamilyFeature } from "./sales-outreach-campaign.js";
import { acquisitionChannelForFeature } from "./campaign-identity.js";
import { fundingFromBudgets } from "./campaign-funding.js";
import { adoptOfferForPairSafely } from "./campaign-offer-adoption.js";
import { reportTurnHolds, type TurnHold } from "./turn-hold-event.js";
import { fetchBrandSalesBudget } from "./brand-sales-budget-client.js";
import { fetchOfferSalesPaths, type SalesPathEntry } from "./offer-sales-paths-client.js";
import { fetchChannelCatalogue, type CatalogueLeg } from "./channel-operator-client.js";
import {
  isGlobalBudgetExhausted,
  isReactiveLeg,
  rankEntryTargets,
  selectByPathRoi,
  type GlobalCandidate,
} from "./global-sales-budget.js";
import { brandSalesSpentTodayCents, potRecheckAt, readSpentTodayCents } from "./global-sales-pot.js";
import { itemVerdict } from "./sales-items-pace.js";
import type { SalesItem } from "./sales-items.js";

// A campaign that did not get this brand's turn re-checks on the next active tick. The turn is
// re-ranked from scratch every tick, so this is a "wait your turn", not a backoff. EVERY alive
// campaign of the brand is in the running every tick: none is ever held out because another one
// covers the same work.
export const TURN_DEFER_MS = 60_000; // 1 min

/**
 * How long a campaign the customer funds NOTHING for waits before it is looked at again.
 *
 * A held campaign is not waiting its turn, it is waiting for money, and money changes when a
 * person edits their ceilings — hours or days apart, not minutes. Re-checking it at the turn
 * cadence would be one billing read per held brand per minute, forever, for a state that almost
 * never moves; the 27 brands held today would be ~39k reads a day answering "still nothing".
 *
 * It is also the WHOLE latency of the feature: funding a campaign makes it eligible
 * within this window, with no manual step. Ten minutes is the same cadence the resume sweep runs
 * at, and for the same reason — the customer is owed that it works without them, not that it
 * works within the minute.
 */
export const FUNDING_RECHECK_MS = 10 * 60_000; // 10 min

/**
 * The campaign columns the turn planner reads. Structurally a subset of what the scheduler's
 * claim already returns, so the planner never needs its own query.
 */
export interface ClaimedSalesCampaign {
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
  /** This campaign's own daily budget. Stated → it IS the ceiling this campaign runs on. */
  dailyBudgetCents: number | null;
  /** The offer this campaign sells — brand-service's id, carried and never derived. */
  offerId?: string | null;
  /** The single LEG this campaign was bought for — features-service's identifier, never derived. */
  legKey?: string | null;
}

/** One sales campaign in the running to take the brand's next turn. */
export interface TurnCandidate {
  campaignId: string;
  /** The LEG the campaign was bought for (empty when it states none). Only breaks a tie. */
  legKey: string;
  /** Committed spend today for THIS campaign, in cents. */
  spentCents: number;
  /** This campaign's own daily ceiling, in cents. Always > 0 (a zero ceiling is not funded). */
  ceilingCents: number;
}

/**
 * Which funded campaign goes next: the one with the lowest ratio of what it has already spent
 * today to what it is allowed to spend today.
 *
 * NOT a fixed order. A fixed order starves whatever sits last — if the first campaign can absorb
 * the whole day, the others never run, and that shows up in no log at all. Ranking on the ratio
 * fills every campaign at the same pace RELATIVE to what it can absorb, and a campaign at its
 * ceiling yields its turn with no special case: its ratio is >= 1, so it is simply not a candidate.
 *
 * Returns null when every funded campaign is at its ceiling — nothing runs until they reset.
 * Ties break on the leg, then the campaign id, so the choice is deterministic rather than
 * insertion-ordered.
 */
export function selectLowestFillRatio(candidates: TurnCandidate[]): string | null {
  let bestId: string | null = null;
  let bestRatio = Infinity;
  let bestKey = "";

  for (const c of candidates) {
    if (!(c.ceilingCents > 0)) continue; // not funded — never run
    const ratio = c.spentCents / c.ceilingCents;
    if (ratio >= 1) continue; // at its ceiling: stops and yields to another funded campaign
    const key = `${c.legKey}\u0000${c.campaignId}`;
    if (ratio < bestRatio || (ratio === bestRatio && key < bestKey)) {
      bestRatio = ratio;
      bestKey = key;
      bestId = c.campaignId;
    }
  }

  return bestId;
}

/**
 * Plan which of the claimed campaigns may fire this tick.
 *
 * Returns the campaigns that must NOT fire, each with the time it should be re-checked. A
 * campaign absent from the map fires — so every non-sales campaign is untouched.
 *
 * Three things happen per brand, in this order:
 *   0. Hold — a campaign the customer funds nothing for does not run. This is the ONLY thing that
 *      holds a brand's sales campaigns now: `brand_pause` is gone, and funding says it instead.
 *      Fail-CLOSED (an unreadable answer holds), because the gate refuses to spend on a ceiling
 *      it cannot read anyway, so firing would only burn a run.
 *   1. Serialize — at most ONE run in flight per brand ACROSS ITS SALES CAMPAIGNS. This is the
 *      deliberate constraint that keeps campaigns from running concurrently; removing it is what
 *      unlocks parallelism later, and nothing else has to be undone for that. It is not a lock:
 *      the same runs-service liveness read the per-campaign guard already uses, asked of each of
 *      the brand's sales campaigns. It deliberately does NOT count the brand's PR / AI-visibility
 *      / hiring / VC runs — those share neither leads nor sending accounts, and counting them
 *      stopped a brand's sales outreach outright (see hasLiveRunForBrandCohort), and it counts
 *      only the campaigns of the SAME cohort — a paid-reach run and a cold-email run share
 *      neither leads nor mailboxes, so neither holds the other.
 *   2. Rank — the funded campaign with the lowest spent/ceiling ratio takes the turn.
 *
 * Turn-taking is fail-SOFT (it only reorders work already allowed); the HOLD is fail-CLOSED, and
 * so is the per-campaign CEILING in gate-check, which is where spend control belongs.
 */
export async function planBrandTurns(
  claimed: ClaimedSalesCampaign[],
  now: Date = new Date(),
): Promise<Map<string, Date>> {
  const deferred = new Map<string, Date>();
  // Every decision that parks a campaign on a cadence of its own — rather than on its turn — is
  // collected here and stated on the run ledger once planning is done. See `turn-hold-event.ts`:
  // these are the paths that used to return early with no run, no event and no log, so a campaign
  // correctly declining to run was indistinguishable from one that had silently died.
  const holds: TurnHold[] = [];

  // Only the sales family is funded per campaign by billing. Everything else keeps its own pacing
  // and its own per-campaign serialization, untouched.
  const groups = new Map<string, ClaimedSalesCampaign[]>();
  for (const c of claimed) {
    if (!isSalesFamilyFeature(c.featureSlug)) continue;
    const brandId = c.brandIds?.[0];
    if (!brandId) continue;
    const key = `${c.orgId}::${brandId}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(c);
    else groups.set(key, [c]);
  }

  for (const group of groups.values()) {
    try {
      await planOneBrand(group, now, deferred, holds);
    } catch (err) {
      // A planning failure is not a licence to spend: hold the group and say so. The gate would
      // refuse these runs anyway (it fail-closes on the same unreadable ceilings), so firing them
      // buys nothing and costs a run each.
      console.warn(`[campaign-service] turn planning failed for campaign ${group[0]?.id} — holding the brand:`, err);
      const heldAt = new Date(now.getTime() + FUNDING_RECHECK_MS);
      for (const c of group) {
        deferred.set(c.id, heldAt);
        holds.push({
          campaign: c,
          reason: "planning_failed",
          detail: `Campaign not run — turn planning failed for this brand: ${err instanceof Error ? err.message : String(err)}. Held rather than spent; re-checked at ${heldAt.toISOString()}.`,
          nextRunAt: heldAt,
        });
      }
    }
  }

  // Fail-SOFT and AFTER the planning: the holds are a statement about decisions already made, so
  // an unreportable one must never change whether a campaign runs.
  await reportTurnHolds(holds);

  return deferred;
}

async function planOneBrand(
  group: ClaimedSalesCampaign[],
  now: Date,
  deferred: Map<string, Date>,
  holds: TurnHold[],
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

  const budgets = await fetchCampaignBudgets(brandId, identity);
  // Fail-CLOSED. An unreadable ceiling is not "spend freely for a tick": the gate refuses the run
  // on the very same read, so firing it only burns a run and re-asks in a minute.
  if (!budgets.ok) {
    for (const c of group) {
      deferred.set(c.id, heldAt);
      holds.push({
        campaign: c,
        reason: "budgets_unreadable",
        detail: `Campaign not run — billing's campaign budgets for brand ${brandId} could not be read, so the ceiling that paces this campaign is unknown. Held rather than spent (fail-closed); re-checked at ${heldAt.toISOString()}.`,
        nextRunAt: heldAt,
      });
    }
    return;
  }

  // A funded ceiling that names NO leg is a DISAGREEMENT, not a coarser statement.
  //
  // A customer buys a LEG and a campaign states the single leg it was bought for. Money without
  // one is matched only through billing's "no other leg on this channel" rule, which is how one
  // identity once grew two campaigns. It is reported, naming the ceiling, and nothing is created
  // or started from it.
  //
  // It does not hold the brand. The disagreement is about a ceiling that has no campaign — holding
  // would stop the brand's live campaigns for a fault that is not theirs.
  reportLegKeylessCeilings(orgId, brandId, legKeylessFundedCeilings(budgets), now);

  // The brand's funding MODE. `campaigns` (every brand until one states a global sales budget) is
  // today's planner, byte-identical. Fail-CLOSED exactly like an unreadable ceiling: a mode we
  // cannot read is a cap we cannot read.
  const salesBudget = await fetchBrandSalesBudget(brandId, identity);
  if (!salesBudget.ok) {
    console.error(
      `[campaign-service] brand ${brandId} (org ${orgId}): billing's sales-budget mode could not be read (${salesBudget.detail}) — holding the brand (fail-closed).`,
    );
    for (const c of group) {
      deferred.set(c.id, heldAt);
      holds.push({
        campaign: c,
        reason: "budgets_unreadable",
        detail: `Campaign not run — billing's sales-budget mode for brand ${brandId} could not be read (${salesBudget.detail}), so whether a brand-wide sales budget caps this campaign is unknown. Held rather than spent (fail-closed); re-checked at ${heldAt.toISOString()}.`,
        nextRunAt: heldAt,
      });
    }
    return;
  }

  // Attribution only — it creates no campaign, starts none, and changes no status. Nothing about
  // money reaches it: it states which OFFER a campaign already running sells, so its history lands
  // in the totals the customer reads. Fail-soft, and a no-op on an ordinary tick.

  const provisioning = await buildProvisioningIdentity(seed, brandId);
  if (provisioning) {
    await adoptOfferForPairSafely({ orgId, brandId }, provisioning, now);
  }

  // (0) The hold. A campaign the customer funds nothing for waits for money, not for a turn — so
  // it is out of the running entirely and re-checked on the funding cadence. This is the only
  // thing that holds a brand's sales campaigns now.
  //
  // EVERY funded campaign of the brand is in the running, every tick: each is ranked on what IT has already spent today
  // against the ceiling that actually binds IT, so nothing starves and nothing overspends.
  // ITEMS mode (see sales-items.ts): each campaign is judged on its OWN item and nothing else, and
  // the global pot does not exist. One campaign held never holds another.
  if (salesBudget.mode === "items") {
    await planItemsBrand(group, salesBudget.items, budgets, now, deferred, holds);
    return;
  }

  let candidates: TurnCandidate[] = [];
  const cohortOf = new Map<string, string>();
  // Strict per-campaign spend (null = unreadable). Only GLOBAL mode reads it: the brand-wide cap
  // must not treat an unreadable spend as zero. Campaigns mode keeps the lenient 0 it always had.
  const strictSpent = new Map<string, number | null>();
  for (const c of group) {
    const verdict = fundingFromBudgets(c, budgets);
    if (!verdict.funded) {
      deferred.set(c.id, heldAt);
      holds.push({
        campaign: c,
        reason: "unfunded",
        detail: `Campaign not run — the customer funds no positive daily ceiling for it (offer ${c.offerId ?? "(none stated)"}, leg ${c.legKey ?? "(none stated)"}, channel ${c.featureSlug ?? "(none stated)"}). It is waiting for money, not for its turn; re-checked at ${heldAt.toISOString()}.`,
        nextRunAt: heldAt,
      });
      continue;
    }
    cohortOf.set(c.id, serializationCohort(c.featureSlug));
    candidates.push({
      campaignId: c.id,
      legKey: c.legKey ?? "",
      // The campaign's OWN feature, never the seed's: the spend read filters on it, so asking
      // runs-service for a Google Ads campaign's spend under the seed's cold-email slug answers
      // ZERO — the ad campaign then reads as perfectly empty and takes every turn, forever.
      spentCents: await (async () => {
        const strict = await readSpentTodayCents(orgId, c.id, c.featureSlug ?? featureSlug);
        strictSpent.set(c.id, strict);
        return strict ?? 0;
      })(),
      ceilingCents: verdict.ceilingCents,
    });
  }

  if (candidates.length === 0) return;

  const byId = new Map(group.map((c) => [c.id, c]));

  // Bottom of the funnel first (global mode only): a reactive candidate takes its cohort's turn
  // ahead of an entry leg.
  let firstServed = new Set<string>();
  if (salesBudget.mode === "global") {
    const allocation = await allocateGlobalBudget({
      orgId,
      brandId,
      featureSlug,
      budgetCents: salesBudget.dailyBudgetCents,
      candidates,
      byId,
      strictSpent,
      provisioning,
      now,
      deferred,
      holds,
    });
    candidates = allocation.candidates;
    firstServed = allocation.reactiveIds;
    if (candidates.length === 0) return;
  }

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
  const cohorts = new Map<string, TurnCandidate[]>();
  for (const c of candidates) {
    const key = cohortOf.get(c.campaignId)!;
    const bucket = cohorts.get(key);
    if (bucket) bucket.push(c);
    else cohorts.set(key, [c]);
  }

  for (const [cohort, members] of cohorts) {
    await planOneCohort(orgId, brandId, cohort, members, byId, now, deferred, holds, firstServed);
  }
}

/**
 * ITEMS MODE: the customer budgets each campaign (offer, leg, channel) and billing serves the items.
 *
 * Every campaign is judged alone on its item (`itemVerdict`, the same verdict gate-check and the
 * step trigger give): no item = held as unfunded; spent = parked until a raise or the rollover;
 * unreadable = held (fail-closed) — each for THAT campaign only. The ones that may spend take the
 * cohort turn exactly as in campaigns mode, ranked on their fill ratio against today's allowance,
 * reactive legs first (bottom of the funnel first, as in global mode).
 */
async function planItemsBrand(
  group: ClaimedSalesCampaign[],
  items: readonly SalesItem[],
  budgets: Awaited<ReturnType<typeof fetchCampaignBudgets>>,
  now: Date,
  deferred: Map<string, Date>,
  holds: TurnHold[],
): Promise<void> {
  const seed = group[0];
  const orgId = seed.orgId;
  const brandId = seed.brandIds![0];

  const catalogue = await fetchChannelCatalogue();
  let legs: readonly CatalogueLeg[] = [];
  if (catalogue.ok) legs = catalogue.legs;
  else {
    console.error(
      `[campaign-service] brand ${brandId} (org ${orgId}) is in ITEMS sales-budget mode but the channel catalogue could not be read (${catalogue.detail}) — every leg is paced as proactive.`,
    );
  }

  const candidates: TurnCandidate[] = [];
  const cohortOf = new Map<string, string>();
  const reactiveIds = new Set<string>();
  for (const c of group) {
    const reactive = isReactiveLeg(c.legKey, legs);
    const verdict = await itemVerdict({
      campaign: {
        id: c.id,
        orgId,
        offerId: c.offerId ?? null,
        legKey: c.legKey ?? null,
        featureSlug: c.featureSlug,
        dailyBudgetCents: c.dailyBudgetCents,
      },
      brandId,
      items,
      reactive,
      identity: { orgId, userId: c.createdByUserId ?? undefined, campaignId: c.id, brandId },
      now,
      budgets,
    });
    if (!verdict.run) {
      const nextRunAt = verdict.kind === "unfunded" ? new Date(now.getTime() + FUNDING_RECHECK_MS) : verdict.nextRunAt;
      deferred.set(c.id, nextRunAt);
      const reason = verdict.kind === "unfunded" ? "unfunded" : verdict.kind === "reached" ? "item_budget_reached" : "budgets_unreadable";
      const leadNote = reactive && verdict.kind !== "unfunded"
        ? " A lead waiting at this step is not dropped: it stays due and is worked by the first run the item can pay for."
        : "";
      holds.push({
        campaign: c,
        reason,
        detail: `Campaign not run — ${verdict.detail}.${leadNote} Re-checked at ${nextRunAt.toISOString()}.`,
        nextRunAt,
        data: verdict.capCents !== undefined ? { spentCents: verdict.spentCents, itemCapCents: verdict.capCents } : undefined,
      });
      continue;
    }
    if (verdict.reactive) reactiveIds.add(c.id);
    cohortOf.set(c.id, serializationCohort(c.featureSlug));
    candidates.push({ campaignId: c.id, legKey: c.legKey ?? "", spentCents: verdict.spentCents, ceilingCents: verdict.capCents });
  }
  if (candidates.length === 0) return;

  const byId = new Map(group.map((c) => [c.id, c]));
  const cohorts = new Map<string, TurnCandidate[]>();
  for (const c of candidates) {
    const key = cohortOf.get(c.campaignId)!;
    const bucket = cohorts.get(key);
    if (bucket) bucket.push(c);
    else cohorts.set(key, [c]);
  }
  for (const [cohort, members] of cohorts) {
    await planOneCohort(orgId, brandId, cohort, members, byId, now, deferred, holds, reactiveIds);
  }
}

interface GlobalAllocationInput {
  orgId: string;
  brandId: string;
  featureSlug: string;
  budgetCents: number;
  candidates: TurnCandidate[];
  byId: Map<string, ClaimedSalesCampaign>;
  strictSpent: Map<string, number | null>;
  provisioning: Awaited<ReturnType<typeof buildProvisioningIdentity>>;
  now: Date;
  deferred: Map<string, Date>;
  holds: TurnHold[];
}

interface GlobalAllocation {
  /** The candidates that stay in the running for this tick's cohort ranking. */
  candidates: TurnCandidate[];
  /** Which of them are REACTIVE: they take their cohort's turn first (bottom of the funnel first). */
  reactiveIds: Set<string>;
}

/**
 * GLOBAL MODE: the brand stated ONE daily sales budget, and it is the ONE pot for every sales
 * campaign of the brand, reactive and proactive (owner, 2026-10-03; see global-sales-budget.ts).
 * Returns the candidates that stay in the running for this tick's cohort ranking — every REACTIVE
 * candidate plus AT MOST ONE proactive campaign, the one the rest of the pot goes to. Every other
 * candidate is deferred here.
 *
 *   - Brand-wide spend today (ALL legs, reactive included) >= the pot, or a $0 pot: EVERY candidate
 *     is parked until a raise or the rollover. A reactive one loses no lead: the lead stays due in
 *     lead-service's queue and the first run the pot can pay for works it.
 *   - Spend unreadable: every candidate is held (fail-closed); the pot cannot be judged.
 *   - Otherwise reactive candidates run (only when a lead is waiting: their DAG ends idle
 *     otherwise), and what is left of the pot goes to the best-ROI sales path that can run
 *     (`selectByPathRoi`); an offer whose paths cannot be read, or are not `ok`, falls back to
 *     fill-ratio pacing — loudly — still inside the pot.
 *
 * Per-campaign ceilings are untouched: gate-check still paces every run on them, and on the pot
 * itself (`globalSalesPotBlock`), so a run dispatched by the step trigger is bound too.
 */
async function allocateGlobalBudget(input: GlobalAllocationInput): Promise<GlobalAllocation> {
  const { orgId, brandId, featureSlug, budgetCents, candidates, byId, strictSpent, provisioning, now, deferred, holds } = input;

  const catalogue = await fetchChannelCatalogue();
  let legs: readonly CatalogueLeg[] = [];
  if (catalogue.ok) {
    legs = catalogue.legs;
  } else {
    // Conservative: with no catalogue every leg reads PROACTIVE, i.e. no leg jumps the queue. The
    // pot binds every leg either way.
    console.error(
      `[campaign-service] brand ${brandId} (org ${orgId}) is in GLOBAL sales-budget mode but the channel catalogue could not be read (${catalogue.detail}) — treating every leg as proactive (no leg served first).`,
    );
  }

  const reactive: TurnCandidate[] = [];
  const proactive: TurnCandidate[] = [];
  for (const c of candidates) {
    if (isReactiveLeg(byId.get(c.campaignId)?.legKey ?? null, legs)) reactive.push(c);
    else proactive.push(c);
  }
  const reactiveIds = new Set(reactive.map((c) => c.campaignId));

  // EVERY leg's spend comes out of the pot — reactive included.
  const known = new Map<string, number | null>(candidates.map((c) => [c.campaignId, strictSpent.get(c.campaignId) ?? null]));
  const spent = await brandSalesSpentTodayCents(orgId, brandId, featureSlug, known);
  const recheck = new Date(now.getTime() + FUNDING_RECHECK_MS);

  if (spent === null) {
    console.error(
      `[campaign-service] brand ${brandId} (org ${orgId}): brand-wide sales spend today could not be read — holding its sales campaigns rather than spending past a global sales budget of ${budgetCents} cents (fail-closed).`,
    );
    for (const c of candidates) {
      deferred.set(c.campaignId, recheck);
      const campaign = byId.get(c.campaignId);
      if (!campaign) continue;
      holds.push({
        campaign,
        reason: "budgets_unreadable",
        detail: `Campaign not run — the brand's spend today could not be read, so its global daily sales budget of ${budgetCents} cents cannot be judged. Held rather than spent (fail-closed); re-checked at ${recheck.toISOString()}.`,
        nextRunAt: recheck,
      });
    }
    return { candidates: [], reactiveIds };
  }

  if (isGlobalBudgetExhausted(spent, budgetCents)) {
    const reset = potRecheckAt(now);
    for (const c of candidates) {
      deferred.set(c.campaignId, reset);
      const campaign = byId.get(c.campaignId);
      if (!campaign) continue;
      const leadNote = reactiveIds.has(c.campaignId)
        ? " A lead waiting at this step is not dropped: it stays due and is worked by the first run the budget can pay for."
        : "";
      holds.push({
        campaign,
        reason: "global_sales_budget_reached",
        detail: `Campaign not run — the brand's global daily sales budget is ${budgetCents} cents and ${spent.toFixed(0)} cents of sales spend (every leg) is already committed today.${leadNote} It runs again when the budget is raised or the day rolls over; re-checked at ${reset.toISOString()}.`,
        nextRunAt: reset,
        data: { spentCents: spent, globalBudgetCents: budgetCents },
      });
    }
    return { candidates: [], reactiveIds };
  }

  if (proactive.length === 0) return { candidates: reactive, reactiveIds };

  // Rank the paths of every offer the proactive candidates sell.
  const pathsByOffer = new Map<string, SalesPathEntry[]>();
  const offers = new Set<string>();
  for (const c of proactive) {
    const offerId = byId.get(c.campaignId)?.offerId;
    if (offerId) offers.add(offerId);
  }
  for (const offerId of offers) {
    if (!provisioning) {
      console.error(
        `[campaign-service] brand ${brandId} (org ${orgId}), offer ${offerId}: no identity to read its sales paths with — falling back to fill-ratio pacing inside the global sales budget.`,
      );
      continue;
    }
    const read = await fetchOfferSalesPaths(offerId, brandId, provisioning);
    if (!read.ok) {
      console.error(
        `[campaign-service] brand ${brandId} (org ${orgId}), offer ${offerId}: sales paths could not be read (${read.detail}) — falling back to fill-ratio pacing inside the global sales budget.`,
      );
      continue;
    }
    if (read.status !== "ok") {
      console.error(
        `[campaign-service] brand ${brandId} (org ${orgId}), offer ${offerId}: sales paths status is ${read.status} — falling back to fill-ratio pacing inside the global sales budget.`,
      );
      continue;
    }
    pathsByOffer.set(offerId, read.paths);
  }

  const globalCandidates: GlobalCandidate[] = proactive.map((c) => {
    const row = byId.get(c.campaignId);
    return {
      campaignId: c.campaignId,
      offerId: row?.offerId ?? null,
      legKey: c.legKey,
      featureSlug: row?.featureSlug ?? null,
      spentCents: c.spentCents,
      ceilingCents: c.ceilingCents,
    };
  });
  const pick = selectByPathRoi(globalCandidates, rankEntryTargets(pathsByOffer));

  // Nobody can run: every proactive candidate is at its own ceiling. Hand them all to the cohort
  // ranking unchanged, which parks them on the ceiling exactly as campaigns mode does.
  if (!pick) return { candidates: [...reactive, ...proactive], reactiveIds };

  for (const c of proactive) {
    if (c.campaignId === pick.campaignId) continue;
    // Yielding the brand's budget to a better path is a turn, not a hold: silent, on the turn cadence.
    deferred.set(c.campaignId, new Date(now.getTime() + TURN_DEFER_MS));
  }
  return { candidates: [...reactive, ...proactive.filter((c) => c.campaignId === pick.campaignId)], reactiveIds };
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
  candidates: TurnCandidate[],
  byId: Map<string, ClaimedSalesCampaign>,
  now: Date,
  deferred: Map<string, Date>,
  holds: TurnHold[],
  firstServed: ReadonlySet<string> = new Set(),
): Promise<void> {
  if (await hasLiveRunForBrandCohort(orgId, brandId, cohort, now)) {
    for (const c of candidates) {
      deferred.set(c.campaignId, new Date(now.getTime() + TURN_DEFER_MS));
    }
    return;
  }

  // Bottom of the funnel first (global mode): a reactive candidate under its ceiling takes the turn
  // before any entry leg. It only holds the turn while a lead is waiting — a reactive run with
  // nobody due ends idle and waits NO_WORK_RECHECK_MS — so it cannot starve the entry legs.
  const winner =
    selectLowestFillRatio(candidates.filter((c) => firstServed.has(c.campaignId))) ??
    selectLowestFillRatio(candidates);
  // Every funded pair is at its ceiling. What re-opens it is NOT only the day rollover: a customer
  // who raises a ceiling at 14:57 has bought headroom that exists the moment they buy it. The defer
  // is written ONCE, from the ceiling current at this instant, and nothing else looks at an ongoing
  // campaign deferred to tomorrow — not the claim (`next_run_at <= now()`), not `claimStuckCampaigns`
  // (`next_run_at IS NULL`), not the resume sweep (stopped rows only). So parking on the rollover
  // makes the raise land the NEXT DAY, with real funded headroom unused (prod 2026-08-23, brand
  // 75d7e3e8: $39.13 of a $40 ceiling, raised to $50 at 14:57, zero runs after 13:24).
  //
  // Bounded by the funding cadence instead — the same figure and the same argument as
  // FUNDING_RECHECK_MS, whose promise ("funding a campaign makes it eligible within this
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
    deferred.set(c.campaignId, reset ?? new Date(now.getTime() + TURN_DEFER_MS));
    // Only the CEILING park is stated. A campaign that merely yielded its turn (a sibling of the
    // same cohort outranked it, or one is in flight) is deferred sixty seconds and its brand is
    // visibly working — that is the routine path, it fires per campaign per tick for every client,
    // and an event there would be exactly the per-minute bip this repo's log discipline forbids.
    // A campaign parked at its ceiling is the one whose silence has no other explanation.
    if (!reset) continue;
    const campaign = byId.get(c.campaignId);
    if (!campaign) continue;
    holds.push({
      campaign,
      reason: "daily_ceiling_reached",
      detail: `Campaign not run — it has already spent its whole daily ceiling: ${c.spentCents.toFixed(0)} of ${c.ceilingCents} cents committed today on leg ${c.legKey || "(none stated)"}. It runs again when the ceiling is raised or the day rolls over; re-checked at ${reset.toISOString()}.`,
      nextRunAt: reset,
      data: { spentCents: c.spentCents, ceilingCents: c.ceilingCents, legKey: c.legKey || null },
    });
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
 * ACCOUNTS. A PR pitch shares neither, so it was never meant to hold sales outreach back — and
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
    if (!isSalesFamilyFeature(c.featureSlug)) continue;
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
    const key = `${orgId}::${brandId}::${c.featureSlug}::${c.offerId ?? ""}`;
    const last = lastLegKeylessReportAt.get(key) ?? 0;
    if (now.getTime() - last < LEG_KEYLESS_CEILING_REPORT_MS) continue;
    lastLegKeylessReportAt.set(key, now.getTime());
    console.error(
      `[campaign-service] FUNDED CEILING STATES NO LEG — org ${orgId}, brand ${brandId}, channel ${c.featureSlug}, offer ${c.offerId ?? "(none stated)"}, ${c.dailyBudgetCents} cents/day. A campaign is bought for ONE leg, so money that names none is matched only through billing's "no other leg on this channel" rule: restate it at the leg it was bought for. Nothing is created or started from this ceiling.`,
    );
  }
}

function nextDayStart(now: Date): Date {
  const d = new Date(now.getTime());
  d.setDate(d.getDate() + 1);
  d.setHours(0, 0, 0, 0);
  return d;
}
