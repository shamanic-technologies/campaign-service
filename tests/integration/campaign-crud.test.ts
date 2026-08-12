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
  function createCampaign(
    body: Record<string, unknown> = validBody,
    orgId = "org_test_crud",
    featureSlug = "sales-cold-email-v1",
  ) {
    return request(app)
      .post("/campaigns")
      .set("x-api-key", API_KEY)
      .set("x-org-id", orgId)
      .set("x-user-id", "user_test_crud")
      .set("x-run-id", crypto.randomUUID())
      .set("x-feature-slug", featureSlug)
      .send(body);
  }

  /** A brand nothing else in this test file is using — a fresh campaign identity. */
  function freshBrand() {
    return [crypto.randomUUID()];
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

      // A DIFFERENT identity (another brand) reusing the name — the name is what conflicts here.
      // Re-posting the SAME identity is not a conflict at all; it switches that campaign's
      // workflow, which is what the next test covers.
      const res = await createCampaign({ ...validBody, brandIds: freshBrand() }).expect(409);
      expect(res.body.error).toBe("A campaign with this name already exists in your organization");
    });

    it("switches the workflow of the campaign that already IS this identity, never creating a second", async () => {
      // (org, brand, funnel, channel) is the identity. The WORKFLOW is not part of it: a campaign
      // changes workflow whenever selection picks a better one. Creating one per workflow is what
      // grew a single brand 137 stopped rows, one per workflow version.
      const brandIds = freshBrand();
      const first = await createCampaign({ ...validBody, name: "Identity", brandIds }).expect(201);

      const again = await createCampaign({
        ...validBody,
        name: "Identity — a later workflow",
        brandIds,
        workflowSlug: "sales-cold-email-outreach-osprey",
      }).expect(200);

      expect(again.body.campaign.id).toBe(first.body.campaign.id);
      expect(again.body.campaign.workflowSlug).toBe("sales-cold-email-outreach-osprey");
      // The name is the campaign's own label, not a restatement of which workflow runs.
      expect(again.body.campaign.name).toBe("Identity");
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
      // The stop it described is over, so the reason goes with it.
      expect(activateRes.body.campaign.stopReason).toBeNull();
    });

    it("records a hand stop as `manual`, so nothing ever brings it back on its own", async () => {
      const createRes = await createCampaign().expect(201);
      const campaignId = createRes.body.campaign.id;

      const stopRes = await request(app)
        .patch(`/campaigns/${campaignId}`)
        .set("x-api-key", API_KEY)
        .set("x-org-id", "org_test_crud")
        .send({ status: "stop" })
        .expect(200);

      expect(stopRes.body.campaign.status).toBe("stopped");
      // `manual` is not resumable: stopping a campaign on purpose has to stay stopped.
      expect(stopRes.body.campaign.stopReason).toBe("manual");
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

      const res2 = await createCampaign({ ...validBody, name: "Other Campaign", brandIds: freshBrand() }).expect(201);

      const renameRes = await request(app)
        .patch(`/campaigns/${res2.body.campaign.id}`)
        .set("x-api-key", API_KEY)
        .set("x-org-id", "org_test_crud")
        .send({ name: validBody.name })
        .expect(409);

      expect(renameRes.body.error).toBe("A campaign with this name already exists in your organization");
    });
  });

  // === Campaign v2: per-campaign own config (audience subset / services / destination) ===
  describe("Campaign v2 own config", () => {
    const ownConfig = {
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
        audienceIds: null,
        servicesOffered: null,
        clickDestinationUrl: null,
      }).expect(200);
      expect(clearRes.body.campaign.audienceIds).toBeNull();
      expect(clearRes.body.campaign.servicesOffered).toBeNull();
      expect(clearRes.body.campaign.clickDestinationUrl).toBeNull();
    });

    it("targets one OR more audiences (subset) and rejects an empty subset", async () => {
      const one = await createCampaign({ ...validBody, name: "One Aud", audienceIds: ["aud-only"] }).expect(201);
      expect(one.body.campaign.audienceIds).toEqual(["aud-only"]);

      await createCampaign({ ...validBody, name: "Empty Aud", audienceIds: [] }).expect(400);
    });

    // `goal` is not writable any more: a campaign says what it sells with its SALES FUNNEL, the
    // only word that separates a meeting bought with a positive reply from one bought with a click
    // onto the site. The field is still SERVED (consumers migrate next) and it is simply ignored on
    // the way in rather than 400-ing a caller that has not dropped it yet.
    it("ignores a goal a caller still sends, and serves the stored value (null) back", async () => {
      const res = await createCampaign({ ...validBody, name: "Goal Ignored", goal: "meetingBooked" }).expect(201);
      expect(res.body.campaign.goal).toBeNull();

      const patched = await patch(res.body.campaign.id, { goal: "formSubmission" }).expect(200);
      expect(patched.body.campaign.goal).toBeNull();
    });

    it("does NOT clobber a sibling campaign under the same brand", async () => {
      const sharedBrand = crypto.randomUUID();
      const a = await createCampaign({ ...validBody, name: "Sibling A", brandIds: [sharedBrand] }).expect(201);
      // Two campaigns CAN share a brand — on different acquisition channels. Same brand, same
      // channel and same funnel would be one identity, so B runs a different feature.
      const b = await createCampaign(
        // A sales-outreach feature STATES the funnel it sells; every other feature states none.
        { ...validBody, name: "Sibling B", brandIds: [sharedBrand], funnelKey: "form_magnet" },
        "org_test_crud",
        "sales-crm-email-outreach",
      ).expect(201);

      // Configure A only.
      await patch(a.body.campaign.id, ownConfig).expect(200);

      // Sibling B is untouched — still inheriting (all null).
      const bRead = await get(b.body.campaign.id).expect(200);
      expect(bRead.body.campaign.audienceIds).toBeNull();
      expect(bRead.body.campaign.servicesOffered).toBeNull();
      expect(bRead.body.campaign.clickDestinationUrl).toBeNull();

      // A kept its own config.
      const aRead = await get(a.body.campaign.id).expect(200);
      expect(aRead.body.campaign).toMatchObject(ownConfig);
    });
  });

  // === A campaign STATES the sales funnel it sells, at birth ===
  describe("the sales funnel a campaign states", () => {
    const SALES = "sales-cold-email-outreach";

    function get(id: string, orgId = "org_test_crud") {
      return request(app).get(`/campaigns/${id}`).set("x-api-key", API_KEY).set("x-org-id", orgId);
    }

    it("refuses to create a sales campaign that states no funnel", async () => {
      const res = await createCampaign(
        { ...validBody, name: "No Funnel", brandIds: freshBrand() },
        "org_test_crud",
        SALES,
      ).expect(400);
      expect(res.body.error).toContain("funnelKey is required");
    });

    it("refuses a funnel token no catalogue names, rather than storing a fifth funnel", async () => {
      const res = await createCampaign(
        { ...validBody, name: "Bad Funnel", brandIds: freshBrand(), funnelKey: "whatsapp_chain" },
        "org_test_crud",
        SALES,
      ).expect(400);
      expect(res.body.error).toContain("Unknown sales funnel");
    });

    it("stores the funnel the caller states, canonicalised from any spelling billing still emits", async () => {
      const res = await createCampaign(
        { ...validBody, name: "Legacy Spelling", brandIds: freshBrand(), funnelKey: "reply_meeting" },
        "org_test_crud",
        SALES,
      ).expect(201);
      expect(res.body.campaign.funnelKey).toBe("sales_meetings_from_conversation");

      const read = await get(res.body.campaign.id).expect(200);
      expect(read.body.campaign.funnelKey).toBe("sales_meetings_from_conversation");
    });

    it("a feature that sells through no sales funnel states none, and is not asked for one", async () => {
      const res = await createCampaign(
        { ...validBody, name: "PR Campaign", brandIds: freshBrand() },
        "org_test_crud",
        "pr-cold-email-outreach",
      ).expect(201);
      expect(res.body.campaign.funnelKey).toBeNull();
    });

    it("one live campaign per (org, brand, funnel, channel) — the same funnel switches workflow, a different one is its own campaign", async () => {
      const brandIds = freshBrand();
      const first = await createCampaign(
        { ...validBody, name: "Meetings", brandIds, funnelKey: "sales_meetings_from_conversation" },
        "org_test_crud",
        SALES,
      ).expect(201);

      // Same identity, later workflow → the SAME campaign, re-pointed. Never a second row.
      const again = await createCampaign(
        {
          ...validBody,
          name: "Meetings — later workflow",
          brandIds,
          funnelKey: "sales_meetings_from_conversation",
          workflowSlug: "sales-cold-email-outreach-osprey",
        },
        "org_test_crud",
        SALES,
      ).expect(200);
      expect(again.body.campaign.id).toBe(first.body.campaign.id);

      // A DIFFERENT funnel of the same brand and channel is a different identity: its own campaign,
      // paced on its own ceiling.
      const other = await createCampaign(
        { ...validBody, name: "Purchases", brandIds, funnelKey: "website_purchases" },
        "org_test_crud",
        SALES,
      ).expect(201);
      expect(other.body.campaign.id).not.toBe(first.body.campaign.id);
      expect(other.body.campaign.funnelKey).toBe("website_purchases");
    });

    it("uniqueness binds ONGOING rows only — a stopped campaign is history, not a competitor", async () => {
      const brandIds = freshBrand();
      const first = await createCampaign(
        { ...validBody, name: "Stopped Then New", brandIds, funnelKey: "form_magnet" },
        "org_test_crud",
        SALES,
      ).expect(201);

      await request(app)
        .patch(`/campaigns/${first.body.campaign.id}`)
        .set("x-api-key", API_KEY)
        .set("x-org-id", "org_test_crud")
        .send({ status: "stop" })
        .expect(200);

      const second = await createCampaign(
        { ...validBody, name: "Stopped Then New — the live one", brandIds, funnelKey: "form_magnet" },
        "org_test_crud",
        SALES,
      ).expect(201);
      expect(second.body.campaign.id).not.toBe(first.body.campaign.id);
      expect(second.body.campaign.status).toBe("ongoing");

      const stopped = await get(first.body.campaign.id).expect(200);
      expect(stopped.body.campaign.status).toBe("stopped");
      expect(stopped.body.campaign.funnelKey).toBe("form_magnet");
    });
  });
});
