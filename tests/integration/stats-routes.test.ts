import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";

const { mockGetStatsBudget } = vi.hoisted(() => ({
  mockGetStatsBudget: vi.fn(),
}));

vi.mock("@distribute/runs-client", () => ({
  listRuns: vi.fn(),
  createRun: vi.fn(),
  updateRun: vi.fn(),
  getStatsBudget: mockGetStatsBudget,
}));

const { mockResolveWorkflow, mockResolveFeature, mockWorkflowMap, mockFeatureMap } = vi.hoisted(() => ({
  mockResolveWorkflow: vi.fn(),
  mockResolveFeature: vi.fn(),
  mockWorkflowMap: vi.fn(),
  mockFeatureMap: vi.fn(),
}));

vi.mock("../../src/lib/dynasty-client.js", () => ({
  resolveWorkflowDynastySlugs: mockResolveWorkflow,
  resolveFeatureDynastySlugs: mockResolveFeature,
  getWorkflowDynastyMap: mockWorkflowMap,
  getFeatureDynastyMap: mockFeatureMap,
}));

import app from "../../src/index.js";
import { cleanTestData, closeDb, insertTestCampaign } from "../helpers/test-db.js";

const API_KEY = process.env.CAMPAIGN_SERVICE_API_KEY || "test-api-key";

