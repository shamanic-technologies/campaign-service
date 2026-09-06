import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import app from "../../src/index.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";

const API_KEY = process.env.CAMPAIGN_SERVICE_API_KEY || "test-api-key";
const ORG = "org_test_offer";

/**
 * A campaign sells exactly ONE offer — the third word of (offer x sales funnel x acquisition
 * channel). These pin the two halves of the contract that matter while callers migrate:
 * a campaign can STATE one and read it back, and a campaign that states NONE behaves exactly as
 * it did before the field existed.
 */
describe("Campaign offer", () => {
  beforeEach(async () => {
    await cleanTestData();
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  function createCampaign(
    body: Record<string, unknown>,
    featureSlug = "sales-cold-email-v1",
  ) {
    return request(app)
      .post("/campaigns")
      .set("x-api-key", API_KEY)
      .set("x-org-id", ORG)
      .set("x-user-id", "user_test_offer")
      .set("x-run-id", crypto.randomUUID())
      .set("x-feature-slug", featureSlug)
      .send(body);
  }

  function read(id: string) {
    return request(app)
      .get(`/campaigns/${id}`)
      .set("x-api-key", API_KEY)
      .set("x-org-id", ORG);
  }

  function baseBody(name: string) {
    return {
      name,
      workflowSlug: "sales-email-cold-outreach",
      orgId: ORG,
      brandIds: [crypto.randomUUID()],
    };
  }

  it("creates a campaign carrying an offer and reads it back", async () => {
    const offerId = crypto.randomUUID();

    const created = await createCampaign({ ...baseBody("Offer Campaign"), offerId }).expect(201);
    expect(created.body.campaign.offerId).toBe(offerId);

    const readBack = await read(created.body.campaign.id).expect(200);
    expect(readBack.body.campaign.offerId).toBe(offerId);
  });

  it("a campaign created WITHOUT an offer states none — and nothing else about it changes", async () => {
    const body = baseBody("Offerless Campaign");

    const created = await createCampaign(body).expect(201);

    expect(created.body.campaign.offerId).toBeNull();
    // The rest of the row is exactly what it was before the field existed.
    expect(created.body.campaign.name).toBe("Offerless Campaign");
    expect(created.body.campaign.workflowSlug).toBe("sales-email-cold-outreach");
    expect(created.body.campaign.brandIds).toEqual(body.brandIds);
    expect(created.body.campaign.status).toBe("ongoing");

    const readBack = await read(created.body.campaign.id).expect(200);
    expect(readBack.body.campaign.offerId).toBeNull();
  });

  it("an explicit null states no offer, same as omitting it", async () => {
    const created = await createCampaign({ ...baseBody("Null Offer"), offerId: null }).expect(201);
    expect(created.body.campaign.offerId).toBeNull();
  });

  it("rejects an offerId that is not a UUID — brand-service owns the entity, we carry its id", async () => {
    const res = await createCampaign({ ...baseBody("Bad Offer"), offerId: "not-a-uuid" }).expect(400);
    expect(res.body.error).toContain("offerId");
  });

  it("PATCH states the offer of a campaign created before it could, and null clears it", async () => {
    const offerId = crypto.randomUUID();
    const created = await createCampaign(baseBody("Late Offer")).expect(201);
    expect(created.body.campaign.offerId).toBeNull();

    const patched = await request(app)
      .patch(`/campaigns/${created.body.campaign.id}`)
      .set("x-api-key", API_KEY)
      .set("x-org-id", ORG)
      .send({ offerId })
      .expect(200);
    expect(patched.body.campaign.offerId).toBe(offerId);

    const cleared = await request(app)
      .patch(`/campaigns/${created.body.campaign.id}`)
      .set("x-api-key", API_KEY)
      .set("x-org-id", ORG)
      .send({ offerId: null })
      .expect(200);
    expect(cleared.body.campaign.offerId).toBeNull();
  });

  it("a re-create that says nothing about the offer does not blank the one already stated", async () => {
    const offerId = crypto.randomUUID();
    const body = baseBody("Incumbent Offer");

    const created = await createCampaign({ ...body, offerId }).expect(201);
    expect(created.body.campaign.offerId).toBe(offerId);

    // Same (org, brand, funnel, channel) → the incumbent is updated, not duplicated.
    const again = await createCampaign({ ...body, workflowSlug: "sales-email-cold-outreach-v2" }).expect(200);
    expect(again.body.campaign.id).toBe(created.body.campaign.id);
    expect(again.body.campaign.offerId).toBe(offerId);
  });

  it("a create stating a DIFFERENT offer is a NEW campaign, not a restatement of the live one", async () => {
    const first = crypto.randomUUID();
    const second = crypto.randomUUID();
    const body = baseBody("Two Offers, One Channel");

    // A customer funds their money PER OFFER, so two offers worked through one (funnel, channel,
    // leg) are two ceilings the customer set separately. Reading the second create as a
    // restatement of the first is what left that second offer funded and never provisioned.
    const created = await createCampaign({ ...body, offerId: first }).expect(201);
    const other = await createCampaign(
      { ...body, name: "Two Offers, One Channel (second)", offerId: second },
    ).expect(201);

    expect(other.body.campaign.id).not.toBe(created.body.campaign.id);
    expect(created.body.campaign.offerId).toBe(first);
    expect(other.body.campaign.offerId).toBe(second);
    // Both alive at once: the identity that could not be expressed now can be.
    expect(created.body.campaign.status).toBe("ongoing");
    expect(other.body.campaign.status).toBe("ongoing");
  });

  it("restating the SAME offer updates that offer's campaign rather than growing a second", async () => {
    const offerId = crypto.randomUUID();
    const body = baseBody("Restated Offer");

    const created = await createCampaign({ ...body, offerId }).expect(201);
    const again = await createCampaign(
      { ...body, name: "Restated Offer (again)", offerId, workflowSlug: "sales-email-cold-outreach-v2" },
    ).expect(200);

    expect(again.body.campaign.id).toBe(created.body.campaign.id);
    expect(again.body.campaign.offerId).toBe(offerId);
    expect(again.body.campaign.workflowSlug).toBe("sales-email-cold-outreach-v2");
  });

  it("a create that states an offer ADOPTS the offer-less campaign already holding the identity", async () => {
    const offerId = crypto.randomUUID();
    const body = baseBody("Pre-offer Campaign");

    // The pre-offer population: one campaign on the identity, stating no offer. A create that now
    // names one is that campaign saying which offer it sells — never a twin beside it.
    const created = await createCampaign(body).expect(201);
    expect(created.body.campaign.offerId).toBeNull();

    const stated = await createCampaign({ ...body, offerId }).expect(200);
    expect(stated.body.campaign.id).toBe(created.body.campaign.id);
    expect(stated.body.campaign.offerId).toBe(offerId);
  });
});
