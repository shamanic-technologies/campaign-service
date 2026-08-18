import type { IdentityHeaders } from "@distribute/runs-client";
import { channelCeilingCents, fetchFunnelBudgets, type FunnelBudgetsRead } from "./funnel-budget-client.js";
import { toFunnelKey } from "./sales-funnel-vocabulary.js";

/**
 * THE definition of "is this campaign funded" — the ONE place the platform answers it.
 *
 * A campaign is eligible to run when the customer's money says so, and nowhere else. There used
 * to be a second answer: `brand_pause.paused`, a brand-wide flag this service stored and the
 * scheduler joined against. The customer surface that wrote it was deleted months ago (a customer
 * stops a chain by dropping its ceiling to zero), so it became a source of truth nobody could
 * change: 27 brands sat stored-paused, 10 of them funded, holding 11 ongoing campaigns that could
 * never be claimed and had no API path back. Two representations of one fact is what produced
 * that, so there is one now, and it is billing's.
 *
 * The precedence is gate-check's, exactly — the campaign's OWN daily budget, else its own (funnel,
 * acquisition channel) pair's ceiling, else its funnel's ceiling, else the brand's daily budget —
 * because a campaign the gate would refuse to let spend must not be handed a turn, and a campaign
 * the gate WOULD let spend must not be held.
 *
 * A ceiling that was never stated is NOT "unbounded", it is "unfunded". That is the one place
 * this differs from what the gate used to do: `brandDailyBudgetBlock` read a null brand budget as
 * "no cap this tick" and let the campaign run, which is how two brands funding nothing at all
 * kept sending against no ceiling. Funding is what makes a campaign eligible; the absence of
 * funding cannot be the thing that removes the limit.
 */
export type FundingVerdict =
  | { funded: true; ceilingCents: number }
  | { funded: false; reason: string };

/**
 * Decide from ceilings ALREADY read, so a caller holding one read for a brand can judge every
 * campaign of that brand without asking billing again per campaign.
 */
export function fundingFromBudgets(
  campaign: {
    dailyBudgetCents?: number | null;
    funnelKey?: string | null;
    /** The acquisition CHANNEL this campaign works its funnel through — a feature slug. */
    featureSlug?: string | null;
  },
  budgets: Extract<FunnelBudgetsRead, { ok: true }>,
): FundingVerdict {
  // The campaign's own figure is a MIRROR of its funnel's ceiling (gate-check is the first node
  // of every run and cannot read billing hot), so when it is stated it is the answer.
  if (campaign.dailyBudgetCents !== null && campaign.dailyBudgetCents !== undefined) {
    return campaign.dailyBudgetCents > 0
      ? { funded: true, ceilingCents: campaign.dailyBudgetCents }
      : { funded: false, reason: "its own daily budget is zero" };
  }

  if (campaign.funnelKey && budgets.funnels.length > 0) {
    // Both sides canonicalised — billing still emits the pre-rename spellings, so comparing raw
    // tokens would read a fully funded funnel as unfunded and hold a campaign the customer pays
    // for.
    const funnelKey = toFunnelKey(campaign.funnelKey);

    // The ceiling that binds THIS campaign is its own (funnel, channel) pair's, whenever billing
    // states one: a funnel worked through two offers funds each separately, and holding both
    // against the funnel TOTAL would let one spend the other's money. A funnel billing states no
    // pair for falls through to the funnel figure below — that is every brand funding one channel
    // per funnel, unchanged.
    if (funnelKey) {
      const pair = channelCeilingCents(budgets, funnelKey, campaign.featureSlug);
      if (pair.grain === "pair") {
        if (pair.cents === null) {
          return {
            funded: false,
            reason: `funnel ${campaign.funnelKey} is not funded for channel ${campaign.featureSlug ?? "none"}`,
          };
        }
        return pair.cents > 0
          ? { funded: true, ceilingCents: pair.cents }
          : {
              funded: false,
              reason: `funnel ${campaign.funnelKey} is funded at zero for channel ${campaign.featureSlug ?? "none"}`,
            };
      }
    }

    const ceilingCents = funnelKey
      ? budgets.funnels.find((f) => f.funnelKey === funnelKey)?.dailyBudgetCents ?? null
      : null;
    if (ceilingCents === null) return { funded: false, reason: `funnel ${campaign.funnelKey} is not funded` };
    return ceilingCents > 0
      ? { funded: true, ceilingCents }
      : { funded: false, reason: `funnel ${campaign.funnelKey} is funded at zero` };
  }

  // A brand with ONE pot — and a funnel campaign of a brand billing reports no per-funnel
  // ceilings for, which paces on that same pot. Stamping the funnel fleet-wide must not turn a
  // brand that never split its budget into an unfunded one.
  const brandCents = budgets.brandDailyBudgetCents;
  if (brandCents === null) return { funded: false, reason: "the brand has no daily budget set" };
  return brandCents > 0
    ? { funded: true, ceilingCents: brandCents }
    : { funded: false, reason: "the brand's daily budget is zero" };
}

/**
 * Read the ceilings and decide, for ONE campaign.
 *
 * Fail-CLOSED: billing not answering leaves the campaign held. That is the same stance the gate
 * takes on the same read ("Funnel daily budget unavailable"), so firing a run during a billing
 * outage could only burn a run that the gate is about to refuse anyway.
 */
export async function campaignFunding(
  campaign: {
    dailyBudgetCents?: number | null;
    funnelKey?: string | null;
    featureSlug?: string | null;
  },
  brandId: string,
  identity: IdentityHeaders,
): Promise<FundingVerdict> {
  // Answerable without billing: an own ceiling is the mirror, and a zero one is a decision.
  if (campaign.dailyBudgetCents !== null && campaign.dailyBudgetCents !== undefined) {
    return campaign.dailyBudgetCents > 0
      ? { funded: true, ceilingCents: campaign.dailyBudgetCents }
      : { funded: false, reason: "its own daily budget is zero" };
  }

  const budgets = await fetchFunnelBudgets(brandId, identity);
  if (!budgets.ok) return { funded: false, reason: "billing did not answer the brand's budget" };
  return fundingFromBudgets(campaign, budgets);
}

/**
 * Is this brand HELD — i.e. is there nothing the customer funds for it?
 *
 * This is what `GET /brands/:brandId/pause` now answers. A brand is held when no sales funnel of
 * it carries a positive ceiling AND its brand-level pot is not positive either. Funding any one
 * funnel releases it, with no other step.
 */
export function brandHeldFromBudgets(budgets: Extract<FunnelBudgetsRead, { ok: true }>): boolean {
  if (budgets.funnels.some((f) => f.dailyBudgetCents > 0)) return false;
  return !(budgets.brandDailyBudgetCents !== null && budgets.brandDailyBudgetCents > 0);
}
