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
const OTHER_LEG = "conversation_to_meeting_booked";

/**
 * A sales campaign can be identified by (OFFER, LEG, CHANNEL) alone, with no funnel.
 *
 * The funnel is leaving what a campaign IS: one leg belongs to several funnels, so the same leg
 * run by the same channel for the same offer is ONE campaign. These pin that such a campaign can
 * be created and found, that it is never twinned — by another funnel-less create or by a
 * funnel-keyed one — and that a funnel-keyed flow behaves exactly as it did.
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

  it("creates a sales campaign from offer + leg with no funnel, and finds it by (offer, leg, channel)", async () => {
    const brandId = crypto.randomUUID();
    const offerId = crypto.randomUUID();

    const created = await create(body("Offer x leg", brandId, { offerId, legKey: LEG })).expect(201);
    expect(created.body.campaign.funnelKey).toBeNull();
    expect(created.body.campaign.offerId).toBe(offerId);
    expect(created.body.campaign.legKey).toBe(LEG);
    expect(created.body.campaign.acquisitionChannel).toBe("cold_email");
    expect(created.body.campaign.status).toBe("ongoing");

    const found = await list({ brandId, featureSlug: SALES, offerId, legKey: LEG }).expect(200);
    expect(found.body.campaigns.map((c: { id: string }) => c.id)).toEqual([created.body.campaign.id]);

    // Another leg of the same offer is a different campaign, and the filter tells them apart.
    await list({ brandId, offerId, legKey: OTHER_LEG }).expect(200).then((r) => {
      expect(r.body.campaigns).toEqual([]);
    });
  });

  it("a second funnel-less create of the same (offer, leg, channel) is the SAME campaign", async () => {
    const brandId = crypto.randomUUID();
    const offerId = crypto.randomUUID();

    const first = await create(body("Offer x leg", brandId, { offerId, legKey: LEG })).expect(201);
    const again = await create(body("Offer x leg again", brandId, { offerId, legKey: LEG })).expect(200);
    expect(again.body.campaign.id).toBe(first.body.campaign.id);
  });

  it("a funnel-less create hands back the campaign already running that (offer, leg, channel) under a funnel", async () => {
    const brandId = crypto.randomUUID();
    const offerId = crypto.randomUUID();

    const funnelKeyed = await create(body("Funnel-keyed", brandId, {
      funnelKey: "sales_meetings_from_conversation", offerId, legKey: LEG,
    })).expect(201);

    const funnelless = await create(body("Funnel-less", brandId, { offerId, legKey: LEG })).expect(200);
    expect(funnelless.body.campaign.id).toBe(funnelKeyed.body.campaign.id);
    // Nothing about the incumbent's identity moved.
    expect(funnelless.body.campaign.funnelKey).toBe("sales_meetings_from_conversation");
  });

  it("a funnel-keyed create never twins a campaign created without a funnel", async () => {
    const brandId = crypto.randomUUID();
    const offerId = crypto.randomUUID();

    const funnelless = await create(body("Funnel-less", brandId, { offerId, legKey: LEG })).expect(201);
    const funnelKeyed = await create(body("Funnel-keyed", brandId, {
      funnelKey: "sales_meetings_from_conversation", offerId, legKey: LEG,
    })).expect(200);
    expect(funnelKeyed.body.campaign.id).toBe(funnelless.body.campaign.id);
    expect(funnelKeyed.body.campaign.funnelKey).toBeNull();
  });

  it("funnel-keyed creates keep today's behaviour: another funnel is another campaign", async () => {
    const brandId = crypto.randomUUID();
    const offerId = crypto.randomUUID();

    const a = await create(body("Funnel A", brandId, {
      funnelKey: "sales_meetings_from_conversation", offerId, legKey: LEG,
    })).expect(201);
    const b = await create(body("Funnel B", brandId, {
      funnelKey: "sales_meetings_from_website", offerId, legKey: LEG,
    })).expect(201);
    expect(b.body.campaign.id).not.toBe(a.body.campaign.id);
  });

  it("still refuses a sales campaign that states neither a funnel nor an offer + leg", async () => {
    const brandId = crypto.randomUUID();
    await create(body("Nothing stated", brandId, {})).expect(400);
    await create(body("Leg only", brandId, { legKey: LEG })).expect(400);
    await create(body("Offer only", brandId, { offerId: crypto.randomUUID() })).expect(400);
    // An unrecognised funnel is still refused, even beside an offer and a leg.
    await create(body("Bad funnel", brandId, {
      funnelKey: "not_a_funnel", offerId: crypto.randomUUID(), legKey: LEG,
    })).expect(400);
  });
});
