import { describe, expect, it, vi } from "vitest";
import {
  GOOGLE_ADS_FEATURE_SLUG,
  isOutboundSalesFeature,
  isSalesFunnelFeature,
  MAX_BUDGET_FIELDS,
  salesMaxBudgetRefusal,
  SALES_CRM_FEATURE_SLUG,
  SALES_FEEDBACK_REQUEST_FEATURE_SLUG,
  SALES_OUTREACH_FEATURE_SLUG,
} from "../../src/lib/sales-outreach-campaign.js";
import type { Campaign } from "../../src/db/schema.js";

function campaign(overrides: Partial<Campaign> = {}): Campaign {
  const now = new Date("2026-06-18T00:00:00.000Z");
  return {
    id: "campaign-1",
    orgId: "org-1",
    createdByUserId: "user-1",
    parentRunId: null,
    name: "Sales",
    workflowSlug: "sales-email-cold-outreach",
    brandIds: ["brand-1"],
    featureSlug: SALES_OUTREACH_FEATURE_SLUG,
    featureInputs: null,
    activeGoalId: null,
    brandProfileId: null,
    audienceId: null,
    maxBudgetDailyUsd: null,
    maxBudgetWeeklyUsd: null,
    maxBudgetMonthlyUsd: null,
    maxBudgetTotalUsd: null,
    maxLeads: null,
    startDate: null,
    endDate: null,
    status: "ongoing",
    nextRunAt: null,
    notifyFrequency: null,
    notifyChannel: null,
    notifyDestination: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function mutation(returned: Campaign[]) {
  const returning = vi.fn().mockResolvedValue(returned);
  const where = vi.fn(() => ({ returning }));
  const set = vi.fn(() => ({ where }));
  const values = vi.fn(() => ({ returning }));
  return {
    update: vi.fn(() => ({ set })),
    insert: vi.fn(() => ({ values })),
    fns: { set, where, values, returning },
  };
}

describe("isSalesFunnelFeature", () => {
  it("includes every acquisition channel that sells a sales funnel — paid reach included", () => {
    // Membership is a MONEY statement, not a medium one: this campaign's ceiling is billing's,
    // per (funnel, channel, offer). Google Ads answers that identically to a cold email.
    expect(isSalesFunnelFeature(GOOGLE_ADS_FEATURE_SLUG)).toBe(true);
    expect(isSalesFunnelFeature("google-ads")).toBe(true);
  });

  it("does NOT sweep in the rest of the published paid-reach catalogue", () => {
    // Published by features-service, executable by nothing — a campaign for one would sit ongoing
    // and produce nothing forever.
    for (const slug of ["meta-ads", "linkedin-ads", "tiktok-ads", "bing-ads", "cold-call-outreach"]) {
      expect(isSalesFunnelFeature(slug)).toBe(false);
    }
  });

  it("includes both cold and CRM sales-outreach features (full parity)", () => {
    expect(isSalesFunnelFeature(SALES_OUTREACH_FEATURE_SLUG)).toBe(true);
    expect(isSalesFunnelFeature(SALES_CRM_FEATURE_SLUG)).toBe(true);
    expect(isSalesFunnelFeature("sales-cold-email-outreach")).toBe(true);
    expect(isSalesFunnelFeature("sales-crm-email-outreach")).toBe(true);
  });

  it("excludes non-sales features and empty/nullish slugs", () => {
    expect(isSalesFunnelFeature("pr-expert-quote-outreach")).toBe(false);
    expect(isSalesFunnelFeature("hiring-cold-email-outreach")).toBe(false);
    expect(isSalesFunnelFeature("")).toBe(false);
    expect(isSalesFunnelFeature(null)).toBe(false);
    expect(isSalesFunnelFeature(undefined)).toBe(false);
  });
});

describe("isOutboundSalesFeature", () => {
  it("is the cold-email subset — the channels that share leads and sending accounts", () => {
    expect(isOutboundSalesFeature(SALES_OUTREACH_FEATURE_SLUG)).toBe(true);
    expect(isOutboundSalesFeature(SALES_CRM_FEATURE_SLUG)).toBe(true);
    expect(isOutboundSalesFeature(SALES_FEEDBACK_REQUEST_FEATURE_SLUG)).toBe(true);
  });

  it("EXCLUDES paid reach — an ad shares no lead population and no mailbox", () => {
    // Three behaviours key on this and must not reach a Google Ads campaign: the per-brand
    // serialization, the greedy workflow rotation, and the extend-audience lifecycle email.
    expect(isOutboundSalesFeature(GOOGLE_ADS_FEATURE_SLUG)).toBe(false);
    expect(isOutboundSalesFeature(null)).toBe(false);
  });
});

describe("salesMaxBudgetRefusal", () => {
  const SALES = "sales-cold-email-outreach";
  const NON_SALES = "pr-expert-quote-outreach";

  it("refuses each per-campaign budget window on a sales-family campaign, naming where the ceiling belongs", () => {
    for (const slug of [SALES, "sales-crm-email-outreach", "feedback-request-cold-email-outreach", "google-ads"]) {
      for (const field of MAX_BUDGET_FIELDS) {
        const message = salesMaxBudgetRefusal(slug, { [field]: "10.00" });
        expect(message).toContain(field);
        expect(message).toContain("billing");
        expect(message).toMatch(/funnel/i);
      }
    }
  });

  it("names every stated field in one refusal", () => {
    const message = salesMaxBudgetRefusal(SALES, {
      maxBudgetDailyUsd: "10.00",
      maxBudgetTotalUsd: "500.00",
    });
    expect(message).toContain("maxBudgetDailyUsd");
    expect(message).toContain("maxBudgetTotalUsd");
  });

  it("allows a NON-sales campaign to state one — the column is live for it and gate-check enforces it", () => {
    for (const field of MAX_BUDGET_FIELDS) {
      expect(salesMaxBudgetRefusal(NON_SALES, { [field]: "10.00" })).toBeNull();
      expect(salesMaxBudgetRefusal("hiring-cold-email-outreach", { [field]: "10.00" })).toBeNull();
      expect(salesMaxBudgetRefusal(null, { [field]: "10.00" })).toBeNull();
    }
  });

  it("has nothing to refuse when a sales campaign states no budget window", () => {
    expect(salesMaxBudgetRefusal(SALES, {})).toBeNull();
    expect(salesMaxBudgetRefusal(SALES, { dailyBudgetCents: 5000, name: "x" })).toBeNull();
  });
});
