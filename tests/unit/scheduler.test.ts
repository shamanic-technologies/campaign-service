import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const {
  mockExecuteCampaignWorkflow,
  mockDbReturning,
  mockDbFindMany,
  mockListRuns,
} = vi.hoisted(() => {
  return {
    mockExecuteCampaignWorkflow: vi.fn(),
    mockDbReturning: vi.fn(),
    mockDbFindMany: vi.fn(),
    mockListRuns: vi.fn(),
  };
});

vi.mock("../../src/lib/workflows.js", () => ({
  executeCampaignWorkflow: mockExecuteCampaignWorkflow,
}));

vi.mock("@distribute/runs-client", () => ({
  listRuns: mockListRuns,
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
    query: {
      campaigns: {
        findMany: mockDbFindMany,
      },
    },
  },
}));

vi.mock("../../src/db/schema.js", () => ({
  campaigns: {
    id: "id",
    status: "status",
    nextRunAt: "next_run_at",
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
  isNull: vi.fn(),
}));

import { reRunDueCampaigns, claimStuckCampaigns } from "../../src/lib/scheduler.js";

describe("Scheduler - reRunDueCampaigns", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecuteCampaignWorkflow.mockResolvedValue(undefined);
    mockDbReturning.mockResolvedValue([]);
  });

  it("should return 0 when no campaigns are due", async () => {
    const count = await reRunDueCampaigns();
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

    const count = await reRunDueCampaigns();

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

    await reRunDueCampaigns();

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

    await reRunDueCampaigns();

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

    await reRunDueCampaigns();

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

    const count = await reRunDueCampaigns();

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

    const count = await reRunDueCampaigns();

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

    const count = await reRunDueCampaigns();

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

    const count = await reRunDueCampaigns();

    expect(count).toBe(2);
    expect(mockExecuteCampaignWorkflow).toHaveBeenCalledTimes(2);
  });
});

describe("Scheduler - claimStuckCampaigns", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbReturning.mockResolvedValue([]);
    mockDbFindMany.mockResolvedValue([]);
    mockListRuns.mockResolvedValue({ runs: [], limit: 50, offset: 0 });
  });

  it("should return 0 and skip runs-service when no candidates", async () => {
    mockDbFindMany.mockResolvedValue([]);

    const count = await claimStuckCampaigns();

    expect(count).toBe(0);
    expect(mockListRuns).not.toHaveBeenCalled();
    expect(mockDbReturning).not.toHaveBeenCalled();
  });

  it("should NOT claim when a fresh running run exists", async () => {
    mockDbFindMany.mockResolvedValue([{ id: "c-running", orgId: "org-1" }]);
    mockListRuns.mockResolvedValue({
      runs: [
        { id: "run-1", status: "running", startedAt: new Date().toISOString() },
      ],
      limit: 50,
      offset: 0,
    });

    const count = await claimStuckCampaigns();

    expect(count).toBe(0);
    expect(mockListRuns).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org-1",
        serviceName: "campaign-service",
        taskName: "c-running",
        status: "running",
        startedAfter: expect.any(String),
      }),
    );
    expect(mockDbReturning).not.toHaveBeenCalled();
  });

  it("should claim when no running run exists (true stuck)", async () => {
    mockDbFindMany.mockResolvedValue([{ id: "c-stuck", orgId: "org-2" }]);
    mockListRuns.mockResolvedValue({ runs: [], limit: 50, offset: 0 });
    mockDbReturning.mockResolvedValue([{ id: "c-stuck" }]);

    const count = await claimStuckCampaigns();

    expect(count).toBe(1);
    expect(mockListRuns).toHaveBeenCalledTimes(1);
    expect(mockDbReturning).toHaveBeenCalledTimes(1);
  });

  it("should only claim the stuck candidate when mixed with a running one", async () => {
    mockDbFindMany.mockResolvedValue([
      { id: "c-running", orgId: "org-1" },
      { id: "c-stuck", orgId: "org-2" },
    ]);
    mockListRuns
      .mockResolvedValueOnce({
        runs: [
          { id: "run-1", status: "running", startedAt: new Date().toISOString() },
        ],
        limit: 50,
        offset: 0,
      })
      .mockResolvedValueOnce({ runs: [], limit: 50, offset: 0 });
    mockDbReturning.mockResolvedValue([{ id: "c-stuck" }]);

    const count = await claimStuckCampaigns();

    expect(count).toBe(1);
    expect(mockListRuns).toHaveBeenCalledTimes(2);
    expect(mockDbReturning).toHaveBeenCalledTimes(1);
  });

  it("should propagate listRuns errors (no swallow)", async () => {
    mockDbFindMany.mockResolvedValue([{ id: "c1", orgId: "org-1" }]);
    mockListRuns.mockRejectedValue(new Error("runs-service down"));

    await expect(claimStuckCampaigns()).rejects.toThrow("runs-service down");
    expect(mockDbReturning).not.toHaveBeenCalled();
  });
});

describe("Scheduler - logging hygiene", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExecuteCampaignWorkflow.mockResolvedValue(undefined);
    mockDbReturning.mockResolvedValue([]);
    mockDbFindMany.mockResolvedValue([]);
    mockListRuns.mockResolvedValue({ runs: [], limit: 50, offset: 0 });
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it("reRunDueCampaigns should NOT log 'Claimed N campaign(s) for re-run'", async () => {
    mockDbReturning.mockResolvedValue([
      {
        id: "campaign-1",
        orgId: "org-1",
        workflowSlug: "sales-email-cold-outreach",
        brandIds: ["brand-1"],
        createdByUserId: "user-1",
        parentRunId: null,
        featureSlug: "sales-cold-email-v1",
      },
    ]);

    await reRunDueCampaigns();

    const allLogs = [
      ...logSpy.mock.calls.flat(),
      ...warnSpy.mock.calls.flat(),
    ].join(" ");
    expect(allLogs).not.toMatch(/Claimed \d+ campaign\(s\) for re-run/);
  });

  it("claimStuckCampaigns should NOT emit a warn and should log per claim", async () => {
    mockDbFindMany.mockResolvedValue([{ id: "c-stuck", orgId: "org-2" }]);
    mockListRuns.mockResolvedValue({ runs: [], limit: 50, offset: 0 });
    mockDbReturning.mockResolvedValue([{ id: "c-stuck" }]);

    await claimStuckCampaigns();

    expect(warnSpy).not.toHaveBeenCalled();
    const allLogs = logSpy.mock.calls.flat().join(" ");
    expect(allLogs).toMatch(/Claimed stuck campaign c-stuck/);
  });

  it("claimStuckCampaigns should NOT log when nothing claimed", async () => {
    mockDbFindMany.mockResolvedValue([{ id: "c-running", orgId: "org-1" }]);
    mockListRuns.mockResolvedValue({
      runs: [
        { id: "run-1", status: "running", startedAt: new Date().toISOString() },
      ],
      limit: 50,
      offset: 0,
    });

    await claimStuckCampaigns();

    expect(warnSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
  });
});
