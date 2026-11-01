import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";

const { mockExecute, mockCatalogue, mockFunding, mockListRuns, mockResolveSlug, mockGetStatsBudget, mockFile, mockDue } =
  vi.hoisted(() => ({
    mockGetStatsBudget: vi.fn(),
    mockExecute: vi.fn(),
    mockCatalogue: vi.fn(),
    mockFunding: vi.fn(),
    mockListRuns: vi.fn(),
    mockResolveSlug: vi.fn(),
    mockFile: vi.fn(),
    mockDue: vi.fn(),
  }));

vi.mock("@distribute/runs-client", () => ({
  createRun: vi.fn(),
  updateRun: vi.fn(),
  listRuns: mockListRuns,
  getStatsBudget: (p: { featureSlug?: string }) => (p?.featureSlug?.startsWith("sourcing-") ? Promise.resolve({ windows: [] }) : mockGetStatsBudget(p)),
}));
vi.mock("../../src/lib/workflows.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/lib/workflows.js")>();
  return { ...original, executeCampaignWorkflow: mockExecute };
});
vi.mock("../../src/lib/channel-operator-client.js", () => ({ fetchChannelCatalogue: mockCatalogue }));
vi.mock("../../src/lib/features-workflow-projection-client.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/lib/features-workflow-projection-client.js")>();
  return { ...original, resolveSelectionForTrigger: mockResolveSlug };
});
// The dispatched campaigns are sales funnel UNITS: their money is their funnel's caps, driven here
// by `mockFunding` (funded = runs; not funded = held `unfunded`, the hold an event waits through).
vi.mock("../../src/lib/sales-funnel-campaigns.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/lib/sales-funnel-campaigns.js")>();
  return {
    ...original,
    salesFunnelUnitMoney: async () => {
      const f = await mockFunding();
      return f.funded
        ? { run: true, pace: { spentCents: 0, ceilingCents: f.ceilingCents } }
        : { run: false, kind: "unfunded", reason: "Unfunded", detail: f.reason, nextRunAt: new Date(Date.now() + 600_000) };
    },
  };
});
vi.mock("../../src/lib/sales-funnel-people.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/lib/sales-funnel-people.js")>();
  return { ...original, fileNamedPerson: mockFile, scheduleNamedPersonDue: mockDue };
});

import { eq } from "drizzle-orm";
import app from "../../src/index.js";
import { db } from "../../src/db/index.js";
import { campaigns, triggerEventDeliveries, triggerEvents } from "../../src/db/schema.js";
import { cleanTestData, closeDb, insertTestCampaign } from "../helpers/test-db.js";
import { fireDueTriggerEvents } from "../../src/lib/trigger-events.js";
import { salesFunnelCampaigns } from "../../src/db/schema.js";
import { settleTriggerDelivery } from "../../src/lib/trigger-deliveries.js";

const API_KEY = process.env.CAMPAIGN_SERVICE_API_KEY || "test-api-key";
const ORG = "b645207b-0000-4000-8000-000000000101";
const BRAND = "75d7e3e8-0000-4000-8000-000000000102";
const OFFER = "231bb036-0000-4000-8000-000000000103";
const USER = "7a3b1c22-0000-4000-8000-000000000104";
const FOLLOW_UP = "follow_up_due";
const CHANNEL = "ai-follow-up-email";
const LEG = "signup_to_paid_client";
const LEAD = "3a4f1089-0000-4000-8000-000000000105";
const EMAIL = "info@martiandbb.example";

function catalogue() {
  return {
    ok: true,
    operatorBySlug: new Map(),
    legsBySlug: new Map(),
    stepKeys: new Set(["signup", "paid_client"]),
    legs: [{ legKey: LEG, fromStepKey: "signup", toStepKey: "paid_client" }],
    triggers: new Map([
      [FOLLOW_UP, { id: FOLLOW_UP, label: "Follow-up due", fromStepKey: null, firedBy: "chat-service", coded: true }],
    ]),
    triggerTransitions: [{ featureSlug: CHANNEL, legKey: LEG, triggerId: FOLLOW_UP }],
  };
}

