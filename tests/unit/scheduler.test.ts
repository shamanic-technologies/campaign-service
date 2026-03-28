import { describe, it, expect, beforeEach, vi } from "vitest";

const {
  mockExecuteCampaignWorkflow,
  mockCreateRun,
  mockDbValues,
  mockDbUpdate,
  mockSet,
  mockWhere,
} = vi.hoisted(() => {
  const mockWhere = vi.fn().mockResolvedValue(undefined);
  const mockSet = vi.fn().mockReturnValue({ where: mockWhere });
  const mockDbUpdate = vi.fn().mockReturnValue({ set: mockSet });
  const mockDbValues: Array<{
    id: string;
    orgId: string;
    workflowSlug: string;
    brandId?: string | null;
    createdByUserId?: string | null;
    featureSlug?: string | null;
  }> = [];

  return {
    mockExecuteCampaignWorkflow: vi.fn(),
    mockCreateRun: vi.fn(),
    mockDbValues,
    mockDbUpdate,
    mockSet,
    mockWhere,
  };
});

vi.mock("../../src/lib/workflows.js", () => ({
  executeCampaignWorkflow: mockExecuteCampaignWorkflow,
}));

vi.mock("@mcpfactory/runs-client", () => ({
  createRun: mockCreateRun,
}));

vi.mock("../../src/db/index.js", () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockImplementation(() => mockDbValues),
      }),
    }),
    update: mockDbUpdate,
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
    mockDbValues.length = 0;
    mockExecuteCampaignWorkflow.mockResolvedValue(undefined);
    mockCreateRun.mockResolvedValue({ id: "scheduler-run-123" });
  });

  it("should return 0 when no campaigns are due", async () => {
    const count = await resumeDueCampaigns();
    expect(count).toBe(0);
    expect(mockExecuteCampaignWorkflow).not.toHaveBeenCalled();
  });

  it("should re-trigger due campaigns and clear toResumeAt", async () => {
    mockDbValues.push({
      id: "campaign-1",
      orgId: "org-ext-1",
      workflowSlug: "sales-email-cold-outreach",
      brandId: "brand-123",
      createdByUserId: "user-1",
      featureSlug: "sales-cold-email-v1",
    });

    const count = await resumeDueCampaigns();

    expect(count).toBe(1);
    expect(mockDbUpdate).toHaveBeenCalled();
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({ toResumeAt: null }),
    );
    expect(mockCreateRun).toHaveBeenCalledWith({
      orgId: "org-ext-1",
      serviceName: "campaign-service",
      taskName: "scheduler-resume",
      userId: "user-1",
      campaignId: "campaign-1",
      brandId: "brand-123",
      workflowSlug: "sales-email-cold-outreach",
      featureSlug: "sales-cold-email-v1",
    });
    expect(mockExecuteCampaignWorkflow).toHaveBeenCalledWith(
      "sales-email-cold-outreach",
      {
        campaignId: "campaign-1",
        orgId: "org-ext-1",
        brandId: "brand-123",
        userId: "user-1",
        runId: "scheduler-run-123",
        featureSlug: "sales-cold-email-v1",
      },
    );
  });

  it("should skip campaigns without brandId", async () => {
    mockDbValues.push({
      id: "campaign-no-brand",
      orgId: "org-ext-1",
      workflowSlug: "sales-email-cold-outreach",
      brandId: null,
      createdByUserId: "user-1",
      featureSlug: "sales-cold-email-v1",
    });

    const count = await resumeDueCampaigns();

    expect(count).toBe(1);
    expect(mockExecuteCampaignWorkflow).not.toHaveBeenCalled();
    expect(mockCreateRun).not.toHaveBeenCalled();
  });

  it("should skip campaigns without createdByUserId or featureSlug", async () => {
    mockDbValues.push({
      id: "campaign-no-user",
      orgId: "org-ext-1",
      workflowSlug: "sales-email-cold-outreach",
      brandId: "brand-1",
      createdByUserId: null,
      featureSlug: null,
    });

    const count = await resumeDueCampaigns();

    expect(count).toBe(1);
    expect(mockExecuteCampaignWorkflow).not.toHaveBeenCalled();
    expect(mockCreateRun).not.toHaveBeenCalled();
  });

  it("should handle multiple due campaigns", async () => {
    mockDbValues.push(
      {
        id: "campaign-1",
        orgId: "org-ext-1",
        workflowSlug: "sales-email-cold-outreach",
        brandId: "brand-1",
        createdByUserId: "user-1",
        featureSlug: "sales-cold-email-v1",
      },
      {
        id: "campaign-2",
        orgId: "org-ext-2",
        workflowSlug: "pr-email-cold-outreach",
        brandId: "brand-2",
        createdByUserId: "user-2",
        featureSlug: "pr-media-pitch-v1",
      },
    );

    const count = await resumeDueCampaigns();

    expect(count).toBe(2);
    expect(mockExecuteCampaignWorkflow).toHaveBeenCalledTimes(2);
  });

  it("should continue processing other campaigns if one fails", async () => {
    mockDbValues.push(
      {
        id: "campaign-1",
        orgId: "org-ext-1",
        workflowSlug: "sales-email-cold-outreach",
        brandId: "brand-1",
        createdByUserId: "user-1",
        featureSlug: "sales-cold-email-v1",
      },
      {
        id: "campaign-2",
        orgId: "org-ext-2",
        workflowSlug: "pr-email-cold-outreach",
        brandId: "brand-2",
        createdByUserId: "user-2",
        featureSlug: "pr-media-pitch-v1",
      },
    );

    // First update call fails (clearing toResumeAt for campaign-1)
    mockDbUpdate
      .mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockRejectedValue(new Error("DB error")),
        }),
      })
      .mockReturnValue({ set: mockSet });

    const count = await resumeDueCampaigns();

    expect(count).toBe(2);
    expect(mockExecuteCampaignWorkflow).toHaveBeenCalledTimes(1);
    expect(mockExecuteCampaignWorkflow).toHaveBeenCalledWith(
      "pr-email-cold-outreach",
      expect.objectContaining({ campaignId: "campaign-2" }),
    );
  });
});
