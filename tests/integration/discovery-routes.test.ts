import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import app from "../../src/index.js";
import { cleanTestData, insertTestCampaign, closeDb } from "../helpers/test-db.js";

const API_KEY = process.env.CAMPAIGN_SERVICE_API_KEY || "test-api-key";
const ORG_ID = "org_discovery_test";

describe("Discovery Routes", () => {
  beforeEach(async () => {
    await cleanTestData();
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  // === Discovered Outlets ===

  describe("POST /campaigns/:id/discovered-outlets", () => {
    it("should store outlets for a campaign", async () => {
      const campaign = await insertTestCampaign(ORG_ID, {
        workflowName: "outlets-database-discovery-cedar",
      });

      const res = await request(app)
        .post(`/campaigns/${campaign.id}/discovered-outlets`)
        .set("x-api-key", API_KEY)
        .set("x-org-id", ORG_ID)
        .send({
          outlets: [
            {
              name: "TechCrunch",
              type: "blog",
              url: "https://techcrunch.com",
              domainRating: 92,
              monthlyTraffic: 5000000,
              topics: ["tech", "startups"],
              country: "US",
              language: "en",
              contactEmail: "tips@techcrunch.com",
              notes: "Top-tier tech publication",
            },
            {
              name: "Wired",
              type: "magazine",
              url: "https://wired.com",
              domainRating: 91,
              topics: ["tech", "science"],
            },
          ],
        })
        .expect(201);

      expect(res.body.outlets).toHaveLength(2);
      expect(res.body.outlets[0].name).toBe("TechCrunch");
      expect(res.body.outlets[0].domainRating).toBe(92);
      expect(res.body.outlets[0].topics).toEqual(["tech", "startups"]);
      expect(res.body.outlets[0].id).toBeDefined();
      expect(res.body.outlets[0].createdAt).toBeDefined();
      expect(res.body.outlets[1].name).toBe("Wired");
    });

    it("should return 404 for non-existent campaign", async () => {
      const res = await request(app)
        .post(`/campaigns/${crypto.randomUUID()}/discovered-outlets`)
        .set("x-api-key", API_KEY)
        .set("x-org-id", ORG_ID)
        .send({ outlets: [{ name: "Test" }] })
        .expect(404);

      expect(res.body.error).toBe("Campaign not found");
    });

    it("should reject empty outlets array", async () => {
      const campaign = await insertTestCampaign(ORG_ID);

      await request(app)
        .post(`/campaigns/${campaign.id}/discovered-outlets`)
        .set("x-api-key", API_KEY)
        .set("x-org-id", ORG_ID)
        .send({ outlets: [] })
        .expect(400);
    });

    it("should reject when outlets is missing", async () => {
      const campaign = await insertTestCampaign(ORG_ID);

      await request(app)
        .post(`/campaigns/${campaign.id}/discovered-outlets`)
        .set("x-api-key", API_KEY)
        .set("x-org-id", ORG_ID)
        .send({})
        .expect(400);
    });

    it("should not allow cross-org access", async () => {
      const campaign = await insertTestCampaign(ORG_ID);

      await request(app)
        .post(`/campaigns/${campaign.id}/discovered-outlets`)
        .set("x-api-key", API_KEY)
        .set("x-org-id", "other_org")
        .send({ outlets: [{ name: "Test" }] })
        .expect(404);
    });
  });

  describe("GET /campaigns/:id/discovered-outlets", () => {
    it("should return paginated outlets", async () => {
      const campaign = await insertTestCampaign(ORG_ID, {
        workflowName: "outlets-database-discovery-cedar",
      });

      // Insert 3 outlets
      await request(app)
        .post(`/campaigns/${campaign.id}/discovered-outlets`)
        .set("x-api-key", API_KEY)
        .set("x-org-id", ORG_ID)
        .send({
          outlets: [
            { name: "Outlet A", topics: ["tech"] },
            { name: "Outlet B", topics: ["finance"] },
            { name: "Outlet C", topics: ["health"] },
          ],
        })
        .expect(201);

      // Get first page
      const res = await request(app)
        .get(`/campaigns/${campaign.id}/discovered-outlets?limit=2&offset=0`)
        .set("x-api-key", API_KEY)
        .set("x-org-id", ORG_ID)
        .expect(200);

      expect(res.body.outlets).toHaveLength(2);
      expect(res.body.pagination).toEqual({ total: 3, limit: 2, offset: 0 });

      // Get second page
      const res2 = await request(app)
        .get(`/campaigns/${campaign.id}/discovered-outlets?limit=2&offset=2`)
        .set("x-api-key", API_KEY)
        .set("x-org-id", ORG_ID)
        .expect(200);

      expect(res2.body.outlets).toHaveLength(1);
      expect(res2.body.pagination).toEqual({ total: 3, limit: 2, offset: 2 });
    });

    it("should return empty array for campaign with no outlets", async () => {
      const campaign = await insertTestCampaign(ORG_ID);

      const res = await request(app)
        .get(`/campaigns/${campaign.id}/discovered-outlets`)
        .set("x-api-key", API_KEY)
        .set("x-org-id", ORG_ID)
        .expect(200);

      expect(res.body.outlets).toEqual([]);
      expect(res.body.pagination.total).toBe(0);
    });

    it("should return 404 for non-existent campaign", async () => {
      await request(app)
        .get(`/campaigns/${crypto.randomUUID()}/discovered-outlets`)
        .set("x-api-key", API_KEY)
        .set("x-org-id", ORG_ID)
        .expect(404);
    });

    it("should use default pagination", async () => {
      const campaign = await insertTestCampaign(ORG_ID);

      const res = await request(app)
        .get(`/campaigns/${campaign.id}/discovered-outlets`)
        .set("x-api-key", API_KEY)
        .set("x-org-id", ORG_ID)
        .expect(200);

      expect(res.body.pagination.limit).toBe(50);
      expect(res.body.pagination.offset).toBe(0);
    });
  });

  // === Discovered Journalists ===

  describe("POST /campaigns/:id/discovered-journalists", () => {
    it("should store journalists for a campaign", async () => {
      const campaign = await insertTestCampaign(ORG_ID, {
        workflowName: "journalists-database-discovery-cedar",
      });

      const res = await request(app)
        .post(`/campaigns/${campaign.id}/discovered-journalists`)
        .set("x-api-key", API_KEY)
        .set("x-org-id", ORG_ID)
        .send({
          journalists: [
            {
              firstName: "Jane",
              lastName: "Doe",
              email: "jane@techcrunch.com",
              outletName: "TechCrunch",
              title: "Senior Reporter",
              beat: "AI",
              linkedinUrl: "https://linkedin.com/in/janedoe",
              twitterHandle: "@janedoe",
              location: "San Francisco, US",
              domainRating: 92,
              notes: "Covers AI startups",
            },
            {
              firstName: "John",
              lastName: "Smith",
              email: "john@wired.com",
              outletName: "Wired",
            },
          ],
        })
        .expect(201);

      expect(res.body.journalists).toHaveLength(2);
      expect(res.body.journalists[0].firstName).toBe("Jane");
      expect(res.body.journalists[0].domainRating).toBe(92);
      expect(res.body.journalists[0].id).toBeDefined();
      expect(res.body.journalists[0].createdAt).toBeDefined();
      expect(res.body.journalists[1].firstName).toBe("John");
    });

    it("should return 404 for non-existent campaign", async () => {
      await request(app)
        .post(`/campaigns/${crypto.randomUUID()}/discovered-journalists`)
        .set("x-api-key", API_KEY)
        .set("x-org-id", ORG_ID)
        .send({ journalists: [{ firstName: "Test" }] })
        .expect(404);
    });

    it("should reject empty journalists array", async () => {
      const campaign = await insertTestCampaign(ORG_ID);

      await request(app)
        .post(`/campaigns/${campaign.id}/discovered-journalists`)
        .set("x-api-key", API_KEY)
        .set("x-org-id", ORG_ID)
        .send({ journalists: [] })
        .expect(400);
    });
  });

  describe("GET /campaigns/:id/discovered-journalists", () => {
    it("should return paginated journalists", async () => {
      const campaign = await insertTestCampaign(ORG_ID, {
        workflowName: "journalists-database-discovery-cedar",
      });

      // Insert journalists
      await request(app)
        .post(`/campaigns/${campaign.id}/discovered-journalists`)
        .set("x-api-key", API_KEY)
        .set("x-org-id", ORG_ID)
        .send({
          journalists: [
            { firstName: "Alice", lastName: "A" },
            { firstName: "Bob", lastName: "B" },
            { firstName: "Charlie", lastName: "C" },
          ],
        })
        .expect(201);

      const res = await request(app)
        .get(`/campaigns/${campaign.id}/discovered-journalists?limit=2&offset=0`)
        .set("x-api-key", API_KEY)
        .set("x-org-id", ORG_ID)
        .expect(200);

      expect(res.body.journalists).toHaveLength(2);
      expect(res.body.pagination).toEqual({ total: 3, limit: 2, offset: 0 });
    });

    it("should return empty array for campaign with no journalists", async () => {
      const campaign = await insertTestCampaign(ORG_ID);

      const res = await request(app)
        .get(`/campaigns/${campaign.id}/discovered-journalists`)
        .set("x-api-key", API_KEY)
        .set("x-org-id", ORG_ID)
        .expect(200);

      expect(res.body.journalists).toEqual([]);
      expect(res.body.pagination.total).toBe(0);
    });

    it("should cascade delete when campaign is deleted", async () => {
      const campaign = await insertTestCampaign(ORG_ID);

      // Add outlets and journalists
      await request(app)
        .post(`/campaigns/${campaign.id}/discovered-outlets`)
        .set("x-api-key", API_KEY)
        .set("x-org-id", ORG_ID)
        .send({ outlets: [{ name: "Test Outlet", topics: [] }] })
        .expect(201);

      await request(app)
        .post(`/campaigns/${campaign.id}/discovered-journalists`)
        .set("x-api-key", API_KEY)
        .set("x-org-id", ORG_ID)
        .send({ journalists: [{ firstName: "Test" }] })
        .expect(201);

      // Delete campaign
      await request(app)
        .delete(`/campaigns/${campaign.id}`)
        .set("x-api-key", API_KEY)
        .set("x-org-id", ORG_ID)
        .expect(200);

      // Verify data is gone (campaign not found)
      await request(app)
        .get(`/campaigns/${campaign.id}/discovered-outlets`)
        .set("x-api-key", API_KEY)
        .set("x-org-id", ORG_ID)
        .expect(404);
    });
  });
});
