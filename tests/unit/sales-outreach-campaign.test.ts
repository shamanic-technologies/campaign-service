import { describe, expect, it, vi } from "vitest";
import {
  ensureRunnableSalesOutreachCampaign,
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

describe("ensureRunnableSalesOutreachCampaign", () => {
  it("reuses an existing ongoing sales campaign", async () => {
    const existing = campaign();
    const mut = mutation([]);
    const store = {
      query: { campaigns: { findFirst: vi.fn().mockResolvedValueOnce(existing) } },
      update: mut.update,
      insert: mut.insert,
    };

    await expect(ensureRunnableSalesOutreachCampaign(store as never, {
      orgId: "org-1",
      brandId: "brand-1",
    })).resolves.toEqual({ action: "existing", campaign: existing });

    expect(store.query.campaigns.findFirst).toHaveBeenCalledTimes(1);
    expect(mut.update).not.toHaveBeenCalled();
    expect(mut.insert).not.toHaveBeenCalled();
  });

  it("resumes the latest stopped sales campaign and schedules it now", async () => {
    const now = new Date("2026-06-18T12:00:00.000Z");
    const stopped = campaign({ id: "campaign-stopped", status: "stopped", nextRunAt: null });
    const resumed = campaign({ id: "campaign-stopped", status: "ongoing", nextRunAt: now, updatedAt: now });
    const mut = mutation([resumed]);
    const store = {
      query: { campaigns: { findFirst: vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce(stopped) } },
      update: mut.update,
      insert: mut.insert,
    };

    await expect(ensureRunnableSalesOutreachCampaign(store as never, {
      orgId: "org-1",
      brandId: "brand-1",
      now,
    })).resolves.toEqual({ action: "resumed", campaign: resumed });

    expect(mut.fns.set).toHaveBeenCalledWith({ status: "ongoing", nextRunAt: now, updatedAt: now });
    expect(mut.insert).not.toHaveBeenCalled();
  });

  it("treats a concurrent resume as an existing ongoing campaign", async () => {
    const stopped = campaign({ id: "campaign-stopped", status: "stopped", nextRunAt: null });
    const existing = campaign({ id: "campaign-stopped", status: "ongoing" });
    const mut = mutation([]);
    const store = {
      query: {
        campaigns: {
          findFirst: vi.fn()
            .mockResolvedValueOnce(undefined)
            .mockResolvedValueOnce(stopped)
            .mockResolvedValueOnce(existing),
        },
      },
      update: mut.update,
      insert: mut.insert,
    };

    await expect(ensureRunnableSalesOutreachCampaign(store as never, {
      orgId: "org-1",
      brandId: "brand-1",
    })).resolves.toEqual({ action: "existing", campaign: existing });

    expect(mut.update).toHaveBeenCalledTimes(1);
    expect(mut.insert).not.toHaveBeenCalled();
  });

  it("creates a default sales campaign when none exists", async () => {
    const now = new Date("2026-06-18T12:00:00.000Z");
    const created = campaign({ id: "campaign-created", nextRunAt: now, updatedAt: now });
    const mut = mutation([created]);
    const store = {
      query: { campaigns: { findFirst: vi.fn().mockResolvedValue(undefined) } },
      update: mut.update,
      insert: mut.insert,
    };

    await expect(ensureRunnableSalesOutreachCampaign(store as never, {
      orgId: "org-1",
      brandId: "brand-1",
      userId: "user-1",
      runId: "run-1",
      now,
    })).resolves.toEqual({ action: "created", campaign: created });

    expect(mut.update).not.toHaveBeenCalled();
    expect(mut.fns.values).toHaveBeenCalledWith(expect.objectContaining({
      orgId: "org-1",
      createdByUserId: "user-1",
      parentRunId: "run-1",
      workflowSlug: SALES_OUTREACH_WORKFLOW_SLUG,
      brandIds: ["brand-1"],
      featureSlug: SALES_OUTREACH_FEATURE_SLUG,
      status: "ongoing",
      nextRunAt: now,
    }));
  });

  it("fails loud when the stopped campaign is missing its user id", async () => {
    const stopped = campaign({ id: "campaign-stopped", status: "stopped", createdByUserId: null });
    const mut = mutation([]);
    const store = {
      query: { campaigns: { findFirst: vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce(stopped) } },
      update: mut.update,
      insert: mut.insert,
    };

    await expect(ensureRunnableSalesOutreachCampaign(store as never, {
      orgId: "org-1",
      brandId: "brand-1",
    })).rejects.toThrow("missing createdByUserId");

    expect(mut.update).not.toHaveBeenCalled();
    expect(mut.insert).not.toHaveBeenCalled();
  });

  it("fails loud when creating a new campaign without a user id", async () => {
    const mut = mutation([]);
    const store = {
      query: { campaigns: { findFirst: vi.fn().mockResolvedValue(undefined) } },
      update: mut.update,
      insert: mut.insert,
    };

    await expect(ensureRunnableSalesOutreachCampaign(store as never, {
      orgId: "org-1",
      brandId: "brand-1",
    })).rejects.toThrow("x-user-id header required");

    expect(mut.update).not.toHaveBeenCalled();
    expect(mut.insert).not.toHaveBeenCalled();
  });
});
