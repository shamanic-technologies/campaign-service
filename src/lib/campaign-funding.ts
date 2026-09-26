import type { IdentityHeaders } from "@distribute/runs-client";
import {
  campaignCeilingCents,
  fetchCampaignBudgets,
  type CampaignBudgetsRead,
} from "./campaign-budget-client.js";

/**
 * THE definition of "is this campaign funded" — the ONE place the platform answers it.
 *
 * A campaign is eligible to run when the customer's money says so, and nowhere else. billing
 * states that money per campaign — (offer x leg x acquisition channel) — and this reads it.
 *
 * The precedence is gate-check's, exactly — the campaign's OWN daily budget, else its own
 * (offer, leg, channel) ceiling, else (a brand whose money is not split per campaign at all) the
 * brand's pot — because a campaign the gate would refuse to let spend must not be handed a turn,
 * and a campaign the gate WOULD let spend must not be held.
 *
 * A ceiling that was never stated is NOT "unbounded", it is "unfunded". Funding is what makes a
 * campaign eligible; the absence of funding cannot be the thing that removes the limit.
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
    /** The acquisition CHANNEL this campaign works — a feature slug. */
    featureSlug?: string | null;
    /** The OFFER this campaign sells — brand-service's id, carried and never derived. */
    offerId?: string | null;
    /** The single LEG this campaign was bought for — features-service's id, carried and never derived. */
    legKey?: string | null;
  },
  budgets: Extract<CampaignBudgetsRead, { ok: true }>,
): FundingVerdict {
  // The campaign's own figure, when stated, is the answer (gate-check is the first node of every
  // run and reads the same column).
  if (campaign.dailyBudgetCents !== null && campaign.dailyBudgetCents !== undefined) {
    return campaign.dailyBudgetCents > 0
      ? { funded: true, ceilingCents: campaign.dailyBudgetCents }
      : { funded: false, reason: "its own daily budget is zero" };
  }

  const ceiling = campaignCeilingCents(budgets, campaign);
  if (ceiling.grain === "brand") {
    if (ceiling.cents === null) return { funded: false, reason: "the brand has no daily budget set" };
    return ceiling.cents > 0
      ? { funded: true, ceilingCents: ceiling.cents }
      : { funded: false, reason: "the brand's daily budget is zero" };
  }

  const scope =
    `offer ${campaign.offerId ?? "none"}, leg ${campaign.legKey ?? "none"}, channel ${campaign.featureSlug ?? "none"}`;
  if (ceiling.cents === null) return { funded: false, reason: `campaign (${scope}) is not funded` };
  return ceiling.cents > 0
    ? { funded: true, ceilingCents: ceiling.cents }
    : { funded: false, reason: `campaign (${scope}) is funded at zero` };
}

/**
 * Read the ceilings and decide, for ONE campaign.
 *
 * Fail-CLOSED: billing not answering leaves the campaign held. That is the same stance the gate
 * takes on the same read, so firing a run during a billing outage could only burn a run that the
 * gate is about to refuse anyway.
 */
export async function campaignFunding(
  campaign: {
    dailyBudgetCents?: number | null;
    featureSlug?: string | null;
    offerId?: string | null;
    legKey?: string | null;
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

  const budgets = await fetchCampaignBudgets(brandId, identity);
  if (!budgets.ok) return { funded: false, reason: "billing did not answer the brand's budget" };
  return fundingFromBudgets(campaign, budgets);
}

/**
 * Is this brand HELD — i.e. is there nothing the customer funds for it?
 *
 * This is what `GET /brands/:brandId/pause` answers. A brand is held when no campaign ceiling of it
 * is positive AND its brand-level pot is not positive either. Funding any one campaign releases it.
 */
export function brandHeldFromBudgets(budgets: Extract<CampaignBudgetsRead, { ok: true }>): boolean {
  if (budgets.campaigns.some((e) => e.dailyBudgetCents > 0)) return false;
  return !(budgets.brandDailyBudgetCents !== null && budgets.brandDailyBudgetCents > 0);
}