/** A funnel campaign naming ONE person (the Copilot's follow-up), with its unit on the follow-up pipe. */
async function peopleCampaign(people: Array<{ email: string; leadId: string | null }> | null = [{ email: EMAIL, leadId: LEAD }]) {
  const [sfc] = await db
    .insert(salesFunnelCampaigns)
    .values({
      orgId: ORG,
      brandId: BRAND,
      offerId: OFFER,
      salesFunnelId: `${CHANNEL}|${LEG}`,
      salesFunnelName: "Follow-up",
      status: "ongoing",
      people,
      peopleKey: people ? people.map((p) => p.email).sort().join(",") : "",
    })
    .returning();
  return insertTestCampaign(ORG, {
    brandIds: [BRAND],
    brandId: BRAND,
    status: "ongoing",
    featureSlug: CHANNEL,
    workflowSlug: "ai-follow-up-email-algenib",
    createdByUserId: USER,
    parentRunId: "9f0d1c22-0000-4000-8000-000000000109",
    offerId: OFFER,
    legKey: LEG,
    salesFunnelCampaignId: sfc.id,
    salesFunnelId: `${CHANNEL}|${LEG}`,
  });
}

const postEvent = (body: Record<string, unknown>) =>
  request(app).post("/internal/trigger-events").set("x-api-key", API_KEY).set("x-org-id", ORG).send(body);
const eventRow = async (id: string) => (await db.select().from(triggerEvents).where(eq(triggerEvents.id, id)))[0];
const deliveries = async (eventId: string) =>
  db.select().from(triggerEventDeliveries).where(eq(triggerEventDeliveries.eventId, eventId));
const endRun = (campaignId: string, runId: string, body: Record<string, unknown>) =>
  request(app)
    .post("/end-run")
    .set({
      "x-api-key": API_KEY,
      "x-org-id": ORG,
      "x-campaign-id": campaignId,
      "x-user-id": USER,
      "x-run-id": runId,
      "x-workflow-slug": "ai-follow-up-email-algenib",
      "x-feature-slug": CHANNEL,
    })
    .send(body);
const listed = async (eventId: string) => {
  const res = await request(app)
    .get(`/internal/offers/${OFFER}/trigger-events?brandId=${BRAND}`)
    .set("x-api-key", API_KEY)
    .set("x-org-id", ORG)
    .expect(200);
  return (res.body.events as Array<Record<string, unknown>>).find((e) => e.id === eventId)!;
};
const settled = async (eventId: string, until: (e: Awaited<ReturnType<typeof eventRow>>) => boolean) => {
  let event = await eventRow(eventId);
  for (let i = 0; i < 50 && !until(event); i++) {
    await new Promise((r) => setTimeout(r, 50));
    event = await eventRow(eventId);
  }
  return event;
};

let runSeq = 0;
const nextRun = () => `wf-people-run-${++runSeq}`;

