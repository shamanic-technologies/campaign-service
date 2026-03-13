import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";

vi.mock("@mcpfactory/runs-client", () => ({
  listRuns: vi.fn(),
  createRun: vi.fn(),
  updateRun: vi.fn(),
  getStatsBudget: vi.fn().mockResolvedValue({ windows: [] }),
}));

import app from "../../src/index.js";
import { cleanTestData, closeDb, insertTestCampaign } from "../helpers/test-db.js";

const API_KEY = process.env.CAMPAIGN_SERVICE_API_KEY || "test-api-key";

describe("Scheduler Endpoints", () => {
  beforeEach(async () => {
    await cleanTestData();
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
});
