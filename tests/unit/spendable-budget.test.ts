import { describe, it, expect } from "vitest";
import { computeSpendableBudget, type SpendableCampaign } from "../../src/lib/spendable-budget.js";
import type { StatedSalesFunnelCap } from "../../src/lib/sales-funnel-campaigns.js";

/**
 * ONE money model (owner 2026-10-14): a campaign's money is its SALES FUNNEL's caps. billing's
 * per-campaign ceilings and the brand pot are retired: `rows` is always empty, `grain` always `none`,
 * and the totals are the funnel caps only.
 */

const ORG = "org-1";
const BRAND = "brand-1";
const SALES = "sales-cold-email-outreach";
const ENTRY_LEG = "lead_found_to_conversation";

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

function cap(over: Partial<StatedSalesFunnelCap> = {}): StatedSalesFunnelCap {
  return {
    offerId: "offer-1",
    salesFunnelId: "sf-1",
    maxBudget: { amountCents: 3000, period: "daily", dailyBudgetCents: 3000 },
    fundedBy: "max_budget",
    ...over,
  };
}

describe("computeSpendableBudget", () => {
  it("serves no per-campaign rows and grain `none`, whatever campaigns exist", () => {
    const result = computeSpendableBudget(ORG, BRAND, [campaign({ id: "live" })]);
    expect(result.grain).toBe("none");
    expect(result.rows).toEqual([]);
    expect(result.configuredDailyBudgetCents).toBe(0);
    expect(result.runningDailyBudgetCents).toBe(0);
  });

  it("names every ONGOING campaign with 0 figures, never a stopped one", () => {
    const result = computeSpendableBudget(ORG, BRAND, [
      campaign({ id: "live", createdAt: new Date("2026-06-01T00:00:00Z") }),
      campaign({ id: "stopped", status: "stopped" }),
      campaign({ id: "unit", salesFunnelCampaignId: "sfc-1", createdAt: new Date("2026-02-01T00:00:00Z") }),
    ]);
    expect(result.campaigns.map((c) => c.campaignId)).toEqual(["unit", "live"]);
    for (const line of result.campaigns) {
      expect(line).toMatchObject({ running: true, configuredDailyBudgetCents: 0, runningDailyBudgetCents: 0 });
    }
    expect(result.campaigns[0].salesFunnelCampaignId).toBe("sfc-1");
    expect(result.campaigns[1].salesFunnelCampaignId).toBeNull();
  });

  it("totals = the funnel caps only: a running funnel counts in both, a stopped one in configured only", () => {
    const result = computeSpendableBudget(
      ORG,
      BRAND,
      [
        campaign({ id: "u1", salesFunnelCampaignId: "sfc-1" }),
        campaign({ id: "u2", offerId: "offer-2", salesFunnelCampaignId: "sfc-2", status: "stopped" }),
      ],
      {
        caps: [
          cap(),
          cap({ offerId: "offer-2", salesFunnelId: "sf-2", maxBudget: { amountCents: 7000, period: "weekly", dailyBudgetCents: 1000 } }),
        ],
        salesFunnelCampaigns: [
          { id: "sfc-1", offerId: "offer-1", salesFunnelId: "sf-1", status: "ongoing" },
          { id: "sfc-2", offerId: "offer-2", salesFunnelId: "sf-2", status: "stopped" },
        ],
      },
    );
    expect(result.grain).toBe("none");
    expect(result.rows).toEqual([]);
    expect(result.configuredDailyBudgetCents).toBe(4000);
    expect(result.runningDailyBudgetCents).toBe(3000);
    expect(result.salesFunnels).toEqual([
      expect.objectContaining({ salesFunnelCampaignId: "sfc-1", running: true, dailyBudgetCents: 3000, unitCampaignIds: ["u1"] }),
      expect.objectContaining({ salesFunnelCampaignId: "sfc-2", running: false, dailyBudgetCents: 1000, unitCampaignIds: ["u2"] }),
    ]);
    expect(result.offers).toEqual([
      { offerId: "offer-1", configuredDailyBudgetCents: 3000, runningDailyBudgetCents: 3000, campaignIds: ["u1"] },
      { offerId: "offer-2", configuredDailyBudgetCents: 1000, runningDailyBudgetCents: 0, campaignIds: ["u2"] },
    ]);
  });

  it("a cap with no funnel campaign yet is configured money nothing runs", () => {
    const result = computeSpendableBudget(ORG, BRAND, [], { caps: [cap()], salesFunnelCampaigns: [] });
    expect(result.configuredDailyBudgetCents).toBe(3000);
    expect(result.runningDailyBudgetCents).toBe(0);
    expect(result.salesFunnels[0]).toMatchObject({ salesFunnelCampaignId: null, status: null, running: false });
  });

  it("a volume-only funnel is funded at $0/day: it adds nothing to any total", () => {
    const result = computeSpendableBudget(ORG, BRAND, [], {
      caps: [cap({ maxBudget: null, fundedBy: "max_volume" })],
      salesFunnelCampaigns: [{ id: "sfc-1", offerId: "offer-1", salesFunnelId: "sf-1", status: "ongoing" }],
    });
    expect(result.configuredDailyBudgetCents).toBe(0);
    expect(result.salesFunnels[0]).toMatchObject({ fundedBy: "max_volume", dailyBudgetCents: 0, recurring: false, running: true });
  });

  it("a brand that configured nothing answers `none` with zero figures", () => {
    const result = computeSpendableBudget(ORG, BRAND, []);
    expect(result.grain).toBe("none");
    expect(result.configuredDailyBudgetCents).toBe(0);
    expect(result.rows).toEqual([]);
    expect(result.salesFunnels).toEqual([]);
  });

  it("never serves the retired funnel KEY (sales funnels of 2026-10-10 are served under salesFunnels)", () => {
    const result = computeSpendableBudget(ORG, BRAND, [campaign({ id: "live" })]);
    expect(JSON.stringify(result)).not.toMatch(/funnelKey|funnel_key/i);
    expect(result.salesFunnels).toEqual([]);
  });
});
