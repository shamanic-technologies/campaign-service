import { describe, it, expect, beforeEach, vi } from "vitest";

const { mockCreateRun, mockUpdateRun, mockDbSet, mockDbWhere } = vi.hoisted(() => ({
  mockCreateRun: vi.fn(),
  mockUpdateRun: vi.fn(),
  mockDbSet: vi.fn(),
  mockDbWhere: vi.fn(),
}));

vi.mock("@distribute/runs-client", () => ({
  createRun: mockCreateRun,
  updateRun: mockUpdateRun,
}));

vi.mock("../../src/db/index.js", () => ({
  db: {
    update: vi.fn().mockReturnValue({
      set: mockDbSet.mockReturnValue({ where: mockDbWhere }),
    }),
  },
}));

vi.mock("../../src/db/schema.js", () => ({
  campaigns: { id: "id", parentRunId: "parent_run_id", updatedAt: "updated_at" },
}));

vi.mock("drizzle-orm", () => ({ eq: vi.fn() }));

import { ensureCampaignRunId } from "../../src/lib/trigger-run.js";

const CAMPAIGN = {
  id: "campaign-1",
  orgId: "org-1",
  parentRunId: null as string | null,
  createdByUserId: "user-1",
  brandIds: ["brand-a", "brand-b"],
  workflowSlug: "sales-email-cold-outreach",
  featureSlug: "sales-cold-email-outreach",
};

describe("ensureCampaignRunId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateRun.mockResolvedValue({ id: "anchor-1" });
    mockUpdateRun.mockResolvedValue({ id: "anchor-1", status: "completed" });
    mockDbSet.mockReturnValue({ where: mockDbWhere });
    mockDbWhere.mockResolvedValue(undefined);
  });

  it("returns the stored ancestor untouched — it already resolves", async () => {
    const runId = await ensureCampaignRunId({ ...CAMPAIGN, parentRunId: "run-existing" });

    expect(runId).toBe("run-existing");
    expect(mockCreateRun).not.toHaveBeenCalled();
    expect(mockDbSet).not.toHaveBeenCalled();
  });

  it("creates a real root run when the campaign never stored one", async () => {
    const runId = await ensureCampaignRunId({ ...CAMPAIGN });

    expect(runId).toBe("anchor-1");
    expect(mockCreateRun).toHaveBeenCalledWith({
      orgId: "org-1",
      serviceName: "campaign-service",
      taskName: "campaign-trigger",
      userId: "user-1",
      brandId: "brand-a,brand-b",
      featureSlug: "sales-cold-email-outreach",
    });
  });

  it("states NO workflow — the workflow is re-picked every run, the ancestor is permanent", async () => {
    await ensureCampaignRunId({ ...CAMPAIGN });

    // runs-service refuses a child whose workflowSlug differs from its parent's (409
    // Parent-child field conflict), so freezing this run's workflow on a permanent ancestor
    // stops every execution the greedy bandit later picks a different one for.
    expect(mockCreateRun.mock.calls[0][0]).not.toHaveProperty("workflowSlug");
    expect(mockUpdateRun.mock.calls[0][2]).not.toHaveProperty("workflowSlug");
  });

  it("does NOT tag the anchor with the campaign — every campaign-scoped read would then see it", async () => {
    await ensureCampaignRunId({ ...CAMPAIGN });

    // The gate's stale-run cleanup, its lifetime completed count, the scheduler's in-flight guard
    // and the brand serialization all filter on campaignId. An anchor carrying one is the orphan
    // run that stopped this service creating runs at trigger time in the first place.
    expect(mockCreateRun.mock.calls[0][0]).not.toHaveProperty("campaignId");
    expect(mockCreateRun.mock.calls[0][0]).not.toHaveProperty("parentRunId");
  });

  it("persists the anchor on the campaign, so it is minted once and not per tick", async () => {
    const campaign = { ...CAMPAIGN };
    await ensureCampaignRunId(campaign);

    expect(mockDbSet).toHaveBeenCalledWith(
      expect.objectContaining({ parentRunId: "anchor-1" }),
    );
    // The in-memory row follows the write, so a second call in the same tick reuses it.
    expect(campaign.parentRunId).toBe("anchor-1");

    mockCreateRun.mockClear();
    expect(await ensureCampaignRunId(campaign)).toBe("anchor-1");
    expect(mockCreateRun).not.toHaveBeenCalled();
  });

  it("marks the anchor completed — nothing is executing under it yet", async () => {
    await ensureCampaignRunId({ ...CAMPAIGN });

    expect(mockUpdateRun).toHaveBeenCalledWith(
      "anchor-1",
      "completed",
      expect.objectContaining({ orgId: "org-1" }),
    );
  });

  it("persists BEFORE finalizing, so a failed finalize does not throw the run away", async () => {
    mockUpdateRun.mockRejectedValue(new Error("runs-service unavailable"));

    await expect(ensureCampaignRunId({ ...CAMPAIGN })).rejects.toThrow("runs-service unavailable");
    expect(mockDbSet).toHaveBeenCalledWith(
      expect.objectContaining({ parentRunId: "anchor-1" }),
    );
  });

  it("throws when the anchor cannot be created — the caller must not dispatch", async () => {
    mockCreateRun.mockRejectedValue(new Error("runs-service unavailable"));

    await expect(ensureCampaignRunId({ ...CAMPAIGN })).rejects.toThrow("runs-service unavailable");
    expect(mockDbSet).not.toHaveBeenCalled();
  });

  it("falls back to the scalar brandId when the campaign carries no brandIds array", async () => {
    await ensureCampaignRunId({ ...CAMPAIGN, brandIds: null, brandId: "brand-scalar" });

    expect(mockCreateRun.mock.calls[0][0]).toMatchObject({ brandId: "brand-scalar" });
  });
});
