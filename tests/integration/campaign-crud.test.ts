import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import app from "../../src/index.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";

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
    workflowName: "sales-email-cold-outreach",
    orgId: "org_test_crud",
    brandUrl: "https://example.com",
    brandId: crypto.randomUUID(),
    targetOutcome: "Book sales demos",
    valueForTarget: "Access to enterprise analytics at startup pricing",
  };

  describe("POST /campaigns", () => {
    it("should create a campaign with all required fields", async () => {
      const res = await request(app)
        .post("/campaigns")
        .set("x-api-key", API_KEY)
        .set("x-org-id", "org_test_crud")
        .send(validBody)
        .expect(201);

      expect(res.body.campaign).toBeDefined();
      expect(res.body.campaign.name).toBe("Test Campaign");
      expect(res.body.campaign.workflowName).toBe("sales-email-cold-outreach");
      expect(res.body.campaign.brandId).toBe(validBody.brandId);
    });

    it("should reject when workflowName is missing", async () => {
      const { workflowName, ...body } = validBody;

      const res = await request(app)
        .post("/campaigns")
        .set("x-api-key", API_KEY)
        .set("x-org-id", "org_test_crud")
        .send(body)
        .expect(400);

      expect(res.body.error).toBeDefined();
    });

    it("should reject when brandId is missing", async () => {
      const { brandId, ...body } = validBody;

      const res = await request(app)
        .post("/campaigns")
        .set("x-api-key", API_KEY)
        .set("x-org-id", "org_test_crud")
        .send(body)
        .expect(400);

      expect(res.body.error).toBeDefined();
    });

    it("should reject when orgId is missing from body", async () => {
      const { orgId, ...body } = validBody;

      const res = await request(app)
        .post("/campaigns")
        .set("x-api-key", API_KEY)
        .set("x-org-id", "org_test_crud")
        .send(body)
        .expect(400);

      expect(res.body.error).toBeDefined();
    });

    it("should reject when brandId is not a valid UUID", async () => {
      const res = await request(app)
        .post("/campaigns")
        .set("x-api-key", API_KEY)
        .set("x-org-id", "org_test_crud")
        .send({ ...validBody, brandId: "not-a-uuid" })
        .expect(400);

      expect(res.body.error).toBeDefined();
    });

    it("should create a campaign with targetAudience", async () => {
      const audience = "CEOs and CTOs at SaaS startups with 1-50 employees in the US";
      const res = await request(app)
        .post("/campaigns")
        .set("x-api-key", API_KEY)
        .set("x-org-id", "org_test_crud")
        .send({ ...validBody, targetAudience: audience })
        .expect(201);

      expect(res.body.campaign.targetAudience).toBe(audience);
    });

    it("should create a campaign without targetAudience", async () => {
      const res = await request(app)
        .post("/campaigns")
        .set("x-api-key", API_KEY)
        .set("x-org-id", "org_test_crud")
        .send(validBody)
        .expect(201);

      expect(res.body.campaign.targetAudience).toBeNull();
    });

    it("should create a campaign with targetOutcome and valueForTarget", async () => {
      const res = await request(app)
        .post("/campaigns")
        .set("x-api-key", API_KEY)
        .set("x-org-id", "org_test_crud")
        .send(validBody)
        .expect(201);

      expect(res.body.campaign.targetOutcome).toBe("Book sales demos");
      expect(res.body.campaign.valueForTarget).toBe("Access to enterprise analytics at startup pricing");
    });

    it("should reject when targetOutcome is missing", async () => {
      const { targetOutcome, ...body } = validBody;

      const res = await request(app)
        .post("/campaigns")
        .set("x-api-key", API_KEY)
        .set("x-org-id", "org_test_crud")
        .send(body)
        .expect(400);

      expect(res.body.error).toBeDefined();
    });

    it("should reject when valueForTarget is missing", async () => {
      const { valueForTarget, ...body } = validBody;

      const res = await request(app)
        .post("/campaigns")
        .set("x-api-key", API_KEY)
        .set("x-org-id", "org_test_crud")
        .send(body)
        .expect(400);

      expect(res.body.error).toBeDefined();
    });

    it("should reject when targetOutcome is empty string", async () => {
      const res = await request(app)
        .post("/campaigns")
        .set("x-api-key", API_KEY)
        .set("x-org-id", "org_test_crud")
        .send({ ...validBody, targetOutcome: "" })
        .expect(400);

      expect(res.body.error).toBeDefined();
    });

    it("should reject when valueForTarget is empty string", async () => {
      const res = await request(app)
        .post("/campaigns")
        .set("x-api-key", API_KEY)
        .set("x-org-id", "org_test_crud")
        .send({ ...validBody, valueForTarget: "" })
        .expect(400);

      expect(res.body.error).toBeDefined();
    });

    it("should reject Apollo fields that no longer exist", async () => {
      const res = await request(app)
        .post("/campaigns")
        .set("x-api-key", API_KEY)
        .set("x-org-id", "org_test_crud")
        .send({ ...validBody, personTitles: ["CEO"] });

      // Zod strips unknown fields by default, so it should still succeed
      // but the field should not appear in the response
      expect(res.body.campaign).toBeDefined();
      expect(res.body.campaign).not.toHaveProperty("personTitles");
    });

    it("should not have legacy fields on campaign", async () => {
      const res = await request(app)
        .post("/campaigns")
        .set("x-api-key", API_KEY)
        .set("x-org-id", "org_test_crud")
        .send(validBody)
        .expect(201);

      expect(res.body.campaign).not.toHaveProperty("urgency");
      expect(res.body.campaign).not.toHaveProperty("scarcity");
      expect(res.body.campaign).not.toHaveProperty("riskReversal");
      expect(res.body.campaign).not.toHaveProperty("socialProof");
      expect(res.body.campaign).not.toHaveProperty("type");
      expect(res.body.campaign).not.toHaveProperty("appId");
      expect(res.body.campaign).not.toHaveProperty("keySource");
    });
  });

  describe("PATCH /campaigns/:id", () => {
    it("should accept activate", async () => {
      const createRes = await request(app)
        .post("/campaigns")
        .set("x-api-key", API_KEY)
        .set("x-org-id", "org_test_crud")
        .send(validBody)
        .expect(201);

      const campaignId = createRes.body.campaign.id;

      // Stop first
      await request(app)
        .patch(`/campaigns/${campaignId}`)
        .set("x-api-key", API_KEY)
        .set("x-org-id", "org_test_crud")
        .send({ status: "stop" })
        .expect(200);

      // Activate
      const activateRes = await request(app)
        .patch(`/campaigns/${campaignId}`)
        .set("x-api-key", API_KEY)
        .set("x-org-id", "org_test_crud")
        .send({ status: "activate" })
        .expect(200);

      expect(activateRes.body.campaign.status).toBe("ongoing");
    });

    it("should update targetAudience", async () => {
      const createRes = await request(app)
        .post("/campaigns")
        .set("x-api-key", API_KEY)
        .set("x-org-id", "org_test_crud")
        .send(validBody)
        .expect(201);

      const campaignId = createRes.body.campaign.id;
      const newAudience = "VPs of Engineering at fintech companies";

      const updateRes = await request(app)
        .patch(`/campaigns/${campaignId}`)
        .set("x-api-key", API_KEY)
        .set("x-org-id", "org_test_crud")
        .send({ targetAudience: newAudience })
        .expect(200);

      expect(updateRes.body.campaign.targetAudience).toBe(newAudience);
    });

    it("should update targetOutcome and valueForTarget", async () => {
      const createRes = await request(app)
        .post("/campaigns")
        .set("x-api-key", API_KEY)
        .set("x-org-id", "org_test_crud")
        .send(validBody)
        .expect(201);

      const campaignId = createRes.body.campaign.id;

      const updateRes = await request(app)
        .patch(`/campaigns/${campaignId}`)
        .set("x-api-key", API_KEY)
        .set("x-org-id", "org_test_crud")
        .send({
          targetOutcome: "Recruit community ambassadors",
          valueForTarget: "Early access to beta features",
        })
        .expect(200);

      expect(updateRes.body.campaign.targetOutcome).toBe("Recruit community ambassadors");
      expect(updateRes.body.campaign.valueForTarget).toBe("Early access to beta features");
    });
  });
});
