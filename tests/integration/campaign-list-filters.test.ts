import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import app from "../../src/index.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";

const API_KEY = process.env.CAMPAIGN_SERVICE_API_KEY || "test-api-key";
const ORG = "org_test_list_filters";

/**
 * A caller asking for the campaigns that are RUNNING must receive those, and not every campaign
 * the org has ever had. The filter used to be accepted by the gateway, forwarded, and dropped
 * here without a word — a 200 with the full list, which reads as "you really do have N running".
 */
describe("GET /campaigns filters", () => {
  beforeEach(async () => {
    await cleanTestData();
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  function createCampaign(body: Record<string, unknown>, featureSlug = "pr-cold-email-outreach") {
    return request(app)
      .post("/campaigns")
      .set("x-api-key", API_KEY)
      .set("x-org-id", ORG)
      .set("x-user-id", "user_test_list_filters")
      .set("x-run-id", crypto.randomUUID())
      .set("x-feature-slug", featureSlug)
      .send(body);
  }

  function list(query = "") {
    return request(app)
      .get(`/campaigns${query}`)
      .set("x-api-key", API_KEY)
      .set("x-org-id", ORG);
  }

  function stop(id: string) {
    return request(app)
      .patch(`/campaigns/${id}`)
      .set("x-api-key", API_KEY)
      .set("x-org-id", ORG)
      .set("x-user-id", "user_test_list_filters")
      .set("x-run-id", crypto.randomUUID())
      .set("x-feature-slug", "pr-cold-email-outreach")
      .send({ status: "stop" });
  }

  /** Two ongoing campaigns and three stopped ones, each on its own brand identity. */
  async function seed() {
    const ids: { ongoing: string[]; stopped: string[] } = { ongoing: [], stopped: [] };

    for (let i = 0; i < 2; i++) {
      const res = await createCampaign({
        name: `Ongoing ${i}`,
        workflowSlug: "pr-email-cold-outreach",
        orgId: ORG,
        brandIds: [crypto.randomUUID()],
      }).expect(201);
      ids.ongoing.push(res.body.campaign.id);
    }

    for (let i = 0; i < 3; i++) {
      const res = await createCampaign({
        name: `Stopped ${i}`,
        workflowSlug: "pr-email-cold-outreach",
        orgId: ORG,
        brandIds: [crypto.randomUUID()],
      }).expect(201);
      await stop(res.body.campaign.id).expect(200);
      ids.stopped.push(res.body.campaign.id);
    }

    return ids;
  }

  it("returns only the running campaigns for status=ongoing", async () => {
    const ids = await seed();

    const res = await list("?status=ongoing").expect(200);

    expect(res.body.campaigns).toHaveLength(2);
    expect(res.body.campaigns.map((c: { id: string }) => c.id).sort()).toEqual([...ids.ongoing].sort());
    expect(res.body.campaigns.every((c: { status: string }) => c.status === "ongoing")).toBe(true);
  });

  it("returns only the stopped campaigns for status=stopped", async () => {
    const ids = await seed();

    const res = await list("?status=stopped").expect(200);

    expect(res.body.campaigns).toHaveLength(3);
    expect(res.body.campaigns.map((c: { id: string }) => c.id).sort()).toEqual([...ids.stopped].sort());
  });

  it("returns everything, unchanged, when no filter is sent", async () => {
    await seed();

    const res = await list().expect(200);

    expect(res.body.campaigns).toHaveLength(5);
    expect(res.body.hasMore).toBeUndefined();
  });

  // The whole point: an unrecognised status must not come back as a full unfiltered list. That is
  // exactly what made the missing filter invisible for however long it was missing.
  it.each(["running", "active", "ONGOING", "paused", ""])(
    "refuses an unrecognised status %j rather than serving the whole list",
    async (bad) => {
      await seed();

      const res = await list(`?status=${encodeURIComponent(bad)}`).expect(400);

      expect(res.body.campaigns).toBeUndefined();
      expect(res.body.error).toContain("status");
    },
  );

  it("still filters by brandId, workflowSlug and featureSlug, and combines them with status", async () => {
    const brand = crypto.randomUUID();
    const kept = await createCampaign({
      name: "Kept",
      workflowSlug: "pr-email-cold-outreach",
      orgId: ORG,
      brandIds: [brand],
    }).expect(201);
    const otherBrand = await createCampaign({
      name: "Other Brand",
      workflowSlug: "pr-email-cold-outreach",
      orgId: ORG,
      brandIds: [crypto.randomUUID()],
    }).expect(201);
    const otherFeature = await createCampaign(
      {
        name: "Other Feature",
        workflowSlug: "hiring-email-cold-outreach",
        orgId: ORG,
        brandIds: [crypto.randomUUID()],
      },
      "hiring-cold-email-outreach",
    ).expect(201);

    const byBrand = await list(`?brandId=${brand}`).expect(200);
    expect(byBrand.body.campaigns.map((c: { id: string }) => c.id)).toEqual([kept.body.campaign.id]);

    const byWorkflow = await list("?workflowSlug=hiring-email-cold-outreach").expect(200);
    expect(byWorkflow.body.campaigns.map((c: { id: string }) => c.id)).toEqual([otherFeature.body.campaign.id]);

    const byFeature = await list("?featureSlug=pr-cold-email-outreach").expect(200);
    expect(byFeature.body.campaigns.map((c: { id: string }) => c.id).sort()).toEqual(
      [kept.body.campaign.id, otherBrand.body.campaign.id].sort(),
    );

    // Combined: stop the kept one, and it leaves the ongoing slice of its own brand.
    await stop(kept.body.campaign.id).expect(200);
    const combined = await list(`?brandId=${brand}&status=ongoing`).expect(200);
    expect(combined.body.campaigns).toEqual([]);
  });

  it("caps the response on request and says so, without changing the unbounded default", async () => {
    await seed();

    const capped = await list("?limit=2").expect(200);
    expect(capped.body.campaigns).toHaveLength(2);
    expect(capped.body.hasMore).toBe(true);

    const roomy = await list("?limit=50").expect(200);
    expect(roomy.body.campaigns).toHaveLength(5);
    expect(roomy.body.hasMore).toBe(false);

    // A limit that is not a positive integer is refused, not silently ignored.
    await list("?limit=0").expect(400);
    await list("?limit=abc").expect(400);
  });
});
