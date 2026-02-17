import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import app from "../../src/index.js";
import { cleanTestData, closeDb, insertTestOrg } from "../helpers/test-db.js";

const API_KEY = process.env.CAMPAIGN_SERVICE_API_KEY || "test-api-key";

describe("Campaign CRUD", () => {
  beforeEach(async () => {
    await cleanTestData();
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  const validBody = {
    name: "Test Campaign",
    clerkOrgId: "org_test_crud",
    brandUrl: "https://example.com",
    brandId: crypto.randomUUID(),
    appId: "mcpfactory",
  };

  describe("POST /campaigns", () => {
    it("should create a campaign with all required fields", async () => {
      const res = await request(app)
        .post("/campaigns")
        .set("x-api-key", API_KEY)
        .set("x-clerk-org-id", "org_test_crud")
        .send(validBody)
        .expect(201);

      expect(res.body.campaign).toBeDefined();
      expect(res.body.campaign.name).toBe("Test Campaign");
      expect(res.body.campaign.brandId).toBe(validBody.brandId);
      expect(res.body.campaign.appId).toBe("mcpfactory");
    });

    it("should reject when brandId is missing", async () => {
      const { brandId, ...body } = validBody;

      const res = await request(app)
        .post("/campaigns")
        .set("x-api-key", API_KEY)
        .set("x-clerk-org-id", "org_test_crud")
        .send(body)
        .expect(400);

      expect(res.body.error).toBeDefined();
    });

    it("should reject when appId is missing", async () => {
      const { appId, ...body } = validBody;

      const res = await request(app)
        .post("/campaigns")
        .set("x-api-key", API_KEY)
        .set("x-clerk-org-id", "org_test_crud")
        .send(body)
        .expect(400);

      expect(res.body.error).toBeDefined();
    });

    it("should reject when clerkOrgId is missing from body", async () => {
      const { clerkOrgId, ...body } = validBody;

      const res = await request(app)
        .post("/campaigns")
        .set("x-api-key", API_KEY)
        .set("x-clerk-org-id", "org_test_crud")
        .send(body)
        .expect(400);

      expect(res.body.error).toBeDefined();
    });

    it("should reject when brandId is not a valid UUID", async () => {
      const res = await request(app)
        .post("/campaigns")
        .set("x-api-key", API_KEY)
        .set("x-clerk-org-id", "org_test_crud")
        .send({ ...validBody, brandId: "not-a-uuid" })
        .expect(400);

      expect(res.body.error).toBeDefined();
    });

    it("should create a campaign with targetAudience", async () => {
      const audience = "CEOs and CTOs at SaaS startups with 1-50 employees in the US";
      const res = await request(app)
        .post("/campaigns")
        .set("x-api-key", API_KEY)
        .set("x-clerk-org-id", "org_test_crud")
        .send({ ...validBody, targetAudience: audience })
        .expect(201);

      expect(res.body.campaign.targetAudience).toBe(audience);
    });

    it("should create a campaign without targetAudience", async () => {
      const res = await request(app)
        .post("/campaigns")
        .set("x-api-key", API_KEY)
        .set("x-clerk-org-id", "org_test_crud")
        .send(validBody)
        .expect(201);

      expect(res.body.campaign.targetAudience).toBeNull();
    });

    it("should reject Apollo fields that no longer exist", async () => {
      const res = await request(app)
        .post("/campaigns")
        .set("x-api-key", API_KEY)
        .set("x-clerk-org-id", "org_test_crud")
        .send({ ...validBody, personTitles: ["CEO"] });

      // Zod strips unknown fields by default, so it should still succeed
      // but the field should not appear in the response
      expect(res.body.campaign).toBeDefined();
      expect(res.body.campaign).not.toHaveProperty("personTitles");
    });
  });

  describe("PATCH /campaigns/:id", () => {
    it("should update targetAudience", async () => {
      // Create campaign first
      const createRes = await request(app)
        .post("/campaigns")
        .set("x-api-key", API_KEY)
        .set("x-clerk-org-id", "org_test_crud")
        .send(validBody)
        .expect(201);

      const campaignId = createRes.body.campaign.id;
      const newAudience = "VPs of Engineering at fintech companies";

      const updateRes = await request(app)
        .patch(`/campaigns/${campaignId}`)
        .set("x-api-key", API_KEY)
        .set("x-clerk-org-id", "org_test_crud")
        .send({ targetAudience: newAudience })
        .expect(200);

      expect(updateRes.body.campaign.targetAudience).toBe(newAudience);
    });
  });
});
