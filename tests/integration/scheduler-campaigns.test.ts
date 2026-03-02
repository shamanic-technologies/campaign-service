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

describe("Scheduler Endpoints", () => {
  beforeEach(async () => {
    await cleanTestData();
    vi.clearAllMocks();
    mockGetStatsBudget.mockResolvedValue({ windows: [] });
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  describe("GET /campaigns/list", () => {
    it("should return all campaigns across all orgs", async () => {
      await insertTestCampaign("org_1", { name: "Org1 Campaign", status: "ongoing" });
      await insertTestCampaign("org_2", { name: "Org2 Campaign", status: "ongoing" });

      const res = await request(app)
        .get("/campaigns/list")
        .set("x-api-key", API_KEY)
        .expect(200);

      expect(res.body.campaigns).toHaveLength(2);
    });

    it("should include orgId for downstream service calls", async () => {
      await insertTestCampaign("org_test_ext", { name: "Test", status: "ongoing" });

      const res = await request(app)
        .get("/campaigns/list")
        .set("x-api-key", API_KEY)
        .expect(200);

      expect(res.body.campaigns[0].orgId).toBe("org_test_ext");
    });

    it("should return empty array when no campaigns", async () => {
      const res = await request(app)
        .get("/campaigns/list")
        .set("x-api-key", API_KEY)
        .expect(200);

      expect(res.body.campaigns).toHaveLength(0);
    });
  });

  describe("POST /campaigns/batch-budget-usage", () => {
    it("should return cost total from getStatsBudget for each campaign", async () => {
      const campaign = await insertTestCampaign("org_batch", {
        status: "ongoing",
        maxBudgetTotalUsd: "50.00",
        maxLeads: 100,
      });

      mockGetStatsBudget.mockResolvedValue({
        windows: [{ label: "total", totalCostInUsdCents: "1234", actualCostInUsdCents: "1234", provisionedCostInUsdCents: "0" }],
      });

      const res = await request(app)
        .post("/campaigns/batch-budget-usage")
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
      const campaign = await insertTestCampaign("org_batch_params", {});

      mockGetStatsBudget.mockResolvedValue({ windows: [] });

      await request(app)
        .post("/campaigns/batch-budget-usage")
        .set("x-api-key", API_KEY)
        .send({ campaignIds: [campaign.id] })
        .expect(200);

      expect(mockGetStatsBudget).toHaveBeenCalledWith({
        orgId: "org_batch_params",
        campaignId: campaign.id,
        windows: [{ label: "total" }],
      });
    });

    it("should handle not-found campaign gracefully", async () => {
      const fakeId = crypto.randomUUID();

      const res = await request(app)
        .post("/campaigns/batch-budget-usage")
        .set("x-api-key", API_KEY)
        .send({ campaignIds: [fakeId] })
        .expect(200);

      expect(res.body.results[fakeId]).toEqual({ error: "Campaign not found" });
    });

    it("should handle getStatsBudget failure gracefully", async () => {
      const campaign = await insertTestCampaign("org_batch_err", {});

      mockGetStatsBudget.mockRejectedValue(new Error("runs-service down"));

      const res = await request(app)
        .post("/campaigns/batch-budget-usage")
        .set("x-api-key", API_KEY)
        .send({ campaignIds: [campaign.id] })
        .expect(200);

      expect(res.body.results[campaign.id]).toEqual({ error: "Failed to fetch stats" });
    });

    it("should return null totalCostInUsdCents when no windows returned", async () => {
      const campaign = await insertTestCampaign("org_batch_empty", {});

      mockGetStatsBudget.mockResolvedValue({ windows: [] });

      const res = await request(app)
        .post("/campaigns/batch-budget-usage")
        .set("x-api-key", API_KEY)
        .send({ campaignIds: [campaign.id] })
        .expect(200);

      expect(res.body.results[campaign.id].totalCostInUsdCents).toBeNull();
    });

    it("should handle multiple campaigns in batch", async () => {
      const c1 = await insertTestCampaign("org_multi", { status: "ongoing" });
      const c2 = await insertTestCampaign("org_multi", { status: "stopped" });

      mockGetStatsBudget
        .mockResolvedValueOnce({
          windows: [{ label: "total", totalCostInUsdCents: "100", actualCostInUsdCents: "100", provisionedCostInUsdCents: "0" }],
        })
        .mockResolvedValueOnce({
          windows: [{ label: "total", totalCostInUsdCents: "200", actualCostInUsdCents: "200", provisionedCostInUsdCents: "0" }],
        });

      const res = await request(app)
        .post("/campaigns/batch-budget-usage")
        .set("x-api-key", API_KEY)
        .send({ campaignIds: [c1.id, c2.id] })
        .expect(200);

      expect(res.body.results[c1.id].status).toBe("ongoing");
      expect(res.body.results[c1.id].totalCostInUsdCents).toBe("100");
      expect(res.body.results[c2.id].status).toBe("stopped");
      expect(res.body.results[c2.id].totalCostInUsdCents).toBe("200");
    });
  });
});
