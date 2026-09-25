import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  fetchFunnelBudgets,
  legCeilingCents,
  offerLegCeilingCents,
  type FunnelBudgetsRead,
  type FunnelLegBudget,
} from "../../src/lib/funnel-budget-client.js";
import { brandHeldFromBudgets, fundingFromBudgets } from "../../src/lib/campaign-funding.js";
import { computeSpendableBudget } from "../../src/lib/spendable-budget.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const SALES = "sales-cold-email-outreach";
const FEEDBACK = "feedback-request-cold-email-outreach";
const OFFER_A = "d5ecba00-783a-4939-b5bd-f85b9e6b7d9e";
const OFFER_B = "8f1e2c44-6a10-4d3b-9c77-1b2a3c4d5e6f";
const LEG = "start_to_website_visit";
const OTHER_LEG = "start_to_conversation";

function readWith(legs: FunnelLegBudget[], brand: number | null = null): Extract<FunnelBudgetsRead, { ok: true }> {
  return { ok: true, brandDailyBudgetCents: brand, funnels: [], channels: [], offers: [], legs };
}

const row = (over: Partial<FunnelLegBudget>): FunnelLegBudget => ({
  funnelKey: "website_purchases",
  featureSlug: SALES,
  offerId: OFFER_A,
  legKey: LEG,
  dailyBudgetCents: 1000,
  ...over,
});

describe("offerLegCeilingCents — a campaign identified by (offer, leg, channel)", () => {
  it("answers none for a campaign that states no leg", () => {
    expect(offerLegCeilingCents(readWith([row({})]), SALES, OFFER_A, null)).toEqual({ grain: "none" });
  });

  it("answers none when the brand's money names no leg at all (the brand pot keeps pacing it)", () => {
    expect(offerLegCeilingCents(readWith([row({ legKey: null })]), SALES, OFFER_A, LEG)).toEqual({ grain: "none" });
  });

  it("prefers billing's own funnel-less (offer, leg, channel) row", () => {
    const read = readWith([row({ funnelKey: null, dailyBudgetCents: 700 }), row({ dailyBudgetCents: 1000 })]);
    expect(offerLegCeilingCents(read, SALES, OFFER_A, LEG)).toEqual({ grain: "offer_leg", cents: 700 });
  });

  it("until billing serves that grain, sums the leg across the funnels it was funded under", () => {
    const read = readWith([
      row({ funnelKey: "website_purchases", dailyBudgetCents: 1000 }),
      row({ funnelKey: "sales_meetings_from_website", dailyBudgetCents: 500 }),
      row({ legKey: OTHER_LEG, dailyBudgetCents: 9999 }),
      row({ featureSlug: FEEDBACK, dailyBudgetCents: 9999 }),
      row({ offerId: OFFER_B, dailyBudgetCents: 9999 }),
    ]);
    expect(offerLegCeilingCents(read, SALES, OFFER_A, LEG)).toEqual({ grain: "offer_leg", cents: 1500 });
  });

  it("is unfunded — never a coarser figure — when the brand funds legs and none is this one", () => {
    const read = readWith([row({ legKey: OTHER_LEG })], 5000);
    expect(offerLegCeilingCents(read, SALES, OFFER_A, LEG)).toEqual({ grain: "offer_leg", cents: null });
  });

  it("matches the channel exactly", () => {
    expect(offerLegCeilingCents(readWith([row({})]), FEEDBACK, OFFER_A, LEG)).toEqual({ grain: "offer_leg", cents: null });
  });

  it("an unscoped leg row counts only for the brand's sole named offer (billing's rule)", () => {
    const sole = readWith([row({ offerId: null, dailyBudgetCents: 300 }), row({ legKey: OTHER_LEG })]);
    expect(offerLegCeilingCents(sole, SALES, OFFER_A, LEG)).toEqual({ grain: "offer_leg", cents: 300 });
    const split = readWith([row({ offerId: null }), row({ offerId: OFFER_B, legKey: OTHER_LEG })]);
    expect(offerLegCeilingCents(split, SALES, OFFER_A, LEG)).toEqual({ grain: "offer_leg", cents: null });
  });

  it("a funnel-keyed campaign never reads a funnel-less row (its precedence is unchanged)", () => {
    const read = readWith([row({ funnelKey: null, dailyBudgetCents: 700 })]);
    expect(legCeilingCents(read, "website_purchases", SALES, OFFER_A, LEG)).toEqual({ grain: "none" });
  });
});

