import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from "vitest";

// CLIENT-ACTIVITY-1030: a client's create / edit / pause / resume is reported to crm-service, ONE report per
// request, after the write; a crm failure never changes the route's answer; a system write reports nothing.
const { mockPlan } = vi.hoisted(() => ({ mockPlan: vi.fn() }));

vi.mock("@distribute/runs-client", () => ({
  createRun: vi.fn(async () => ({ id: crypto.randomUUID() })),
  updateRun: vi.fn(),
  listRuns: vi.fn(async () => ({ runs: [] })),
  getStatsBudget: vi.fn(),
}));
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
vi.mock("../../src/lib/mission-status-notification.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/lib/mission-status-notification.js")>();
  return { ...original, signalMissionStatusChanged: vi.fn(async () => undefined) };
});
vi.mock("../../src/lib/payment-hold.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/lib/payment-hold.js")>();
  return { ...original, paymentStartRefusal: vi.fn(async () => null) };
});
vi.mock("../../src/lib/startable-pair.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/lib/startable-pair.js")>();
  return { ...original, resolveSalesFunnelPlan: mockPlan };
});

import request from "supertest";
import app from "../../src/index.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { campaigns } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import { setCampaignStatus, TRANSITION_SOURCES } from "../../src/lib/campaign-status-history.js";
import { STOP_REASONS } from "../../src/lib/stop-reason.js";

const API_KEY = process.env.CAMPAIGN_SERVICE_API_KEY || "test-api-key";
const CRM = "http://crm-activity.test";
const ORG = "4c1b2a0e-0000-4000-8000-00000000a001";
const USER = "4c1b2a0e-0000-4000-8000-00000000a002";
const BRAND = "4c1b2a0e-0000-4000-8000-00000000a003";
const OFFER = "4c1b2a0e-0000-4000-8000-00000000a004";

type Sent = { headers: Record<string, string>; body: Record<string, any> };
let sent: Sent[] = [];
let crmAnswer: () => Promise<Response> = async () => new Response(JSON.stringify({ id: "x", stored: true, duplicate: false }), { status: 200 });
const realFetch = globalThis.fetch;

beforeAll(() => {
  process.env.CRM_SERVICE_URL = CRM;
  process.env.CRM_SERVICE_API_KEY = "crm-key";
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith(CRM)) {
      sent.push({ headers: init.headers, body: JSON.parse(init.body) });
      return crmAnswer();
    }
    return realFetch(input, init);
  });
});

const person = (r: request.Test) =>
  r.set("x-api-key", API_KEY).set("x-org-id", ORG).set("x-user-id", USER).set("x-run-id", crypto.randomUUID()).set("x-email", "client@acme.test");

/** Wait for the background report(s), then make sure no other one follows. */
async function reports(n: number): Promise<Sent[]> {
  await vi.waitFor(() => expect(sent.length).toBeGreaterThanOrEqual(n), { timeout: 2000 });
  await new Promise((r) => setTimeout(r, 100));
  expect(sent).toHaveLength(n);
  return sent;
}

async function createCampaign(name = "ABA Owners Meetings") {
  const res = await person(request(app).post("/campaigns"))
    .set("x-feature-slug", "sales-cold-email-v1")
    .send({ name, workflowSlug: "sales-email-cold-outreach", orgId: ORG, brandIds: [BRAND] });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.campaign;
}

const patch = (id: string, body: Record<string, unknown>) =>
  person(request(app).patch(`/campaigns/${id}`)).set("x-feature-slug", "sales-cold-email-v1").send(body);

