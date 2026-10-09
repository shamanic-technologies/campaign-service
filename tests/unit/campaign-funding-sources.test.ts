import { describe, it, expect } from "vitest";
import { fundingFromBudgets } from "../../src/lib/campaign-funding.js";
import type { CampaignBudgetEntry, CampaignBudgetsRead } from "../../src/lib/campaign-budget-client.js";

const OFFER = "offer-1";
const OUTREACH = { featureSlug: "sales-cold-email-outreach", offerId: OFFER, legKey: "lead_found_to_website_visit" };

function read(campaigns: CampaignBudgetEntry[]): Extract<CampaignBudgetsRead, { ok: true }> {
  return { ok: true, brandDailyBudgetCents: campaigns.reduce((s, e) => s + e.dailyBudgetCents, 0), campaigns };
}

const VISIT: CampaignBudgetEntry = { offerId: OFFER, legKey: "lead_found_to_website_visit", featureSlug: "sales-cold-email-outreach", dailyBudgetCents: 300 };
const COLD: CampaignBudgetEntry = { offerId: OFFER, legKey: "start_to_lead_found", featureSlug: "sourcing-apollo-cold-filters", dailyBudgetCents: 1700 };

describe("fundingFromBudgets with feeding lead sources (turn planner pace)", () => {
  it("paces the outreach campaign on its own ceiling plus each ongoing source's", () => {
    expect(fundingFromBudgets(OUTREACH, read([VISIT, COLD]), [
      { featureSlug: "sourcing-apollo-cold-filters", status: "ongoing" },
    ])).toEqual({ funded: true, ceilingCents: 2000 });
  });

  it("is unchanged without sources (every other caller)", () => {
    expect(fundingFromBudgets(OUTREACH, read([VISIT, COLD]))).toEqual({ funded: true, ceilingCents: 300 });
  });

  it("a stopped source adds nothing", () => {
    expect(fundingFromBudgets(OUTREACH, read([VISIT, COLD]), [
      { featureSlug: "sourcing-apollo-cold-filters", status: "stopped" },
    ])).toEqual({ funded: true, ceilingCents: 300 });
  });

  it("source money never funds an outreach campaign with no ceiling of its own", () => {
    const verdict = fundingFromBudgets(OUTREACH, read([COLD]), [
      { featureSlug: "sourcing-apollo-cold-filters", status: "ongoing" },
    ]);
    expect(verdict.funded).toBe(false);
  });
});
