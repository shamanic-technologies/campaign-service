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
import { db } from "../../src/db/index.js";
import { campaigns, salesFunnelCampaigns } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";

const API_KEY = process.env.CAMPAIGN_SERVICE_API_KEY || "test-api-key";
const BRAND = "11111111-1111-4111-8111-111111111111";
const BRAND_2 = "22222222-2222-4222-8222-222222222222";

/** billing-service's per-campaign budget read, as it comes off the wire. */
function billingPayload(body: unknown) {
  return { ok: true, json: async () => body } as unknown as Response;
}

describe("Brand spendable budget", () => {
  const fetchMock = vi.fn();
  // billing's brand SALES FUNNEL caps (GET /internal/brands/:id/sales-funnel-caps): none unless a
  // test states some. Every other billing read goes to `fetchMock`.
  let funnelCaps: unknown[] = [];
  const capsReads: string[] = [];
  const routedFetch = (url: string, init?: unknown) => {
    if (String(url).includes("/sales-funnel-caps")) {
      capsReads.push(String(url));
      return Promise.resolve(billingPayload({ orgId: "o", brandId: "b", caps: funnelCaps }));
    }
    return fetchMock(url, init);
  };

  beforeEach(async () => {
    await cleanTestData();
    vi.clearAllMocks();
    process.env.BILLING_SERVICE_URL = "http://billing.test";
    process.env.BILLING_SERVICE_API_KEY = "billing-key";
    funnelCaps = [];
    capsReads.length = 0;
    vi.stubGlobal("fetch", routedFetch);
  });

  it("counts a SALES FUNNEL campaign by its max budget per day, and never by a per-pipe ceiling", async () => {
    const orgId = "org-funnels";
    const OFFER = "33333333-3333-4333-8333-333333333333";
    const ENTRY = "lead_found_to_website_visit";
    // A stopped PRE-FUNNEL campaign on the pipe, funded at $30/day by its own ceiling.
    const preFunnel = await insertTestCampaign(orgId, {
      brandIds: [BRAND], brandId: BRAND, featureSlug: "sales-cold-email-outreach", acquisitionChannel: "cold_email",
      offerId: OFFER, legKey: ENTRY, status: "stopped",
    });
    // A RUNNING sales funnel campaign whose unit works the SAME pipe.
    const [weekly] = await db.insert(salesFunnelCampaigns).values({
      orgId, brandId: BRAND, offerId: OFFER, salesFunnelId: "f-weekly", salesFunnelName: "Epiphany", status: "ongoing",
    }).returning();
    const unit = await insertTestCampaign(orgId, {
      brandIds: [BRAND], brandId: BRAND, featureSlug: "sales-cold-email-outreach", acquisitionChannel: "cold_email",
      offerId: OFFER, legKey: ENTRY, status: "ongoing", name: "unit",
    });
    await db.update(campaigns).set({ salesFunnelId: "f-weekly", salesFunnelCampaignId: weekly.id }).where(eq(campaigns.id, unit.id));
    // A STOPPED funnel campaign on a monthly cap, and a one-off cap with no funnel campaign.
    await db.insert(salesFunnelCampaigns).values({
      orgId, brandId: BRAND, offerId: OFFER, salesFunnelId: "f-monthly", salesFunnelName: "Bliss", status: "stopped",
    });
    funnelCaps = [
      { offerId: OFFER, salesFunnelId: "f-weekly", maxBudget: { amountCents: "7000", period: "weekly" }, maxVolume: null, updatedAt: "2026-10-10T00:00:00Z" },
      { offerId: OFFER, salesFunnelId: "f-monthly", maxBudget: { amountCents: "30000", period: "monthly" }, maxVolume: null, updatedAt: "2026-10-10T00:00:00Z" },
      { offerId: OFFER, salesFunnelId: "f-once", maxBudget: { amountCents: "50000", period: "one_off" }, maxVolume: null, updatedAt: "2026-10-10T00:00:00Z" },
      { offerId: OFFER, salesFunnelId: "f-volume", maxBudget: null, maxVolume: { count: 10, period: "daily", unit: "first_contacts" }, updatedAt: "2026-10-10T00:00:00Z" },
    ];
    fetchMock.mockResolvedValue(billingPayload({
      brandId: BRAND,
      dailyBudgetCents: "3000",
      campaigns: [{ offerId: OFFER, legKey: ENTRY, featureSlug: "sales-cold-email-outreach", dailyBudgetCents: "3000" }],
    }));

    const res = await request(app).get(`/brands/${BRAND}/spendable-budget`).set("x-api-key", API_KEY).set("x-org-id", orgId).expect(200);

    // The pipe's ceiling stays the STOPPED pre-funnel campaign's: the running unit never wakes it.
    expect(res.body.rows).toEqual([expect.objectContaining({ campaignId: preFunnel.id, running: false, dailyBudgetCents: 3000 })]);
    // weekly 7000/7 = 1000 (running), monthly 30000/30 = 1000 (stopped), one_off 0, volume-only 0.
    expect(res.body.configuredDailyBudgetCents).toBe(3000 + 1000 + 1000);
    expect(res.body.runningDailyBudgetCents).toBe(1000);
    const line = (id: string) => res.body.salesFunnels.find((f: { salesFunnelId: string }) => f.salesFunnelId === id);
    expect(line("f-weekly")).toMatchObject({ salesFunnelCampaignId: weekly.id, running: true, dailyBudgetCents: 1000, recurring: true, unitCampaignIds: [unit.id] });
    expect(line("f-monthly")).toMatchObject({ status: "stopped", running: false, dailyBudgetCents: 1000 });
    expect(line("f-once")).toMatchObject({ salesFunnelCampaignId: null, dailyBudgetCents: 0, recurring: false });
    expect(line("f-volume")).toMatchObject({ dailyBudgetCents: 0 });
    // The unit is named, with NO budget of its own.
    expect(res.body.campaigns.find((c: { campaignId: string }) => c.campaignId === unit.id)).toMatchObject({
      salesFunnelCampaignId: weekly.id, configuredDailyBudgetCents: 0, runningDailyBudgetCents: 0,
    });
    expect(res.body.offers).toEqual([expect.objectContaining({ offerId: OFFER, configuredDailyBudgetCents: 5000, runningDailyBudgetCents: 1000 })]);
    expect(capsReads).toHaveLength(1);
  });

  it("answers 502, never a smaller figure, when billing's funnel caps cannot be read", async () => {
    fetchMock.mockResolvedValue(billingPayload({ brandId: BRAND, dailyBudgetCents: null, campaigns: [] }));
    vi.stubGlobal("fetch", (url: string, init?: unknown) =>
      String(url).includes("/sales-funnel-caps") ? Promise.resolve({ ok: false, status: 503, json: async () => ({}) }) : fetchMock(url, init));
    await request(app).get(`/brands/${BRAND}/spendable-budget`).set("x-api-key", API_KEY).set("x-org-id", "org-x").expect(502);
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await cleanTestData();
    await closeDb();
  });

  it("reports configured money with nothing running when the funded ceiling has no campaign", async () => {
    fetchMock.mockResolvedValue(billingPayload({
      brandId: BRAND,
      dailyBudgetCents: "5000",
      campaigns: [{ offerId: "33333333-3333-4333-8333-333333333333", legKey: "start_to_conversation", featureSlug: "sales-cold-email-outreach", dailyBudgetCents: "5000" }],
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

  it("counts a running lead SOURCE campaign's ceiling as running, and names a stopped one", async () => {
    const orgId = "org-sources";
    const OFFER = "33333333-3333-4333-8333-333333333333";
    const outreach = await insertTestCampaign(orgId, {
      brandIds: [BRAND],
      brandId: BRAND,
      featureSlug: "sales-cold-email-outreach",
      acquisitionChannel: "cold_email",
      offerId: OFFER,
      legKey: "lead_found_to_website_visit",
      status: "ongoing",
    });
    const coldFilters = await insertTestCampaign(orgId, {
      brandIds: [BRAND],
      brandId: BRAND,
      featureSlug: "sourcing-apollo-cold-filters",
      offerId: OFFER,
      legKey: "start_to_lead_found",
      status: "ongoing",
    });
    const signals = await insertTestCampaign(orgId, {
      brandIds: [BRAND],
      brandId: BRAND,
      featureSlug: "sourcing-apollo-buying-signals",
      offerId: OFFER,
      legKey: "start_to_lead_found",
      status: "stopped",
    });

    fetchMock.mockResolvedValue(billingPayload({
      brandId: BRAND,
      dailyBudgetCents: "2500",
      campaigns: [
        { offerId: OFFER, legKey: "lead_found_to_website_visit", featureSlug: "sales-cold-email-outreach", dailyBudgetCents: "300" },
        { offerId: OFFER, legKey: "start_to_lead_found", featureSlug: "sourcing-apollo-cold-filters", dailyBudgetCents: "1700" },
        { offerId: OFFER, legKey: "start_to_lead_found", featureSlug: "sourcing-apollo-buying-signals", dailyBudgetCents: "500" },
      ],
    }));

    const res = await request(app)
      .get(`/brands/${BRAND}/spendable-budget`)
      .set("x-api-key", API_KEY)
      .set("x-org-id", orgId)
      .expect(200);

    expect(res.body.configuredDailyBudgetCents).toBe(2500);
    expect(res.body.runningDailyBudgetCents).toBe(2000);
    const row = (slug: string) => res.body.rows.find((r: { featureSlug: string }) => r.featureSlug === slug);
    expect(row("sales-cold-email-outreach")).toMatchObject({ running: true, campaignId: outreach.id });
    expect(row("sourcing-apollo-cold-filters")).toMatchObject({ running: true, campaignId: coldFilters.id });
    expect(row("sourcing-apollo-buying-signals")).toMatchObject({ running: false, campaignId: signals.id, campaignStatus: "stopped" });
  });

  it("counts only the ceiling whose campaign is ongoing", async () => {
    const orgId = "org-partly-running";
    await insertTestCampaign(orgId, {
      brandIds: [BRAND],
      brandId: BRAND,
      featureSlug: "sales-cold-email-outreach",
      acquisitionChannel: "cold_email",
      offerId: "33333333-3333-4333-8333-333333333333",
      legKey: "start_to_conversation",
      status: "ongoing",
    });
    await insertTestCampaign(orgId, {
      brandIds: [BRAND],
      brandId: BRAND,
      featureSlug: "sales-cold-email-outreach",
      acquisitionChannel: "cold_email",
      offerId: "33333333-3333-4333-8333-333333333333",
      legKey: "start_to_website_visit",
      status: "stopped",
    });

    fetchMock.mockResolvedValue(billingPayload({
      brandId: BRAND,
      dailyBudgetCents: "9000",
      campaigns: [
        { offerId: "33333333-3333-4333-8333-333333333333", legKey: "start_to_conversation", featureSlug: "sales-cold-email-outreach", dailyBudgetCents: "4000" },
        { offerId: "33333333-3333-4333-8333-333333333333", legKey: "start_to_website_visit", featureSlug: "sales-cold-email-outreach", dailyBudgetCents: "5000" },
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
      offerId: "33333333-3333-4333-8333-333333333333",
      legKey: "start_to_conversation",
      status: "ongoing",
    });

    fetchMock.mockImplementation(async (url: string, init: { headers: Record<string, string> }) => {
      const orgId = init.headers["x-org-id"];
      if (orgId === orgA) {
        return billingPayload({
          dailyBudgetCents: "4000",
          campaigns: [{ offerId: "33333333-3333-4333-8333-333333333333", legKey: "start_to_conversation", featureSlug: "sales-cold-email-outreach", dailyBudgetCents: "4000" }],
        });
      }
      return billingPayload({
        dailyBudgetCents: "3000",
        campaigns: [{ offerId: "33333333-3333-4333-8333-333333333333", legKey: "start_to_conversation", featureSlug: "sales-cold-email-outreach", dailyBudgetCents: "3000" }],
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
