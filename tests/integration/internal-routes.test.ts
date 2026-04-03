import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";

const {
  mockCreateRun,
  mockUpdateRun,
  mockListRuns,
  mockExecute,
  mockGateChecks,
} = vi.hoisted(() => ({
  mockCreateRun: vi.fn(),
  mockUpdateRun: vi.fn(),
  mockListRuns: vi.fn(),
  mockExecute: vi.fn(),
  mockGateChecks: vi.fn(),
}));

vi.mock("@distribute/runs-client", () => ({
  createRun: mockCreateRun,
  updateRun: mockUpdateRun,
  listRuns: mockListRuns,
  getStatsBudget: vi.fn(),
}));

vi.mock("../../src/lib/workflows.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/lib/workflows.js")>();
  return {
    ...original,
    executeCampaignWorkflow: mockExecute,
  };
});

vi.mock("../../src/lib/gate-check.js", () => ({
  runGateChecks: mockGateChecks,
}));

import app from "../../src/index.js";
import { db } from "../../src/db/index.js";
import { campaigns } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import { cleanTestData, closeDb, insertTestCampaign } from "../helpers/test-db.js";

const API_KEY = process.env.CAMPAIGN_SERVICE_API_KEY || "test-api-key";

/** All required pipeline headers for a valid DAG request */
function pipelineHeaders(overrides: Record<string, string> = {}) {
  return {
    "x-api-key": API_KEY,
    "x-org-id": overrides["x-org-id"] ?? "org_internal_test",
    "x-campaign-id": overrides["x-campaign-id"] ?? crypto.randomUUID(),
    "x-user-id": overrides["x-user-id"] ?? "user_test",
    "x-run-id": overrides["x-run-id"] ?? crypto.randomUUID(),
    "x-workflow-slug": overrides["x-workflow-slug"] ?? "sales-email-cold-outreach",
    "x-feature-slug": overrides["x-feature-slug"] ?? "sales-cold-email-v1",
  };
}

