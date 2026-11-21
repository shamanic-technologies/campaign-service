import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";

const { mockPlan } = vi.hoisted(() => ({ mockPlan: vi.fn() }));

vi.mock("@distribute/runs-client", () => ({
  createRun: vi.fn(async () => ({ id: crypto.randomUUID() })),
  updateRun: vi.fn(),
  listRuns: vi.fn(async () => ({ runs: [] })),
  getStatsBudget: vi.fn(),
}));

vi.mock("../../src/lib/startable-pair.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/lib/startable-pair.js")>();
  return { ...original, resolveSalesFunnelPlan: mockPlan };
});

vi.mock("../../src/lib/channel-operator-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/channel-operator-client.js")>()),
  fetchChannelCatalogue: vi.fn(async () => ({
    ok: true,
    operatorBySlug: new Map(),
    legsBySlug: new Map(),
    legs: [],
    stepKeys: new Set(["lead_found", "conversation", "meeting_booked", "paid_client"]),
    stepLabels: new Map([["meeting_booked", "Meeting booked"]]),
  })),
}));

vi.mock("../../src/lib/workflows.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/lib/workflows.js")>();
  return { ...original, executeCampaignWorkflow: vi.fn() };
});

import app from "../../src/index.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { campaigns } from "../../src/db/schema.js";

const API_KEY = process.env.CAMPAIGN_SERVICE_API_KEY || "test-api-key";
const ORG = "c0ffee00-0000-4000-8000-0000000000a1";
const BRAND = "c0ffee00-0000-4000-8000-0000000000a2";
const OFFER = "c0ffee00-0000-4000-8000-0000000000a3";
// The catalogue's one funnel to a booked meeting: Lead Sourcing, cold email, the AI that books the meeting on replies.
const FUNNEL =
  "start_to_lead_found@lead-sourcing+lead_found_to_conversation@sales-cold-email-outreach+conversation_to_meeting_booked@ai-meeting-booking+meeting_booked_to_meeting_attended+meeting_attended_to_paid_client";
const BRIEF = "Book meetings with HR leaders of mid-size companies: write to them by email, answer their replies, propose a time.";

const as = (r: request.Test) =>
  r.set("x-api-key", API_KEY).set("x-org-id", ORG).set("x-user-id", "user_caps").set("x-run-id", crypto.randomUUID());

const billingCalls: { url: string; method: string; body: unknown }[] = [];
let putStatus = 200;
let ownCaps: unknown = { capScope: "sales_funnel" };
const realFetch = globalThis.fetch;
// Money reads (the caps a run is held to) GET the same path; the writes are the PUTs.
const puts = () => billingCalls.filter((c) => c.method === "PUT");
const capsPath = (sfc: string) =>
  `http://billing.local/internal/brands/${BRAND}/offers/${OFFER}/sales-funnels/${encodeURIComponent(FUNNEL)}/campaigns/${sfc}/caps`;

const create = (extra: Record<string, unknown> = {}) =>
  as(request(app).post("/sales-funnel-campaigns")).send({
    brandId: BRAND,
    offerId: OFFER,
    salesFunnelId: FUNNEL,
    target: "meeting_booked",
    brief: BRIEF,
    status: "ongoing",
    ...extra,
  });

