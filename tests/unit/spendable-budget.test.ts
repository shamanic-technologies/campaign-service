import { describe, it, expect } from "vitest";
import { computeSpendableBudget, type SpendableCampaign } from "../../src/lib/spendable-budget.js";
import type { FunnelBudgetsRead } from "../../src/lib/funnel-budget-client.js";

const ORG = "org-1";
const BRAND = "brand-1";

function budgets(partial: Partial<Extract<FunnelBudgetsRead, { ok: true }>>): Extract<FunnelBudgetsRead, { ok: true }> {
  return {
    ok: true,
    brandDailyBudgetCents: null,
    funnels: [],
    channels: [],
    offers: [],
    legs: [],
    ...partial,
  };
}

function campaign(over: Partial<SpendableCampaign> & { id: string }): SpendableCampaign {
  return {
    status: "ongoing",
    funnelKey: "sales_meetings_from_conversation",
    featureSlug: "sales-cold-email-outreach",
    offerId: null,
    legKey: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...over,
  };
}

describe("computeSpendableBudget", () => {
  it("reports a running figure of ZERO and a non-zero configured figure when a funded funnel has no campaign", () => {
    const result = computeSpendableBudget(
      ORG,
      BRAND,
      budgets({
        brandDailyBudgetCents: 5000,
        funnels: [{ funnelKey: "sales_meetings_from_conversation", dailyBudgetCents: 5000 }],
      }),
      [],
    );

    expect(result.configuredDailyBudgetCents).toBe(5000);
    expect(result.runningDailyBudgetCents).toBe(0);
    expect(result.grain).toBe("funnel");
    expect(result.rows[0]).toMatchObject({ running: false, campaignId: null });
  });

  it("excludes ONLY the stopped funnel when several funnels are funded", () => {
    const result = computeSpendableBudget(
      ORG,
      BRAND,
      budgets({
        brandDailyBudgetCents: 9000,
        funnels: [
          { funnelKey: "sales_meetings_from_conversation", dailyBudgetCents: 4000 },
          { funnelKey: "website_purchases", dailyBudgetCents: 5000 },
        ],
      }),
      [
        campaign({ id: "c-live" }),
        campaign({ id: "c-stopped", status: "stopped", funnelKey: "website_purchases" }),
      ],
    );

    expect(result.configuredDailyBudgetCents).toBe(9000);
    expect(result.runningDailyBudgetCents).toBe(4000);
    // The stopped campaign is NAMED, not merely absent: "configured but not running" has to be
    // legible, and a missing row reads as "there is no such campaign".
    const stopped = result.campaigns.find((c) => c.campaignId === "c-stopped")!;
    expect(stopped.running).toBe(false);
    expect(stopped.configuredDailyBudgetCents).toBe(5000);
    expect(stopped.runningDailyBudgetCents).toBe(0);
  });

  it("counts an UNSCOPED (no-offer) ceiling as running when a campaign on that funnel and channel is ongoing", () => {
    const result = computeSpendableBudget(
      ORG,
      BRAND,
      budgets({
        brandDailyBudgetCents: 4000,
        funnels: [{ funnelKey: "sales_meetings_from_conversation", dailyBudgetCents: 4000 }],
        channels: [{ funnelKey: "sales_meetings_from_conversation", featureSlug: "sales-cold-email-outreach", dailyBudgetCents: 4000 }],
        offers: [{ funnelKey: "sales_meetings_from_conversation", featureSlug: "sales-cold-email-outreach", offerId: null, dailyBudgetCents: 4000 }],
      }),
      [campaign({ id: "c-live", offerId: "offer-a" })],
    );

    expect(result.grain).toBe("offer");
    expect(result.runningDailyBudgetCents).toBe(4000);
    // And that money is filed under the offer the CAMPAIGN sells, so it appears on that offer's
    // page rather than under "no offer".
    expect(result.offers).toEqual([
      { offerId: "offer-a", configuredDailyBudgetCents: 4000, runningDailyBudgetCents: 4000, campaignIds: ["c-live"] },
    ]);
  });

  it("counts exactly ONE grain — the finest billing states — so a dollar is never counted twice", () => {
    const result = computeSpendableBudget(
      ORG,
      BRAND,
      budgets({
        brandDailyBudgetCents: 6000,
        funnels: [{ funnelKey: "sales_meetings_from_conversation", dailyBudgetCents: 6000 }],
        channels: [
          { funnelKey: "sales_meetings_from_conversation", featureSlug: "sales-cold-email-outreach", dailyBudgetCents: 4000 },
          { funnelKey: "sales_meetings_from_conversation", featureSlug: "feedback-request-cold-email-outreach", dailyBudgetCents: 2000 },
        ],
      }),
      [campaign({ id: "c-live" })],
    );

    expect(result.grain).toBe("channel");
    expect(result.configuredDailyBudgetCents).toBe(6000);
    // The funnel is SPLIT across two channels, so the channel the campaign does not work is not
    // its money — the exact rule the gate paces on.
    expect(result.runningDailyBudgetCents).toBe(4000);
  });

  it("binds a single-channel funnel to whatever feature the campaign states", () => {
    const result = computeSpendableBudget(
      ORG,
      BRAND,
      budgets({
        channels: [{ funnelKey: "sales_meetings_from_conversation", featureSlug: "sales-cold-email-outreach", dailyBudgetCents: 3000 }],
      }),
      [campaign({ id: "c-live", featureSlug: "feedback-request-cold-email-outreach" })],
    );

    expect(result.runningDailyBudgetCents).toBe(3000);
  });

  it("canonicalises billing's pre-rename funnel spellings against the campaign's", () => {
    const result = computeSpendableBudget(
      ORG,
      BRAND,
      budgets({ funnels: [{ funnelKey: "sales_meetings_from_conversation", dailyBudgetCents: 2500 }] }),
      [campaign({ id: "c-live", funnelKey: "reply_meeting" })],
    );

    expect(result.runningDailyBudgetCents).toBe(2500);
  });

  it("names an ongoing campaign that no ceiling stands behind, at zero", () => {
    const result = computeSpendableBudget(ORG, BRAND, budgets({}), [campaign({ id: "c-live" })]);

    expect(result.grain).toBe("none");
    expect(result.configuredDailyBudgetCents).toBe(0);
    expect(result.campaigns).toEqual([
      {
        campaignId: "c-live",
        status: "ongoing",
        running: true,
        funnelKey: "sales_meetings_from_conversation",
        featureSlug: "sales-cold-email-outreach",
        offerId: null,
        legKey: null,
        configuredDailyBudgetCents: 0,
        runningDailyBudgetCents: 0,
      },
    ]);
  });

  it("prefers the ONGOING campaign over a stopped one on the same identity, whatever the creation dates", () => {
    const result = computeSpendableBudget(
      ORG,
      BRAND,
      budgets({ funnels: [{ funnelKey: "sales_meetings_from_conversation", dailyBudgetCents: 1000 }] }),
      [
        campaign({ id: "c-stopped", status: "stopped", createdAt: new Date("2026-06-01T00:00:00Z") }),
        campaign({ id: "c-live", createdAt: new Date("2026-01-01T00:00:00Z") }),
      ],
    );

    expect(result.rows[0]!.campaignId).toBe("c-live");
    expect(result.runningDailyBudgetCents).toBe(1000);
  });

  it("paces a brand with one undifferentiated pot on that pot", () => {
    const result = computeSpendableBudget(
      ORG,
      BRAND,
      budgets({ brandDailyBudgetCents: 1500 }),
      [campaign({ id: "c-live", funnelKey: null })],
    );

    expect(result.grain).toBe("brand");
    expect(result.configuredDailyBudgetCents).toBe(1500);
    expect(result.runningDailyBudgetCents).toBe(1500);
  });

  it("never leaves a consumer to add anything up: brand, offer and campaign totals all agree", () => {
    const result = computeSpendableBudget(
      ORG,
      BRAND,
      budgets({
        offers: [
          { funnelKey: "sales_meetings_from_conversation", featureSlug: "sales-cold-email-outreach", offerId: "offer-a", dailyBudgetCents: 4000 },
          { funnelKey: "website_purchases", featureSlug: "google-ads", offerId: "offer-b", dailyBudgetCents: 2000 },
        ],
      }),
      [
        campaign({ id: "c-a", offerId: "offer-a" }),
        campaign({ id: "c-b", status: "stopped", funnelKey: "website_purchases", featureSlug: "google-ads", offerId: "offer-b" }),
      ],
    );

    expect(result.configuredDailyBudgetCents).toBe(
      result.offers.reduce((s, o) => s + o.configuredDailyBudgetCents, 0),
    );
    expect(result.runningDailyBudgetCents).toBe(
      result.offers.reduce((s, o) => s + o.runningDailyBudgetCents, 0),
    );
    expect(result.runningDailyBudgetCents).toBe(4000);
  });

  it("counts at the LEG grain, giving each leg's money to the campaign bought for THAT leg", () => {
    const BOOKING_LEG = "conversation_to_meeting_booked";
    const ATTENDED_LEG = "meeting_booked_to_meeting_attended";
    const result = computeSpendableBudget(
      ORG,
      BRAND,
      budgets({
        brandDailyBudgetCents: 3000,
        funnels: [{ funnelKey: "sales_meetings_from_conversation", dailyBudgetCents: 3000 }],
        // The offer figure is the SUM of the two legs. Counting there would find ONE campaign for
        // a row that funds two, and report the other as running on nothing.
        offers: [{ funnelKey: "sales_meetings_from_conversation", featureSlug: "sales-cold-email-outreach", offerId: null, dailyBudgetCents: 3000 }],
        legs: [
          { funnelKey: "sales_meetings_from_conversation", featureSlug: "sales-cold-email-outreach", offerId: null, legKey: BOOKING_LEG, dailyBudgetCents: 2000 },
          { funnelKey: "sales_meetings_from_conversation", featureSlug: "sales-cold-email-outreach", offerId: null, legKey: ATTENDED_LEG, dailyBudgetCents: 1000 },
        ],
      }),
      [
        campaign({ id: "booking", legKey: BOOKING_LEG }),
        campaign({ id: "attended", legKey: ATTENDED_LEG, status: "stopped" }),
      ],
    );

    expect(result.grain).toBe("leg");
    expect(result.configuredDailyBudgetCents).toBe(3000);
    // Only the leg whose campaign is ongoing is running money — and it is ITS leg's figure, not
    // the offer SUM that also holds the stopped sibling's.
    expect(result.runningDailyBudgetCents).toBe(2000);
    const lines = Object.fromEntries(result.campaigns.map((c) => [c.campaignId, c]));
    expect(lines.booking).toMatchObject({ legKey: BOOKING_LEG, configuredDailyBudgetCents: 2000, runningDailyBudgetCents: 2000 });
    expect(lines.attended).toMatchObject({ legKey: ATTENDED_LEG, configuredDailyBudgetCents: 1000, runningDailyBudgetCents: 0 });
  });
});
