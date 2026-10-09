import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";

vi.mock("../../src/lib/workflows.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/lib/workflows.js")>();
  return { ...original, executeCampaignWorkflow: vi.fn(async () => undefined) };
});

vi.mock("../../src/lib/features-workflow-projection-client.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/lib/features-workflow-projection-client.js")>();
  return {
    ...original,
    resolveSelectionForTrigger: vi.fn(async (a: { fallbackSlug: string }) => ({ workflowSlug: a.fallbackSlug, audienceId: null })),
  };
});

import app from "../../src/index.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";

const API_KEY = process.env.CAMPAIGN_SERVICE_API_KEY || "test-api-key";
const ORG = "org_test_offer_leg_identity";
const SALES = "sales-cold-email-outreach";
const LEG = "start_to_conversation";
const NEW_LEG = "lead_found_to_conversation";
const OTHER_LEG = "conversation_to_meeting_booked";

/**
 * A sales campaign IS (OFFER, LEG, CHANNEL). These pin that such a campaign can be created and
 * found, and that it is never twinned.
 */
describe("Campaign identified by (offer, leg, channel)", () => {
  beforeEach(async () => {
    await cleanTestData();
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  function create(body: Record<string, unknown>, featureSlug = SALES) {
    return request(app)
      .post("/campaigns")
      .set("x-api-key", API_KEY)
      .set("x-org-id", ORG)
      .set("x-user-id", "user_test_offer_leg")
      .set("x-run-id", crypto.randomUUID())
      .set("x-feature-slug", featureSlug)
      .send(body);
  }

  function list(query: Record<string, string>) {
    return request(app)
      .get("/campaigns")
      .query(query)
      .set("x-api-key", API_KEY)
      .set("x-org-id", ORG);
  }

  function body(name: string, brandId: string, extra: Record<string, unknown>) {
    return { name, workflowSlug: "sales-cold-email-outreach-osprey", orgId: ORG, brandIds: [brandId], ...extra };
  }

  it("creates a sales campaign from offer + leg, and finds it by (offer, leg, channel)", async () => {
    const brandId = crypto.randomUUID();
    const offerId = crypto.randomUUID();

    const created = await create(body("Offer x leg", brandId, { offerId, legKey: LEG })).expect(201);
    expect(created.body.campaign).not.toHaveProperty("funnelKey");
    expect(created.body.campaign.offerId).toBe(offerId);
    // Stated in the legacy outbound spelling, stored and served in the new one (wave 2).
    expect(created.body.campaign.legKey).toBe(NEW_LEG);
    expect(created.body.campaign.acquisitionChannel).toBe("cold_email");
    expect(created.body.campaign.status).toBe("ongoing");

    const found = await list({ brandId, featureSlug: SALES, offerId, legKey: LEG }).expect(200);
    expect(found.body.campaigns.map((c: { id: string }) => c.id)).toEqual([created.body.campaign.id]);

    // Another leg of the same offer is a different campaign, and the filter tells them apart.
    await list({ brandId, offerId, legKey: OTHER_LEG }).expect(200).then((r) => {
      expect(r.body.campaigns).toEqual([]);
    });
  });

  it("a second create of the same (offer, leg, channel) is the SAME campaign", async () => {
    const brandId = crypto.randomUUID();
    const offerId = crypto.randomUUID();

    const first = await create(body("Offer x leg", brandId, { offerId, legKey: LEG })).expect(201);
    const again = await create(body("Offer x leg again", brandId, { offerId, legKey: LEG })).expect(200);
    expect(again.body.campaign.id).toBe(first.body.campaign.id);
  });

  it("refuses a sales campaign that does not state both an offer and a leg", async () => {
    const brandId = crypto.randomUUID();
    await create(body("Nothing stated", brandId, {})).expect(400);
    await create(body("Leg only", brandId, { legKey: LEG })).expect(400);
    await create(body("Offer only", brandId, { offerId: crypto.randomUUID() })).expect(400);
  });

  // The outbound leg-key rename (lib/leg-identity.ts): the legacy and the new spelling of an
  // OUTBOUND leg are one identity; since wave 2 the spelling stored and served is the new one.
  it("a create under the NEW outbound spelling is the SAME campaign, served in the new spelling", async () => {
    const brandId = crypto.randomUUID();
    const offerId = crypto.randomUUID();

    const first = await create(body("Outbound", brandId, { offerId, legKey: LEG })).expect(201);
    const again = await create(body("Outbound again", brandId, { offerId, legKey: NEW_LEG })).expect(200);
    expect(again.body.campaign.id).toBe(first.body.campaign.id);
    expect(again.body.campaign.legKey).toBe(NEW_LEG);
  });

  it("a campaign first created under the new spelling is stored under it, and a legacy create finds it", async () => {
    const brandId = crypto.randomUUID();
    const offerId = crypto.randomUUID();

    const created = await create(body("Outbound new", brandId, { offerId, legKey: NEW_LEG })).expect(201);
    expect(created.body.campaign.legKey).toBe(NEW_LEG);
    const again = await create(body("Outbound old", brandId, { offerId, legKey: LEG })).expect(200);
    expect(again.body.campaign.id).toBe(created.body.campaign.id);
  });

  it("GET /campaigns?legKey answers the same under either outbound spelling, with or without the channel", async () => {
    const brandId = crypto.randomUUID();
    const offerId = crypto.randomUUID();
    const created = await create(body("Outbound list", brandId, { offerId, legKey: LEG })).expect(201);

    for (const legKey of [LEG, NEW_LEG]) {
      const withChannel = await list({ brandId, featureSlug: SALES, offerId, legKey }).expect(200);
      expect(withChannel.body.campaigns.map((c: { id: string }) => c.id)).toEqual([created.body.campaign.id]);
      const noChannel = await list({ brandId, offerId, legKey }).expect(200);
      expect(noChannel.body.campaigns.map((c: { id: string }) => c.id)).toEqual([created.body.campaign.id]);
    }
  });

  it("a NON-outbound start_to_website_visit is never matched by the new spelling", async () => {
    const brandId = crypto.randomUUID();
    await create(
      { name: "PR visit", workflowSlug: "pr-email-cold-outreach", orgId: ORG, brandIds: [brandId], legKey: "start_to_website_visit" },
      "pr-cold-email-outreach",
    ).expect(201);

    const legacy = await list({ brandId, legKey: "start_to_website_visit" }).expect(200);
    expect(legacy.body.campaigns).toHaveLength(1);
    const renamed = await list({ brandId, legKey: "lead_found_to_website_visit" }).expect(200);
    expect(renamed.body.campaigns).toEqual([]);
  });
});

