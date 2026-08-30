import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import app from "../../src/index.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";

const API_KEY = process.env.CAMPAIGN_SERVICE_API_KEY || "test-api-key";
const ORG = "org_test_leg";

/**
 * A campaign states the single funnel LEG it is bought for.
 *
 * A leg is the step-to-step move a customer actually buys, and features-service's identifier names
 * exactly one — no funnel is needed to disambiguate it, which is the whole point: two different
 * legs can land on the SAME step (a booked meeting is reached from a positive reply AND from a
 * website visit), so the step a leg lands on could never identify it.
 *
 * These pin the three halves of the contract that matter while callers migrate: a campaign can
 * STATE a leg and read it back, two campaigns on one channel buying two different legs are told
 * apart by that statement alone, and a campaign that states NONE behaves exactly as it did before
 * the field existed.
 */
describe("Campaign leg", () => {
  // Real identifiers from features-service's published catalogue (GET /public/channels →
  // legs[].legKey). They are OPAQUE here: nothing in this service parses them, and the entry leg
  // (`start_to_conversation`, whose lead was on no funnel before) is spelled like any other.
  const ENTRY_LEG = "start_to_conversation";
  const BOOKED_FROM_CONVERSATION = "conversation_to_meeting_booked";
  const ATTENDED_FROM_BOOKED = "meeting_booked_to_meeting_attended";

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
      .set("x-user-id", "user_test_leg")
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

  function patch(id: string, body: Record<string, unknown>) {
    return request(app)
      .patch(`/campaigns/${id}`)
      .set("x-api-key", API_KEY)
      .set("x-org-id", ORG)
      .set("x-user-id", "user_test_leg")
      .set("x-run-id", crypto.randomUUID())
      .send(body);
  }

  function baseBody(name: string) {
    return {
      name,
      workflowSlug: "sales-email-cold-outreach",
      orgId: ORG,
      brandIds: [crypto.randomUUID()],
    };
  }

  it("creates a campaign stating its leg and reads it back", async () => {
    const created = await createCampaign({
      ...baseBody("Booked Meetings Campaign"),
      legKey: BOOKED_FROM_CONVERSATION,
    }).expect(201);

    expect(created.body.campaign.legKey).toBe(BOOKED_FROM_CONVERSATION);

    const readBack = await read(created.body.campaign.id).expect(200);
    expect(readBack.body.campaign.legKey).toBe(BOOKED_FROM_CONVERSATION);
  });

  it("a leg that STARTS a funnel is stated through the same field, with no special case", async () => {
    const created = await createCampaign({
      ...baseBody("Entry Leg Campaign"),
      legKey: ENTRY_LEG,
    }).expect(201);

    expect(created.body.campaign.legKey).toBe(ENTRY_LEG);
    // No funnel had to be named for the statement to identify one leg.
    expect(created.body.campaign.funnelKey).toBeNull();
  });

  it("two campaigns on ONE channel buying two DIFFERENT legs are distinguishable, with no funnel", async () => {
    const brandIds = [crypto.randomUUID()];
    const channelFeature = "sales-cold-email-v1";

    const booked = await createCampaign(
      { ...baseBody("Cold Email — booked meetings"), brandIds, legKey: BOOKED_FROM_CONVERSATION },
      channelFeature,
    ).expect(201);

    const attended = await createCampaign(
      { ...baseBody("Cold Email — attended meetings"), brandIds, legKey: ATTENDED_FROM_BOOKED },
      channelFeature,
    ).expect(201);

    // Two rows, told apart by what each STATES — not by a funnel, which neither names.
    expect(attended.body.campaign.id).not.toBe(booked.body.campaign.id);
    expect(booked.body.campaign.legKey).toBe(BOOKED_FROM_CONVERSATION);
    expect(attended.body.campaign.legKey).toBe(ATTENDED_FROM_BOOKED);
    expect(booked.body.campaign.funnelKey).toBeNull();
    expect(attended.body.campaign.funnelKey).toBeNull();
    // And the same two legs land on steps that a funnel-derived answer could confuse: both of
    // these are meeting legs. The identifier separates them on its own.
    expect(booked.body.campaign.legKey).not.toBe(attended.body.campaign.legKey);
  });

  it("never holds the same leg twice — a restated identity UPDATES the campaign it names", async () => {
    const brandIds = [crypto.randomUUID()];
    const channelFeature = "sales-cold-email-v1";

    const first = await createCampaign(
      { ...baseBody("Cold Email — booked meetings"), brandIds, legKey: BOOKED_FROM_CONVERSATION },
      channelFeature,
    ).expect(201);

    // The SAME (org, brand, funnel, channel, leg). One live campaign per identity, so this is the
    // same campaign restated — never a second row racing it for the brand's turn.
    const again = await createCampaign(
      { ...baseBody("Cold Email — booked meetings, restated"), brandIds, legKey: BOOKED_FROM_CONVERSATION },
      channelFeature,
    ).expect(200);

    expect(again.body.campaign.id).toBe(first.body.campaign.id);
    expect(again.body.campaign.legKey).toBe(BOOKED_FROM_CONVERSATION);
  });

  it("a campaign created WITHOUT a leg states none — and nothing else about it changes", async () => {
    const body = baseBody("Legless Campaign");

    const created = await createCampaign(body).expect(201);

    expect(created.body.campaign.legKey).toBeNull();
    // The rest of the row is exactly what it was before the field existed.
    expect(created.body.campaign.name).toBe("Legless Campaign");
    expect(created.body.campaign.workflowSlug).toBe("sales-email-cold-outreach");
    expect(created.body.campaign.brandIds).toEqual(body.brandIds);
    expect(created.body.campaign.status).toBe("ongoing");
    expect(created.body.campaign.funnelKey).toBeNull();

    const readBack = await read(created.body.campaign.id).expect(200);
    expect(readBack.body.campaign.legKey).toBeNull();
  });

  it("states, restates and clears the leg on update", async () => {
    const created = await createCampaign(baseBody("Migrating Campaign")).expect(201);
    const id = created.body.campaign.id;
    expect(created.body.campaign.legKey).toBeNull();

    // A campaign created before it could state a leg says which one it buys — no second campaign.
    const stated = await patch(id, { legKey: BOOKED_FROM_CONVERSATION }).expect(200);
    expect(stated.body.campaign.legKey).toBe(BOOKED_FROM_CONVERSATION);

    // An update that says nothing about the leg leaves it alone.
    const renamed = await patch(id, { name: "Migrating Campaign (renamed)" }).expect(200);
    expect(renamed.body.campaign.legKey).toBe(BOOKED_FROM_CONVERSATION);

    // null is the spelling for "states no leg".
    const cleared = await patch(id, { legKey: null }).expect(200);
    expect(cleared.body.campaign.legKey).toBeNull();
  });

  it("refuses an empty leg — a campaign either states one or states none", async () => {
    await createCampaign({ ...baseBody("Empty Leg Campaign"), legKey: "" }).expect(400);
  });
});