describe("client campaign actions reported to crm-service", () => {
  beforeEach(async () => {
    await cleanTestData();
    sent = [];
    crmAnswer = async () => new Response(JSON.stringify({ id: "x", stored: true, duplicate: false }), { status: 200 });
    mockPlan.mockResolvedValue({
      ok: true,
      plan: {
        salesFunnelId: "unused",
        salesFunnelName: "Epiphany",
        units: [{ pipeId: "sales-cold-email-outreach|lead_found_to_conversation", featureSlug: "sales-cold-email-outreach", legKey: "lead_found_to_conversation", mode: "proactive", workflowSlug: "aurora-v3" }],
      },
    });
  });
  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("a create sends one `campaign_created` with the actor, the org, the brand and the campaign name", async () => {
    const campaign = await createCampaign();
    const [r] = await reports(1);
    expect(r.headers).toMatchObject({ "x-api-key": "crm-key", "x-org-id": ORG, "x-user-id": USER, "x-email": "client@acme.test" });
    expect(r.body).toMatchObject({
      producer: "campaign-service",
      type: "campaign_created",
      title: "Campaign created",
      subject: { kind: "campaign", id: campaign.id, name: "ABA Owners Meetings" },
      brandId: BRAND,
    });
    expect(r.body.changes).toBeUndefined();
    expect(r.body.activityId).toContain(campaign.id);
  });

  it("an edit sends one `campaign_updated` with before and after; a no-op save sends nothing", async () => {
    const campaign = await createCampaign();
    await reports(1);
    sent = [];

    await patch(campaign.id, { name: "ABA Owners Q4", maxLeads: 50 }).expect(200);
    const [r] = await reports(1);
    expect(r.body).toMatchObject({ type: "campaign_updated", title: "Campaign edited", subject: { name: "ABA Owners Q4" } });
    expect(r.body.changes).toEqual([
      { label: "Name", before: "ABA Owners Meetings", after: "ABA Owners Q4" },
      { label: "Max leads", before: null, after: "50" },
    ]);

    sent = [];
    await patch(campaign.id, { name: "ABA Owners Q4" }).expect(200);
    await reports(0);
  });

  it("a pause, then a resume, each send exactly one report; pausing a paused campaign sends nothing", async () => {
    const campaign = await createCampaign();
    await reports(1);
    sent = [];

    await patch(campaign.id, { status: "stop" }).expect(200);
    expect((await reports(1))[0].body).toMatchObject({ type: "campaign_paused", title: "Campaign paused", subject: { id: campaign.id } });

    sent = [];
    await patch(campaign.id, { status: "stop" }).expect(200);
    await reports(0);

    await patch(campaign.id, { status: "activate" }).expect(200);
    expect((await reports(1))[0].body).toMatchObject({ type: "campaign_resumed", title: "Campaign resumed" });
  });

  it("a sales funnel campaign: launch, edit its brief, pause, each one report named by the funnel", async () => {
    const launched = await person(request(app).post("/sales-funnel-campaigns"))
      .send({ brandId: BRAND, offerId: OFFER, salesFunnelId: "lead_found_to_conversation@sales-cold-email-outreach", status: "stopped" })
      .expect(201);
    const fc = launched.body.salesFunnelCampaign;
    expect((await reports(1))[0].body).toMatchObject({ type: "campaign_created", subject: { id: fc.id, name: "Epiphany" }, brandId: BRAND });

    sent = [];
    await person(request(app).patch(`/sales-funnel-campaigns/${fc.id}`)).send({ brief: "Only dental clinics in Texas" }).expect(200);
    expect((await reports(1))[0].body).toMatchObject({
      type: "campaign_updated",
      changes: [{ label: "Brief", before: null, after: "Only dental clinics in Texas" }],
    });

    sent = [];
    await person(request(app).patch(`/sales-funnel-campaigns/${fc.id}`)).send({ status: "activate" }).expect(200);
    expect((await reports(1))[0].body).toMatchObject({ type: "campaign_resumed", subject: { id: fc.id } });

    // A unit paused from a screen still showing pipes moves its whole funnel: ONE report, on the funnel.
    sent = [];
    const [unit] = await db.select().from(campaigns).where(eq(campaigns.salesFunnelCampaignId, fc.id));
    await patch(unit.id, { status: "stop" }).expect(200);
    expect((await reports(1))[0].body).toMatchObject({ type: "campaign_paused", subject: { id: fc.id, name: "Epiphany" } });
  });

  it("a crm-service error or timeout leaves the route's answer unchanged", async () => {
    crmAnswer = async () => new Response("boom", { status: 500 });
    const campaign = await createCampaign();
    await reports(1);

    sent = [];
    crmAnswer = () => new Promise(() => {}); // never answers
    const started = Date.now();
    const res = await patch(campaign.id, { status: "stop" }).expect(200);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(res.body.campaign).toMatchObject({ id: campaign.id, status: "stopped" });

    crmAnswer = async () => { throw new Error("ECONNREFUSED"); };
    sent = [];
    const resumed = await patch(campaign.id, { status: "activate" }).expect(200);
    expect(resumed.body.campaign.status).toBe("ongoing");
  });

  it("a request naming no person and a system write report nothing", async () => {
    const campaign = await createCampaign();
    await reports(1);
    sent = [];

    // The payment hold / teardown path: a status write with no person behind it.
    await setCampaignStatus({
      campaignId: campaign.id,
      orgId: ORG,
      fromStatus: "ongoing",
      toStatus: "stopped",
      reason: STOP_REASONS.PAYMENT_DECLINED,
      source: TRANSITION_SOURCES.PAYMENT_HOLD,
    });
    // A caller without x-user-id (a platform run).
    await request(app).patch(`/campaigns/${campaign.id}`)
      .set("x-api-key", API_KEY).set("x-org-id", ORG).set("x-feature-slug", "sales-cold-email-v1")
      .send({ name: "Renamed by a script" })
      .expect(200);
    await reports(0);
  });
});
