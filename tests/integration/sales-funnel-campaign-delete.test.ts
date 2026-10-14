import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";

const { mockPlan, mockListRuns } = vi.hoisted(() => ({ mockPlan: vi.fn(), mockListRuns: vi.fn() }));

vi.mock("@distribute/runs-client", () => ({
  createRun: vi.fn(async () => ({ id: crypto.randomUUID() })),
  updateRun: vi.fn(),
  listRuns: mockListRuns,
  getStatsBudget: vi.fn(),
}));

vi.mock("../../src/lib/startable-pair.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/lib/startable-pair.js")>();
  return { ...original, resolveSalesFunnelPlan: mockPlan };
});

vi.mock("../../src/lib/workflows.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/lib/workflows.js")>();
  return { ...original, executeCampaignWorkflow: vi.fn() };
});

import app from "../../src/index.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { campaigns, campaignStatusTransitions, salesFunnelCampaigns, triggerEventDeliveries } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import { notifySalesFunnelCampaignPrecompute } from "../../src/lib/sales-funnel-campaign-precompute.js";

const API_KEY = process.env.CAMPAIGN_SERVICE_API_KEY || "test-api-key";
const ORG = "b645207b-0000-4000-8000-0000000000d1";
const OTHER_ORG = "b645207b-0000-4000-8000-0000000000d9";
const BRAND = "75d7e3e8-0000-4000-8000-0000000000d2";
const OFFER = "231bb036-0000-4000-8000-0000000000d3";
const COLD = "sales-cold-email-outreach";
const ENTRY = "lead_found_to_conversation";
const FUNNEL = `${ENTRY}@${COLD}+conversation_to_paid_client`;

const as = (r: request.Test, org = ORG) =>
  r.set("x-api-key", API_KEY).set("x-org-id", org).set("x-user-id", "user_del").set("x-run-id", crypto.randomUUID());

const launch = () =>
  as(request(app).post("/sales-funnel-campaigns")).send({ brandId: BRAND, offerId: OFFER, salesFunnelId: FUNNEL, status: "stopped" });
const del = (id: string, org = ORG) => as(request(app).delete(`/sales-funnel-campaigns/${id}`), org);

const billingCalls: { url: string; method: string }[] = [];
let billingStatus = 200;
const realFetch = globalThis.fetch;

describe("DELETE /sales-funnel-campaigns/:id (a campaign created by mistake, never ran)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await cleanTestData();
    billingCalls.length = 0;
    billingStatus = 200;
    process.env.BILLING_SERVICE_URL = "http://billing.local";
    process.env.BILLING_SERVICE_API_KEY = "k";
    vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("http://billing.local")) {
        billingCalls.push({ url, method: init?.method ?? "GET" });
        return new Response(JSON.stringify({}), { status: billingStatus });
      }
      return realFetch(input, init);
    });
    mockListRuns.mockResolvedValue({ runs: [] });
    mockPlan.mockResolvedValue({
      ok: true,
      plan: {
        salesFunnelId: "unused",
        salesFunnelName: "Mistake",
        units: [{ pipeId: `${COLD}|${ENTRY}`, featureSlug: COLD, legKey: ENTRY, mode: "proactive", workflowSlug: "aurora-v3" }],
      },
    });
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await cleanTestData();
    await closeDb();
  });

  it("deletes a stopped campaign that never ran, with its units; it is gone from the list; history kept", async () => {
    const fc = (await launch().expect(201)).body.salesFunnelCampaign;
    const unitIds = fc.units.map((u: { campaignId: string }) => u.campaignId);

    const res = await del(fc.id).expect(200);
    expect(res.body).toEqual({ deleted: true, salesFunnelCampaignId: fc.id, unitIds });

    expect(mockListRuns).toHaveBeenCalledWith({ orgId: ORG, campaignIds: unitIds, limit: 1 });
    expect(billingCalls).toEqual([
      {
        method: "DELETE",
        url: `http://billing.local/internal/brands/${BRAND}/offers/${OFFER}/sales-funnels/${encodeURIComponent(FUNNEL)}/campaigns/${fc.id}/caps`,
      },
    ]);
    expect(await db.select().from(salesFunnelCampaigns)).toHaveLength(0);
    expect(await db.select().from(campaigns)).toHaveLength(0);
    expect((await db.select().from(campaignStatusTransitions).where(eq(campaignStatusTransitions.orgId, ORG))).length).toBeGreaterThan(0);
    expect(vi.mocked(notifySalesFunnelCampaignPrecompute)).toHaveBeenLastCalledWith(
      expect.objectContaining({ salesFunnelCampaignId: fc.id, brandId: BRAND, offerId: OFFER }),
    );

    const list = await as(request(app).get("/sales-funnel-campaigns")).expect(200);
    expect(list.body.salesFunnelCampaigns).toEqual([]);
  });

  it("refuses a campaign that has run (any run on a unit), deletes nothing, touches no billing cap", async () => {
    const fc = (await launch().expect(201)).body.salesFunnelCampaign;
    mockListRuns.mockResolvedValue({ runs: [{ id: "r1", status: "failed" }] });

    const res = await del(fc.id).expect(409);
    expect(res.body.reason).toBe("sales_funnel_campaign_has_history");
    expect(billingCalls).toEqual([]);
    expect(await db.select().from(salesFunnelCampaigns)).toHaveLength(1);
    expect(await db.select().from(campaigns)).toHaveLength(1);
  });

  it("refuses a campaign whose unit has a recorded trigger delivery, without asking runs-service", async () => {
    const fc = (await launch().expect(201)).body.salesFunnelCampaign;
    await db.insert(triggerEventDeliveries).values({
      eventId: crypto.randomUUID(),
      campaignId: fc.units[0].campaignId,
      runId: crypto.randomUUID(),
      status: "completed",
    });
    const res = await del(fc.id).expect(409);
    expect(res.body.reason).toBe("sales_funnel_campaign_has_history");
    expect(mockListRuns).not.toHaveBeenCalled();
  });

  it("refuses an ongoing campaign", async () => {
    const fc = (await launch().expect(201)).body.salesFunnelCampaign;
    await db.update(salesFunnelCampaigns).set({ status: "ongoing" }).where(eq(salesFunnelCampaigns.id, fc.id));
    const res = await del(fc.id).expect(409);
    expect(res.body.reason).toBe("sales_funnel_campaign_ongoing");
    expect(mockListRuns).not.toHaveBeenCalled();
    expect(await db.select().from(salesFunnelCampaigns)).toHaveLength(1);
  });

  it("fails closed when runs-service cannot answer (502 runs_unavailable, nothing deleted)", async () => {
    const fc = (await launch().expect(201)).body.salesFunnelCampaign;
    mockListRuns.mockRejectedValue(new Error("runs down"));
    const res = await del(fc.id).expect(502);
    expect(res.body.reason).toBe("runs_unavailable");
    expect(await db.select().from(salesFunnelCampaigns)).toHaveLength(1);
  });

  it("fails closed when billing cannot clear the caps (502 billing_unavailable, nothing deleted)", async () => {
    const fc = (await launch().expect(201)).body.salesFunnelCampaign;
    billingStatus = 500;
    const res = await del(fc.id).expect(502);
    expect(res.body.reason).toBe("billing_unavailable");
    expect(await db.select().from(campaigns)).toHaveLength(1);
  });

  it("is scoped to the caller's org (another org's id = 404)", async () => {
    const fc = (await launch().expect(201)).body.salesFunnelCampaign;
    await del(fc.id, OTHER_ORG).expect(404);
    expect(await db.select().from(salesFunnelCampaigns)).toHaveLength(1);
  });
});
