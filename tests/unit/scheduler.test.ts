import { describe, it, expect, beforeEach, vi } from "vitest";

const {
  mockExecuteCampaignWorkflow,
  mockDbReturning,
} = vi.hoisted(() => {
  return {
    mockExecuteCampaignWorkflow: vi.fn(),
    mockDbReturning: vi.fn(),
  };
});

vi.mock("../../src/lib/workflows.js", () => ({
  executeCampaignWorkflow: mockExecuteCampaignWorkflow,
}));

vi.mock("../../src/db/index.js", () => ({
  db: {
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: mockDbReturning,
        }),
      }),
    }),
  },
}));

vi.mock("../../src/db/schema.js", () => ({
  campaigns: {
    id: "id",
    status: "status",
    toResumeAt: "to_resume_at",
    workflowSlug: "workflow_slug",
    orgId: "org_id",
    updatedAt: "updated_at",
    brandIds: "brand_ids",
    createdByUserId: "created_by_user_id",
    parentRunId: "parent_run_id",
    featureSlug: "feature_slug",
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(),
  and: vi.fn(),
  lte: vi.fn(),
  isNotNull: vi.fn(),
}));

import { resumeDueCampaigns } from "../../src/lib/scheduler.js";

describe("Scheduler - resumeDueCampaigns", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecuteCampaignWorkflow.mockResolvedValue(undefined);
    mockDbReturning.mockResolvedValue([]);
  });

  it("should return 0 when no campaigns are due", async () => {
    const count = await resumeDueCampaigns();
    expect(count).toBe(0);
    expect(mockExecuteCampaignWorkflow).not.toHaveBeenCalled();
  });

  it("should re-trigger due campaigns using atomic UPDATE RETURNING", async () => {
    mockDbReturning.mockResolvedValue([
      {
        id: "campaign-1",
        orgId: "org-ext-1",
        workflowSlug: "sales-email-cold-outreach",
        brandIds: ["brand-123"],
        createdByUserId: "user-1",
        parentRunId: null,
        featureSlug: "sales-cold-email-v1",
      },
    ]);

    const count = await resumeDueCampaigns();

    expect(count).toBe(1);
    expect(mockExecuteCampaignWorkflow).toHaveBeenCalledWith(
      "sales-email-cold-outreach",
      expect.objectContaining({
        campaignId: "campaign-1",
        orgId: "org-ext-1",
        brandId: "brand-123",
        userId: "user-1",
        featureSlug: "sales-cold-email-v1",
      }),
    );
  });

  it("should NOT create a run — let the workflow's start-run do it", async () => {
    mockDbReturning.mockResolvedValue([
      {
        id: "campaign-1",
        orgId: "org-ext-1",
        workflowSlug: "sales-email-cold-outreach",
        brandIds: ["brand-123"],
        createdByUserId: "user-1",
        parentRunId: null,
        featureSlug: "sales-cold-email-v1",
      },
    ]);

    await resumeDueCampaigns();

    // No createRun import or call — scheduler delegates run creation to the DAG
    expect(mockExecuteCampaignWorkflow).toHaveBeenCalledTimes(1);
  });

  it("should use parentRunId as runId when available", async () => {
    mockDbReturning.mockResolvedValue([
      {
        id: "campaign-1",
        orgId: "org-ext-1",
        workflowSlug: "sales-email-cold-outreach",
        brandIds: ["brand-123"],
        createdByUserId: "user-1",
        parentRunId: "parent-run-abc",
        featureSlug: "sales-cold-email-v1",
      },
    ]);

    await resumeDueCampaigns();

    expect(mockExecuteCampaignWorkflow).toHaveBeenCalledWith(
      "sales-email-cold-outreach",
      expect.objectContaining({ runId: "parent-run-abc" }),
    );
  });

  it("should generate a UUID runId when no parentRunId", async () => {
    mockDbReturning.mockResolvedValue([
      {
        id: "campaign-1",
        orgId: "org-ext-1",
        workflowSlug: "sales-email-cold-outreach",
        brandIds: ["brand-123"],
        createdByUserId: "user-1",
        parentRunId: null,
        featureSlug: "sales-cold-email-v1",
      },
    ]);

    await resumeDueCampaigns();

    const call = mockExecuteCampaignWorkflow.mock.calls[0];
    expect(call[1].runId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("should skip campaigns without brandIds", async () => {
    mockDbReturning.mockResolvedValue([
      {
        id: "campaign-no-brand",
        orgId: "org-ext-1",
        workflowSlug: "sales-email-cold-outreach",
        brandIds: null,
        createdByUserId: "user-1",
        parentRunId: null,
        featureSlug: "sales-cold-email-v1",
      },
    ]);

    const count = await resumeDueCampaigns();

    expect(count).toBe(1);
    expect(mockExecuteCampaignWorkflow).not.toHaveBeenCalled();
  });

  it("should skip campaigns without createdByUserId or featureSlug", async () => {
    mockDbReturning.mockResolvedValue([
      {
        id: "campaign-no-user",
        orgId: "org-ext-1",
        workflowSlug: "sales-email-cold-outreach",
        brandIds: ["brand-1"],
        createdByUserId: null,
        parentRunId: null,
        featureSlug: null,
      },
    ]);

    const count = await resumeDueCampaigns();

    expect(count).toBe(1);
    expect(mockExecuteCampaignWorkflow).not.toHaveBeenCalled();
  });

  it("should handle multiple due campaigns", async () => {
    mockDbReturning.mockResolvedValue([
      {
        id: "campaign-1",
        orgId: "org-ext-1",
        workflowSlug: "sales-email-cold-outreach",
        brandIds: ["brand-1"],
        createdByUserId: "user-1",
        parentRunId: null,
        featureSlug: "sales-cold-email-v1",
      },
      {
        id: "campaign-2",
        orgId: "org-ext-2",
        workflowSlug: "pr-email-cold-outreach",
        brandIds: ["brand-2"],
        createdByUserId: "user-2",
        parentRunId: null,
        featureSlug: "pr-media-pitch-v1",
      },
    ]);

    const count = await resumeDueCampaigns();

    expect(count).toBe(2);
    expect(mockExecuteCampaignWorkflow).toHaveBeenCalledTimes(2);
  });

  it("should continue processing other campaigns if one throws", async () => {
    mockDbReturning.mockResolvedValue([
      {
        id: "campaign-1",
        orgId: "org-ext-1",
        workflowSlug: "sales-email-cold-outreach",
        brandIds: ["brand-1"],
        createdByUserId: "user-1",
        parentRunId: null,
        featureSlug: "sales-cold-email-v1",
      },
      {
        id: "campaign-2",
        orgId: "org-ext-2",
        workflowSlug: "pr-email-cold-outreach",
        brandIds: ["brand-2"],
        createdByUserId: "user-2",
        parentRunId: null,
        featureSlug: "pr-media-pitch-v1",
      },
    ]);

    // First workflow execution throws synchronously
    mockExecuteCampaignWorkflow
      .mockImplementationOnce(() => { throw new Error("Workflow error"); })
      .mockResolvedValueOnce(undefined);

    const count = await resumeDueCampaigns();

    expect(count).toBe(2);
    expect(mockExecuteCampaignWorkflow).toHaveBeenCalledTimes(2);
  });
});
