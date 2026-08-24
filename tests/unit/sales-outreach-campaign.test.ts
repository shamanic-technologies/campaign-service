import { describe, expect, it, vi } from "vitest";
import {
  isSalesOutreachFeature,
  MAX_BUDGET_FIELDS,
  salesMaxBudgetRefusal,
  SALES_CRM_FEATURE_SLUG,
  SALES_OUTREACH_FEATURE_SLUG,
  SALES_OUTREACH_WORKFLOW_SLUG,
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
    workflowSlug: SALES_OUTREACH_WORKFLOW_SLUG,
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

describe("isSalesOutreachFeature", () => {
  it("includes both cold and CRM sales-outreach features (full parity)", () => {
    expect(isSalesOutreachFeature(SALES_OUTREACH_FEATURE_SLUG)).toBe(true);
    expect(isSalesOutreachFeature(SALES_CRM_FEATURE_SLUG)).toBe(true);
    expect(isSalesOutreachFeature("sales-cold-email-outreach")).toBe(true);
    expect(isSalesOutreachFeature("sales-crm-email-outreach")).toBe(true);
  });

  it("excludes non-sales features and empty/nullish slugs", () => {
    expect(isSalesOutreachFeature("pr-expert-quote-outreach")).toBe(false);
    expect(isSalesOutreachFeature("hiring-cold-email-outreach")).toBe(false);
    expect(isSalesOutreachFeature("")).toBe(false);
    expect(isSalesOutreachFeature(null)).toBe(false);
    expect(isSalesOutreachFeature(undefined)).toBe(false);
  });
});

describe("salesMaxBudgetRefusal", () => {
  const SALES = "sales-cold-email-outreach";
  const NON_SALES = "pr-expert-quote-outreach";

  it("refuses each per-campaign budget window on a sales-family campaign, naming where the ceiling belongs", () => {
    for (const slug of [SALES, "sales-crm-email-outreach", "feedback-request-cold-email-outreach"]) {
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