describe("ONE-CAMPAIGN-VOLUME-1122: one campaign to booked meetings, its volume and max budget written on it", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await cleanTestData();
    billingCalls.length = 0;
    putStatus = 200;
    ownCaps = { capScope: "sales_funnel" };
    process.env.BILLING_SERVICE_URL = "http://billing.local";
    process.env.BILLING_SERVICE_API_KEY = "k";
    vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("http://billing.local") && url.includes("/campaigns/")) {
        const method = init?.method ?? "GET";
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        billingCalls.push({ url, method, body });
        if (method === "PUT") return new Response(JSON.stringify({ capScope: "sales_funnel_campaign", funded: true, ...body }), { status: putStatus });
        return new Response(JSON.stringify(ownCaps), { status: 200 });
      }
      return realFetch(input, init);
    });
    mockPlan.mockResolvedValue({
      ok: true,
      plan: {
        salesFunnelId: FUNNEL,
        salesFunnelName: "Meetings booked",
        shape: { target: "paid_client", mode: "proactive", triggerId: null },
        units: [
          { pipeId: "lead-sourcing|start_to_lead_found", featureSlug: "lead-sourcing", legKey: "start_to_lead_found", mode: "proactive", workflowSlug: "engine:lead_found" },
          { pipeId: "sales-cold-email-outreach|lead_found_to_conversation", featureSlug: "sales-cold-email-outreach", legKey: "lead_found_to_conversation", mode: "proactive", workflowSlug: "sales-cold-email-outreach-ballad" },
          { pipeId: "ai-meeting-booking|conversation_to_meeting_booked", featureSlug: "ai-meeting-booking", legKey: "conversation_to_meeting_booked", mode: "reactive", workflowSlug: "ai-meeting-booking-torcular" },
        ],
      },
    });
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await cleanTestData();
    await closeDb();
  });

  it("one create = ONE campaign targeting meeting_booked, its parts under it, its caps written on it at billing", async () => {
    const res = await create({ maxVolume: { count: 10, period: "weekly" }, maxBudget: { amountCents: 26000, period: "weekly" } }).expect(201);
    const fc = res.body.salesFunnelCampaign;
    expect(fc.target).toBe("meeting_booked");
    expect(fc.status).toBe("ongoing");
    expect(fc.units.map((u: { featureSlug: string }) => u.featureSlug).sort()).toEqual(
      ["ai-meeting-booking", "lead-sourcing", "sales-cold-email-outreach"],
    );
    expect(puts()).toEqual([
      {
        url: capsPath(fc.id),
        method: "PUT",
        body: { maxBudget: { amountCents: 26000, period: "weekly" }, maxVolume: { count: 10, period: "weekly" } },
      },
    ]);
    expect(res.body.caps).toMatchObject({ capScope: "sales_funnel_campaign", funded: true });

    // Stopping the campaign stops every part.
    await as(request(app).patch(`/sales-funnel-campaigns/${fc.id}`)).send({ status: "stop" }).expect(200);
    const units = await db.select().from(campaigns);
    expect(units).toHaveLength(3);
    expect(units.every((u) => u.status === "stopped")).toBe(true);
  });

  it("states no caps = asks billing nothing (every caller before)", async () => {
    const res = await create().expect(201);
    expect(res.body.caps).toBeUndefined();
    expect(puts()).toEqual([]);
  });

  it("a later volume change moves its caps and keeps its own max budget", async () => {
    const fc = (await create({ maxVolume: { count: 10, period: "weekly" }, maxBudget: { amountCents: 26000, period: "weekly" } }).expect(201)).body.salesFunnelCampaign;
    billingCalls.length = 0;
    ownCaps = { capScope: "sales_funnel_campaign", maxBudget: { amountCents: "26000", period: "weekly" }, maxVolume: { count: 10, period: "weekly" } };

    const res = await as(request(app).patch(`/sales-funnel-campaigns/${fc.id}`)).send({ maxVolume: { count: 15, period: "weekly" } }).expect(200);
    expect(puts()).toHaveLength(1);
    expect(puts()[0].body).toEqual({ maxBudget: { amountCents: 26000, period: "weekly" }, maxVolume: { count: 15, period: "weekly" } });
    expect(res.body.caps).toMatchObject({ maxVolume: { count: 15 } });
    expect(res.body.salesFunnelCampaign.status).toBe("ongoing");
  });

  it("a half it never had on its own stays empty (a funnel-wide cap is never copied onto the campaign)", async () => {
    const fc = (await create().expect(201)).body.salesFunnelCampaign;
    ownCaps = { capScope: "sales_funnel", maxBudget: { amountCents: "99999", period: "monthly" }, maxVolume: null };
    await as(request(app).patch(`/sales-funnel-campaigns/${fc.id}`)).send({ maxVolume: { count: 5, period: "monthly" } }).expect(200);
    expect(puts().at(-1)!.body).toEqual({ maxBudget: null, maxVolume: { count: 5, period: "monthly" } });
  });

  it("billing refusing = 502 naming the campaign; the same create again hands it back and writes the caps", async () => {
    putStatus = 503;
    const caps = { maxVolume: { count: 10, period: "weekly" }, maxBudget: { amountCents: 26000, period: "weekly" } };
    const first = await create(caps).expect(502);
    expect(first.body.reason).toBe("billing_unavailable");
    expect(first.body.salesFunnelCampaignId).toEqual(expect.any(String));

    putStatus = 200;
    const again = await create(caps).expect(200);
    expect(again.body.salesFunnelCampaign.id).toBe(first.body.salesFunnelCampaignId);
    expect(again.body.created).toBe(false);
    expect(again.body.caps).toMatchObject({ funded: true });
  });

  it("refuses a malformed cap by name, nothing written", async () => {
    const res = await create({ maxVolume: { count: -1, period: "weekly" } }).expect(400);
    expect(JSON.stringify(res.body)).toContain("maxVolume.count");
    expect(billingCalls).toEqual([]);
    expect(await db.select().from(campaigns)).toHaveLength(0);
  });
});
