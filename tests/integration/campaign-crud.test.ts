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
    workflowSlug: "sales-email-cold-outreach",
    orgId: "org_test_crud",
    brandIds: [crypto.randomUUID()],
  };
  const attribution = {
    activeGoalId: "goal_test_crud",
    brandProfileId: "brand_profile_test_crud",
    audienceId: "audience_test_crud",
  };

  /** Helper: create a campaign with all required headers */
  function createCampaign(body: Record<string, unknown> = validBody, orgId = "org_test_crud") {
    return request(app)
      .post("/campaigns")
      .set("x-api-key", API_KEY)
      .set("x-org-id", orgId)
      .set("x-user-id", "user_test_crud")
      .set("x-run-id", crypto.randomUUID())
      .set("x-feature-slug", "sales-cold-email-v1")
      .send(body);
  }

  describe("POST /campaigns", () => {
    it("should create a campaign with all required fields", async () => {
      const res = await createCampaign().expect(201);

      expect(res.body.campaign).toBeDefined();
      expect(res.body.campaign.name).toBe("Test Campaign");
      expect(res.body.campaign.workflowSlug).toBe("sales-email-cold-outreach");
      expect(res.body.campaign.brandIds).toEqual(validBody.brandIds);
      expect(res.body.campaign.activeGoalId).toBeNull();
      expect(res.body.campaign.brandProfileId).toBeNull();
      expect(res.body.campaign.audienceId).toBeNull();
    });

    it("should preserve persona/profile attribution through create and read", async () => {
      const createRes = await createCampaign({
        ...validBody,
        name: "Attributed Campaign",
        ...attribution,
      }).expect(201);

      expect(createRes.body.campaign).toMatchObject(attribution);

      const readRes = await request(app)
        .get(`/campaigns/${createRes.body.campaign.id}`)
        .set("x-api-key", API_KEY)
        .set("x-org-id", "org_test_crud")
        .expect(200);

      expect(readRes.body.campaign).toMatchObject(attribution);
    });

    it("should reject when workflowSlug is missing", async () => {
      const { workflowSlug, ...body } = validBody;

      const res = await createCampaign(body).expect(400);
      expect(res.body.error).toBeDefined();
    });

    it("should reject when brandIds is missing", async () => {
      const { brandIds, ...body } = validBody;

      const res = await createCampaign(body).expect(400);
      expect(res.body.error).toBeDefined();
    });

    it("should reject when orgId is missing from body", async () => {
      const { orgId, ...body } = validBody;

      const res = await createCampaign(body).expect(400);
      expect(res.body.error).toBeDefined();
    });

    it("should reject when brandIds contains invalid UUIDs", async () => {
      const res = await createCampaign({ ...validBody, brandIds: ["not-a-uuid"] }).expect(400);
      expect(res.body.error).toBeDefined();
    });

    it("should create a campaign with featureSlug and featureInputs", async () => {
      const res = await createCampaign({
        ...validBody,
        name: "Feature Campaign",
        featureSlug: "sales-cold-email-v1",
        featureInputs: { targetAudience: "CTOs", targetOutcome: "Book demos" },
      }).expect(201);

      expect(res.body.campaign.featureSlug).toBe("sales-cold-email-v1");
      expect(res.body.campaign.featureInputs).toEqual({
        targetAudience: "CTOs",
        targetOutcome: "Book demos",
      });
    });

    it("should reject campaign creation without x-feature-slug header", async () => {
      const res = await request(app)
        .post("/campaigns")
        .set("x-api-key", API_KEY)
        .set("x-org-id", "org_test_crud")
        .set("x-user-id", "user_test_crud")
        .set("x-run-id", crypto.randomUUID())
        // no x-feature-slug header
        .send(validBody)
        .expect(400);

      expect(res.body.error).toContain("x-feature-slug");
    });

    it("should reject campaign creation without x-user-id header", async () => {
      const res = await request(app)
        .post("/campaigns")
        .set("x-api-key", API_KEY)
        .set("x-org-id", "org_test_crud")
        .set("x-run-id", crypto.randomUUID())
        .send(validBody)
        .expect(400);

      expect(res.body.error).toContain("x-user-id");
    });

    it("should reject campaign creation without x-run-id header", async () => {
      const res = await request(app)
        .post("/campaigns")
        .set("x-api-key", API_KEY)
        .set("x-org-id", "org_test_crud")
        .set("x-user-id", "user_test")
        .send(validBody)
        .expect(400);

      expect(res.body.error).toContain("x-run-id");
    });

    it("should reject Apollo fields that no longer exist", async () => {
      const res = await createCampaign({ ...validBody, personTitles: ["CEO"] });

      // Zod strips unknown fields by default, so it should still succeed
      // but the field should not appear in the response
      expect(res.body.campaign).toBeDefined();
      expect(res.body.campaign).not.toHaveProperty("personTitles");
    });

    it("should not have legacy fields on campaign", async () => {
      const res = await createCampaign().expect(201);

      expect(res.body.campaign).not.toHaveProperty("urgency");
      expect(res.body.campaign).not.toHaveProperty("scarcity");
      expect(res.body.campaign).not.toHaveProperty("riskReversal");
      expect(res.body.campaign).not.toHaveProperty("socialProof");
      expect(res.body.campaign).not.toHaveProperty("type");
      expect(res.body.campaign).not.toHaveProperty("appId");
      expect(res.body.campaign).not.toHaveProperty("keySource");
    });

    it("should reject duplicate campaign name within same org with 409", async () => {
      await createCampaign().expect(201);

      const res = await createCampaign().expect(409);
      expect(res.body.error).toBe("A campaign with this name already exists in your organization");
    });

    it("should allow same campaign name in different orgs", async () => {
      await createCampaign().expect(201);

      const res = await createCampaign({ ...validBody, orgId: "org_other" }, "org_other").expect(201);
      expect(res.body.campaign.name).toBe(validBody.name);
    });
  });

  describe("PATCH /campaigns/:id", () => {
    it("should accept activate", async () => {
      const createRes = await createCampaign().expect(201);
      const campaignId = createRes.body.campaign.id;

      // Stop first
      await request(app)
        .patch(`/campaigns/${campaignId}`)
        .set("x-api-key", API_KEY)
        .set("x-org-id", "org_test_crud")
        .send({ status: "stop" })
        .expect(200);

      // Activate — requires tracking headers
      const activateRes = await request(app)
        .patch(`/campaigns/${campaignId}`)
        .set("x-api-key", API_KEY)
        .set("x-org-id", "org_test_crud")
        .set("x-user-id", "user_test_crud")
        .set("x-run-id", crypto.randomUUID())
        .set("x-feature-slug", "sales-cold-email-v1")
        .send({ status: "activate" })
        .expect(200);

      expect(activateRes.body.campaign.status).toBe("ongoing");
    });

    it("should update featureInputs", async () => {
      const createRes = await createCampaign({
        ...validBody,
        featureSlug: "sales-cold-email-v1",
        featureInputs: { targetAudience: "CTOs" },
      }).expect(201);

      const campaignId = createRes.body.campaign.id;

      const updateRes = await request(app)
        .patch(`/campaigns/${campaignId}`)
        .set("x-api-key", API_KEY)
        .set("x-org-id", "org_test_crud")
        .send({ featureInputs: { targetAudience: "VPs of Sales", vertical: "fintech" } })
        .expect(200);

      expect(updateRes.body.campaign.featureInputs).toEqual({
        targetAudience: "VPs of Sales",
        vertical: "fintech",
      });
    });

    it("should reject renaming to a name that already exists in the same org", async () => {
      await createCampaign().expect(201);

      const res2 = await createCampaign({ ...validBody, name: "Other Campaign" }).expect(201);

      const renameRes = await request(app)
        .patch(`/campaigns/${res2.body.campaign.id}`)
        .set("x-api-key", API_KEY)
        .set("x-org-id", "org_test_crud")
        .send({ name: validBody.name })
        .expect(409);

      expect(renameRes.body.error).toBe("A campaign with this name already exists in your organization");
    });
  });

  // === Campaign v2: per-campaign own config (goal / audience subset / services / destination) ===
  describe("Campaign v2 own config", () => {
    const ownConfig = {
      goal: "purchase",
      audienceIds: ["aud-1", "aud-2"],
      servicesOffered: ["seo", "ads"],
      clickDestinationUrl: "https://example.com/landing",
    };

    function patch(id: string, body: Record<string, unknown>, orgId = "org_test_crud") {
      return request(app)
        .patch(`/campaigns/${id}`)
        .set("x-api-key", API_KEY)
        .set("x-org-id", orgId)
        .set("x-user-id", "user_test_crud")
        .set("x-run-id", crypto.randomUUID())
        .set("x-feature-slug", "sales-cold-email-v1")
        .send(body);
    }

    function get(id: string, orgId = "org_test_crud") {
      return request(app)
        .get(`/campaigns/${id}`)
        .set("x-api-key", API_KEY)
        .set("x-org-id", orgId);
    }

    it("persists own config on create and reads it back (single + list)", async () => {
      const createRes = await createCampaign({ ...validBody, name: "Own Config", ...ownConfig }).expect(201);
      expect(createRes.body.campaign).toMatchObject(ownConfig);

      const readRes = await get(createRes.body.campaign.id).expect(200);
      expect(readRes.body.campaign).toMatchObject(ownConfig);

      const listRes = await request(app)
        .get("/campaigns")
        .set("x-api-key", API_KEY)
        .set("x-org-id", "org_test_crud")
        .expect(200);
      const listed = listRes.body.campaigns.find((c: any) => c.id === createRes.body.campaign.id);
      expect(listed).toMatchObject(ownConfig);
    });

    it("defaults to null (inherit brand) when nothing is set", async () => {
      const res = await createCampaign({ ...validBody, name: "Inherit" }).expect(201);
      expect(res.body.campaign.goal).toBeNull();
      expect(res.body.campaign.audienceIds).toBeNull();
      expect(res.body.campaign.servicesOffered).toBeNull();
      expect(res.body.campaign.clickDestinationUrl).toBeNull();
    });

    it("sets own config via update and clears it back to inherit with null", async () => {
      const created = await createCampaign({ ...validBody, name: "Editable" }).expect(201);
      const id = created.body.campaign.id;

      const setRes = await patch(id, ownConfig).expect(200);
      expect(setRes.body.campaign).toMatchObject(ownConfig);

      const clearRes = await patch(id, {
        goal: null,
        audienceIds: null,
        servicesOffered: null,
        clickDestinationUrl: null,
      }).expect(200);
      expect(clearRes.body.campaign.goal).toBeNull();
      expect(clearRes.body.campaign.audienceIds).toBeNull();
      expect(clearRes.body.campaign.servicesOffered).toBeNull();
      expect(clearRes.body.campaign.clickDestinationUrl).toBeNull();
    });

    it("targets one OR more audiences (subset) and rejects an empty subset", async () => {
      const one = await createCampaign({ ...validBody, name: "One Aud", audienceIds: ["aud-only"] }).expect(201);
      expect(one.body.campaign.audienceIds).toEqual(["aud-only"]);

      await createCampaign({ ...validBody, name: "Empty Aud", audienceIds: [] }).expect(400);
    });

    it("rejects an unknown goal value", async () => {
      await createCampaign({ ...validBody, name: "Bad Goal", goal: "worldPeace" }).expect(400);
    });

    it("does NOT clobber a sibling campaign under the same brand", async () => {
      const sharedBrand = crypto.randomUUID();
      const a = await createCampaign({ ...validBody, name: "Sibling A", brandIds: [sharedBrand] }).expect(201);
      const b = await createCampaign({ ...validBody, name: "Sibling B", brandIds: [sharedBrand] }).expect(201);

      // Configure A only.
      await patch(a.body.campaign.id, ownConfig).expect(200);

      // Sibling B is untouched — still inheriting (all null).
      const bRead = await get(b.body.campaign.id).expect(200);
      expect(bRead.body.campaign.goal).toBeNull();
      expect(bRead.body.campaign.audienceIds).toBeNull();
      expect(bRead.body.campaign.servicesOffered).toBeNull();
      expect(bRead.body.campaign.clickDestinationUrl).toBeNull();

      // A kept its own config.
      const aRead = await get(a.body.campaign.id).expect(200);
      expect(aRead.body.campaign).toMatchObject(ownConfig);
    });
  });
});
