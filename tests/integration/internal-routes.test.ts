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

vi.mock("../../src/lib/workflows.js", () => ({
  executeCampaignWorkflow: mockExecute,
}));

vi.mock("../../src/lib/gate-check.js", () => ({
  runGateChecks: mockGateChecks,
}));

import app from "../../src/index.js";
import { cleanTestData, closeDb, insertTestOrg, insertTestCampaign } from "../helpers/test-db.js";

const API_KEY = process.env.CAMPAIGN_SERVICE_API_KEY || "test-api-key";

describe("Pipeline routes", () => {
  let org: { id: string; clerkOrgId: string };
  const brandId = crypto.randomUUID();

  beforeEach(async () => {
    await cleanTestData();
    vi.clearAllMocks();

    org = await insertTestOrg({ clerkOrgId: "org_internal_test" });

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
        .send({ clerkOrgId: "some-org" })
        .expect(400);
    });

    it("should return 400 if clerkOrgId is missing", async () => {
      await request(app)
        .post("/gate-check")
        .set("x-api-key", API_KEY)
        .send({ campaignId: crypto.randomUUID() })
        .expect(400);
    });

    it("should return 404 if org not found", async () => {
      const res = await request(app)
        .post("/gate-check")
        .set("x-api-key", API_KEY)
        .send({ campaignId: crypto.randomUUID(), clerkOrgId: "nonexistent-org" })
        .expect(404);

      expect(res.body.error).toBe("Organization not found");
    });

    it("should return 404 if campaign not found", async () => {
      const res = await request(app)
        .post("/gate-check")
        .set("x-api-key", API_KEY)
        .send({ campaignId: crypto.randomUUID(), clerkOrgId: org.clerkOrgId })
        .expect(404);

      expect(res.body.error).toBe("Campaign not found");
    });

    it("should return allowed: true when gate checks pass", async () => {
      const campaign = await insertTestCampaign(org.id, {
        brandUrl: "https://example.com",
        brandId,
      });

      const res = await request(app)
        .post("/gate-check")
        .set("x-api-key", API_KEY)
        .send({ campaignId: campaign.id, clerkOrgId: org.clerkOrgId })
        .expect(200);

      expect(res.body.allowed).toBe(true);
      expect(res.body.reason).toBeUndefined();
    });

    it("should return allowed: false with reason when gate checks fail", async () => {
      const campaign = await insertTestCampaign(org.id, {
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
        .send({ campaignId: campaign.id, clerkOrgId: org.clerkOrgId })
        .expect(200);

      expect(res.body.allowed).toBe(false);
      expect(res.body.reason).toBe("daily budget exceeded");
    });

    it("should return autoStopped flag when campaign is auto-stopped", async () => {
      const campaign = await insertTestCampaign(org.id, {
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
        .send({ campaignId: campaign.id, clerkOrgId: org.clerkOrgId })
        .expect(200);

      expect(res.body.allowed).toBe(false);
      expect(res.body.autoStopped).toBe(true);
    });

    it("should pass campaign data to runGateChecks", async () => {
      const campaign = await insertTestCampaign(org.id, {
        brandUrl: "https://example.com",
        brandId,
        maxBudgetDailyUsd: "50.00",
        maxLeads: 100,
      });

      await request(app)
        .post("/gate-check")
        .set("x-api-key", API_KEY)
        .send({ campaignId: campaign.id, clerkOrgId: org.clerkOrgId })
        .expect(200);

      expect(mockGateChecks).toHaveBeenCalledWith(
        expect.objectContaining({
          campaignId: campaign.id,
          clerkOrgId: org.clerkOrgId,
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
        .send({ clerkOrgId: "some-org" })
        .expect(400);
    });

    it("should return 404 if org not found", async () => {
      const res = await request(app)
        .post("/start-run")
        .set("x-api-key", API_KEY)
        .send({ campaignId: crypto.randomUUID(), clerkOrgId: "nonexistent-org" })
        .expect(404);

      expect(res.body.error).toBe("Organization not found");
    });

    it("should return 404 if campaign not found", async () => {
      const res = await request(app)
        .post("/start-run")
        .set("x-api-key", API_KEY)
        .send({ campaignId: crypto.randomUUID(), clerkOrgId: org.clerkOrgId })
        .expect(404);

      expect(res.body.error).toBe("Campaign not found");
    });

    it("should return 400 if campaign has no brandUrl", async () => {
      const campaign = await insertTestCampaign(org.id, {
        brandId,
        brandUrl: undefined,
      });

      const res = await request(app)
        .post("/start-run")
        .set("x-api-key", API_KEY)
        .send({ campaignId: campaign.id, clerkOrgId: org.clerkOrgId })
        .expect(400);

      expect(res.body.error).toBe("Campaign has no brandUrl");
    });

    it("should return 400 if campaign has no brandId", async () => {
      const campaign = await insertTestCampaign(org.id, {
        brandUrl: "https://example.com",
        brandId: undefined,
      });

      const res = await request(app)
        .post("/start-run")
        .set("x-api-key", API_KEY)
        .send({ campaignId: campaign.id, clerkOrgId: org.clerkOrgId })
        .expect(400);

      expect(res.body.error).toBe("Campaign has no brandId");
    });

    it("should return 200 with campaign data and runId", async () => {
      const campaign = await insertTestCampaign(org.id, {
        brandUrl: "https://example.com",
        brandId,
        appId: "mcpfactory",
        targetOutcome: "Book demos",
        valueForTarget: "Analytics platform",
      });

      const res = await request(app)
        .post("/start-run")
        .set("x-api-key", API_KEY)
        .send({ campaignId: campaign.id, clerkOrgId: org.clerkOrgId })
        .expect(200);

      expect(res.body.runId).toBe("run-123");
      expect(res.body.campaignId).toBe(campaign.id);
      expect(res.body.clerkOrgId).toBe(org.clerkOrgId);
      expect(res.body.brandId).toBe(brandId);
      expect(res.body.brandUrl).toBe("https://example.com");
      expect(res.body.brandDomain).toBe("example.com");
      expect(res.body.appId).toBe("mcpfactory");
      expect(res.body.workflowName).toBe("sales-email-cold-outreach");
      expect(res.body.targetOutcome).toBe("Book demos");
      expect(res.body.valueForTarget).toBe("Analytics platform");
    });

    it("should not return sales-specific fields", async () => {
      const campaign = await insertTestCampaign(org.id, {
        brandUrl: "https://example.com",
        brandId,
      });

      const res = await request(app)
        .post("/start-run")
        .set("x-api-key", API_KEY)
        .send({ campaignId: campaign.id, clerkOrgId: org.clerkOrgId })
        .expect(200);

      expect(res.body).not.toHaveProperty("urgency");
      expect(res.body).not.toHaveProperty("scarcity");
      expect(res.body).not.toHaveProperty("riskReversal");
      expect(res.body).not.toHaveProperty("socialProof");
    });

    it("should pass all user context as unstructured searchParams", async () => {
      const campaign = await insertTestCampaign(org.id, {
        brandUrl: "https://example.com",
        brandId,
        targetAudience: "VPs of Sales at B2B SaaS companies",
        targetOutcome: "Book demo meetings",
        valueForTarget: "Reduce outbound prospecting time by 80%",
      });

      const res = await request(app)
        .post("/start-run")
        .set("x-api-key", API_KEY)
        .send({ campaignId: campaign.id, clerkOrgId: org.clerkOrgId })
        .expect(200);

      expect(res.body.searchParams).toEqual({
        targetAudience: "VPs of Sales at B2B SaaS companies",
        targetOutcome: "Book demo meetings",
        valueForTarget: "Reduce outbound prospecting time by 80%",
      });
    });

    it("should have null searchParams when no user context is set", async () => {
      const campaign = await insertTestCampaign(org.id, {
        brandUrl: "https://example.com",
        brandId,
      });

      const res = await request(app)
        .post("/start-run")
        .set("x-api-key", API_KEY)
        .send({ campaignId: campaign.id, clerkOrgId: org.clerkOrgId })
        .expect(200);

      expect(res.body.searchParams).toBeNull();
    });

    it("should extract brandDomain from brandUrl", async () => {
      const campaign = await insertTestCampaign(org.id, {
        brandUrl: "https://www.example.com/path",
        brandId,
      });

      const res = await request(app)
        .post("/start-run")
        .set("x-api-key", API_KEY)
        .send({ campaignId: campaign.id, clerkOrgId: org.clerkOrgId })
        .expect(200);

      expect(res.body.brandDomain).toBe("example.com");
      expect(res.body.brandUrl).toBe("https://www.example.com/path");
    });

    it("should pass parentRunId to createRun when campaign has one", async () => {
      const parentRunId = crypto.randomUUID();
      const campaign = await insertTestCampaign(org.id, {
        brandUrl: "https://example.com",
        brandId,
        parentRunId,
      });

      await request(app)
        .post("/start-run")
        .set("x-api-key", API_KEY)
        .send({ campaignId: campaign.id, clerkOrgId: org.clerkOrgId })
        .expect(200);

      expect(mockCreateRun).toHaveBeenCalledWith(
        expect.objectContaining({ parentRunId }),
      );
    });

    it("should NOT pass parentRunId to createRun when campaign has none", async () => {
      const campaign = await insertTestCampaign(org.id, {
        brandUrl: "https://example.com",
        brandId,
      });

      await request(app)
        .post("/start-run")
        .set("x-api-key", API_KEY)
        .send({ campaignId: campaign.id, clerkOrgId: org.clerkOrgId })
        .expect(200);

      expect(mockCreateRun).toHaveBeenCalledWith(
        expect.not.objectContaining({ parentRunId: expect.any(String) }),
      );
    });

    it("should pass workflowName to createRun", async () => {
      const campaign = await insertTestCampaign(org.id, {
        brandUrl: "https://example.com",
        brandId,
        workflowName: "pr-email-cold-outreach",
      });

      await request(app)
        .post("/start-run")
        .set("x-api-key", API_KEY)
        .send({ campaignId: campaign.id, clerkOrgId: org.clerkOrgId })
        .expect(200);

      expect(mockCreateRun).toHaveBeenCalledWith(
        expect.objectContaining({ workflowName: "pr-email-cold-outreach" }),
      );
    });

    it("should NOT call gate checks (gate check is a separate DAG node)", async () => {
      const campaign = await insertTestCampaign(org.id, {
        brandUrl: "https://example.com",
        brandId,
      });

      await request(app)
        .post("/start-run")
        .set("x-api-key", API_KEY)
        .send({ campaignId: campaign.id, clerkOrgId: org.clerkOrgId })
        .expect(200);

      expect(mockGateChecks).not.toHaveBeenCalled();
    });
  });

  // === POST /end-run ===

  describe("POST /end-run", () => {
    it("should return 400 if required fields are missing", async () => {
      await request(app)
        .post("/end-run")
        .set("x-api-key", API_KEY)
        .send({ campaignId: crypto.randomUUID(), clerkOrgId: "org-1" })
        .expect(400);
    });

    it("should find and mark running run as completed when success is true", async () => {
      const campaign = await insertTestCampaign(org.id, {
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
          clerkOrgId: org.clerkOrgId,
          success: true,
        })
        .expect(200);

      expect(res.body.status).toBe("completed");
      expect(mockUpdateRun).toHaveBeenCalledWith("run-123", "completed");
    });

    it("should find and mark running run as failed when success is false", async () => {
      const campaign = await insertTestCampaign(org.id, {
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
          clerkOrgId: org.clerkOrgId,
          success: false,
        })
        .expect(200);

      expect(res.body.status).toBe("failed");
      expect(mockUpdateRun).toHaveBeenCalledWith("run-456", "failed");
    });

    it("should skip run update when no running runs exist (gate-check blocked)", async () => {
      const campaign = await insertTestCampaign(org.id, {
        brandUrl: "https://example.com",
        brandId,
      });

      mockListRuns.mockResolvedValue({ runs: [] });

      const res = await request(app)
        .post("/end-run")
        .set("x-api-key", API_KEY)
        .send({
          campaignId: campaign.id,
          clerkOrgId: org.clerkOrgId,
          success: false,
        })
        .expect(200);

      expect(res.body.status).toBe("failed");
      expect(mockUpdateRun).not.toHaveBeenCalled();
    });

    it("should re-trigger workflow using workflowName if campaign is still ongoing", async () => {
      const campaign = await insertTestCampaign(org.id, {
        brandUrl: "https://example.com",
        brandId,
        status: "ongoing",
        workflowName: "sales-email-cold-outreach",
      });

      await request(app)
        .post("/end-run")
        .set("x-api-key", API_KEY)
        .send({
          campaignId: campaign.id,
          clerkOrgId: org.clerkOrgId,
          success: true,
        })
        .expect(200);

      // Wait for async re-trigger
      await new Promise((r) => setTimeout(r, 100));

      expect(mockExecute).toHaveBeenCalledWith(
        "sales-email-cold-outreach",
        {
          campaignId: campaign.id,
          clerkOrgId: org.clerkOrgId,
          appId: "",
        },
      );
    });

    it("should NOT re-trigger if campaign is stopped", async () => {
      const campaign = await insertTestCampaign(org.id, {
        brandUrl: "https://example.com",
        brandId,
        status: "stopped",
      });

      await request(app)
        .post("/end-run")
        .set("x-api-key", API_KEY)
        .send({
          campaignId: campaign.id,
          clerkOrgId: org.clerkOrgId,
          success: true,
        })
        .expect(200);

      await new Promise((r) => setTimeout(r, 100));

      expect(mockExecute).not.toHaveBeenCalled();
    });

    it("should auto-stop campaign and NOT re-trigger when leadFound is false", async () => {
      const campaign = await insertTestCampaign(org.id, {
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
          clerkOrgId: org.clerkOrgId,
          success: true,
          leadFound: false,
        })
        .expect(200);

      expect(res.body.status).toBe("completed");
      expect(mockUpdateRun).toHaveBeenCalledWith("run-789", "completed");

      // Wait for async auto-stop
      await new Promise((r) => setTimeout(r, 100));

      // Should NOT re-trigger
      expect(mockExecute).not.toHaveBeenCalled();
    });

    it("should re-trigger normally when leadFound is true", async () => {
      const campaign = await insertTestCampaign(org.id, {
        brandUrl: "https://example.com",
        brandId,
        status: "ongoing",
      });

      mockListRuns.mockResolvedValue({
        runs: [
          { id: "run-101", status: "running", startedAt: new Date().toISOString() },
        ],
      });

      await request(app)
        .post("/end-run")
        .set("x-api-key", API_KEY)
        .send({
          campaignId: campaign.id,
          clerkOrgId: org.clerkOrgId,
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
          clerkOrgId: org.clerkOrgId,
        }),
      );
    });
  });
});
