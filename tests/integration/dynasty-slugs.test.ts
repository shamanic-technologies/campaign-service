import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";

const { mockResolveLatestWorkflow, mockResolveLatestFeature, mockResolveWorkflow, mockResolveFeature } = vi.hoisted(() => ({
  mockResolveLatestWorkflow: vi.fn(),
  mockResolveLatestFeature: vi.fn(),
  mockResolveWorkflow: vi.fn(),
  mockResolveFeature: vi.fn(),
}));

vi.mock("../../src/lib/dynasty-client.js", () => ({
  resolveLatestWorkflowSlug: mockResolveLatestWorkflow,
  resolveLatestFeatureSlug: mockResolveLatestFeature,
  resolveWorkflowDynastySlugs: mockResolveWorkflow,
  resolveFeatureDynastySlugs: mockResolveFeature,
  getWorkflowDynastyMap: vi.fn(),
  getFeatureDynastyMap: vi.fn(),
}));

import app from "../../src/index.js";
import { cleanTestData, closeDb, insertTestCampaign } from "../helpers/test-db.js";

const API_KEY = process.env.CAMPAIGN_SERVICE_API_KEY || "test-api-key";

describe("Dynasty Slug Support", () => {
  beforeEach(async () => {
    await cleanTestData();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  function createCampaign(body: Record<string, unknown>, orgId = "org_dynasty") {
    return request(app)
      .post("/campaigns")
      .set("x-api-key", API_KEY)
      .set("x-org-id", orgId)
      .set("x-user-id", "user_dynasty")
      .set("x-run-id", crypto.randomUUID())
      .set("x-feature-slug", "sales-cold-email-v1")
      .send(body);
  }

  const baseBody = {
    name: "Dynasty Campaign",
    orgId: "org_dynasty",
    brandUrl: "https://example.com",
    brandIds: [crypto.randomUUID()],
  };

  describe("POST /campaigns — dynasty slug resolution", () => {
    it("should accept workflowDynastySlug and resolve to latest versioned slug", async () => {
      mockResolveLatestWorkflow.mockResolvedValueOnce("cold-email-v3");

      const res = await createCampaign({
        ...baseBody,
        workflowDynastySlug: "cold-email",
      }).expect(201);

      expect(res.body.campaign.workflowSlug).toBe("cold-email-v3");
      expect(res.body.campaign.workflowDynastySlug).toBe("cold-email");
      expect(mockResolveLatestWorkflow).toHaveBeenCalledWith("cold-email");
    });

    it("should prefer explicit workflowSlug over workflowDynastySlug", async () => {
      const res = await createCampaign({
        ...baseBody,
        workflowSlug: "cold-email-v2",
        workflowDynastySlug: "cold-email",
      }).expect(201);

      expect(res.body.campaign.workflowSlug).toBe("cold-email-v2");
      expect(res.body.campaign.workflowDynastySlug).toBe("cold-email");
      expect(mockResolveLatestWorkflow).not.toHaveBeenCalled();
    });

    it("should reject when neither workflowSlug nor workflowDynastySlug is provided", async () => {
      const res = await createCampaign({
        ...baseBody,
        name: "No Workflow",
      }).expect(400);

      expect(res.body.error).toContain("workflowSlug");
    });

    it("should store featureDynastySlug on create", async () => {
      const res = await createCampaign({
        ...baseBody,
        workflowSlug: "cold-email-v1",
        featureDynastySlug: "sales-cold-email",
      }).expect(201);

      expect(res.body.campaign.featureDynastySlug).toBe("sales-cold-email");
    });

    it("should return 500 when dynasty slug resolution fails", async () => {
      mockResolveLatestWorkflow.mockRejectedValueOnce(
        new Error("No versioned slugs found")
      );

      await createCampaign({
        ...baseBody,
        name: "Fail Campaign",
        workflowDynastySlug: "nonexistent",
      }).expect(500);
    });
  });

  describe("GET /campaigns — slug filtering", () => {
    it("should filter by workflowSlug", async () => {
      await insertTestCampaign("org_filter", { workflowSlug: "cold-email-v1" });
      await insertTestCampaign("org_filter", { workflowSlug: "warm-intro-v1" });

      const res = await request(app)
        .get("/campaigns?workflowSlug=cold-email-v1")
        .set("x-api-key", API_KEY)
        .set("x-org-id", "org_filter")
        .expect(200);

      expect(res.body.campaigns).toHaveLength(1);
      expect(res.body.campaigns[0].workflowSlug).toBe("cold-email-v1");
    });

    it("should filter by featureSlug", async () => {
      await insertTestCampaign("org_filter_feat", { featureSlug: "feat-alpha" });
      await insertTestCampaign("org_filter_feat", { featureSlug: "feat-beta" });

      const res = await request(app)
        .get("/campaigns?featureSlug=feat-alpha")
        .set("x-api-key", API_KEY)
        .set("x-org-id", "org_filter_feat")
        .expect(200);

      expect(res.body.campaigns).toHaveLength(1);
      expect(res.body.campaigns[0].featureSlug).toBe("feat-alpha");
    });

    it("should filter by workflowDynastySlug (resolved to all versioned slugs)", async () => {
      await insertTestCampaign("org_dyn_filter", { name: "DynFilter 1", workflowSlug: "cold-email-v1" });
      await insertTestCampaign("org_dyn_filter", { name: "DynFilter 2", workflowSlug: "cold-email-v2" });
      await insertTestCampaign("org_dyn_filter", { name: "DynFilter 3", workflowSlug: "warm-intro-v1" });

      mockResolveWorkflow.mockResolvedValueOnce(["cold-email-v1", "cold-email-v2"]);

      const res = await request(app)
        .get("/campaigns?workflowDynastySlug=cold-email")
        .set("x-api-key", API_KEY)
        .set("x-org-id", "org_dyn_filter")
        .expect(200);

      expect(res.body.campaigns).toHaveLength(2);
      expect(mockResolveWorkflow).toHaveBeenCalledWith("cold-email");
    });

    it("should filter by featureDynastySlug (resolved to all versioned slugs)", async () => {
      await insertTestCampaign("org_dyn_feat", { name: "DynFeat 1", featureSlug: "feat-alpha-v1" });
      await insertTestCampaign("org_dyn_feat", { name: "DynFeat 2", featureSlug: "feat-alpha-v2" });
      await insertTestCampaign("org_dyn_feat", { name: "DynFeat 3", featureSlug: "feat-beta-v1" });

      mockResolveFeature.mockResolvedValueOnce(["feat-alpha-v1", "feat-alpha-v2"]);

      const res = await request(app)
        .get("/campaigns?featureDynastySlug=feat-alpha")
        .set("x-api-key", API_KEY)
        .set("x-org-id", "org_dyn_feat")
        .expect(200);

      expect(res.body.campaigns).toHaveLength(2);
    });

    it("should return empty array when dynasty slug resolves to no versions", async () => {
      await insertTestCampaign("org_empty_dyn", { workflowSlug: "cold-email-v1" });

      mockResolveWorkflow.mockResolvedValueOnce([]);

      const res = await request(app)
        .get("/campaigns?workflowDynastySlug=nonexistent")
        .set("x-api-key", API_KEY)
        .set("x-org-id", "org_empty_dyn")
        .expect(200);

      expect(res.body.campaigns).toHaveLength(0);
    });

    it("should combine workflowDynastySlug with brandId filter", async () => {
      const brandId = crypto.randomUUID();
      await insertTestCampaign("org_combo_dyn", { name: "Combo 1", workflowSlug: "cold-email-v1", brandIds: [brandId] });
      await insertTestCampaign("org_combo_dyn", { name: "Combo 2", workflowSlug: "cold-email-v2" });
      await insertTestCampaign("org_combo_dyn", { name: "Combo 3", workflowSlug: "warm-intro-v1", brandIds: [brandId] });

      mockResolveWorkflow.mockResolvedValueOnce(["cold-email-v1", "cold-email-v2"]);

      const res = await request(app)
        .get(`/campaigns?workflowDynastySlug=cold-email&brandId=${brandId}`)
        .set("x-api-key", API_KEY)
        .set("x-org-id", "org_combo_dyn")
        .expect(200);

      expect(res.body.campaigns).toHaveLength(1);
      expect(res.body.campaigns[0].workflowSlug).toBe("cold-email-v1");
    });
  });

  describe("PATCH /campaigns/:id — featureDynastySlug", () => {
    it("should resolve featureDynastySlug to latest versioned slug on update", async () => {
      const campaign = await insertTestCampaign("org_patch_dyn", {
        featureSlug: "feat-alpha-v1",
      });

      mockResolveLatestFeature.mockResolvedValueOnce("feat-alpha-v3");

      const res = await request(app)
        .patch(`/campaigns/${campaign.id}`)
        .set("x-api-key", API_KEY)
        .set("x-org-id", "org_patch_dyn")
        .send({ featureDynastySlug: "feat-alpha" })
        .expect(200);

      expect(res.body.campaign.featureSlug).toBe("feat-alpha-v3");
      expect(res.body.campaign.featureDynastySlug).toBe("feat-alpha");
    });
  });
});
