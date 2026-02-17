import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";

const {
  mockCreateRun,
  mockUpdateRun,
  mockListRuns,
  mockGetRunsBatch,
  mockExecute,
  mockGateChecks,
  mockFetch,
} = vi.hoisted(() => ({
  mockCreateRun: vi.fn(),
  mockUpdateRun: vi.fn(),
  mockListRuns: vi.fn(),
  mockGetRunsBatch: vi.fn(),
  mockExecute: vi.fn(),
  mockGateChecks: vi.fn(),
  mockFetch: vi.fn(),
}));

vi.mock("@mcpfactory/runs-client", () => ({
  createRun: mockCreateRun,
  updateRun: mockUpdateRun,
  listRuns: mockListRuns,
  getRun: vi.fn(),
  getRunsBatch: mockGetRunsBatch,
  addCosts: vi.fn(),
}));

vi.mock("../../src/lib/workflows.js", () => ({
  executeCampaignWorkflow: mockExecute,
  deployWorkflows: vi.fn(),
  COLD_EMAIL_PROMPT: "test prompt {{leadFirstName}}",
  COLD_EMAIL_VARIABLES: ["leadFirstName"],
}));

vi.mock("../../src/lib/gate-check.js", () => ({
  runGateChecks: mockGateChecks,
}));

vi.stubGlobal("fetch", mockFetch);

import app from "../../src/index.js";
import { cleanTestData, closeDb, insertTestOrg, insertTestCampaign } from "../helpers/test-db.js";

const API_KEY = process.env.CAMPAIGN_SERVICE_API_KEY || "test-api-key";