describe("Stats Routes", () => {
  beforeEach(async () => {
    await cleanTestData();
    vi.clearAllMocks();
    mockGetStatsBudget.mockResolvedValue({ windows: [] });
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  describe("POST /stats/batch-budget", () => {
    it("should return cost total for each campaign", async () => {
      const campaign = await insertTestCampaign("org_stats_1", {
        status: "ongoing",
        maxBudgetTotalUsd: "50.00",
        maxLeads: 100,
      });

      mockGetStatsBudget.mockResolvedValue({
        windows: [{ label: "total", totalCostInUsdCents: "1234", actualCostInUsdCents: "1234", provisionedCostInUsdCents: "0" }],
      });

      const res = await request(app)
        .post("/stats/batch-budget")
        .set("x-api-key", API_KEY)
        .send({ campaignIds: [campaign.id] })
        .expect(200);

      const result = res.body.results[campaign.id];
      expect(result.status).toBe("ongoing");
      expect(result.maxLeads).toBe(100);
      expect(result.maxBudgetTotalUsd).toBe("50.00");
      expect(result.totalCostInUsdCents).toBe("1234");
    });

    it("should call getStatsBudget with correct params", async () => {
      const campaign = await insertTestCampaign("org_stats_params", {});

      await request(app)
        .post("/stats/batch-budget")
        .set("x-api-key", API_KEY)
        .send({ campaignIds: [campaign.id] })
        .expect(200);

      expect(mockGetStatsBudget).toHaveBeenCalledWith({
        orgId: "org_stats_params",
        campaignId: campaign.id,
        windows: [{ label: "total" }],
      });
    });

    it("should handle not-found campaign gracefully", async () => {
      const fakeId = crypto.randomUUID();

      const res = await request(app)
        .post("/stats/batch-budget")
        .set("x-api-key", API_KEY)
        .send({ campaignIds: [fakeId] })
        .expect(200);

      expect(res.body.results[fakeId]).toEqual({ error: "Campaign not found" });
    });

    it("should handle getStatsBudget failure gracefully", async () => {
      const campaign = await insertTestCampaign("org_stats_err", {});

      mockGetStatsBudget.mockRejectedValue(new Error("runs-service down"));

      const res = await request(app)
        .post("/stats/batch-budget")
        .set("x-api-key", API_KEY)
        .send({ campaignIds: [campaign.id] })
        .expect(200);

      expect(res.body.results[campaign.id]).toEqual({ error: "Failed to fetch stats" });
    });

    it("should return null totalCostInUsdCents when no windows returned", async () => {
      const campaign = await insertTestCampaign("org_stats_empty", {});

      const res = await request(app)
        .post("/stats/batch-budget")
        .set("x-api-key", API_KEY)
        .send({ campaignIds: [campaign.id] })
        .expect(200);

      expect(res.body.results[campaign.id].totalCostInUsdCents).toBeNull();
    });

    it("should handle multiple campaigns in batch", async () => {
      const c1 = await insertTestCampaign("org_stats_multi", { status: "ongoing" });
      const c2 = await insertTestCampaign("org_stats_multi", { status: "stopped" });

      mockGetStatsBudget
        .mockResolvedValueOnce({
          windows: [{ label: "total", totalCostInUsdCents: "100", actualCostInUsdCents: "100", provisionedCostInUsdCents: "0" }],
        })
        .mockResolvedValueOnce({
          windows: [{ label: "total", totalCostInUsdCents: "200", actualCostInUsdCents: "200", provisionedCostInUsdCents: "0" }],
        });

      const res = await request(app)
        .post("/stats/batch-budget")
        .set("x-api-key", API_KEY)
        .send({ campaignIds: [c1.id, c2.id] })
        .expect(200);

      expect(res.body.results[c1.id].status).toBe("ongoing");
      expect(res.body.results[c1.id].totalCostInUsdCents).toBe("100");
      expect(res.body.results[c2.id].status).toBe("stopped");
      expect(res.body.results[c2.id].totalCostInUsdCents).toBe("200");
    });

    it("should reject empty campaignIds array", async () => {
      await request(app)
        .post("/stats/batch-budget")
        .set("x-api-key", API_KEY)
        .send({ campaignIds: [] })
        .expect(400);
    });

    it("should reject missing body", async () => {
      await request(app)
        .post("/stats/batch-budget")
        .set("x-api-key", API_KEY)
        .send({})
        .expect(400);
    });
  });

  describe("GET /stats", () => {
    it("should return stats filtered by orgId", async () => {
      await insertTestCampaign("org_stats_get", { status: "ongoing", maxBudgetTotalUsd: "100.00", maxLeads: 50 });
      await insertTestCampaign("org_stats_get", { status: "stopped", maxBudgetTotalUsd: "200.00", maxLeads: 30 });
      await insertTestCampaign("org_other", { status: "ongoing" });

      const res = await request(app)
        .get("/stats?orgId=org_stats_get")
        .set("x-api-key", API_KEY)
        .expect(200);

      expect(res.body.stats.totalCampaigns).toBe(2);
      expect(res.body.stats.byStatus).toEqual({ ongoing: 1, stopped: 1 });
      expect(res.body.stats.budgetTotalUsd).toBe(300);
      expect(res.body.stats.maxLeadsTotal).toBe(80);
    });

    it("should return stats filtered by brandId", async () => {
      const brandId = crypto.randomUUID();
      await insertTestCampaign("org_brand_stat", { status: "ongoing", brandIds: [brandId] });
      await insertTestCampaign("org_brand_stat", { status: "ongoing" }); // no brandIds

      const res = await request(app)
        .get(`/stats?brandId=${brandId}`)
        .set("x-api-key", API_KEY)
        .expect(200);

      expect(res.body.stats.totalCampaigns).toBe(1);
    });

    it("should return stats filtered by campaignId", async () => {
      const c = await insertTestCampaign("org_cid_stat", { status: "ongoing", maxLeads: 42 });
      await insertTestCampaign("org_cid_stat", { status: "ongoing" });

      const res = await request(app)
        .get(`/stats?campaignId=${c.id}`)
        .set("x-api-key", API_KEY)
        .expect(200);

      expect(res.body.stats.totalCampaigns).toBe(1);
      expect(res.body.stats.maxLeadsTotal).toBe(42);
    });

    it("should reject request with no filter params", async () => {
      await request(app)
        .get("/stats")
        .set("x-api-key", API_KEY)
        .expect(400);
    });

    it("should return null budgetTotalUsd when no budgets set", async () => {
      await insertTestCampaign("org_no_budget", { status: "ongoing" });

      const res = await request(app)
        .get("/stats?orgId=org_no_budget")
        .set("x-api-key", API_KEY)
        .expect(200);

      expect(res.body.stats.budgetTotalUsd).toBeNull();
    });

    it("should return empty stats when no campaigns match", async () => {
      const res = await request(app)
        .get("/stats?orgId=nonexistent_org")
        .set("x-api-key", API_KEY)
        .expect(200);

      expect(res.body.stats.totalCampaigns).toBe(0);
      expect(res.body.stats.byStatus).toEqual({});
    });

    // --- workflowSlug filter ---

    it("should filter by workflowSlug", async () => {
      await insertTestCampaign("org_wf_filter", { workflowSlug: "cold-email", status: "ongoing" });
      await insertTestCampaign("org_wf_filter", { workflowSlug: "warm-intro", status: "ongoing" });

      const res = await request(app)
        .get("/stats?orgId=org_wf_filter&workflowSlug=cold-email")
        .set("x-api-key", API_KEY)
        .expect(200);

      expect(res.body.stats.totalCampaigns).toBe(1);
    });

    // --- featureSlug filter ---

    it("should filter by featureSlug", async () => {
      await insertTestCampaign("org_fs_filter", { featureSlug: "feat-alpha", status: "ongoing" });
      await insertTestCampaign("org_fs_filter", { featureSlug: "feat-beta", status: "ongoing" });

      const res = await request(app)
        .get("/stats?orgId=org_fs_filter&featureSlug=feat-alpha")
        .set("x-api-key", API_KEY)
        .expect(200);

      expect(res.body.stats.totalCampaigns).toBe(1);
    });

    // --- workflowDynastySlug filter ---

    it("should filter by workflowDynastySlug (resolved to versioned slugs)", async () => {
      await insertTestCampaign("org_wds", { workflowSlug: "cold-email", status: "ongoing" });
      await insertTestCampaign("org_wds", { workflowSlug: "cold-email-v2", status: "ongoing" });
      await insertTestCampaign("org_wds", { workflowSlug: "warm-intro", status: "ongoing" });

      mockResolveWorkflow.mockResolvedValueOnce(["cold-email", "cold-email-v2"]);

      const res = await request(app)
        .get("/stats?orgId=org_wds&workflowDynastySlug=cold-email")
        .set("x-api-key", API_KEY)
        .expect(200);

      expect(res.body.stats.totalCampaigns).toBe(2);
    });

    // --- featureDynastySlug filter ---

    it("should filter by featureDynastySlug (resolved to versioned slugs)", async () => {
      await insertTestCampaign("org_fds", { featureSlug: "feat-alpha", status: "ongoing" });
      await insertTestCampaign("org_fds", { featureSlug: "feat-alpha-v2", status: "ongoing" });
      await insertTestCampaign("org_fds", { featureSlug: "feat-beta", status: "stopped" });

      mockResolveFeature.mockResolvedValueOnce(["feat-alpha", "feat-alpha-v2"]);

      const res = await request(app)
        .get("/stats?orgId=org_fds&featureDynastySlug=feat-alpha")
        .set("x-api-key", API_KEY)
        .expect(200);

      expect(res.body.stats.totalCampaigns).toBe(2);
    });

    // --- combined dynasty + other filters ---

    it("should combine workflowDynastySlug with orgId filter", async () => {
      await insertTestCampaign("org_combo", { workflowSlug: "cold-email", status: "ongoing" });
      await insertTestCampaign("org_combo", { workflowSlug: "cold-email-v2", status: "stopped" });
      await insertTestCampaign("org_other_combo", { workflowSlug: "cold-email", status: "ongoing" });

      mockResolveWorkflow.mockResolvedValueOnce(["cold-email", "cold-email-v2"]);

      const res = await request(app)
        .get("/stats?orgId=org_combo&workflowDynastySlug=cold-email")
        .set("x-api-key", API_KEY)
        .expect(200);

      expect(res.body.stats.totalCampaigns).toBe(2);
    });

    // --- empty dynasty resolution → zero stats ---

    it("should return zero stats when dynasty resolves to empty list", async () => {
      await insertTestCampaign("org_empty_dyn", { status: "ongoing" });

      mockResolveWorkflow.mockResolvedValueOnce([]);

      const res = await request(app)
        .get("/stats?orgId=org_empty_dyn&workflowDynastySlug=nonexistent")
        .set("x-api-key", API_KEY)
        .expect(200);

      expect(res.body.stats.totalCampaigns).toBe(0);
      expect(res.body.stats.byStatus).toEqual({});
    });

    it("should return empty groupedStats when dynasty resolves to empty list with groupBy", async () => {
      await insertTestCampaign("org_empty_grp", { status: "ongoing" });

      mockResolveFeature.mockResolvedValueOnce([]);

      const res = await request(app)
        .get("/stats?orgId=org_empty_grp&featureDynastySlug=nonexistent&groupBy=featureDynastySlug")
        .set("x-api-key", API_KEY)
        .expect(200);

      expect(res.body.groupedStats).toEqual({});
    });

    // --- groupBy: workflowSlug ---

    it("should group by workflowSlug", async () => {
      await insertTestCampaign("org_gb_ws", { workflowSlug: "cold-email", status: "ongoing" });
      await insertTestCampaign("org_gb_ws", { workflowSlug: "cold-email", status: "stopped" });
      await insertTestCampaign("org_gb_ws", { workflowSlug: "warm-intro", status: "ongoing" });

      const res = await request(app)
        .get("/stats?orgId=org_gb_ws&groupBy=workflowSlug")
        .set("x-api-key", API_KEY)
        .expect(200);

      expect(res.body.groupedStats["cold-email"].totalCampaigns).toBe(2);
      expect(res.body.groupedStats["cold-email"].byStatus).toEqual({ ongoing: 1, stopped: 1 });
      expect(res.body.groupedStats["warm-intro"].totalCampaigns).toBe(1);
    });

    // --- groupBy: featureSlug ---

    it("should group by featureSlug", async () => {
      await insertTestCampaign("org_gb_fs", { featureSlug: "feat-alpha", status: "ongoing" });
      await insertTestCampaign("org_gb_fs", { featureSlug: "feat-alpha", status: "stopped" });
      await insertTestCampaign("org_gb_fs", { featureSlug: "feat-beta", status: "ongoing" });

      const res = await request(app)
        .get("/stats?orgId=org_gb_fs&groupBy=featureSlug")
        .set("x-api-key", API_KEY)
        .expect(200);

      expect(res.body.groupedStats["feat-alpha"].totalCampaigns).toBe(2);
      expect(res.body.groupedStats["feat-beta"].totalCampaigns).toBe(1);
    });

    // --- groupBy: workflowDynastySlug ---

    it("should group by workflowDynastySlug", async () => {
      await insertTestCampaign("org_gb_wds", { workflowSlug: "cold-email", status: "ongoing" });
      await insertTestCampaign("org_gb_wds", { workflowSlug: "cold-email-v2", status: "ongoing" });
      await insertTestCampaign("org_gb_wds", { workflowSlug: "warm-intro", status: "stopped" });

      mockWorkflowMap.mockResolvedValueOnce(new Map([
        ["cold-email", "cold-email"],
        ["cold-email-v2", "cold-email"],
        ["warm-intro", "warm-intro"],
      ]));

      const res = await request(app)
        .get("/stats?orgId=org_gb_wds&groupBy=workflowDynastySlug")
        .set("x-api-key", API_KEY)
        .expect(200);

      expect(res.body.groupedStats["cold-email"].totalCampaigns).toBe(2);
      expect(res.body.groupedStats["warm-intro"].totalCampaigns).toBe(1);
    });

    // --- groupBy: featureDynastySlug ---

    it("should group by featureDynastySlug", async () => {
      await insertTestCampaign("org_gb_fds", { featureSlug: "feat-alpha", status: "ongoing" });
      await insertTestCampaign("org_gb_fds", { featureSlug: "feat-alpha-v2", status: "ongoing" });
      await insertTestCampaign("org_gb_fds", { featureSlug: "feat-beta", status: "stopped" });

      mockFeatureMap.mockResolvedValueOnce(new Map([
        ["feat-alpha", "feat-alpha"],
        ["feat-alpha-v2", "feat-alpha"],
        ["feat-beta", "feat-beta"],
      ]));

      const res = await request(app)
        .get("/stats?orgId=org_gb_fds&groupBy=featureDynastySlug")
        .set("x-api-key", API_KEY)
        .expect(200);

      expect(res.body.groupedStats["feat-alpha"].totalCampaigns).toBe(2);
      expect(res.body.groupedStats["feat-beta"].totalCampaigns).toBe(1);
    });

    // --- orphan slugs fallback ---

    it("should fallback orphan slugs to raw value when grouping by dynasty", async () => {
      await insertTestCampaign("org_gb_orphan", { workflowSlug: "cold-email", status: "ongoing" });
      await insertTestCampaign("org_gb_orphan", { workflowSlug: "orphan-wf", status: "ongoing" });

      mockWorkflowMap.mockResolvedValueOnce(new Map([
        ["cold-email", "cold-email"],
      ]));

      const res = await request(app)
        .get("/stats?orgId=org_gb_orphan&groupBy=workflowDynastySlug")
        .set("x-api-key", API_KEY)
        .expect(200);

      expect(res.body.groupedStats["cold-email"].totalCampaigns).toBe(1);
      expect(res.body.groupedStats["orphan-wf"].totalCampaigns).toBe(1);
    });
  });
});
