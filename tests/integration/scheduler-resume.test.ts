import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

const { mockExecute, mockCreateRun } = vi.hoisted(() => ({
  mockExecute: vi.fn(),
  mockCreateRun: vi.fn(),
}));

vi.mock("../../src/lib/workflows.js", () => ({
  executeCampaignWorkflow: mockExecute,
}));

vi.mock("@mcpfactory/runs-client", () => ({
  listRuns: vi.fn().mockResolvedValue({ runs: [] }),
  createRun: mockCreateRun,
  updateRun: vi.fn(),
  getStatsBudget: vi.fn(),
}));

import { db } from "../../src/db/index.js";
import { campaigns } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import { cleanTestData, closeDb, insertTestCampaign } from "../helpers/test-db.js";
import { resumeDueCampaigns } from "../../src/lib/scheduler.js";

const orgId = "scheduler-test-org";

describe("Scheduler - resumeDueCampaigns (integration)", () => {
  beforeEach(async () => {
    await cleanTestData();
    vi.clearAllMocks();
    mockExecute.mockResolvedValue(undefined);
    mockCreateRun.mockResolvedValue({ id: "scheduler-run-123" });
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("should not trigger anything when no campaigns are due", async () => {
    await insertTestCampaign(orgId, {
      status: "ongoing",
    });

    const count = await resumeDueCampaigns();
    expect(count).toBe(0);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("should resume campaign whose toResumeAt is in the past", async () => {
    const pastDate = new Date(Date.now() - 60_000); // 1 minute ago
    const campaign = await insertTestCampaign(orgId, {
      status: "ongoing",
      toResumeAt: pastDate,
    });

    const count = await resumeDueCampaigns();
    expect(count).toBe(1);

    // Should have cleared toResumeAt
    const updated = await db.query.campaigns.findFirst({
      where: eq(campaigns.id, campaign.id),
    });
    expect(updated!.toResumeAt).toBeNull();

    // Should have created a run for the scheduler
    expect(mockCreateRun).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId,
        serviceName: "campaign-service",
        taskName: "scheduler-resume",
        campaignId: campaign.id,
      }),
    );

    // Should have triggered workflow with the scheduler run ID
    expect(mockExecute).toHaveBeenCalledWith(
      "sales-email-cold-outreach",
      expect.objectContaining({
        campaignId: campaign.id,
        orgId,
        runId: "scheduler-run-123",
      }),
    );
  });

  it("should NOT resume campaign whose toResumeAt is in the future", async () => {
    const futureDate = new Date(Date.now() + 3_600_000); // 1 hour from now
    await insertTestCampaign(orgId, {
      status: "ongoing",
      toResumeAt: futureDate,
    });

    const count = await resumeDueCampaigns();
    expect(count).toBe(0);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("should NOT resume stopped campaigns even with past toResumeAt", async () => {
    const pastDate = new Date(Date.now() - 60_000);
    await insertTestCampaign(orgId, {
      status: "stopped",
      toResumeAt: pastDate,
    });

    const count = await resumeDueCampaigns();
    expect(count).toBe(0);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("should resume multiple due campaigns", async () => {
    const pastDate = new Date(Date.now() - 60_000);

    await insertTestCampaign(orgId, {
      name: "Campaign A",
      status: "ongoing",
      toResumeAt: pastDate,
    });
    await insertTestCampaign(orgId, {
      name: "Campaign B",
      status: "ongoing",
      toResumeAt: pastDate,
    });

    const count = await resumeDueCampaigns();
    expect(count).toBe(2);
    expect(mockExecute).toHaveBeenCalledTimes(2);
  });
});
