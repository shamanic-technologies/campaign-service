import { and, arrayContains, eq } from "drizzle-orm";
import { listRuns } from "@distribute/runs-client";
import { db } from "../db/index.js";
import { campaigns } from "../db/schema.js";
import { isOutboundSalesFeature, isSalesFamilyFeature } from "./sales-outreach-campaign.js";
import { acquisitionChannelForFeature } from "./campaign-identity.js";
import { salesFunnelUnitMoney, salesFunnelUnitRef } from "./sales-funnel-campaigns.js";
import { reportTurnHolds, type TurnHold } from "./turn-hold-event.js";

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
  /** The offer this campaign sells — brand-service's id, carried and never derived. */
  offerId?: string | null;
  /** The single LEG this campaign was bought for — features-service's identifier, never derived. */
  legKey?: string | null;
  /** Set on a SALES FUNNEL unit (lib/sales-funnel-campaigns.ts): its money is its funnel's caps. */
  salesFunnelCampaignId?: string | null;
  salesFunnelId?: string | null;
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
 * Per brand cohort, in this order:
 *   0. Hold — a SALES FUNNEL unit its funnel does not fund (or whose caps are reached / unreadable)
 *      does not run; a sales campaign that is NOT a unit has no money at all (owner 2026-10-14, one
 *      money model) and is held by name. Fail-CLOSED.
 *   1. Serialize — at most ONE run in flight per brand COHORT (see hasLiveRunForBrandCohort): the
 *      outbound cold-email channels share leads and sending accounts; every other channel is its own.
 *   2. Rank — the funded unit with the lowest consumed / max budget takes the turn.
 *
 * Turn-taking is fail-SOFT (it only reorders work already allowed); the HOLD is fail-CLOSED, and
 * so is the funnel's caps check in gate-check, which is where spend control belongs.
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

  // Funded SALES FUNNEL units, per (org, brand), on the cohort rule (one run in flight per brand cohort), ranked on their funnel's consumed / max budget.
  const unitGroups = new Map<string, Array<{ campaign: ClaimedSalesCampaign; candidate: TurnCandidate }>>();
  for (const c of claimed) {
    // A SALES FUNNEL unit is planned whatever its channel's family: its money is its funnel's caps
    // (a LinkedIn Posting pipe is a funnel pipe like any other, campaign-service #608).
    if (!isSalesFamilyFeature(c.featureSlug) && !c.salesFunnelCampaignId) continue;
    // A SALES FUNNEL unit's money is its funnel's caps (lib/sales-funnel-campaigns.ts): a unit its
    // funnel does not fund is held here, on the funding cadence.
    if (c.salesFunnelCampaignId) {
      try {
        const verdict = await salesFunnelUnitMoney(salesFunnelUnitRef(c), now);
        if (!verdict.run) {
          deferred.set(c.id, verdict.nextRunAt);
          holds.push({
            campaign: c,
            reason: verdict.kind === "cap_reached" ? "daily_ceiling_reached" : verdict.kind === "unreadable" ? "budgets_unreadable" : "unfunded",
            detail: verdict.detail,
            nextRunAt: verdict.nextRunAt,
          });
          continue;
        }
        const key = `${c.orgId}::${c.brandIds?.[0] ?? ""}`;
        const bucket = unitGroups.get(key) ?? [];
        bucket.push({ campaign: c, candidate: { campaignId: c.id, legKey: c.legKey ?? "", ...verdict.pace } });
        unitGroups.set(key, bucket);
      } catch (err) {
        const heldAt = new Date(now.getTime() + FUNDING_RECHECK_MS);
        deferred.set(c.id, heldAt);
        holds.push({ campaign: c, reason: "planning_failed", detail: `Campaign not run — its sales funnel's money could not be judged: ${err instanceof Error ? err.message : String(err)}`, nextRunAt: heldAt });
      }
      continue;
    }
    // ONE money model (owner 2026-10-14): a sales campaign that is not a sales funnel unit has no
    // money (the per-campaign ceilings, its own daily budget, items and the global pot are retired).
    // Held on the funding cadence by name, never run; the gate refuses it the same way.
    const heldAt = new Date(now.getTime() + FUNDING_RECHECK_MS);
    deferred.set(c.id, heldAt);
    holds.push({
      campaign: c,
      reason: "not_a_sales_funnel_campaign",
      detail: `Campaign not run — it is not part of a sales funnel campaign, and a campaign's money is its sales funnel's caps only. Start it as a sales funnel campaign; re-checked at ${heldAt.toISOString()}.`,
      nextRunAt: heldAt,
    });
  }

  for (const [key, members] of unitGroups) {
    try {
      await planSalesFunnelUnits(members, now, deferred, holds);
    } catch (err) {
      console.warn(`[campaign-service] turn planning failed for sales funnel units of ${key} — holding them:`, err);
      const heldAt = new Date(now.getTime() + FUNDING_RECHECK_MS);
      for (const { campaign } of members) {
        deferred.set(campaign.id, heldAt);
        holds.push({ campaign, reason: "planning_failed", detail: `Campaign not run — turn planning failed: ${err instanceof Error ? err.message : String(err)}`, nextRunAt: heldAt });
      }
    }
  }

  // Fail-SOFT and AFTER the planning: the holds are a statement about decisions already made, so
  // an unreportable one must never change whether a campaign runs.
  await reportTurnHolds(holds);

  return deferred;
}

/**
 * The funded SALES FUNNEL units of one (org, brand): same cohort serialization as every sales
 * campaign (at most one run in flight per brand cohort), the turn to the lowest consumed / max
 * budget (a reactive pipe ranks first).
 */
async function planSalesFunnelUnits(
  members: Array<{ campaign: ClaimedSalesCampaign; candidate: TurnCandidate }>,
  now: Date,
  deferred: Map<string, Date>,
  holds: TurnHold[],
): Promise<void> {
  const orgId = members[0].campaign.orgId;
  const brandId = members[0].campaign.brandIds?.[0];
  if (!brandId) return;
  const byId = new Map(members.map((m) => [m.campaign.id, m.campaign]));
  const cohorts = new Map<string, TurnCandidate[]>();
  for (const { campaign, candidate } of members) {
    const cohort = serializationCohort(campaign.featureSlug);
    cohorts.set(cohort, [...(cohorts.get(cohort) ?? []), candidate]);
  }
  for (const [cohort, candidates] of cohorts) {
    await planOneCohort(orgId, brandId, cohort, candidates, byId, now, deferred, holds);
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
  candidates: TurnCandidate[],
  byId: Map<string, ClaimedSalesCampaign>,
  now: Date,
  deferred: Map<string, Date>,
  holds: TurnHold[],
): Promise<void> {
  if (await hasLiveRunForBrandCohort(orgId, brandId, cohort, now)) {
    for (const c of candidates) {
      deferred.set(c.campaignId, new Date(now.getTime() + TURN_DEFER_MS));
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
    columns: { id: true, featureSlug: true, salesFunnelCampaignId: true },
  });

  const startedAfter = new Date(now.getTime() - LIVE_RUN_FRESHNESS_MS).toISOString();
  for (const c of alive) {
    if (!isSalesFamilyFeature(c.featureSlug) && !c.salesFunnelCampaignId) continue;
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

function nextDayStart(now: Date): Date {
  const d = new Date(now.getTime());
  d.setDate(d.getDate() + 1);
  d.setHours(0, 0, 0, 0);
  return d;
}