describe("fundingFromBudgets — funnel-less campaign", () => {
  const campaign = { funnelKey: null, featureSlug: SALES, offerId: OFFER_A, legKey: LEG };

  it("is funded on its leg's own money", () => {
    expect(fundingFromBudgets(campaign, readWith([row({ dailyBudgetCents: 1200 })], 99999)))
      .toEqual({ funded: true, ceilingCents: 1200 });
  });

  it("is held when the brand funds other legs only", () => {
    const v = fundingFromBudgets(campaign, readWith([row({ legKey: OTHER_LEG })], 99999));
    expect(v.funded).toBe(false);
  });

  it("falls back to the brand pot when no money names a leg", () => {
    expect(fundingFromBudgets(campaign, readWith([], 400))).toEqual({ funded: true, ceilingCents: 400 });
  });

  it("a brand funding only funnel-less money is not held", () => {
    expect(brandHeldFromBudgets(readWith([row({ funnelKey: null })]))).toBe(false);
  });
});

describe("fetchFunnelBudgets — a ceiling stated with no funnel", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    process.env.BILLING_SERVICE_URL = "https://billing.test.local";
    process.env.BILLING_SERVICE_API_KEY = "k";
  });

  function answer(payload: unknown) {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => payload });
    return fetchFunnelBudgets("brand-1", { orgId: "org-1" });
  }

  it("carries a funnel-less leg row, and drops funnel-less rows from the funnel grains instead of refusing the read", async () => {
    const read = await answer({
      dailyBudgetCents: "1500",
      funnels: [{ funnelKey: "website_purchases", dailyBudgetCents: "1000" }, { funnelKey: null, dailyBudgetCents: "500" }],
      channels: [{ funnelKey: null, featureSlug: SALES, dailyBudgetCents: "500" }],
      offers: [{ funnelKey: null, featureSlug: SALES, offerId: OFFER_A, dailyBudgetCents: "500" }],
      legs: [
        { funnelKey: "website_purchases", featureSlug: SALES, offerId: OFFER_A, legKey: LEG, dailyBudgetCents: "1000" },
        { funnelKey: null, featureSlug: SALES, offerId: OFFER_A, legKey: OTHER_LEG, dailyBudgetCents: "500" },
      ],
    });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.funnels).toHaveLength(1);
    expect(read.channels).toHaveLength(0);
    expect(read.offers).toHaveLength(0);
    expect(read.legs).toEqual([
      { funnelKey: "website_purchases", featureSlug: SALES, offerId: OFFER_A, legKey: LEG, dailyBudgetCents: 1000 },
      { funnelKey: null, featureSlug: SALES, offerId: OFFER_A, legKey: OTHER_LEG, dailyBudgetCents: 500 },
    ]);
  });

  it("refuses a leg row that states neither a funnel nor a leg", async () => {
    const read = await answer({
      dailyBudgetCents: null,
      funnels: [],
      legs: [{ funnelKey: null, featureSlug: SALES, offerId: OFFER_A, legKey: null, dailyBudgetCents: "500" }],
    });
    expect(read.ok).toBe(false);
  });
});

describe("computeSpendableBudget — agrees with what the gate paces a funnel-less campaign on", () => {
  it("attributes the leg's money to the funnel-less campaign doing that leg", () => {
    const now = new Date();
    const result = computeSpendableBudget("org", "brand", readWith([row({ dailyBudgetCents: 1000 })]), [
      { id: "c1", status: "ongoing", funnelKey: null, featureSlug: SALES, offerId: OFFER_A, legKey: LEG, createdAt: now },
    ]);
    expect(result.runningDailyBudgetCents).toBe(1000);
    expect(result.rows[0]!.campaignId).toBe("c1");
  });
});