describe("Pipeline routes", () => {
  const orgId = "org_internal_test";
  const brandIds = [crypto.randomUUID()];

  beforeEach(async () => {
    await cleanTestData();
    vi.clearAllMocks();

    // Default mock behaviors
    mockCreateRun.mockResolvedValue({ id: "run-123" });
    mockUpdateRun.mockResolvedValue({});
    mockListRuns.mockResolvedValue({ runs: [] });
    mockGateChecks.mockResolvedValue({ allowed: true });
    mockExecute.mockResolvedValue(undefined);
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  // === POST /gate-check ===

  describe("POST /gate-check", () => {
    it("should return 400 if x-campaign-id header is missing", async () => {
      const headers = pipelineHeaders();
      delete (headers as any)["x-campaign-id"];
      await request(app)
        .post("/gate-check")
        .set(headers)
        .expect(400);
    });

    it("should return 400 if x-org-id header is missing", async () => {
      const headers = pipelineHeaders();
      delete (headers as any)["x-org-id"];
      await request(app)
        .post("/gate-check")
        .set(headers)
        .expect(400);
    });

    it("should return 400 if x-workflow-slug header is missing", async () => {
      const headers = pipelineHeaders();
      delete (headers as any)["x-workflow-slug"];
      await request(app)
        .post("/gate-check")
        .set(headers)
        .expect(400);
    });

    it("should return 400 if x-user-id header is missing", async () => {
      const headers = pipelineHeaders();
      delete (headers as any)["x-user-id"];
      await request(app)
        .post("/gate-check")
        .set(headers)
        .expect(400);
    });

    it("should return 400 if x-feature-slug header is missing", async () => {
      const headers = pipelineHeaders();
      delete (headers as any)["x-feature-slug"];
      await request(app)
        .post("/gate-check")
        .set(headers)
        .expect(400);
    });

    it("should return 404 if campaign not found", async () => {
      const res = await request(app)
        .post("/gate-check")
        .set(pipelineHeaders({ "x-org-id": "nonexistent-org" }))
        .expect(404);

      expect(res.body.error).toBe("Campaign not found");
    });

    it("should return allowed: true when gate checks pass", async () => {
      const campaign = await insertTestCampaign(orgId, { brandIds });

      const res = await request(app)
        .post("/gate-check")
        .set(pipelineHeaders({ "x-org-id": orgId, "x-campaign-id": campaign.id }))
        .expect(200);

      expect(res.body.allowed).toBe(true);
      expect(res.body.reason).toBeUndefined();
    });

    it("should return allowed: false with reason when gate checks fail", async () => {
      const campaign = await insertTestCampaign(orgId, { brandIds });

      mockGateChecks.mockResolvedValue({
        allowed: false,
        reason: "daily budget exceeded",
      });

      const res = await request(app)
        .post("/gate-check")
        .set(pipelineHeaders({ "x-org-id": orgId, "x-campaign-id": campaign.id }))
        .expect(200);

      expect(res.body.allowed).toBe(false);
      expect(res.body.reason).toBe("daily budget exceeded");
    });

    it("should return autoStopped flag when campaign is auto-stopped", async () => {
      const campaign = await insertTestCampaign(orgId, { brandIds });

      mockGateChecks.mockResolvedValue({
        allowed: false,
        reason: "Total budget exceeded",
        autoStopped: true,
      });

      const res = await request(app)
        .post("/gate-check")
        .set(pipelineHeaders({ "x-org-id": orgId, "x-campaign-id": campaign.id }))
        .expect(200);

      expect(res.body.allowed).toBe(false);
      expect(res.body.autoStopped).toBe(true);
    });

    it("should save toResumeAt to DB when gate-check returns it", async () => {
      const campaign = await insertTestCampaign(orgId, { brandIds });

      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(0, 0, 0, 0);

      mockGateChecks.mockResolvedValue({
        allowed: false,
        reason: "daily budget exceeded",
        toResumeAt: tomorrow,
      });

      await request(app)
        .post("/gate-check")
        .set(pipelineHeaders({ "x-org-id": orgId, "x-campaign-id": campaign.id }))
        .expect(200);

      const updated = await db.query.campaigns.findFirst({
        where: eq(campaigns.id, campaign.id),
      });
      expect(updated!.toResumeAt).not.toBeNull();
      expect(new Date(updated!.toResumeAt!).getTime()).toBe(tomorrow.getTime());
    });

    it("should NOT save toResumeAt when gate-check does not return it", async () => {
      const campaign = await insertTestCampaign(orgId, { brandIds });

      mockGateChecks.mockResolvedValue({
        allowed: false,
        reason: "Total budget exceeded",
        autoStopped: true,
      });

      await request(app)
        .post("/gate-check")
        .set(pipelineHeaders({ "x-org-id": orgId, "x-campaign-id": campaign.id }))
        .expect(200);

      const updated = await db.query.campaigns.findFirst({
        where: eq(campaigns.id, campaign.id),
      });
      expect(updated!.toResumeAt).toBeNull();
    });

    it("should pass campaign data to runGateChecks", async () => {
      const campaign = await insertTestCampaign(orgId, {
        brandIds,
        maxBudgetDailyUsd: "50.00",
        maxLeads: 100,
      });

      await request(app)
        .post("/gate-check")
        .set(pipelineHeaders({ "x-org-id": orgId, "x-campaign-id": campaign.id }))
        .expect(200);

      expect(mockGateChecks).toHaveBeenCalledWith(
        expect.objectContaining({
          campaignId: campaign.id,
          orgId,
          brandId: brandIds.join(","),
          status: "ongoing",
          maxBudgetDailyUsd: "50.00",
          maxLeads: 100,
        }),
      );
    });
  });

  // === POST /start-run ===

  describe("POST /start-run", () => {
    it("should return 400 if x-campaign-id header is missing", async () => {
      const headers = pipelineHeaders();
      delete (headers as any)["x-campaign-id"];
      await request(app)
        .post("/start-run")
        .set(headers)
        .expect(400);
    });

    it("should return 400 if x-user-id header is missing", async () => {
      const headers = pipelineHeaders();
      delete (headers as any)["x-user-id"];
      await request(app)
        .post("/start-run")
        .set(headers)
        .expect(400);
    });

    it("should return 404 if campaign not found", async () => {
      const res = await request(app)
        .post("/start-run")
        .set(pipelineHeaders({ "x-org-id": "nonexistent-org" }))
        .expect(404);

      expect(res.body.error).toBe("Campaign not found");
    });

    it("should return 400 if campaign has no brandIds", async () => {
      const campaign = await insertTestCampaign(orgId, {
        brandIds: undefined,
      });

      const res = await request(app)
        .post("/start-run")
        .set(pipelineHeaders({ "x-org-id": orgId, "x-campaign-id": campaign.id }))
        .expect(400);

      expect(res.body.error).toBe("Campaign has no brandIds");
    });

    it("should return 200 with campaign data and runId", async () => {
      const campaign = await insertTestCampaign(orgId, { brandIds });

      const res = await request(app)
        .post("/start-run")
        .set(pipelineHeaders({ "x-org-id": orgId, "x-campaign-id": campaign.id }))
        .expect(200);

      expect(res.body.runId).toBe("run-123");
      expect(res.body.campaignId).toBe(campaign.id);
      expect(res.body.orgId).toBe(orgId);
      expect(res.body.brandIds).toEqual(brandIds);
      expect(res.body.workflowSlug).toBe("sales-email-cold-outreach");
      expect(res.body).not.toHaveProperty("appId");
      expect(res.body).not.toHaveProperty("keySource");
    });

    it("should not return sales-specific fields", async () => {
      const campaign = await insertTestCampaign(orgId, { brandIds });

      const res = await request(app)
        .post("/start-run")
        .set(pipelineHeaders({ "x-org-id": orgId, "x-campaign-id": campaign.id }))
        .expect(200);

      expect(res.body).not.toHaveProperty("urgency");
      expect(res.body).not.toHaveProperty("scarcity");
      expect(res.body).not.toHaveProperty("riskReversal");
      expect(res.body).not.toHaveProperty("socialProof");
    });

    it("should have null searchParams when no featureInputs", async () => {
      const campaign = await insertTestCampaign(orgId, { brandIds });

      const res = await request(app)
        .post("/start-run")
        .set(pipelineHeaders({ "x-org-id": orgId, "x-campaign-id": campaign.id }))
        .expect(200);

      expect(res.body.searchParams).toBeNull();
    });

    it("should pass x-run-id header as parentRunId to createRun", async () => {
      const parentRunId = crypto.randomUUID();
      const campaign = await insertTestCampaign(orgId, { brandIds });

      await request(app)
        .post("/start-run")
        .set(pipelineHeaders({
          "x-org-id": orgId,
          "x-campaign-id": campaign.id,
          "x-run-id": parentRunId,
        }))
        .expect(200);

      expect(mockCreateRun).toHaveBeenCalledWith(
        expect.objectContaining({ parentRunId }),
      );
    });

    it("should pass workflowSlug to createRun", async () => {
      const campaign = await insertTestCampaign(orgId, {
        brandIds,
        workflowSlug: "pr-email-cold-outreach",
      });

      await request(app)
        .post("/start-run")
        .set(pipelineHeaders({ "x-org-id": orgId, "x-campaign-id": campaign.id }))
        .expect(200);

      expect(mockCreateRun).toHaveBeenCalledWith(
        expect.objectContaining({ workflowSlug: "pr-email-cold-outreach" }),
      );
    });

    it("should pass featureSlug to createRun", async () => {
      const campaign = await insertTestCampaign(orgId, { brandIds });

      await request(app)
        .post("/start-run")
        .set(pipelineHeaders({
          "x-org-id": orgId,
          "x-campaign-id": campaign.id,
          "x-feature-slug": "sales-cold-email-v1",
        }))
        .expect(200);

      expect(mockCreateRun).toHaveBeenCalledWith(
        expect.objectContaining({ featureSlug: "sales-cold-email-v1" }),
      );
    });

    it("should prefer x-feature-slug header over campaign.featureSlug", async () => {
      const campaign = await insertTestCampaign(orgId, {
        brandIds,
        featureSlug: "old-slug",
      });

      await request(app)
        .post("/start-run")
        .set(pipelineHeaders({
          "x-org-id": orgId,
          "x-campaign-id": campaign.id,
          "x-feature-slug": "header-slug",
        }))
        .expect(200);

      expect(mockCreateRun).toHaveBeenCalledWith(
        expect.objectContaining({ featureSlug: "header-slug" }),
      );
    });

    it("should return featureSlug and featureInputs when set", async () => {
      const campaign = await insertTestCampaign(orgId, {
        brandIds,
        featureSlug: "pr-media-pitch-v1",
        featureInputs: { mediaType: "podcast", region: "US" },
      });

      const res = await request(app)
        .post("/start-run")
        .set(pipelineHeaders({ "x-org-id": orgId, "x-campaign-id": campaign.id }))
        .expect(200);

      expect(res.body.featureSlug).toBe("pr-media-pitch-v1");
      expect(res.body.featureInputs).toEqual({ mediaType: "podcast", region: "US" });
    });

    it("should use featureInputs as searchParams when available", async () => {
      const campaign = await insertTestCampaign(orgId, {
        brandIds,
        featureInputs: { mediaType: "podcast", region: "US" },
      });

      const res = await request(app)
        .post("/start-run")
        .set(pipelineHeaders({ "x-org-id": orgId, "x-campaign-id": campaign.id }))
        .expect(200);

      expect(res.body.searchParams).toEqual({ mediaType: "podcast", region: "US" });
    });

    it("should NOT call gate checks (gate check is a separate DAG node)", async () => {
      const campaign = await insertTestCampaign(orgId, { brandIds });

      await request(app)
        .post("/start-run")
        .set(pipelineHeaders({ "x-org-id": orgId, "x-campaign-id": campaign.id }))
        .expect(200);

      expect(mockGateChecks).not.toHaveBeenCalled();
    });

    it("should not pass appId to createRun", async () => {
      const campaign = await insertTestCampaign(orgId, { brandIds });

      await request(app)
        .post("/start-run")
        .set(pipelineHeaders({ "x-org-id": orgId, "x-campaign-id": campaign.id }))
        .expect(200);

      const callArgs = mockCreateRun.mock.calls[0][0];
      expect(callArgs).not.toHaveProperty("appId");
    });
  });

  // === POST /end-run ===

  describe("POST /end-run", () => {
    it("should return 400 if success field is missing from body", async () => {
      const campaign = await insertTestCampaign(orgId, { brandIds });
      await request(app)
        .post("/end-run")
        .set(pipelineHeaders({ "x-org-id": orgId, "x-campaign-id": campaign.id }))
        .send({})
        .expect(400);
    });

    it("should return 400 if stopCampaign field is missing from body", async () => {
      const campaign = await insertTestCampaign(orgId, { brandIds });
      await request(app)
        .post("/end-run")
        .set(pipelineHeaders({ "x-org-id": orgId, "x-campaign-id": campaign.id }))
        .send({ success: true })
        .expect(400);
    });

    it("should return 400 if x-campaign-id header is missing", async () => {
      const headers = pipelineHeaders();
      delete (headers as any)["x-campaign-id"];
      await request(app)
        .post("/end-run")
        .set(headers)
        .send({ success: true, stopCampaign: false })
        .expect(400);
    });

    it("should return 400 if x-workflow-slug header is missing", async () => {
      const headers = pipelineHeaders();
      delete (headers as any)["x-workflow-slug"];
      await request(app)
        .post("/end-run")
        .set(headers)
        .send({ success: true, stopCampaign: false })
        .expect(400);
    });

    it("should find and mark running run as completed when success is true", async () => {
      const campaign = await insertTestCampaign(orgId, { brandIds });

      mockListRuns.mockResolvedValue({
        runs: [
          { id: "run-123", status: "running", startedAt: new Date().toISOString() },
        ],
      });

      const res = await request(app)
        .post("/end-run")
        .set(pipelineHeaders({ "x-org-id": orgId, "x-campaign-id": campaign.id }))
        .send({ success: true, stopCampaign: false })
        .expect(200);

      expect(res.body.status).toBe("completed");
      expect(mockUpdateRun).toHaveBeenCalledWith("run-123", "completed", expect.objectContaining({ orgId }));
    });

    it("should find and mark running run as failed when success is false", async () => {
      const campaign = await insertTestCampaign(orgId, { brandIds });

      mockListRuns.mockResolvedValue({
        runs: [
          { id: "run-456", status: "running", startedAt: new Date().toISOString() },
        ],
      });

      const res = await request(app)
        .post("/end-run")
        .set(pipelineHeaders({ "x-org-id": orgId, "x-campaign-id": campaign.id }))
        .send({ success: false, stopCampaign: false })
        .expect(200);

      expect(res.body.status).toBe("failed");
      expect(mockUpdateRun).toHaveBeenCalledWith("run-456", "failed", expect.objectContaining({ orgId }));
    });

    it("should skip run update when no running runs exist (gate-check blocked)", async () => {
      const campaign = await insertTestCampaign(orgId, { brandIds });

      mockListRuns.mockResolvedValue({ runs: [] });

      const res = await request(app)
        .post("/end-run")
        .set(pipelineHeaders({ "x-org-id": orgId, "x-campaign-id": campaign.id }))
        .send({ success: false, stopCampaign: false })
        .expect(200);

      expect(res.body.status).toBe("failed");
      expect(mockUpdateRun).not.toHaveBeenCalled();
    });

    it("should re-trigger workflow when stopCampaign is false and campaign is ongoing", async () => {
      const campaign = await insertTestCampaign(orgId, {
        brandIds,
        status: "ongoing",
        workflowSlug: "sales-email-cold-outreach",
        featureSlug: "sales-cold-email-v1",
        createdByUserId: "user_test",
      });

      await request(app)
        .post("/end-run")
        .set(pipelineHeaders({ "x-org-id": orgId, "x-campaign-id": campaign.id }))
        .send({ success: true, stopCampaign: false })
        .expect(200);

      // Wait for async re-trigger
      await new Promise((r) => setTimeout(r, 100));

      // end-run must NOT create a run — /start-run in the new workflow handles that.
      // Creating one here would cause gate-check to block with "A run is already in progress".
      expect(mockCreateRun).not.toHaveBeenCalled();
      expect(mockExecute).toHaveBeenCalledWith(
        "sales-email-cold-outreach",
        expect.objectContaining({
          campaignId: campaign.id,
          orgId,
        }),
      );
    });

    it("should use parentRunId from campaign as runId for re-trigger", async () => {
      const parentRunId = crypto.randomUUID();
      const campaign = await insertTestCampaign(orgId, {
        brandIds,
        status: "ongoing",
        workflowSlug: "sales-email-cold-outreach",
        featureSlug: "sales-cold-email-v1",
        createdByUserId: "user_test",
        parentRunId,
      });

      await request(app)
        .post("/end-run")
        .set(pipelineHeaders({ "x-org-id": orgId, "x-campaign-id": campaign.id }))
        .send({ success: true, stopCampaign: false })
        .expect(200);

      await new Promise((r) => setTimeout(r, 100));

      expect(mockExecute).toHaveBeenCalledWith(
        "sales-email-cold-outreach",
        expect.objectContaining({ runId: parentRunId }),
      );
    });

    it("should NOT re-trigger if campaign is stopped", async () => {
      const campaign = await insertTestCampaign(orgId, {
        brandIds,
        status: "stopped",
      });

      await request(app)
        .post("/end-run")
        .set(pipelineHeaders({ "x-org-id": orgId, "x-campaign-id": campaign.id }))
        .send({ success: true, stopCampaign: false })
        .expect(200);

      await new Promise((r) => setTimeout(r, 100));

      expect(mockExecute).not.toHaveBeenCalled();
    });

    it("should auto-stop campaign and NOT re-trigger when stopCampaign is true", async () => {
      const campaign = await insertTestCampaign(orgId, {
        brandIds,
        status: "ongoing",
      });

      mockListRuns.mockResolvedValue({
        runs: [
          { id: "run-789", status: "running", startedAt: new Date().toISOString() },
        ],
      });

      const res = await request(app)
        .post("/end-run")
        .set(pipelineHeaders({ "x-org-id": orgId, "x-campaign-id": campaign.id }))
        .send({ success: true, stopCampaign: true })
        .expect(200);

      expect(res.body.status).toBe("completed");
      expect(mockUpdateRun).toHaveBeenCalledWith("run-789", "completed", expect.objectContaining({ orgId }));

      // Wait for async auto-stop
      await new Promise((r) => setTimeout(r, 100));

      // Should NOT re-trigger
      expect(mockExecute).not.toHaveBeenCalled();

      // Should auto-stop in DB
      const updated = await db.query.campaigns.findFirst({
        where: eq(campaigns.id, campaign.id),
      });
      expect(updated!.status).toBe("stopped");
    });

    it("should re-trigger normally when stopCampaign is false", async () => {
      const campaign = await insertTestCampaign(orgId, {
        brandIds,
        status: "ongoing",
        featureSlug: "sales-cold-email-v1",
        createdByUserId: "user_test",
      });

      mockListRuns.mockResolvedValue({
        runs: [
          { id: "run-101", status: "running", startedAt: new Date().toISOString() },
        ],
      });

      await request(app)
        .post("/end-run")
        .set(pipelineHeaders({ "x-org-id": orgId, "x-campaign-id": campaign.id }))
        .send({ success: true, stopCampaign: false })
        .expect(200);

      // Wait for async re-trigger
      await new Promise((r) => setTimeout(r, 100));

      expect(mockExecute).toHaveBeenCalledWith(
        "sales-email-cold-outreach",
        expect.objectContaining({
          campaignId: campaign.id,
          orgId,
        }),
      );
    });

    it("should not pass appId to listRuns", async () => {
      const campaign = await insertTestCampaign(orgId, { brandIds });

      mockListRuns.mockResolvedValue({ runs: [] });

      await request(app)
        .post("/end-run")
        .set(pipelineHeaders({ "x-org-id": orgId, "x-campaign-id": campaign.id }))
        .send({ success: true, stopCampaign: false })
        .expect(200);

      const callArgs = mockListRuns.mock.calls[0][0];
      expect(callArgs).not.toHaveProperty("appId");
    });
  });
});
