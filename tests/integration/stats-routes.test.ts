import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";

const { mockGetStatsBudget } = vi.hoisted(() => ({
  mockGetStatsBudget: vi.fn(),
}));

vi.mock("@mcpfactory/runs-client", () => ({
  listRuns: vi.fn(),
  createRun: vi.fn(),
  updateRun: vi.fn(),
  getStatsBudget: mockGetStatsBudget,
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
      await insertTestCampaign("org_brand_stat", { status: "ongoing", brandId });
      await insertTestCampaign("org_brand_stat", { status: "ongoing" }); // no brandId

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
  });
});
