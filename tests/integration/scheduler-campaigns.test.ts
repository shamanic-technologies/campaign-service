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
import { cleanTestData, closeDb, insertTestOrg, insertTestCampaign } from "../helpers/test-db.js";

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
      const org1 = await insertTestOrg({ clerkOrgId: "org_1" });
      const org2 = await insertTestOrg({ clerkOrgId: "org_2" });

      await insertTestCampaign(org1.id, { name: "Org1 Campaign", status: "ongoing" });
      await insertTestCampaign(org2.id, { name: "Org2 Campaign", status: "ongoing" });

      const res = await request(app)
        .get("/campaigns/list")
        .set("x-api-key", API_KEY)
        .expect(200);

      expect(res.body.campaigns).toHaveLength(2);
      expect(res.body.campaigns[0].clerkOrgId).toBeDefined();
    });

    it("should include clerkOrgId for downstream service calls", async () => {
      const org = await insertTestOrg({ clerkOrgId: "org_test_clerk" });
      await insertTestCampaign(org.id, { name: "Test", status: "ongoing" });

      const res = await request(app)
        .get("/campaigns/list")
        .set("x-api-key", API_KEY)
        .expect(200);

      expect(res.body.campaigns[0].clerkOrgId).toBe("org_test_clerk");
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
      const org = await insertTestOrg({ clerkOrgId: "org_batch" });
      const campaign = await insertTestCampaign(org.id, {
        status: "ongoing",
        maxBudgetTotalUsd: "50.00",
        maxLeads: 100,
        appId: "mcpfactory",
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
      const org = await insertTestOrg({ clerkOrgId: "org_batch_params" });
      const campaign = await insertTestCampaign(org.id, { appId: "mcpfactory" });

      mockGetStatsBudget.mockResolvedValue({ windows: [] });

      await request(app)
        .post("/campaigns/batch-budget-usage")
        .set("x-api-key", API_KEY)
        .send({ campaignIds: [campaign.id] })
        .expect(200);

      expect(mockGetStatsBudget).toHaveBeenCalledWith({
        clerkOrgId: "org_batch_params",
        appId: "mcpfactory",
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
      const org = await insertTestOrg({ clerkOrgId: "org_batch_err" });
      const campaign = await insertTestCampaign(org.id, { appId: "mcpfactory" });

      mockGetStatsBudget.mockRejectedValue(new Error("runs-service down"));

      const res = await request(app)
        .post("/campaigns/batch-budget-usage")
        .set("x-api-key", API_KEY)
        .send({ campaignIds: [campaign.id] })
        .expect(200);

      expect(res.body.results[campaign.id]).toEqual({ error: "Failed to fetch stats" });
    });

    it("should return null totalCostInUsdCents when no windows returned", async () => {
      const org = await insertTestOrg({ clerkOrgId: "org_batch_empty" });
      const campaign = await insertTestCampaign(org.id, { appId: "mcpfactory" });

      mockGetStatsBudget.mockResolvedValue({ windows: [] });

      const res = await request(app)
        .post("/campaigns/batch-budget-usage")
        .set("x-api-key", API_KEY)
        .send({ campaignIds: [campaign.id] })
        .expect(200);

      expect(res.body.results[campaign.id].totalCostInUsdCents).toBeNull();
    });

    it("should handle multiple campaigns in batch", async () => {
      const org = await insertTestOrg({ clerkOrgId: "org_multi" });
      const c1 = await insertTestCampaign(org.id, { appId: "mcpfactory", status: "ongoing" });
      const c2 = await insertTestCampaign(org.id, { appId: "mcpfactory", status: "stopped" });

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
