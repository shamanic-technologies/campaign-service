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

vi.mock("@mcpfactory/runs-client", () => ({
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

describe("Pipeline routes", () => {
  const orgId = "org_internal_test";
  const brandId = crypto.randomUUID();

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
    it("should return 400 if campaignId is missing", async () => {
      await request(app)
        .post("/gate-check")
        .set("x-api-key", API_KEY)
        .send({ orgId: "some-org" })
        .expect(400);
    });

    it("should return 400 if orgId is missing", async () => {
      await request(app)
        .post("/gate-check")
        .set("x-api-key", API_KEY)
        .send({ campaignId: crypto.randomUUID() })
        .expect(400);
    });

    it("should return 404 if campaign not found", async () => {
      const res = await request(app)
        .post("/gate-check")
        .set("x-api-key", API_KEY)
        .send({ campaignId: crypto.randomUUID(), orgId: "nonexistent-org" })
        .expect(404);

      expect(res.body.error).toBe("Campaign not found");
    });

    it("should return allowed: true when gate checks pass", async () => {
      const campaign = await insertTestCampaign(orgId, {
        brandUrl: "https://example.com",
        brandId,
      });

      const res = await request(app)
        .post("/gate-check")
        .set("x-api-key", API_KEY)
        .send({ campaignId: campaign.id, orgId })
        .expect(200);

      expect(res.body.allowed).toBe(true);
      expect(res.body.reason).toBeUndefined();
    });

    it("should return allowed: false with reason when gate checks fail", async () => {
      const campaign = await insertTestCampaign(orgId, {
        brandUrl: "https://example.com",
        brandId,
      });

      mockGateChecks.mockResolvedValue({
        allowed: false,
        reason: "daily budget exceeded",
      });

      const res = await request(app)
        .post("/gate-check")
        .set("x-api-key", API_KEY)
        .send({ campaignId: campaign.id, orgId })
        .expect(200);

      expect(res.body.allowed).toBe(false);
      expect(res.body.reason).toBe("daily budget exceeded");
    });

    it("should return autoStopped flag when campaign is auto-stopped", async () => {
      const campaign = await insertTestCampaign(orgId, {
        brandUrl: "https://example.com",
        brandId,
      });

      mockGateChecks.mockResolvedValue({
        allowed: false,
        reason: "Total budget exceeded",
        autoStopped: true,
      });

      const res = await request(app)
        .post("/gate-check")
        .set("x-api-key", API_KEY)
        .send({ campaignId: campaign.id, orgId })
        .expect(200);

      expect(res.body.allowed).toBe(false);
      expect(res.body.autoStopped).toBe(true);
    });

    it("should save toResumeAt to DB when gate-check returns it", async () => {
      const campaign = await insertTestCampaign(orgId, {
        brandUrl: "https://example.com",
        brandId,
      });

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
        .set("x-api-key", API_KEY)
        .send({ campaignId: campaign.id, orgId })
        .expect(200);

      // Verify toResumeAt was saved to the DB
      const updated = await db.query.campaigns.findFirst({
        where: eq(campaigns.id, campaign.id),
      });
      expect(updated!.toResumeAt).not.toBeNull();
      expect(new Date(updated!.toResumeAt!).getTime()).toBe(tomorrow.getTime());
    });

    it("should NOT save toResumeAt when gate-check does not return it", async () => {
      const campaign = await insertTestCampaign(orgId, {
        brandUrl: "https://example.com",
        brandId,
      });

      mockGateChecks.mockResolvedValue({
        allowed: false,
        reason: "Total budget exceeded",
        autoStopped: true,
      });

      await request(app)
        .post("/gate-check")
        .set("x-api-key", API_KEY)
        .send({ campaignId: campaign.id, orgId })
        .expect(200);

      const updated = await db.query.campaigns.findFirst({
        where: eq(campaigns.id, campaign.id),
      });
      expect(updated!.toResumeAt).toBeNull();
    });

    it("should pass campaign data to runGateChecks", async () => {
      const campaign = await insertTestCampaign(orgId, {
        brandUrl: "https://example.com",
        brandId,
        maxBudgetDailyUsd: "50.00",
        maxLeads: 100,
      });

      await request(app)
        .post("/gate-check")
        .set("x-api-key", API_KEY)
        .send({ campaignId: campaign.id, orgId })
        .expect(200);

      expect(mockGateChecks).toHaveBeenCalledWith(
        expect.objectContaining({
          campaignId: campaign.id,
          orgId,
          brandId,
          status: "ongoing",
          maxBudgetDailyUsd: "50.00",
          maxLeads: 100,
        }),
      );
    });
  });

  // === POST /start-run ===

  describe("POST /start-run", () => {
    it("should return 400 if campaignId is missing", async () => {
      await request(app)
        .post("/start-run")
        .set("x-api-key", API_KEY)
        .send({ orgId: "some-org" })
        .expect(400);
    });

    it("should return 404 if campaign not found", async () => {
      const res = await request(app)
        .post("/start-run")
        .set("x-api-key", API_KEY)
        .send({ campaignId: crypto.randomUUID(), orgId: "nonexistent-org" })
        .expect(404);

      expect(res.body.error).toBe("Campaign not found");
    });

    it("should return 400 if campaign has no brandUrl", async () => {
      const campaign = await insertTestCampaign(orgId, {
        brandId,
        brandUrl: undefined,
      });

      const res = await request(app)
        .post("/start-run")
        .set("x-api-key", API_KEY)
        .send({ campaignId: campaign.id, orgId })
        .expect(400);

      expect(res.body.error).toBe("Campaign has no brandUrl");
    });

    it("should return 400 if campaign has no brandId", async () => {
      const campaign = await insertTestCampaign(orgId, {
        brandUrl: "https://example.com",
        brandId: undefined,
      });

      const res = await request(app)
        .post("/start-run")
        .set("x-api-key", API_KEY)
        .send({ campaignId: campaign.id, orgId })
        .expect(400);

      expect(res.body.error).toBe("Campaign has no brandId");
    });

    it("should return 200 with campaign data and runId", async () => {
      const campaign = await insertTestCampaign(orgId, {
        brandUrl: "https://example.com",
        brandId,
      });

      const res = await request(app)
        .post("/start-run")
        .set("x-api-key", API_KEY)
        .send({ campaignId: campaign.id, orgId })
        .expect(200);

      expect(res.body.runId).toBe("run-123");
      expect(res.body.campaignId).toBe(campaign.id);
      expect(res.body.orgId).toBe(orgId);
      expect(res.body.brandId).toBe(brandId);
      expect(res.body.brandUrl).toBe("https://example.com");
      expect(res.body.brandDomain).toBe("example.com");
      expect(res.body.workflowName).toBe("sales-email-cold-outreach");
      expect(res.body).not.toHaveProperty("appId");
      expect(res.body).not.toHaveProperty("keySource");
    });

    it("should not return sales-specific fields", async () => {
      const campaign = await insertTestCampaign(orgId, {
        brandUrl: "https://example.com",
        brandId,
      });

      const res = await request(app)
        .post("/start-run")
        .set("x-api-key", API_KEY)
        .send({ campaignId: campaign.id, orgId })
        .expect(200);

      expect(res.body).not.toHaveProperty("urgency");
      expect(res.body).not.toHaveProperty("scarcity");
      expect(res.body).not.toHaveProperty("riskReversal");
      expect(res.body).not.toHaveProperty("socialProof");
    });

    it("should have null searchParams when no featureInputs", async () => {
      const campaign = await insertTestCampaign(orgId, {
        brandUrl: "https://example.com",
        brandId,
      });

      const res = await request(app)
        .post("/start-run")
        .set("x-api-key", API_KEY)
        .send({ campaignId: campaign.id, orgId })
        .expect(200);

      expect(res.body.searchParams).toBeNull();
    });

    it("should extract brandDomain from brandUrl", async () => {
      const campaign = await insertTestCampaign(orgId, {
        brandUrl: "https://www.example.com/path",
        brandId,
      });

      const res = await request(app)
        .post("/start-run")
        .set("x-api-key", API_KEY)
        .send({ campaignId: campaign.id, orgId })
        .expect(200);

      expect(res.body.brandDomain).toBe("example.com");
      expect(res.body.brandUrl).toBe("https://www.example.com/path");
    });

    it("should pass x-run-id header as parentRunId to createRun", async () => {
      const parentRunId = crypto.randomUUID();
      const campaign = await insertTestCampaign(orgId, {
        brandUrl: "https://example.com",
        brandId,
      });

      await request(app)
        .post("/start-run")
        .set("x-api-key", API_KEY)
        .set("x-run-id", parentRunId)
        .send({ campaignId: campaign.id, orgId })
        .expect(200);

      expect(mockCreateRun).toHaveBeenCalledWith(
        expect.objectContaining({ parentRunId }),
      );
    });

    it("should NOT pass parentRunId to createRun when x-run-id header is absent", async () => {
      const campaign = await insertTestCampaign(orgId, {
        brandUrl: "https://example.com",
        brandId,
      });

      await request(app)
        .post("/start-run")
        .set("x-api-key", API_KEY)
        .send({ campaignId: campaign.id, orgId })
        .expect(200);

      expect(mockCreateRun).toHaveBeenCalledWith(
        expect.not.objectContaining({ parentRunId: expect.any(String) }),
      );
    });

    it("should pass workflowName to createRun", async () => {
      const campaign = await insertTestCampaign(orgId, {
        brandUrl: "https://example.com",
        brandId,
        workflowName: "pr-email-cold-outreach",
      });

      await request(app)
        .post("/start-run")
        .set("x-api-key", API_KEY)
        .send({ campaignId: campaign.id, orgId })
        .expect(200);

      expect(mockCreateRun).toHaveBeenCalledWith(
        expect.objectContaining({ workflowName: "pr-email-cold-outreach" }),
      );
    });

    it("should pass featureSlug to createRun", async () => {
      const campaign = await insertTestCampaign(orgId, {
        brandUrl: "https://example.com",
        brandId,
      });

      await request(app)
        .post("/start-run")
        .set("x-api-key", API_KEY)
        .set("x-feature-slug", "sales-cold-email-v1")
        .send({ campaignId: campaign.id, orgId })
        .expect(200);

      expect(mockCreateRun).toHaveBeenCalledWith(
        expect.objectContaining({ featureSlug: "sales-cold-email-v1" }),
      );
    });

    it("should prefer x-feature-slug header over campaign.featureSlug", async () => {
      const campaign = await insertTestCampaign(orgId, {
        brandUrl: "https://example.com",
        brandId,
        featureSlug: "old-slug",
      });

      await request(app)
        .post("/start-run")
        .set("x-api-key", API_KEY)
        .set("x-feature-slug", "header-slug")
        .send({ campaignId: campaign.id, orgId })
        .expect(200);

      expect(mockCreateRun).toHaveBeenCalledWith(
        expect.objectContaining({ featureSlug: "header-slug" }),
      );
    });

    it("should return featureSlug and featureInputs when set", async () => {
      const campaign = await insertTestCampaign(orgId, {
        brandUrl: "https://example.com",
        brandId,
        featureSlug: "pr-media-pitch-v1",
        featureInputs: { mediaType: "podcast", region: "US" },
      });

      const res = await request(app)
        .post("/start-run")
        .set("x-api-key", API_KEY)
        .send({ campaignId: campaign.id, orgId })
        .expect(200);

      expect(res.body.featureSlug).toBe("pr-media-pitch-v1");
      expect(res.body.featureInputs).toEqual({ mediaType: "podcast", region: "US" });
    });

    it("should use featureInputs as searchParams when available", async () => {
      const campaign = await insertTestCampaign(orgId, {
        brandUrl: "https://example.com",
        brandId,
        featureInputs: { mediaType: "podcast", region: "US" },
      });

      const res = await request(app)
        .post("/start-run")
        .set("x-api-key", API_KEY)
        .send({ campaignId: campaign.id, orgId })
        .expect(200);

      expect(res.body.searchParams).toEqual({ mediaType: "podcast", region: "US" });
    });

    it("should NOT call gate checks (gate check is a separate DAG node)", async () => {
      const campaign = await insertTestCampaign(orgId, {
        brandUrl: "https://example.com",
        brandId,
      });

      await request(app)
        .post("/start-run")
        .set("x-api-key", API_KEY)
        .send({ campaignId: campaign.id, orgId })
        .expect(200);

      expect(mockGateChecks).not.toHaveBeenCalled();
    });

    it("should not pass appId to createRun", async () => {
      const campaign = await insertTestCampaign(orgId, {
        brandUrl: "https://example.com",
        brandId,
      });

      await request(app)
        .post("/start-run")
        .set("x-api-key", API_KEY)
        .send({ campaignId: campaign.id, orgId })
        .expect(200);

      const callArgs = mockCreateRun.mock.calls[0][0];
      expect(callArgs).not.toHaveProperty("appId");
    });
  });

  // === POST /end-run ===

  describe("POST /end-run", () => {
    it("should return 400 if required fields are missing", async () => {
      await request(app)
        .post("/end-run")
        .set("x-api-key", API_KEY)
        .send({ campaignId: crypto.randomUUID(), orgId: "org-1" })
        .expect(400);
    });

    it("should find and mark running run as completed when success is true", async () => {
      const campaign = await insertTestCampaign(orgId, {
        brandUrl: "https://example.com",
        brandId,
      });

      mockListRuns.mockResolvedValue({
        runs: [
          { id: "run-123", status: "running", startedAt: new Date().toISOString() },
        ],
      });

      const res = await request(app)
        .post("/end-run")
        .set("x-api-key", API_KEY)
        .send({
          campaignId: campaign.id,
          orgId,
          success: true,
        })
        .expect(200);

      expect(res.body.status).toBe("completed");
      expect(mockUpdateRun).toHaveBeenCalledWith("run-123", "completed", expect.objectContaining({ orgId }));
    });

    it("should find and mark running run as failed when success is false", async () => {
      const campaign = await insertTestCampaign(orgId, {
        brandUrl: "https://example.com",
        brandId,
      });

      mockListRuns.mockResolvedValue({
        runs: [
          { id: "run-456", status: "running", startedAt: new Date().toISOString() },
        ],
      });

      const res = await request(app)
        .post("/end-run")
        .set("x-api-key", API_KEY)
        .send({
          campaignId: campaign.id,
          orgId,
          success: false,
        })
        .expect(200);

      expect(res.body.status).toBe("failed");
      expect(mockUpdateRun).toHaveBeenCalledWith("run-456", "failed", expect.objectContaining({ orgId }));
    });

    it("should skip run update when no running runs exist (gate-check blocked)", async () => {
      const campaign = await insertTestCampaign(orgId, {
        brandUrl: "https://example.com",
        brandId,
      });

      mockListRuns.mockResolvedValue({ runs: [] });

      const res = await request(app)
        .post("/end-run")
        .set("x-api-key", API_KEY)
        .send({
          campaignId: campaign.id,
          orgId,
          success: false,
        })
        .expect(200);

      expect(res.body.status).toBe("failed");
      expect(mockUpdateRun).not.toHaveBeenCalled();
    });

    it("should re-trigger workflow using workflowName if campaign is still ongoing", async () => {
      const campaign = await insertTestCampaign(orgId, {
        brandUrl: "https://example.com",
        brandId,
        status: "ongoing",
        workflowName: "sales-email-cold-outreach",
        featureSlug: "sales-cold-email-v1",
      });

      const runId = crypto.randomUUID();
      await request(app)
        .post("/end-run")
        .set("x-api-key", API_KEY)
        .set("x-org-id", orgId)
        .set("x-run-id", runId)
        .set("x-user-id", "user_test")
        .set("x-brand-id", brandId)
        .set("x-campaign-id", campaign.id)
        .set("x-feature-slug", "sales-cold-email-v1")
        .send({
          campaignId: campaign.id,
          orgId,
          success: true,
        })
        .expect(200);

      // Wait for async re-trigger
      await new Promise((r) => setTimeout(r, 100));

      expect(mockExecute).toHaveBeenCalledWith(
        "sales-email-cold-outreach",
        expect.objectContaining({
          campaignId: campaign.id,
          orgId,
          runId,
        }),
      );
    });

    it("should forward x-run-id header to re-triggered workflow", async () => {
      const campaign = await insertTestCampaign(orgId, {
        brandUrl: "https://example.com",
        brandId,
        status: "ongoing",
        workflowName: "sales-email-cold-outreach",
        featureSlug: "sales-cold-email-v1",
      });

      const parentRunId = crypto.randomUUID();
      await request(app)
        .post("/end-run")
        .set("x-api-key", API_KEY)
        .set("x-org-id", orgId)
        .set("x-run-id", parentRunId)
        .set("x-user-id", "user_test")
        .set("x-brand-id", brandId)
        .set("x-campaign-id", campaign.id)
        .set("x-feature-slug", "sales-cold-email-v1")
        .send({
          campaignId: campaign.id,
          orgId,
          success: false,
        })
        .expect(200);

      // Wait for async re-trigger
      await new Promise((r) => setTimeout(r, 100));

      expect(mockExecute).toHaveBeenCalledWith(
        "sales-email-cold-outreach",
        expect.objectContaining({ runId: parentRunId }),
      );
    });

    it("should NOT re-trigger if campaign is stopped", async () => {
      const campaign = await insertTestCampaign(orgId, {
        brandUrl: "https://example.com",
        brandId,
        status: "stopped",
      });

      await request(app)
        .post("/end-run")
        .set("x-api-key", API_KEY)
        .send({
          campaignId: campaign.id,
          orgId,
          success: true,
        })
        .expect(200);

      await new Promise((r) => setTimeout(r, 100));

      expect(mockExecute).not.toHaveBeenCalled();
    });

    it("should auto-stop campaign and NOT re-trigger when leadFound is false", async () => {
      const campaign = await insertTestCampaign(orgId, {
        brandUrl: "https://example.com",
        brandId,
        status: "ongoing",
      });

      mockListRuns.mockResolvedValue({
        runs: [
          { id: "run-789", status: "running", startedAt: new Date().toISOString() },
        ],
      });

      const res = await request(app)
        .post("/end-run")
        .set("x-api-key", API_KEY)
        .send({
          campaignId: campaign.id,
          orgId,
          success: true,
          leadFound: false,
        })
        .expect(200);

      expect(res.body.status).toBe("completed");
      expect(mockUpdateRun).toHaveBeenCalledWith("run-789", "completed", expect.objectContaining({ orgId }));

      // Wait for async auto-stop
      await new Promise((r) => setTimeout(r, 100));

      // Should NOT re-trigger
      expect(mockExecute).not.toHaveBeenCalled();
    });

    it("should re-trigger normally when leadFound is true", async () => {
      const campaign = await insertTestCampaign(orgId, {
        brandUrl: "https://example.com",
        brandId,
        status: "ongoing",
        featureSlug: "sales-cold-email-v1",
      });

      mockListRuns.mockResolvedValue({
        runs: [
          { id: "run-101", status: "running", startedAt: new Date().toISOString() },
        ],
      });

      await request(app)
        .post("/end-run")
        .set("x-api-key", API_KEY)
        .set("x-org-id", orgId)
        .set("x-user-id", "user_test")
        .set("x-run-id", crypto.randomUUID())
        .set("x-brand-id", brandId)
        .set("x-campaign-id", campaign.id)
        .set("x-feature-slug", "sales-cold-email-v1")
        .send({
          campaignId: campaign.id,
          orgId,
          success: true,
          leadFound: true,
        })
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
      const campaign = await insertTestCampaign(orgId, {
        brandUrl: "https://example.com",
        brandId,
      });

      mockListRuns.mockResolvedValue({ runs: [] });

      await request(app)
        .post("/end-run")
        .set("x-api-key", API_KEY)
        .send({
          campaignId: campaign.id,
          orgId,
          success: true,
        })
        .expect(200);

      const callArgs = mockListRuns.mock.calls[0][0];
      expect(callArgs).not.toHaveProperty("appId");
    });
  });
});
