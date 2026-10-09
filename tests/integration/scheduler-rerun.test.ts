import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

const { mockExecute, mockCreateRun, mockLiveDynasty } = vi.hoisted(() => ({
  mockExecute: vi.fn(),
  mockCreateRun: vi.fn(),
  mockLiveDynasty: vi.fn(),
}));

vi.mock("../../src/lib/startable-workflow-client.js", () => ({
  fetchLiveDynastyOtherThan: mockLiveDynasty,
  fetchStartableWorkflowSlug: vi.fn(),
}));

// Workflow bandit resolves to the campaign's configured slug (fallback) so the
// scheduler trigger does not make real network calls during integration tests.
vi.mock("../../src/lib/features-workflow-projection-client.js", () => ({
  resolveSelectionForTrigger: vi.fn(async (a) => ({ workflowSlug: a.fallbackSlug, audienceId: null })),
  isWorkflowRotationEnabled: () => false,
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
import { WorkflowExecutionRefusedError } from "../../src/lib/workflow-refusal.js";

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

  describe("a dispatch that fails (STUCK-DEPRECATED-RUDDER-1009)", () => {
    const deprecated = (slug: string, upgradedToWorkflowSlug: string | null = null) =>
      new WorkflowExecutionRefusedError({
        workflowSlug: slug,
        campaignId: "c",
        status: 410,
        body: JSON.stringify({ error: "Workflow has been deprecated", upgradedTo: null, upgradedToWorkflowSlug }),
      });

    async function dueCampaign(workflowSlug: string) {
      return insertTestCampaign(orgId, {
        status: "ongoing",
        workflowSlug,
        nextRunAt: new Date(Date.now() - 60_000),
        featureSlug: "sales-cold-email-v1",
        createdByUserId: "user_scheduler_test",
        parentRunId: "anchor-run",
      });
    }

    it("replaces a deprecated fallback with a live dynasty, stores it, and runs it in the same tick", async () => {
      const campaign = await dueCampaign("sales-cold-email-outreach-rudder");
      mockExecute.mockRejectedValueOnce(deprecated("sales-cold-email-outreach-rudder")).mockResolvedValueOnce(undefined);
      mockLiveDynasty.mockResolvedValue({ ok: true, workflowSlug: "sales-cold-email-outreach-compass" });

      await reRunDueCampaigns();

      expect(mockExecute.mock.calls.map((c) => c[0])).toEqual([
        "sales-cold-email-outreach-rudder",
        "sales-cold-email-outreach-compass",
      ]);
      const row = await db.query.campaigns.findFirst({ where: eq(campaigns.id, campaign.id) });
      expect(row!.workflowSlug).toBe("sales-cold-email-outreach-compass");
      expect(row!.status).toBe("ongoing");
      expect(row!.consecutiveRunFailures).toBe(0);
      // Dispatched: the run's /end-run reschedules it, exactly like any other run.
      expect(row!.nextRunAt).toBeNull();
    });

    it("takes the successor workflow-service names before asking for a live one", async () => {
      const campaign = await dueCampaign("wf-old");
      mockExecute.mockRejectedValueOnce(deprecated("wf-old", "wf-new")).mockResolvedValueOnce(undefined);

      await reRunDueCampaigns();

      expect(mockLiveDynasty).not.toHaveBeenCalled();
      expect(mockExecute.mock.calls.map((c) => c[0])).toEqual(["wf-old", "wf-new"]);
      const row = await db.query.campaigns.findFirst({ where: eq(campaigns.id, campaign.id) });
      expect(row!.workflowSlug).toBe("wf-new");
    });

    it("backs off and counts the failure when the channel has no live workflow — never stops it", async () => {
      const campaign = await dueCampaign("wf-dead");
      mockExecute.mockRejectedValue(deprecated("wf-dead"));
      mockLiveDynasty.mockResolvedValue({ ok: true, workflowSlug: null });

      const before = Date.now();
      await reRunDueCampaigns();

      const row = await db.query.campaigns.findFirst({ where: eq(campaigns.id, campaign.id) });
      expect(row!.status).toBe("ongoing");
      expect(row!.workflowSlug).toBe("wf-dead");
      expect(row!.consecutiveRunFailures).toBe(1);
      // A FUTURE next_run_at: the stuck sweep only claims NULL, so it no longer re-claims every tick.
      expect(row!.nextRunAt!.getTime()).toBeGreaterThanOrEqual(before + 59_000);
    });

    it("any refused dispatch enters the failure backoff, and the streak widens the interval", async () => {
      const campaign = await dueCampaign("wf-x");
      mockExecute.mockRejectedValue(new Error("workflow-service 500"));
      await db.update(campaigns).set({ consecutiveRunFailures: 5, lastRunFailureAt: new Date() }).where(eq(campaigns.id, campaign.id));

      const before = Date.now();
      await reRunDueCampaigns();

      const row = await db.query.campaigns.findFirst({ where: eq(campaigns.id, campaign.id) });
      expect(row!.consecutiveRunFailures).toBe(6);
      // 6th failure in a row: 60s × 2^3 = 8 min.
      expect(row!.nextRunAt!.getTime()).toBeGreaterThanOrEqual(before + 8 * 60_000 - 1_000);
      expect(mockLiveDynasty).not.toHaveBeenCalled();
    });
  });
});
