import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";

const { mockExecuteCampaignWorkflow } = vi.hoisted(() => ({
  mockExecuteCampaignWorkflow: vi.fn(),
}));

vi.mock("../../src/lib/workflows.js", () => ({
  executeCampaignWorkflow: mockExecuteCampaignWorkflow,
}));

vi.mock("../../src/lib/gate-check.js", () => ({
  runGateChecks: vi.fn().mockResolvedValue({ allowed: true }),
}));

vi.mock("@mcpfactory/runs-client", () => ({
  createRun: vi.fn().mockResolvedValue({ id: "mock-run-id" }),
  updateRun: vi.fn().mockResolvedValue({}),
  listRuns: vi.fn().mockResolvedValue({ runs: [] }),
  getStatsBudget: vi.fn().mockResolvedValue({ windows: [] }),
}));

import app from "../../src/index.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";

const API_KEY = process.env.CAMPAIGN_SERVICE_API_KEY || "test-api-key";

const validBody = {
  name: "Activation Test Campaign",
  workflowName: "sales-email-cold-outreach",
  orgId: "org_activation_test",
  brandUrl: "https://example.com",
  brandId: crypto.randomUUID(),
  targetOutcome: "Book sales demos",
  valueForTarget: "Enterprise analytics at startup pricing",
  targetAudience: "CTOs at SaaS companies",
};

describe("Workflow trigger", () => {
  beforeEach(async () => {
    await cleanTestData();
    vi.clearAllMocks();
    mockExecuteCampaignWorkflow.mockResolvedValue(undefined);
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  describe("on campaign creation", () => {
    it("should trigger workflow immediately when campaign is created", async () => {
      const createRes = await request(app)
        .post("/campaigns")
        .set("x-api-key", API_KEY)
        .set("x-org-id", "org_activation_test")
        .send(validBody)
        .expect(201);

      const campaignId = createRes.body.campaign.id;

      // Wait a tick for the fire-and-forget promise
      await new Promise((r) => setTimeout(r, 50));

      expect(mockExecuteCampaignWorkflow).toHaveBeenCalledOnce();
      expect(mockExecuteCampaignWorkflow).toHaveBeenCalledWith(
        "sales-email-cold-outreach",
        expect.objectContaining({
          campaignId,
          orgId: "org_activation_test",
          brandId: validBody.brandId,
        }),
      );
    });

    it("should still return 201 even if initial workflow execution fails", async () => {
      mockExecuteCampaignWorkflow.mockRejectedValue(new Error("Windmill down"));

      const createRes = await request(app)
        .post("/campaigns")
        .set("x-api-key", API_KEY)
        .set("x-org-id", "org_activation_test")
        .send(validBody)
        .expect(201);

      expect(createRes.body.campaign).toBeDefined();
      expect(createRes.body.campaign.status).toBe("ongoing");
    });
  });

  describe("on PATCH activate", () => {
    it("should trigger workflow when status is set to activate", async () => {
      // Create campaign (triggers workflow once)
      const createRes = await request(app)
        .post("/campaigns")
        .set("x-api-key", API_KEY)
        .set("x-org-id", "org_activation_test")
        .send(validBody)
        .expect(201);

      const campaignId = createRes.body.campaign.id;

      // Stop it first so we can activate
      await request(app)
        .patch(`/campaigns/${campaignId}`)
        .set("x-api-key", API_KEY)
        .set("x-org-id", "org_activation_test")
        .send({ status: "stop" })
        .expect(200);

      vi.clearAllMocks();
      mockExecuteCampaignWorkflow.mockResolvedValue(undefined);

      // Activate (requires parentRunId)
      const activateRes = await request(app)
        .patch(`/campaigns/${campaignId}`)
        .set("x-api-key", API_KEY)
        .set("x-org-id", "org_activation_test")
        .send({ status: "activate" })
        .expect(200);

      expect(activateRes.body.campaign.status).toBe("ongoing");

      // Wait a tick for the fire-and-forget promise
      await new Promise((r) => setTimeout(r, 50));

      expect(mockExecuteCampaignWorkflow).toHaveBeenCalledOnce();
      expect(mockExecuteCampaignWorkflow).toHaveBeenCalledWith(
        "sales-email-cold-outreach",
        expect.objectContaining({
          campaignId,
          orgId: "org_activation_test",
        }),
      );
    });

    it("should NOT trigger workflow on stop (only creation trigger)", async () => {
      const createRes = await request(app)
        .post("/campaigns")
        .set("x-api-key", API_KEY)
        .set("x-org-id", "org_activation_test")
        .send(validBody)
        .expect(201);

      const campaignId = createRes.body.campaign.id;

      // Clear mocks after creation trigger
      await new Promise((r) => setTimeout(r, 50));
      vi.clearAllMocks();
      mockExecuteCampaignWorkflow.mockResolvedValue(undefined);

      await request(app)
        .patch(`/campaigns/${campaignId}`)
        .set("x-api-key", API_KEY)
        .set("x-org-id", "org_activation_test")
        .send({ status: "stop" })
        .expect(200);

      await new Promise((r) => setTimeout(r, 50));

      expect(mockExecuteCampaignWorkflow).not.toHaveBeenCalled();
    });

    it("should NOT trigger workflow when updating non-status fields", async () => {
      const createRes = await request(app)
        .post("/campaigns")
        .set("x-api-key", API_KEY)
        .set("x-org-id", "org_activation_test")
        .send(validBody)
        .expect(201);

      const campaignId = createRes.body.campaign.id;

      // Clear mocks after creation trigger
      await new Promise((r) => setTimeout(r, 50));
      vi.clearAllMocks();
      mockExecuteCampaignWorkflow.mockResolvedValue(undefined);

      await request(app)
        .patch(`/campaigns/${campaignId}`)
        .set("x-api-key", API_KEY)
        .set("x-org-id", "org_activation_test")
        .send({ name: "Updated Name" })
        .expect(200);

      await new Promise((r) => setTimeout(r, 50));

      expect(mockExecuteCampaignWorkflow).not.toHaveBeenCalled();
    });

    it("should still return 200 even if workflow execution fails on activate", async () => {
      const createRes = await request(app)
        .post("/campaigns")
        .set("x-api-key", API_KEY)
        .set("x-org-id", "org_activation_test")
        .send(validBody)
        .expect(201);

      const campaignId = createRes.body.campaign.id;

      // Stop then activate with failing mock
      await request(app)
        .patch(`/campaigns/${campaignId}`)
        .set("x-api-key", API_KEY)
        .set("x-org-id", "org_activation_test")
        .send({ status: "stop" })
        .expect(200);

      mockExecuteCampaignWorkflow.mockRejectedValue(new Error("Windmill down"));

      const activateRes = await request(app)
        .patch(`/campaigns/${campaignId}`)
        .set("x-api-key", API_KEY)
        .set("x-org-id", "org_activation_test")
        .send({ status: "activate" })
        .expect(200);

      expect(activateRes.body.campaign.status).toBe("ongoing");
    });
  });
});
