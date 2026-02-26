import { describe, it, expect, beforeEach, vi } from "vitest";

const {
  mockExecuteCampaignWorkflow,
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
    workflowName: string;
    appId: string | null;
    externalOrgId: string;
  }> = [];

  return {
    mockExecuteCampaignWorkflow: vi.fn(),
    mockDbValues,
    mockDbUpdate,
    mockSet,
    mockWhere,
  };
});

vi.mock("../../src/lib/workflows.js", () => ({
  executeCampaignWorkflow: mockExecuteCampaignWorkflow,
}));

vi.mock("../../src/db/index.js", () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation(() => mockDbValues),
        }),
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
    workflowName: "workflow_name",
    appId: "app_id",
    orgId: "org_id",
    updatedAt: "updated_at",
  },
  orgs: {
    id: "id",
    externalOrgId: "org_id",
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
  });

  it("should return 0 when no campaigns are due", async () => {
    const count = await resumeDueCampaigns();
    expect(count).toBe(0);
    expect(mockExecuteCampaignWorkflow).not.toHaveBeenCalled();
  });

  it("should re-trigger due campaigns and clear toResumeAt", async () => {
    mockDbValues.push({
      id: "campaign-1",
      workflowName: "sales-email-cold-outreach",
      appId: "mcpfactory",
      externalOrgId: "org-ext-1",
    });

    const count = await resumeDueCampaigns();

    expect(count).toBe(1);
    expect(mockDbUpdate).toHaveBeenCalled();
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({ toResumeAt: null }),
    );
    expect(mockExecuteCampaignWorkflow).toHaveBeenCalledWith(
      "sales-email-cold-outreach",
      {
        campaignId: "campaign-1",
        orgId: "org-ext-1",
        appId: "mcpfactory",
      },
    );
  });

  it("should handle multiple due campaigns", async () => {
    mockDbValues.push(
      {
        id: "campaign-1",
        workflowName: "sales-email-cold-outreach",
        appId: "mcpfactory",
        externalOrgId: "org-ext-1",
      },
      {
        id: "campaign-2",
        workflowName: "pr-email-cold-outreach",
        appId: "mcpfactory",
        externalOrgId: "org-ext-2",
      },
    );

    const count = await resumeDueCampaigns();

    expect(count).toBe(2);
    expect(mockExecuteCampaignWorkflow).toHaveBeenCalledTimes(2);
  });

  it("should use empty string when appId is null", async () => {
    mockDbValues.push({
      id: "campaign-1",
      workflowName: "sales-email-cold-outreach",
      appId: null,
      externalOrgId: "org-ext-1",
    });

    await resumeDueCampaigns();

    expect(mockExecuteCampaignWorkflow).toHaveBeenCalledWith(
      "sales-email-cold-outreach",
      expect.objectContaining({ appId: "" }),
    );
  });

  it("should continue processing other campaigns if one fails", async () => {
    mockDbValues.push(
      {
        id: "campaign-1",
        workflowName: "sales-email-cold-outreach",
        appId: "mcpfactory",
        externalOrgId: "org-ext-1",
      },
      {
        id: "campaign-2",
        workflowName: "pr-email-cold-outreach",
        appId: "mcpfactory",
        externalOrgId: "org-ext-2",
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
