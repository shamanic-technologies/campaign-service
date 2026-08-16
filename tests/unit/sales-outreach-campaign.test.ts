import { describe, expect, it, vi } from "vitest";
import {
  isSalesOutreachFeature,
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
