import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";

vi.mock("@distribute/runs-client", () => ({
  listRuns: vi.fn(),
  createRun: vi.fn(),
  updateRun: vi.fn(),
  getStatsBudget: vi.fn(),
}));

import app from "../../src/index.js";
import { cleanTestData, closeDb, insertTestCampaign } from "../helpers/test-db.js";

const API_KEY = process.env.CAMPAIGN_SERVICE_API_KEY || "test-api-key";
const BRAND = "11111111-1111-4111-8111-111111111111";
const BRAND_2 = "22222222-2222-4222-8222-222222222222";

/** billing-service's per-funnel budget read, as it comes off the wire. */
function billingPayload(body: unknown) {
  return { ok: true, json: async () => body } as unknown as Response;
}

describe("Brand spendable budget", () => {
  const fetchMock = vi.fn();

  beforeEach(async () => {
    await cleanTestData();
    vi.clearAllMocks();
    process.env.BILLING_SERVICE_URL = "http://billing.test";
    process.env.BILLING_SERVICE_API_KEY = "billing-key";
    vi.stubGlobal("fetch", fetchMock);
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await cleanTestData();
    await closeDb();
  });

  it("reports configured money with nothing running when the funded funnel has no campaign", async () => {
    fetchMock.mockResolvedValue(billingPayload({
      brandId: BRAND,
      dailyBudgetCents: "5000",
      funnels: [{ funnelKey: "reply_meeting", dailyBudgetCents: "5000" }],
    }));

    const res = await request(app)
      .get(`/brands/${BRAND}/spendable-budget`)
      .set("x-api-key", API_KEY)
      .set("x-org-id", "org-nothing-running")
      .expect(200);

    expect(res.body.configuredDailyBudgetCents).toBe(5000);
    expect(res.body.runningDailyBudgetCents).toBe(0);
    expect(res.body.campaigns).toEqual([]);
  });

  it("counts only the funnel whose campaign is ongoing", async () => {
    const orgId = "org-partly-running";
    await insertTestCampaign(orgId, {
      brandIds: [BRAND],
      brandId: BRAND,
      featureSlug: "sales-cold-email-outreach",
      acquisitionChannel: "cold_email",
      funnelKey: "sales_meetings_from_conversation",
      status: "ongoing",
    });
    await insertTestCampaign(orgId, {
      brandIds: [BRAND],
      brandId: BRAND,
      featureSlug: "sales-cold-email-outreach",
      acquisitionChannel: "cold_email",
      funnelKey: "website_purchases",
      status: "stopped",
    });

    fetchMock.mockResolvedValue(billingPayload({
      brandId: BRAND,
      dailyBudgetCents: "9000",
      funnels: [
        { funnelKey: "reply_meeting", dailyBudgetCents: "4000" },
        { funnelKey: "visit_signup", dailyBudgetCents: "5000" },
      ],
    }));

    const res = await request(app)
      .get(`/brands/${BRAND}/spendable-budget`)
      .set("x-api-key", API_KEY)
      .set("x-org-id", orgId)
      .expect(200);

    expect(res.body.configuredDailyBudgetCents).toBe(9000);
    expect(res.body.runningDailyBudgetCents).toBe(4000);
    expect(res.body.campaigns).toHaveLength(2);
  });

  it("fails LOUD when billing cannot be read, never a smaller figure", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) } as unknown as Response);

    await request(app)
      .get(`/brands/${BRAND}/spendable-budget`)
      .set("x-api-key", API_KEY)
      .set("x-org-id", "org-billing-down")
      .expect(502);
  });

  it("requires an org", async () => {
    await request(app)
      .get(`/brands/${BRAND}/spendable-budget`)
      .set("x-api-key", API_KEY)
      .expect(400);
  });

  it("answers many pairs in one request, with the same numbers as the per-brand route", async () => {
    const orgA = "org-fleet-a";
    const orgB = "org-fleet-b";
    await insertTestCampaign(orgA, {
      brandIds: [BRAND],
      brandId: BRAND,
      featureSlug: "sales-cold-email-outreach",
      acquisitionChannel: "cold_email",
      funnelKey: "sales_meetings_from_conversation",
      status: "ongoing",
    });

    fetchMock.mockImplementation(async (url: string, init: { headers: Record<string, string> }) => {
      const orgId = init.headers["x-org-id"];
      if (orgId === orgA) {
        return billingPayload({
          dailyBudgetCents: "4000",
          funnels: [{ funnelKey: "reply_meeting", dailyBudgetCents: "4000" }],
        });
      }
      return billingPayload({
        dailyBudgetCents: "3000",
        funnels: [{ funnelKey: "reply_meeting", dailyBudgetCents: "3000" }],
      });
    });

    const batch = await request(app)
      .post("/brands/spendable-budget")
      .set("x-api-key", API_KEY)
      .send({ brands: [{ orgId: orgA, brandId: BRAND }, { orgId: orgB, brandId: BRAND_2 }] })
      .expect(200);

    const single = await request(app)
      .get(`/brands/${BRAND}/spendable-budget`)
      .set("x-api-key", API_KEY)
      .set("x-org-id", orgA)
      .expect(200);

    const fromBatch = batch.body.brands.find((b: { orgId: string }) => b.orgId === orgA);
    expect(fromBatch).toEqual(single.body);
    expect(batch.body.unavailable).toEqual([]);

    const other = batch.body.brands.find((b: { orgId: string }) => b.orgId === orgB);
    expect(other.configuredDailyBudgetCents).toBe(3000);
    expect(other.runningDailyBudgetCents).toBe(0);
  });

  it("names a brand billing could not answer for, and gives it NO figures at all", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) } as unknown as Response);

    const res = await request(app)
      .post("/brands/spendable-budget")
      .set("x-api-key", API_KEY)
      .send({ brands: [{ orgId: "org-down", brandId: BRAND }] })
      .expect(200);

    expect(res.body.brands).toEqual([]);
    expect(res.body.unavailable).toHaveLength(1);
    expect(res.body.unavailable[0]).toMatchObject({ orgId: "org-down", brandId: BRAND });
  });
});