describe("an occurrence a campaign NAMING ITS PEOPLE answers is tracked like a carrying one (WF-SILENT-FOLLOWUP-1101)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await cleanTestData();
    mockCatalogue.mockResolvedValue(catalogue());
    mockFunding.mockResolvedValue({ funded: true, ceilingCents: 5000 });
    mockListRuns.mockResolvedValue({ runs: [] });
    mockResolveSlug.mockResolvedValue({ workflowSlug: "ai-follow-up-email-algenib", audienceId: null });
    mockExecute.mockImplementation(async () => ({ runId: nextRun() }));
    mockFile.mockResolvedValue({ ok: true, leadId: LEAD, filed: true });
    mockDue.mockResolvedValue({ ok: true });
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("the run carries the occurrence and the named person; the event reads in flight, never a bare ran", async () => {
    const campaign = await peopleCampaign();
    const res = await postEvent({ triggerId: FOLLOW_UP, brandId: BRAND, offerId: OFFER, leadId: LEAD }).expect(201);
    const eventId = res.body.event.id as string;
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(mockExecute.mock.calls[0][1].trigger).toEqual({
      eventId,
      triggerId: FOLLOW_UP,
      leadId: LEAD,
      item: null,
      person: { email: EMAIL },
    });
    expect(await deliveries(eventId)).toEqual([expect.objectContaining({ campaignId: campaign.id, status: "dispatched" })]);
    expect(res.body.event.delivery).toEqual({ state: "in_flight", refusals: [] });
  });

  it("run ends personNotAdmitted {reason} -> the event reads NOT ADMITTED with that reason, never redelivered", async () => {
    const campaign = await peopleCampaign();
    const res = await postEvent({ triggerId: FOLLOW_UP, brandId: BRAND, offerId: OFFER, leadId: LEAD }).expect(201);
    const eventId = res.body.event.id as string;
    const [d] = await deliveries(eventId);
    await endRun(campaign.id, d.runId, {
      success: true,
      stopCampaign: false,
      personNotAdmitted: { reason: "already_paid_client" },
    }).expect(200);
    const event = await settled(eventId, (e) => e.outcome === "skipped");
    expect(event).toMatchObject({ status: "done", outcome: "skipped", skipReason: "person_not_admitted", ranCampaignIds: [] });
    expect((event.detail as Record<string, unknown>).notAdmitted).toEqual([
      expect.objectContaining({ campaignId: campaign.id, runId: d.runId, reason: "already_paid_client" }),
    ]);
    expect(await listed(eventId)).toMatchObject({ outcome: "skipped", skipReason: "person_not_admitted", delivery: { state: "skipped" } });
    expect(await fireDueTriggerEvents(new Date(Date.now() + 24 * 3_600_000))).toBe(0);
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  it("run ends delivery refused -> the event reads REFUSED with the code", async () => {
    const campaign = await peopleCampaign();
    const res = await postEvent({ triggerId: FOLLOW_UP, brandId: BRAND, offerId: OFFER, leadId: LEAD }).expect(201);
    const eventId = res.body.event.id as string;
    const [d] = await deliveries(eventId);
    const refusal = { state: "refused", code: "person_held_back", reason: "This person already paid: no follow-up was sent." };
    await endRun(campaign.id, d.runId, { success: true, stopCampaign: false, delivery: refusal }).expect(200);
    await settled(eventId, (e) => e.outcome === "refused");
    expect(await listed(eventId)).toMatchObject({
      outcome: "refused",
      skipReason: "person_held_back",
      delivery: { state: "refused", refusals: [{ campaignId: campaign.id, code: "person_held_back", reason: refusal.reason }] },
    });
  });

  it("run ends delivered -> the event reads DELIVERED", async () => {
    const campaign = await peopleCampaign();
    const res = await postEvent({ triggerId: FOLLOW_UP, brandId: BRAND, offerId: OFFER, leadId: LEAD }).expect(201);
    const eventId = res.body.event.id as string;
    const [d] = await deliveries(eventId);
    await endRun(campaign.id, d.runId, { success: true, stopCampaign: false, delivery: { state: "delivered" } }).expect(200);
    let read = await listed(eventId);
    for (let i = 0; i < 50 && (read.delivery as { state: string }).state !== "delivered"; i++) {
      await new Promise((r) => setTimeout(r, 50));
      read = await listed(eventId);
    }
    expect(read).toMatchObject({ outcome: "ran", delivery: { state: "delivered", refusals: [] } });
  });

  it("a run that claimed nobody (noWorkAvailable) is not a delivery: the occurrence is redelivered to that campaign", async () => {
    const campaign = await peopleCampaign();
    const res = await postEvent({ triggerId: FOLLOW_UP, brandId: BRAND, offerId: OFFER, leadId: LEAD }).expect(201);
    const eventId = res.body.event.id as string;
    const [d] = await deliveries(eventId);
    expect((await settleTriggerDelivery(d.runId, { success: true, stopCampaign: false, noWorkAvailable: true })).kind).toBe("redelivered");
    expect(await eventRow(eventId)).toMatchObject({ status: "pending" });
    expect((await listed(eventId)).delivery).toEqual({ state: "owed", refusals: [] });
    await db.update(campaigns).set({ consecutiveRunFailures: 0 }).where(eq(campaigns.id, campaign.id));
    const pending = await eventRow(eventId);
    expect(await fireDueTriggerEvents(new Date(pending.dueAt.getTime() + 1000))).toBe(1);
    expect(mockExecute).toHaveBeenCalledTimes(2);
    expect(mockExecute.mock.calls[1][1].trigger).toMatchObject({ eventId, leadId: LEAD, person: { email: EMAIL } });
  });

  it("a run of the campaign already in flight: the occurrence stays OWED to it, never read ran", async () => {
    await peopleCampaign();
    mockListRuns.mockResolvedValue({ runs: [{ id: "busy", status: "running", startedAt: new Date().toISOString() }] });
    const res = await postEvent({ triggerId: FOLLOW_UP, brandId: BRAND, offerId: OFFER, leadId: LEAD }).expect(201);
    expect(mockExecute).not.toHaveBeenCalled();
    expect(res.body.event.status).toBe("pending");
    expect(res.body.event.delivery).toEqual({ state: "owed", refusals: [] });
  });

  it("a campaign naming NOBODY answering the same lead-only occurrence is unchanged: no trigger, no delivery", async () => {
    await peopleCampaign(null);
    const res = await postEvent({ triggerId: FOLLOW_UP, brandId: BRAND, offerId: OFFER, leadId: LEAD }).expect(201);
    const eventId = res.body.event.id as string;
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(mockExecute.mock.calls[0][1].trigger).toBeUndefined();
    expect(await deliveries(eventId)).toEqual([]);
    expect(res.body.event).toMatchObject({ outcome: "ran", delivery: null });
  });
});
