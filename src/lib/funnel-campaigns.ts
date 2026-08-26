import { and, arrayContains, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { getStatsBudget, listRuns, type IdentityHeaders } from "@distribute/runs-client";
import { db } from "../db/index.js";
import { campaigns } from "../db/schema.js";
import {
  fetchFunnelBudgets,
  fundedChannelPairs,
  fundedFunnels,
  type FunnelBudgetsRead,
} from "./funnel-budget-client.js";
import { fetchFeatureSalesFunnels, type FeatureSalesFunnelsRead } from "./feature-sales-funnels-client.js";
import { fetchActiveWorkflowSlugForFeature, type ActiveWorkflowRead } from "./feature-workflow-client.js";
import { buildProvisioningIdentity, type ProvisioningIdentity } from "./provisioning-identity.js";
import type { SalesFunnelKey } from "./sales-funnel-vocabulary.js";
import {
  fetchBrandSalesFunnels,
  fetchOfferSalesFunnels,
  type SalesFunnelsRead,
} from "./brand-sales-funnels-client.js";
import {
  isOutboundSalesFeature,
  isSalesFunnelFeature,
  SALES_FUNNEL_FEATURE_SLUGS,
} from "./sales-outreach-campaign.js";
import { toFunnelKey } from "./sales-funnel-vocabulary.js";
import { acquisitionChannelForFeature, campaignIdentityColumns } from "./campaign-identity.js";
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
  workflowSlug: string;
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
    workflowSlug: seed.workflowSlug,
  };

  const heldAt = new Date(now.getTime() + FUNDING_RECHECK_MS);

  const budgets = await fetchFunnelBudgets(brandId, identity);
  // Fail-CLOSED. An unreadable ceiling is not "spend freely for a tick": the gate refuses the run
  // on the very same read, so firing it only burns a run and re-asks in a minute.
  if (!budgets.ok) {
    for (const c of group) deferred.set(c.id, heldAt);
    return;
  }

  const funded = fundedPairs(budgets, featureSlug);
  if (funded.length > 0) {
    // The reads below are REFUSED without a full identity, and the campaign row this path is built
    // from carries no run — so the campaign's own ancestor run is established first and stated on
    // every one of them. Null here provisions nothing this sweep and is already logged; it does
    // not hold the brand, because this decides which questions can be asked, not whether money
    // may be spent.
    const provisioning = await buildProvisioningIdentity(seed, brandId);
    if (provisioning) {
      // Asked over the WHOLE group, not just the seed: a brand selling several offers has one
      // campaign per offer in flight, and each is ranked on the funnels of the offer IT sells.
      const declared = await resolveDeclaredFunnels(group, brandId, provisioning);
      await ensureFundedFunnelCampaigns({
        seed,
        brandId,
        funded,
        declared,
        identity: provisioning,
        now,
      });
    }
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
function serializationCohort(featureSlug: string | null | undefined): string {
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
 * One funded (sales funnel, acquisition-channel feature) pair — the unit ONE campaign is
 * provisioned per.
 */
interface FundedPair {
  funnelKey: SalesFunnelKey;
  /** The acquisition channel, as a features-service feature slug. A channel IS a feature slug. */
  featureSlug: string;
}

/**
 * What the customer funds, at the grain a campaign is provisioned per.
 *
 * billing states the pair grain ADDITIVELY, so both shapes are live at once and the fallback is
 * what keeps every brand funding one channel per funnel untouched:
 *
 *   - pairs stated → one campaign per funded pair, each on its own channel.
 *   - no pairs (an older billing deploy, or a brand that funds nothing per funnel) → one campaign
 *     per funded FUNNEL on the seed's channel, i.e. exactly what this did before.
 */
function fundedPairs(
  budgets: Extract<FunnelBudgetsRead, { ok: true }>,
  seedFeatureSlug: string,
): FundedPair[] {
  const pairs = fundedChannelPairs(budgets);
  if (pairs.length > 0) {
    return pairs.map((p) => ({ funnelKey: p.funnelKey, featureSlug: p.featureSlug }));
  }
  return fundedFunnels(budgets).map((f) => ({
    funnelKey: f.funnelKey,
    featureSlug: seedFeatureSlug,
  }));
}

/**
 * Which funnels are sold through this brand, and — for each of them — WHICH OFFER declares it.
 *
 * "The funnels of brand X" stopped having one answer the day a brand could sell several offers:
 * each offer owns its own funnels and its own economics, and brand-service refuses a brand-keyed
 * read on a brand holding more than one rather than picking one. A campaign already states the
 * offer it sells, so the unambiguous question is asked per OFFER and the answers are unioned here.
 */
export interface ResolvedDeclaredFunnels {
  /**
   * funnelKey → the offer that declares it. NULL means it came from the BRAND-keyed read, i.e.
   * from a campaign that states no offer — the pre-offer world, unchanged.
   */
  offerByFunnel: Map<SalesFunnelKey, string | null>;
  /**
   * Declared by SEVERAL offers of this brand. There is no single offer to file a new campaign
   * under, and picking one would rank it on another product's economics — so nothing is
   * provisioned for it and it is said out loud.
   */
  contested: Set<SalesFunnelKey>;
}

const NO_DECLARED_FUNNELS: ResolvedDeclaredFunnels = {
  offerByFunnel: new Map(),
  contested: new Set(),
};

/**
 * Ask for the declared funnels at the grain that HAS one answer: once per distinct offer the
 * brand's campaigns state, plus the brand-keyed read only when a campaign states no offer.
 *
 * A failure is never laundered into "the brand declares nothing" — that collapse is exactly what
 * made the offer level silent. An ambiguity refusal says the grain was wrong (loudly, because it
 * is this service's own question that was unanswerable), a transport failure says nothing is known
 * this tick, and an EMPTY list is a truthful answer that is not logged at all: it is the routine
 * state of a brand that has never declared a funnel, on every sweep of every client.
 */
async function resolveDeclaredFunnels(
  group: Array<{ offerId?: string | null }>,
  brandId: string,
  identity: ProvisioningIdentity,
): Promise<ResolvedDeclaredFunnels> {
  const offerIds = [...new Set(group.map((c) => c.offerId).filter((id): id is string => !!id))];
  const anyOfferless = group.some((c) => !c.offerId);

  const offerByFunnel = new Map<SalesFunnelKey, string | null>();
  const contested = new Set<SalesFunnelKey>();

  const note = (read: SalesFunnelsRead, what: string): void => {
    if (read.ok) return;
    if (read.reason === "ambiguous") {
      console.warn(
        `[campaign-service] brand-service will not state the sales funnels of ${what} (brand ${brandId}) — ${read.detail}. Nothing is provisioned from it; this is a REFUSAL, not an empty declaration.`,
      );
      return;
    }
    console.warn(
      `[campaign-service] Could not read the sales funnels of ${what} (brand ${brandId}) — ${read.detail} (${read.reason})`,
    );
  };

  for (const offerId of offerIds) {
    const read = await fetchOfferSalesFunnels(offerId, identity);
    note(read, `offer ${offerId}`);
    if (!read.ok) continue;
    for (const f of read.funnels) {
      const seen = offerByFunnel.get(f.funnelKey);
      if (seen !== undefined && seen !== null && seen !== offerId) {
        // Two offers of one brand sell through the same chain. Both are equals and neither
        // outranks the other, so there is nobody to attribute a new campaign to.
        contested.add(f.funnelKey);
        continue;
      }
      offerByFunnel.set(f.funnelKey, offerId);
    }
  }

  if (offerIds.length === 0 || anyOfferless) {
    const read = await fetchBrandSalesFunnels(brandId, identity);
    note(read, `brand ${brandId}`);
    if (read.ok) {
      for (const f of read.funnels) {
        // An offer's own statement is the finer one and wins; the brand-keyed answer only fills
        // what no offer named, which is the whole pre-offer population.
        if (!offerByFunnel.has(f.funnelKey)) offerByFunnel.set(f.funnelKey, null);
      }
    }
  }

  return { offerByFunnel, contested };
}

/**
 * Make sure every funded (funnel, channel) pair of the brand HAS a campaign.
 *
 * The campaign STATES its funnel, and that statement is the whole vocabulary for what it sells.
 * Nothing here reads a goal to work out which funnel an existing campaign is on: every campaign
 * states its funnel from birth (creation refuses a sales campaign that does not), so there is
 * nothing left to attribute and nothing that can be unattributable. A brand that funds a funnel
 * gets a campaign for that funnel, full stop — no campaign of the brand can hold provisioning
 * back any more.
 *
 * A funnel billing funds but brand-service does not declare (or declares inactive) is skipped: a
 * switched-off funnel must never be worked, whatever ceiling billing still holds for it. A PAIR the
 * channel may not sell through is skipped the same way, and for the same reason — the feedback
 * request buys a conversation, so it cannot sell the three chains that start with a website click.
 * That statement is features-service's and is asked per channel; no matrix is held here.
 *
 * A channel workflow-service has no ACTIVE workflow for is also skipped: a campaign with no DAG to
 * run would stay ongoing and produce nothing.
 *
 * Funding brings back the campaign that was HELD, never the campaign that stopped for a reason of
 * its own. A row carrying `audience_exhausted`, `max_leads_reached`, `manual` or `org_teardown`
 * stated why it stopped, and money is not an answer to any of those — the exhaustion sweep owns
 * the first (it asks the audience owner, which is the only honest test), and the other three were
 * decisions. A NULL reason is the population that predates the column: those rows are the
 * workflow-version churn this service used to grow one stopped campaign per workflow version for,
 * so they are the campaign, not a decision about it, and funding resumes them.
 */
async function ensureFundedFunnelCampaigns({
  seed,
  brandId,
  funded,
  declared,
  identity,
  now,
}: {
  seed: ClaimedFunnelCampaign;
  brandId: string;
  funded: FundedPair[];
  declared: ResolvedDeclaredFunnels;
  identity: ProvisioningIdentity;
  now: Date;
}): Promise<void> {
  // A campaign that already exists with NO offer is invisible on every offer-scoped surface, and
  // provisioning is the one thing that looks at this pair on this service's own cadence. Asked
  // FIRST, before any early return below: a pair whose funnel declaration is empty or unreadable
  // still has a live campaign the customer cannot see, and that is exactly the pair this closes.
  // Fail-soft and a no-op on every ordinary tick (nothing is read at all unless a campaign of the
  // pair states no offer). See campaign-offer-adoption.ts for the rule and why it is not a script.
  await adoptOfferForPairSafely({ orgId: seed.orgId, brandId }, identity, now);

  // No readable funnel declaration → nothing says the brand still sells through these funnels.
  // Provisioning waits; whatever campaigns already exist keep running.
  if (declared.offerByFunnel.size === 0) return;
  if (!seed.createdByUserId) return; // no recipient/owner to attribute a new campaign to

  // One read per CHANNEL, not per pair: a brand funding both of a channel's funnels asks once.
  const sellableByFeature = new Map<string, FeatureSalesFunnelsRead>();
  const workflowByFeature = new Map<string, ActiveWorkflowRead>();

  // The (org, brand, acquisition channel) triples a funnel campaign is provisioned for on this
  // tick. Collected rather than acted on inline BECAUSE the existing-campaign check below returns
  // early with `continue`: a brand whose twin already exists — which is precisely the brand this
  // recurrence was found on — would never reach an adoption written after that check. See
  // funnel-ancestor-adoption.ts for the rule and why it cannot stay a one-shot migration.
  const adoptFor = new Set<string>();

  for (const f of funded) {
    if (declared.contested.has(f.funnelKey)) {
      // Several offers of this brand sell through this chain. Provisioning one campaign would file
      // it under one of them, i.e. rank it on another product's economics — so it waits for a
      // caller that states which offer it means, and it is not silent about waiting.
      console.warn(
        `[campaign-service] Not provisioning funnel ${f.funnelKey} for brand ${brandId} — several offers of this brand declare it and none outranks another`,
      );
      continue;
    }
    const offerId = declared.offerByFunnel.get(f.funnelKey);
    if (offerId === undefined) continue; // funded, but nobody declares selling through it
    const featureSlug = f.featureSlug;

    if (!sellableByFeature.has(featureSlug)) {
      sellableByFeature.set(featureSlug, await fetchFeatureSalesFunnels(featureSlug, identity));
    }
    const sellable = sellableByFeature.get(featureSlug)!;
    // Unreadable → provision nothing for this channel, exactly as an unreadable brand declaration
    // provisions nothing for the brand. A pair is not guessed at — but it is not passed over in
    // silence either: the customer's money is on this pair and we failed to evaluate it, which is
    // a different thing from evaluating it and saying no.
    if (!sellable.ok) {
      console.warn(
        `[campaign-service] Not provisioning ${featureSlug} for funnel ${f.funnelKey} (brand ${brandId}, org ${seed.orgId}) — could not READ features-service's statement of which funnels this channel sells: ${sellable.detail}`,
      );
      continue;
    }
    if (!sellable.funnels.has(f.funnelKey)) {
      // A pair nobody can run: the customer funds it, but this channel has no way to sell that
      // chain. Logged once per sweep rather than silently dropped — the money is real and the
      // customer is owed an answer about it eventually.
      console.log(
        `[campaign-service] Not provisioning ${featureSlug} for funnel ${f.funnelKey} (brand ${brandId}) — features-service does not state that pair`,
      );
      continue;
    }

    // This pair gets a campaign on this channel — whether one already exists or one is inserted
    // below. Either way a live funnel identity exists for the triple, which is the one moment the
    // funnel-less stopped ancestors of that triple can be folded onto it.
    const channel = acquisitionChannelForFeature(featureSlug);
    if (channel) adoptFor.add(channel);

    // The LIVE campaign of this pair wins over a stopped one, whatever their creation dates.
    // Ordering on `created_at` alone answers "the newest row", which is not the same question: a
    // stopped ancestor created after the incumbent — or one that only just became findable here
    // because its funnel was folded onto this identity — would be returned instead, and the resume
    // below would then try to bring it back alongside the incumbent. That is a 23505 on the partial
    // unique index (ongoing rows only), and it is thrown INSIDE planFunnelTurns, which fail-closes
    // and holds the whole brand: every tick, forever, for a brand whose campaign is running fine.
    // At most one ongoing campaign per identity holds, so there is at most one such row to prefer.
    const existing = await db.query.campaigns.findFirst({
      where: and(
        eq(campaigns.orgId, seed.orgId),
        eq(campaigns.featureSlug, featureSlug),
        eq(campaigns.funnelKey, f.funnelKey),
        arrayContains(campaigns.brandIds, [brandId]),
      ),
      orderBy: [desc(sql`(${campaigns.status} = 'ongoing')`), desc(campaigns.createdAt)],
    });

    if (existing) {
      // A funnel the customer re-funded after switching it off resumes rather than duplicating —
      // unless the campaign stopped for a reason of its own, which money does not answer.
      if (existing.status !== "ongoing") {
        if (existing.stopReason !== null) {
          console.log(
            `[campaign-service] Not resuming campaign ${existing.id} for funded funnel ${f.funnelKey} — it stopped for ${existing.stopReason}`,
          );
          continue;
        }
        await db
          .update(campaigns)
          .set({ status: "ongoing", nextRunAt: now, updatedAt: now })
          .where(and(
            eq(campaigns.id, existing.id),
            eq(campaigns.orgId, seed.orgId),
            eq(campaigns.status, "stopped"),
            isNull(campaigns.stopReason),
          ));
      }
      continue;
    }

    // A workflow belongs to a FEATURE, so the seed's slug is only right for the seed's own
    // channel. Every other channel is asked for its own; a channel with no active workflow is not
    // provisioned, because a campaign with no DAG to run would sit ongoing and produce nothing.
    let workflowSlug: string | null = seed.workflowSlug;
    if (featureSlug !== seed.featureSlug) {
      if (!workflowByFeature.has(featureSlug)) {
        workflowByFeature.set(
          featureSlug,
          await fetchActiveWorkflowSlugForFeature(featureSlug, identity),
        );
      }
      const read = workflowByFeature.get(featureSlug)!;
      // "This channel has no dynasty yet" is a routine answer; "workflow-service would not tell
      // me" is a funded pair nobody evaluated. Same skip, different sentence, on purpose.
      if (!read.ok) {
        console.warn(
          `[campaign-service] Not provisioning ${featureSlug} for funnel ${f.funnelKey} (brand ${brandId}, org ${seed.orgId}) — could not READ workflow-service's active workflows for this channel: ${read.detail}`,
        );
        continue;
      }
      workflowSlug = read.workflowSlug;
    }
    if (!workflowSlug) {
      console.log(
        `[campaign-service] Not provisioning ${featureSlug} for funnel ${f.funnelKey} (brand ${brandId}) — workflow-service states no active workflow for that channel`,
      );
      continue;
    }

    // Deterministic name: uniq_campaigns_org_name is the only uniqueness Postgres can enforce
    // here (brand_ids is a text[], so no unique index can span it), which makes a duplicate
    // provision a constraint violation rather than a second campaign for the same pair. The name
    // already carries the channel, so two channels of one funnel never collide on it.
    const name = funnelCampaignName(featureSlug, brandId, f.funnelKey);

    try {
      await db.insert(campaigns).values({
        orgId: seed.orgId,
        createdByUserId: seed.createdByUserId,
        name,
        workflowSlug,
        brandIds: [brandId],
        ...campaignIdentityColumns({ brandIds: [brandId], featureSlug }),
        featureSlug,
        // The funnel says what this campaign sells, and it is the only word for it. `goal` is
        // NOT written any more: it could not tell the two meeting funnels apart, and a consumer
        // reading it reads a poorer statement of the same thing.
        funnelKey: f.funnelKey,
        // The offer whose declaration is what put this funnel in scope. Carried, never derived:
        // NULL when the funnel came from the brand-keyed read, which is the pre-offer world.
        offerId: offerId ?? null,
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

  // Reachable on every tick that provisions or confirms a funnel campaign, whatever branch each
  // pair took above. Fail-soft and a no-op on every ordinary tick.
  for (const channel of adoptFor) {
    await adoptFunnellessAncestorsSafely(
      { orgId: seed.orgId, brandId, acquisitionChannel: channel },
      now,
    );
  }
}

export function funnelCampaignName(featureSlug: string, brandId: string, funnelKey: string): string {
  return `${featureSlug} - ${brandId} - ${funnelKey}`;
}

/**
 * How often the platform asks "did anybody fund a funnel of a brand that has nothing running?"
 *
 * Its own cadence, like the resume sweep and for the same reason: the answer changes when a person
 * edits their funnels. This IS the latency between funding a funnel and its campaign existing.
 */
export const FUNDING_SWEEP_INTERVAL_MS = 10 * 60_000; // 10 min

/**
 * Most (org, brand) pairs examined in one sweep. Not a silent cap: going over it is logged with
 * the number left behind, and the sweep reads least-recently-touched first, so the remainder is
 * picked up next time rather than starved.
 */
export const FUNDING_SWEEP_MAX_BRANDS = 100;

let lastFundingSweepAt = 0;

/** Test seam: forget the throttle so a test can run consecutive sweeps. */
export function resetFundingSweepThrottle(): void {
  lastFundingSweepAt = 0;
}

/**
 * Provision the funded (funnel, channel) pairs of a brand nothing else will look at soon.
 *
 * `planFunnelTurns` provisions off the campaigns CLAIMED this tick, so it only ever reaches a brand
 * that has a campaign due right now. Two brands fall outside that, for opposite reasons, and both
 * are the same customer-visible failure — a funded channel with no campaign:
 *
 *   - a brand whose campaigns are ALL STOPPED is claimed by nobody, so nothing would look at it
 *     again ever (27 of the 44 brands with sales campaigns, the day this sweep was written);
 *   - a brand whose campaigns are all PARKED AT THEIR CEILING used to be deferred to the day
 *     rollover, so nothing looked at it again until midnight UTC while its funding stayed perfectly
 *     readable the whole time. That is how brand 75d7e3e8 funded a second acquisition channel at
 *     13:59 on 19 Aug and had no campaign for it nineteen hours later (issue #386) — too alive for
 *     a sweep that selected on "nothing ongoing", too quiet for the claim path. That defer is now
 *     bounded by FUNDING_RECHECK_MS, so such a brand is due within the sweep interval and the claim
 *     path reaches it first; this selection covers it either way, which is the point of selecting on
 *     WHEN it is next looked at rather than on which state parked it.
 *
 * So the selection is on WHEN the brand will next be looked at, not on whether it has something
 * running: a pair is examined here unless one of the brand's sales campaigns is in flight or due
 * within the sweep interval, in which case the claim path provisions it sooner than this would.
 * A brand actively working therefore still costs this sweep NOTHING — the read volume is one
 * billing read per QUIET brand per ten minutes, which is the same cadence and the same argument as
 * FUNDING_RECHECK_MS: money moves when a person edits it, hours or days apart.
 *
 * One campaign is stood up per pair the customer FUNDS and brand-service DECLARES; a brand that
 * funds nothing is read and left exactly as it is, which is what keeps every brand held today held.
 *
 * Fail-soft per brand: an unreadable brand is skipped, never provisioned on a guess.
 */
export async function provisionFundedPairsForQuietBrands(now: Date = new Date()): Promise<number> {
  if (now.getTime() - lastFundingSweepAt < FUNDING_SWEEP_INTERVAL_MS) return 0;
  lastFundingSweepAt = now.getTime();

  const slugs = [...SALES_FUNNEL_FEATURE_SLUGS];

  // A brand whose sales campaigns are in flight or due within the sweep interval is looked at by
  // the CLAIM path sooner than this sweep would look at it, so it is not examined here at all —
  // that is what keeps the read volume of an actively-working brand at zero.
  const dueSoon = new Date(now.getTime() + FUNDING_SWEEP_INTERVAL_MS);

  // One row per (org, brand) that has sales campaigns and none of them due soon — preferring an
  // ONGOING row as the seed (it carries the current owner, workflow and offer) and otherwise the
  // most recently touched. Done in SQL rather than by reading every sales campaign into memory:
  // the stopped population is large (682 rows today) and grows, while the answer is at most one
  // row per brand.
  const seeds = await db.execute<{
    id: string;
    org_id: string;
    brand_id: string;
    feature_slug: string;
    workflow_slug: string;
    created_by_user_id: string;
    offer_id: string | null;
    parent_run_id: string | null;
  }>(sql`
    SELECT DISTINCT ON (c.org_id, coalesce(c.brand_id, c.brand_ids[1]))
           c.id, c.org_id, coalesce(c.brand_id, c.brand_ids[1]) AS brand_id,
           c.feature_slug, c.workflow_slug, c.created_by_user_id, c.offer_id, c.parent_run_id
    FROM campaigns c
    WHERE c.feature_slug IN (${sql.join(slugs.map((s) => sql`${s}`), sql`, `)})
      AND coalesce(c.brand_id, c.brand_ids[1]) IS NOT NULL
      AND c.created_by_user_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM campaigns o
        WHERE o.org_id = c.org_id
          AND o.status = 'ongoing'
          AND o.feature_slug IN (${sql.join(slugs.map((s) => sql`${s}`), sql`, `)})
          AND coalesce(o.brand_id, o.brand_ids[1]) = coalesce(c.brand_id, c.brand_ids[1])
          -- In flight (next_run_at cleared at claim time) or due within the sweep interval: the
          -- claim path reaches this brand sooner than this sweep would, and provisioning there is
          -- the same code. A campaign parked past that horizon — at its ceiling until the day
          -- rollover, or held on the funding cadence — leaves the brand quiet, and quiet is
          -- exactly what this sweep is for.
          -- Bound as an ISO string, not a Date: this is a raw sql template, where postgres.js
          -- binds the parameter itself and refuses a Date outright.
          AND (o.next_run_at IS NULL OR o.next_run_at <= ${dueSoon.toISOString()}::timestamptz)
      )
    ORDER BY c.org_id, coalesce(c.brand_id, c.brand_ids[1]),
             (c.status = 'ongoing') DESC, c.updated_at DESC
    LIMIT ${FUNDING_SWEEP_MAX_BRANDS + 1}
  `);

  const rows = Array.from(seeds as unknown as Iterable<{
    id: string;
    org_id: string;
    brand_id: string;
    feature_slug: string;
    workflow_slug: string;
    created_by_user_id: string;
    offer_id: string | null;
    parent_run_id: string | null;
  }>);
  const examined = rows.slice(0, FUNDING_SWEEP_MAX_BRANDS);
  if (rows.length > FUNDING_SWEEP_MAX_BRANDS) {
    console.log(
      `[campaign-service] Funding sweep examining ${examined.length} of ${rows.length}+ quiet brands — the rest are examined on the next sweep (least recently touched first)`,
    );
  }

  let provisioned = 0;
  for (const row of examined) {
    try {
      const seed: ClaimedFunnelCampaign = {
        id: row.id,
        orgId: row.org_id,
        createdByUserId: row.created_by_user_id,
        parentRunId: row.parent_run_id,
        workflowSlug: row.workflow_slug,
        brandIds: [row.brand_id],
        featureSlug: row.feature_slug,
        funnelKey: null,
        dailyBudgetCents: null,
        offerId: row.offer_id,
      };

      const identity: IdentityHeaders = {
        orgId: row.org_id,
        userId: row.created_by_user_id,
        campaignId: row.id,
        brandId: row.brand_id,
        workflowSlug: row.workflow_slug,
      };

      const budgets = await fetchFunnelBudgets(row.brand_id, identity);
      if (!budgets.ok) continue;
      const funded = fundedPairs(budgets, row.feature_slug);
      // The expected state for most brands on most sweeps: still funding nothing. Not logged — it
      // fires for every idle brand of every client on every sweep, and it is already observable in
      // the brand having no ongoing campaign.
      if (funded.length === 0) continue;

      // Same identity discipline as the tick: the two channel reads are refused without a run id,
      // and this sweep's seed carries one no more than a claimed row does.
      const provisioning = await buildProvisioningIdentity(seed, row.brand_id);
      if (!provisioning) continue;

      // Asked over every offer the brand's sales campaigns state, not just the seed's: a brand
      // selling several offers has one campaign per offer, and a funnel declared by the offer the
      // seed does NOT sell would otherwise read as "nobody declares selling through it" and be
      // passed over in silence. The seed's own offer is always in the set.
      const declared = await resolveDeclaredFunnels(
        await offerStatingCampaigns(row.org_id, row.brand_id, row.offer_id),
        row.brand_id,
        provisioning,
      );
      const before = await countOngoingSalesCampaigns(row.org_id, row.brand_id);
      await ensureFundedFunnelCampaigns({
        seed,
        brandId: row.brand_id,
        funded,
        declared,
        identity: provisioning,
        now,
      });
      const after = await countOngoingSalesCampaigns(row.org_id, row.brand_id);
      if (after > before) {
        provisioned += after - before;
        console.log(
          `[campaign-service] Funding brought back brand ${row.brand_id} (org ${row.org_id}): ${after - before} campaign(s) now ongoing for its funded funnels`,
        );
      }
    } catch (err) {
      console.warn(`[campaign-service] Funding sweep failed for brand ${row.brand_id}:`, err);
    }
  }

  return provisioned;
}

/**
 * The offers this (org, brand)'s sales campaigns state, as the group `resolveDeclaredFunnels`
 * takes. Every status is read, not just `ongoing`: the brand this sweep exists for may have
 * nothing ongoing at all, and its stopped campaigns are what say which offers it sells.
 */
async function offerStatingCampaigns(
  orgId: string,
  brandId: string,
  seedOfferId: string | null,
): Promise<Array<{ offerId: string | null }>> {
  const rows = await db.query.campaigns.findMany({
    where: and(
      eq(campaigns.orgId, orgId),
      inArray(campaigns.featureSlug, [...SALES_FUNNEL_FEATURE_SLUGS]),
      arrayContains(campaigns.brandIds, [brandId]),
    ),
    columns: { offerId: true },
  });
  const group = rows.map((r) => ({ offerId: r.offerId }));
  return group.length > 0 ? group : [{ offerId: seedOfferId }];
}

/** How many ongoing sales campaigns this (org, brand) holds — the sweep's before/after. */
async function countOngoingSalesCampaigns(orgId: string, brandId: string): Promise<number> {
  const rows = await db.query.campaigns.findMany({
    where: and(
      eq(campaigns.orgId, orgId),
      eq(campaigns.status, "ongoing"),
      inArray(campaigns.featureSlug, [...SALES_FUNNEL_FEATURE_SLUGS]),
      arrayContains(campaigns.brandIds, [brandId]),
    ),
    columns: { id: true },
  });
  return rows.length;
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
async function hasLiveRunForBrandCohort(
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