describe("Internal routes", () => {
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
    mockGetRunsBatch.mockResolvedValue(new Map());
    mockGateChecks.mockResolvedValue({ allowed: true });
    mockExecute.mockResolvedValue(undefined);
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  describe("POST /internal/start-run", () => {
    it("should return 400 if campaignId or clerkOrgId is missing", async () => {
      await request(app)
        .post("/internal/start-run")
        .set("x-api-key", API_KEY)
        .send({ campaignId: "some-id" })
        .expect(400);

      await request(app)
        .post("/internal/start-run")
        .set("x-api-key", API_KEY)
        .send({ clerkOrgId: "some-org" })
        .expect(400);
    });

    it("should return 404 if org not found", async () => {
      const res = await request(app)
        .post("/internal/start-run")
        .set("x-api-key", API_KEY)
        .send({ campaignId: "fake", clerkOrgId: "nonexistent-org" })
        .expect(404);

      expect(res.body.error).toBe("Organization not found");
    });

    it("should return 404 if campaign not found", async () => {
      const res = await request(app)
        .post("/internal/start-run")
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
        .post("/internal/start-run")
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
        .post("/internal/start-run")
        .set("x-api-key", API_KEY)
        .send({ campaignId: campaign.id, clerkOrgId: org.clerkOrgId })
        .expect(400);

      expect(res.body.error).toBe("Campaign has no brandId");
    });

    it("should return 409 when gate check fails", async () => {
      const campaign = await insertTestCampaign(org.id, {
        brandUrl: "https://example.com",
        brandId,
      });

      mockGateChecks.mockResolvedValue({
        allowed: false,
        reason: "daily budget exceeded",
      });

      const res = await request(app)
        .post("/internal/start-run")
        .set("x-api-key", API_KEY)
        .send({ campaignId: campaign.id, clerkOrgId: org.clerkOrgId })
        .expect(409);

      expect(res.body.error).toBe("Gate check failed");
      expect(res.body.reason).toBe("daily budget exceeded");
    });

    it("should return 204 when no lead is found", async () => {
      const campaign = await insertTestCampaign(org.id, {
        brandUrl: "https://example.com",
        brandId,
      });

      // Mock prompt registration
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
      // Mock brand profile (skip)
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
      // Mock lead fetch — no lead found
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ found: false }),
      });

      await request(app)
        .post("/internal/start-run")
        .set("x-api-key", API_KEY)
        .send({ campaignId: campaign.id, clerkOrgId: org.clerkOrgId })
        .expect(204);

      // Run should be created then immediately failed
      expect(mockCreateRun).toHaveBeenCalledOnce();
      expect(mockUpdateRun).toHaveBeenCalledWith("run-123", "failed");
    });

    it("should return 200 with full pipeline data when lead is found", async () => {
      const campaign = await insertTestCampaign(org.id, {
        brandUrl: "https://example.com",
        brandId,
        appId: "mcpfactory",
        targetOutcome: "Book demos",
        valueForTarget: "Analytics platform",
      });

      // Use URL-based mock to avoid cache ordering issues
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("/prompts")) {
          return Promise.resolve({ ok: true, json: async () => ({}) });
        }
        if (url.includes("/sales-profile")) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              companyName: "Example Inc",
              companyOverview: "A great company",
              valueProposition: "We make things better",
            }),
          });
        }
        if (url.includes("/buffer/next")) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              found: true,
              lead: {
                externalId: "lead-ext-1",
                data: {
                  first_name: "John",
                  last_name: "Doe",
                  title: "CTO",
                  email: "john@acme.com",
                  organization_name: "Acme Corp",
                },
              },
            }),
          });
        }
        return Promise.reject(new Error(`Unexpected fetch: ${url}`));
      });

      const res = await request(app)
        .post("/internal/start-run")
        .set("x-api-key", API_KEY)
        .send({ campaignId: campaign.id, clerkOrgId: org.clerkOrgId })
        .expect(200);

      expect(res.body.runId).toBe("run-123");
      expect(res.body.campaignId).toBe(campaign.id);
      expect(res.body.clerkOrgId).toBe(org.clerkOrgId);
      expect(res.body.brandId).toBe(brandId);
      expect(res.body.targetOutcome).toBe("Book demos");
      expect(res.body.lead.externalId).toBe("lead-ext-1");
      expect(res.body.lead.data.email).toBe("john@acme.com");
      expect(res.body.clientData.companyName).toBe("Example Inc");
      expect(res.body.clientData.companyOverview).toBe("A great company");
    });

    it("should use fallback clientData when brand profile fails", async () => {
      const campaign = await insertTestCampaign(org.id, {
        brandUrl: "https://www.example.com",
        brandId,
      });

      // Use URL-based mock to avoid cache ordering issues
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("/prompts")) {
          return Promise.resolve({ ok: true, json: async () => ({}) });
        }
        if (url.includes("/sales-profile")) {
          return Promise.resolve({ ok: false, status: 500, text: async () => "error" });
        }
        if (url.includes("/buffer/next")) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              found: true,
              lead: {
                externalId: "lead-ext-2",
                data: { first_name: "Jane", email: "jane@test.com" },
              },
            }),
          });
        }
        return Promise.reject(new Error(`Unexpected fetch: ${url}`));
      });

      const res = await request(app)
        .post("/internal/start-run")
        .set("x-api-key", API_KEY)
        .send({ campaignId: campaign.id, clerkOrgId: org.clerkOrgId })
        .expect(200);

      // Should fall back to domain-based clientData
      expect(res.body.clientData.companyName).toBe("example.com");
      expect(res.body.clientData.brandUrl).toBe("https://www.example.com");
    });
  });

  describe("POST /internal/end-run", () => {
    it("should return 400 if required fields are missing", async () => {
      await request(app)
        .post("/internal/end-run")
        .set("x-api-key", API_KEY)
        .send({ runId: "run-1", campaignId: "camp-1" })
        .expect(400);
    });

    it("should mark run as completed when success is true", async () => {
      const campaign = await insertTestCampaign(org.id, {
        brandUrl: "https://example.com",
        brandId,
      });

      const res = await request(app)
        .post("/internal/end-run")
        .set("x-api-key", API_KEY)
        .send({
          runId: "run-123",
          campaignId: campaign.id,
          clerkOrgId: org.clerkOrgId,
          success: true,
        })
        .expect(200);

      expect(res.body.status).toBe("completed");
      expect(mockUpdateRun).toHaveBeenCalledWith("run-123", "completed");
    });

    it("should mark run as failed when success is false", async () => {
      const campaign = await insertTestCampaign(org.id, {
        brandUrl: "https://example.com",
        brandId,
      });

      const res = await request(app)
        .post("/internal/end-run")
        .set("x-api-key", API_KEY)
        .send({
          runId: "run-456",
          campaignId: campaign.id,
          clerkOrgId: org.clerkOrgId,
          success: false,
        })
        .expect(200);

      expect(res.body.status).toBe("failed");
      expect(mockUpdateRun).toHaveBeenCalledWith("run-456", "failed");
    });

    it("should re-trigger workflow if campaign is still ongoing", async () => {
      const campaign = await insertTestCampaign(org.id, {
        brandUrl: "https://example.com",
        brandId,
        status: "ongoing",
      });

      await request(app)
        .post("/internal/end-run")
        .set("x-api-key", API_KEY)
        .send({
          runId: "run-789",
          campaignId: campaign.id,
          clerkOrgId: org.clerkOrgId,
          success: true,
        })
        .expect(200);

      // Wait for async re-trigger
      await new Promise((r) => setTimeout(r, 100));

      expect(mockExecute).toHaveBeenCalledWith(
        "cold-email-outreach",
        {
          campaignId: campaign.id,
          clerkOrgId: org.clerkOrgId,
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
        .post("/internal/end-run")
        .set("x-api-key", API_KEY)
        .send({
          runId: "run-stopped",
          campaignId: campaign.id,
          clerkOrgId: org.clerkOrgId,
          success: true,
        })
        .expect(200);

      await new Promise((r) => setTimeout(r, 100));

      expect(mockExecute).not.toHaveBeenCalled();
    });
  });
});
