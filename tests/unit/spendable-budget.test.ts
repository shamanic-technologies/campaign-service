import { describe, it, expect } from "vitest";
import { computeSpendableBudget, type SpendableCampaign } from "../../src/lib/spendable-budget.js";
import type { CampaignBudgetEntry, CampaignBudgetsRead } from "../../src/lib/campaign-budget-client.js";

const ORG = "org-1";
const BRAND = "brand-1";
const SALES = "sales-cold-email-outreach";
const BOOKING = "ai-meeting-booking";
const ENTRY_LEG = "start_to_conversation";
const VISIT_LEG = "start_to_website_visit";

function budgets(
  campaigns: CampaignBudgetEntry[],
  brandDailyBudgetCents: number | null = campaigns.reduce((s, e) => s + e.dailyBudgetCents, 0),
): Extract<CampaignBudgetsRead, { ok: true }> {
  return { ok: true, brandDailyBudgetCents, campaigns };
}

function entry(over: Partial<CampaignBudgetEntry>): CampaignBudgetEntry {
  return { offerId: "offer-1", legKey: ENTRY_LEG, featureSlug: SALES, dailyBudgetCents: 1000, ...over };
}

function campaign(over: Partial<SpendableCampaign> & { id: string }): SpendableCampaign {
  return {
    status: "ongoing",
    featureSlug: SALES,
    offerId: "offer-1",
    legKey: ENTRY_LEG,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...over,
  };
}

describe("computeSpendableBudget", () => {
  it("reports a running figure of ZERO and a non-zero configured figure when a funded ceiling has no campaign", () => {
    const result = computeSpendableBudget(ORG, BRAND, budgets([entry({ dailyBudgetCents: 5000 })]), []);

    expect(result.grain).toBe("campaign");
    expect(result.configuredDailyBudgetCents).toBe(5000);
    expect(result.runningDailyBudgetCents).toBe(0);
    expect(result.rows[0]).toMatchObject({ running: false, campaignId: null });
  });

  it("excludes ONLY the stopped campaign when several are funded", () => {
    const result = computeSpendableBudget(
      ORG,
      BRAND,
      budgets([entry({ dailyBudgetCents: 4000 }), entry({ legKey: VISIT_LEG, dailyBudgetCents: 5000 })]),
      [
        campaign({ id: "live" }),
        campaign({ id: "stopped", legKey: VISIT_LEG, status: "stopped" }),
      ],
    );

    expect(result.configuredDailyBudgetCents).toBe(9000);
    expect(result.runningDailyBudgetCents).toBe(4000);
    const stopped = result.campaigns.find((c) => c.campaignId === "stopped");
    expect(stopped).toMatchObject({ running: false, configuredDailyBudgetCents: 5000, runningDailyBudgetCents: 0 });
  });

  it("attributes a leg-less ceiling to the campaign billing's rule gives it (no other leg on the channel)", () => {
    const result = computeSpendableBudget(
      ORG,
      BRAND,
      budgets([
        entry({ legKey: null, featureSlug: BOOKING, dailyBudgetCents: 100 }),
        entry({ offerId: "offer-2", legKey: VISIT_LEG, dailyBudgetCents: 300 }),
      ]),
      [
        campaign({ id: "booking", featureSlug: BOOKING, legKey: "conversation_to_meeting_booked" }),
        campaign({ id: "visit", offerId: "offer-2", legKey: VISIT_LEG }),
      ],
    );

    expect(result.runningDailyBudgetCents).toBe(400);
    expect(result.campaigns.find((c) => c.campaignId === "booking")?.runningDailyBudgetCents).toBe(100);
  });

  it("files a pre-offer ceiling under the offer of the campaign that spends it", () => {
    const result = computeSpendableBudget(
      ORG,
      BRAND,
      budgets([entry({ offerId: null, dailyBudgetCents: 700 })]),
      [campaign({ id: "live" })],
    );
    expect(result.rows[0]).toMatchObject({ offerId: null, resolvedOfferId: "offer-1", running: true });
    expect(result.offers).toEqual([
      { offerId: "offer-1", configuredDailyBudgetCents: 700, runningDailyBudgetCents: 700, campaignIds: ["live"] },
    ]);
  });

  it("an ongoing campaign wins the ceiling over a stopped twin, whatever their creation dates", () => {
    const result = computeSpendableBudget(
      ORG,
      BRAND,
      budgets([entry({})]),
      [
        campaign({ id: "old-stopped", status: "stopped", createdAt: new Date("2026-01-01T00:00:00Z") }),
        campaign({ id: "live", createdAt: new Date("2026-06-01T00:00:00Z") }),
      ],
    );
    expect(result.rows[0].campaignId).toBe("live");
  });

  it("names an ongoing campaign funded at nothing rather than hiding it", () => {
    const result = computeSpendableBudget(ORG, BRAND, budgets([entry({ legKey: VISIT_LEG })]), [
      campaign({ id: "unfunded" }),
    ]);
    expect(result.campaigns).toContainEqual(
      expect.objectContaining({ campaignId: "unfunded", configuredDailyBudgetCents: 0, running: true }),
    );
  });

  it("a brand with one pot counts it once, drawn on by every campaign", () => {
    const result = computeSpendableBudget(ORG, BRAND, budgets([], 5000), [campaign({ id: "live" })]);
    expect(result.grain).toBe("brand");
    expect(result.configuredDailyBudgetCents).toBe(5000);
    expect(result.runningDailyBudgetCents).toBe(5000);
  });

  it("a brand that configured nothing answers `none` with zero figures", () => {
    const result = computeSpendableBudget(ORG, BRAND, budgets([], null), []);
    expect(result.grain).toBe("none");
    expect(result.configuredDailyBudgetCents).toBe(0);
    expect(result.rows).toEqual([]);
  });

  it("never serves a funnel", () => {
    const result = computeSpendableBudget(ORG, BRAND, budgets([entry({})]), [campaign({ id: "live" })]);
    expect(JSON.stringify(result)).not.toMatch(/funnel/i);
  });
});
