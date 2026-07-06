import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

const { mockExecute, mockCreateRun } = vi.hoisted(() => ({
  mockExecute: vi.fn(),
  mockCreateRun: vi.fn(),
}));

// Workflow bandit resolves to the campaign's configured slug (fallback) so the
// scheduler trigger does not make real network calls during integration tests.
vi.mock("../../src/lib/features-workflow-projection-client.js", () => ({
  resolveWorkflowSlugForTrigger: vi.fn(async (a) => a.fallbackSlug),
}));

vi.mock("../../src/lib/workflows.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/lib/workflows.js")>();
  return {
    ...original,
    executeCampaignWorkflow: mockExecute,
  };
});

vi.mock("@distribute/runs-client", () => ({
  listRuns: vi.fn().mockResolvedValue({ runs: [] }),
  createRun: mockCreateRun,
  updateRun: vi.fn(),
  getStatsBudget: vi.fn(),
}));

import { db } from "../../src/db/index.js";
import { campaigns } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import { cleanTestData, closeDb, insertTestCampaign } from "../helpers/test-db.js";
import { reRunDueCampaigns } from "../../src/lib/scheduler.js";

const orgId = "scheduler-test-org";
const attribution = {
  activeGoalId: "goal_scheduler_test",
  brandProfileId: "brand_profile_scheduler_test",
  audienceId: "audience_scheduler_test",
};

describe("Scheduler - reRunDueCampaigns (integration)", () => {
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

    const count = await reRunDueCampaigns();
    expect(count).toBe(0);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("should re-run campaign whose nextRunAt is in the past", async () => {
    const pastDate = new Date(Date.now() - 60_000); // 1 minute ago
    const campaign = await insertTestCampaign(orgId, {
      status: "ongoing",
      nextRunAt: pastDate,
      featureSlug: "sales-cold-email-v1",
      createdByUserId: "user_scheduler_test",
      ...attribution,
    });

    const count = await reRunDueCampaigns();
    expect(count).toBe(1);

    // Should have cleared nextRunAt
    const updated = await db.query.campaigns.findFirst({
      where: eq(campaigns.id, campaign.id),
    });
    expect(updated!.nextRunAt).toBeNull();

    // Should have triggered workflow (run is created by /start-run in the DAG, not here)
    expect(mockExecute).toHaveBeenCalledWith(
      "sales-email-cold-outreach",
      expect.objectContaining({
        campaignId: campaign.id,
        orgId,
        ...attribution,
      }),
    );
  });

  it("should NOT resume campaign whose nextRunAt is in the future", async () => {
    const futureDate = new Date(Date.now() + 3_600_000); // 1 hour from now
    await insertTestCampaign(orgId, {
      status: "ongoing",
      nextRunAt: futureDate,
    });

    const count = await reRunDueCampaigns();
    expect(count).toBe(0);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("should NOT resume stopped campaigns even with past nextRunAt", async () => {
    const pastDate = new Date(Date.now() - 60_000);
    await insertTestCampaign(orgId, {
      status: "stopped",
      nextRunAt: pastDate,
    });

    const count = await reRunDueCampaigns();
    expect(count).toBe(0);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("should re-run multiple due campaigns", async () => {
    const pastDate = new Date(Date.now() - 60_000);

    await insertTestCampaign(orgId, {
      name: "Campaign A",
      status: "ongoing",
      nextRunAt: pastDate,
      featureSlug: "sales-cold-email-v1",
      createdByUserId: "user_scheduler_test",
    });
    await insertTestCampaign(orgId, {
      name: "Campaign B",
      status: "ongoing",
      nextRunAt: pastDate,
      featureSlug: "sales-cold-email-v1",
      createdByUserId: "user_scheduler_test",
    });

    const count = await reRunDueCampaigns();
    expect(count).toBe(2);
    expect(mockExecute).toHaveBeenCalledTimes(2);
  });
});
