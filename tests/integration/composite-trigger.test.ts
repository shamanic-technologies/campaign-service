import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";

/**
 * LEAD-EVENT-TRIGGER-1016 (owner 2026-10-16): ONE trigger "Lead event" (`lead_event`, kind `any_of`) stands for every
 * fact about a person. Each occurrence of a member fact records ONE `lead_event` occurrence carrying the fact
 * (`sourceTriggerId`), fired through the same dispatch as any occurrence; facts that are not members (our own actions)
 * record none; a retried member never records it twice; three facts in a row never run a campaign in parallel.
 */

const { mockExecute, mockCatalogue, mockListRuns, mockResolveSlug } = vi.hoisted(() => ({
  mockExecute: vi.fn(),
  mockCatalogue: vi.fn(),
  mockListRuns: vi.fn(),
  mockResolveSlug: vi.fn(),
}));

vi.mock("@distribute/runs-client", () => ({
  createRun: vi.fn(),
  updateRun: vi.fn(),
  listRuns: mockListRuns,
  getStatsBudget: vi.fn().mockResolvedValue({ windows: [] }),
}));
vi.mock("../../src/lib/workflows.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/lib/workflows.js")>();
  return { ...original, executeCampaignWorkflow: mockExecute };
});
vi.mock("../../src/lib/channel-operator-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/channel-operator-client.js")>()),
  fetchChannelCatalogue: mockCatalogue,
}));
vi.mock("../../src/lib/features-workflow-projection-client.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/lib/features-workflow-projection-client.js")>();
  return { ...original, resolveSelectionForTrigger: mockResolveSlug };
});
vi.mock("../../src/lib/sales-funnel-campaigns.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/sales-funnel-campaigns.js")>()),
  salesFunnelUnitMoney: vi.fn().mockResolvedValue({ run: true, pace: { spentCents: 0, ceilingCents: 5000 } }),
}));

import app from "../../src/index.js";
import { db } from "../../src/db/index.js";
import { triggerEvents } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import { cleanTestData, closeDb, insertTestCampaign } from "../helpers/test-db.js";
import { fireDueTriggerEvents } from "../../src/lib/trigger-events.js";
import { settleCompositeFires } from "../../src/lib/composite-trigger.js";
import { detectableTriggers, liveScopesBehind, readDelayParams } from "../../src/lib/delay-trigger-detector.js";

const API_KEY = process.env.CAMPAIGN_SERVICE_API_KEY || "test-api-key";
const ORG = "b645207b-0000-4000-8000-0000000001f1";
const BRAND = "75d7e3e8-0000-4000-8000-0000000001f2";
const OFFER = "231bb036-0000-4000-8000-0000000001f3";
const USER = "7a3b1c22-0000-4000-8000-0000000001f4";
const RUN = "9f0d1c22-0000-4000-8000-0000000001f5";
const FOLLOW_UP = "ai-follow-up-email";
const FOLLOW_UP_LEG = "lead_found_to_paid_client";
const LEAD_EVENT = "lead_event";
const REPLY = "positive_reply_received";
const SIGNUP = "signed_up";
const MEMBERS = [REPLY, "website_visited", SIGNUP, "form_submitted", "paid_client", "signup_not_paid_30_min", "follow_up_date_reached"];

function catalogue(members: string[] = MEMBERS) {
  const trigger = (id: string, label: string, fromStepKey: string | null, kind: string, params: Record<string, unknown> | null = null) =>
    [id, { id, label, fromStepKey, firedBy: "x", coded: true, kind, params, callable: kind !== "any_of" && kind !== "delay" }] as const;
  return {
    ok: true,
    operatorBySlug: new Map(),
    legsBySlug: new Map([[FOLLOW_UP, new Set([FOLLOW_UP_LEG])]]),
    stepKeys: new Set(["lead_found", "conversation", "website_visit", "signup", "paid_client", "form_submitted"]),
    legs: [
      { legKey: FOLLOW_UP_LEG, fromStepKey: "lead_found", toStepKey: "paid_client" },
      { legKey: "conversation_to_meeting_booked", fromStepKey: "conversation", toStepKey: "meeting_booked" },
    ],
    triggers: new Map([
      trigger("lead_found", "Lead", "lead_found", "event"),
      trigger(REPLY, "Positive reply", "conversation", "event"),
      trigger("website_visited", "Website visit", "website_visit", "event"),
      trigger(SIGNUP, "Signup", "signup", "event"),
      trigger("form_submitted", "Form submitted", "form_submitted", "event"),
      trigger("paid_client", "Paid client", "paid_client", "event"),
      trigger("email_sent", "Email sent", "email_sent", "event"),
      trigger("follow_up_due", "Follow-up Due", null, "reported"),
      trigger("signup_not_paid_30_min", "Signup Not Paid In 30 Min", "signup", "delay", { afterStep: "signup", minutes: 30, unlessStep: "paid_client" }),
      trigger(LEAD_EVENT, "Lead event", null, "any_of", { memberTriggerIds: members }),
    ]),
    triggerAliases: new Map([["follow_up_date_reached", "follow_up_due"]]),
    triggerTransitions: [],
  };
}

/** A unit of "Lead event -> AI follow-up -> Paid client": it runs on the Lead event trigger. */
const leadEventUnit = (over: Parameters<typeof insertTestCampaign>[1] = {}) =>
  insertTestCampaign(ORG, {
    brandIds: [BRAND],
    brandId: BRAND,
    status: "ongoing",
    createdByUserId: USER,
    parentRunId: RUN,
    offerId: OFFER,
    salesFunnelCampaignId: crypto.randomUUID(),
    featureSlug: FOLLOW_UP,
    legKey: FOLLOW_UP_LEG,
    workflowSlug: "ai-follow-up-email-algenib",
    salesFunnelId: `trigger:${LEAD_EVENT}+${FOLLOW_UP_LEG}@${FOLLOW_UP}`,
    runsOnTriggerId: LEAD_EVENT,
    ...over,
  });

const postEvent = (body: Record<string, unknown>) =>
  request(app).post("/internal/trigger-events").set("x-api-key", API_KEY).set("x-org-id", ORG).send({ brandId: BRAND, offerId: OFFER, ...body });
const postStep = (step: string, leadId: string) =>
  request(app).post("/internal/campaigns/trigger-for-step").set("x-api-key", API_KEY).set("x-org-id", ORG).send({ brandId: BRAND, offerId: OFFER, step, leadId });
const leadEvents = async () => {
  await settleCompositeFires();
  return db.select().from(triggerEvents).where(eq(triggerEvents.triggerId, LEAD_EVENT));
};
const executed = () => mockExecute.mock.calls.map((c) => ({ campaignId: (c[1] as { campaignId: string }).campaignId, trigger: (c[1] as { trigger?: Record<string, unknown> }).trigger }));

describe("Lead event: one trigger for every fact about a person (LEAD-EVENT-TRIGGER-1016)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await cleanTestData();
    mockCatalogue.mockResolvedValue(catalogue());
    mockListRuns.mockResolvedValue({ runs: [] });
    mockResolveSlug.mockImplementation(async (a: { fallbackSlug: string }) => ({ workflowSlug: a.fallbackSlug, audienceId: null }));
    mockExecute.mockResolvedValue({ runId: "wf-run-1" });
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("a positive reply records a Lead event carrying the fact, and the Lead event campaign runs with it", async () => {
    const unit = await leadEventUnit();

    const res = await postEvent({ triggerId: REPLY, leadId: "lead-7" });
    await settleCompositeFires();

    expect(res.status).toBe(201);
    // Nobody answers the reply itself here; its Lead event is what runs.
    expect(res.body.event).toMatchObject({ triggerId: REPLY, status: "done", outcome: "skipped", sourceTriggerId: null });
    const [le] = await leadEvents();
    expect(le).toMatchObject({
      leadId: "lead-7",
      recordedVia: "composite_trigger",
      status: "done",
      outcome: "ran",
      ranCampaignIds: [unit.id],
      idempotencyKey: `composite:${LEAD_EVENT}:${res.body.event.id}`,
    });
    expect(le.detail).toMatchObject({ sourceTriggerId: REPLY, sourceEventId: res.body.event.id, sourceStep: "conversation" });
    expect(executed()).toEqual([
      { campaignId: unit.id, trigger: expect.objectContaining({ eventId: le.id, triggerId: LEAD_EVENT, leadId: "lead-7", sourceTriggerId: REPLY }) },
    ]);

    const list = await request(app).get(`/internal/offers/${OFFER}/trigger-events`).query({ brandId: BRAND }).set("x-api-key", API_KEY).set("x-org-id", ORG);
    expect(list.body.events.find((e: { id: string }) => e.id === le.id)).toMatchObject({ triggerId: LEAD_EVENT, sourceTriggerId: REPLY });
  });

  it("LEAD-EVENT-ASYNC-1024: the fact's caller never waits for the Lead event campaign's run", async () => {
    const unit = await leadEventUnit();
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    // The Lead event campaign's dispatch hangs (prod: lead-service filing took 30 s).
    mockExecute.mockImplementation(async () => { await held; return { runId: "wf-run-1" }; });

    const res = await postEvent({ triggerId: "website_visited", leadId: "lead-8" });

    expect(res.status).toBe(201);
    // Answered while the dispatch is still hanging; the Lead event is already recorded, never lost.
    const [pendingLe] = await db.select().from(triggerEvents).where(eq(triggerEvents.triggerId, LEAD_EVENT));
    expect(pendingLe).toMatchObject({ leadId: "lead-8", recordedVia: "composite_trigger" });
    expect(pendingLe.status).not.toBe("done");

    release();
    const [le] = await leadEvents();
    expect(le).toMatchObject({ status: "done", outcome: "ran", ranCampaignIds: [unit.id], attempts: 1 });
  });

  it("a Lead event the scheduler tick claimed first is fired once, never twice", async () => {
    await leadEventUnit();
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let calls = 0;
    mockExecute.mockImplementation(async () => { calls += 1; if (calls === 1) await held; return { runId: `wf-run-${calls}` }; });

    // A first fact holds the scope's queue, so the second fact's Lead event waits in it, pending.
    await postEvent({ triggerId: "website_visited", leadId: "lead-10" });
    await postEvent({ triggerId: SIGNUP, leadId: "lead-11" });
    // The tick claims the waiting one first.
    await fireDueTriggerEvents(new Date());
    release();

    const rows = await leadEvents();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === "done" && r.attempts === 1)).toBe(true);
    expect(mockExecute.mock.calls.filter((c) => (c[1] as { trigger?: { leadId?: string } }).trigger?.leadId === "lead-11")).toHaveLength(1);
  });

  it("a person the fact names rides the Lead event (person + item kept on the occurrence)", async () => {
    const res = await postEvent({ triggerId: "form_submitted", person: { email: "k.lourd+le@distribute.you", phone: "+33612345678" }, item: { form: "Demo" } });

    expect(res.status).toBe(201);
    const [le] = await leadEvents();
    expect(le.detail).toMatchObject({
      sourceTriggerId: "form_submitted",
      person: { email: "k.lourd+le@distribute.you", phone: "+33612345678" },
      item: { form: "Demo" },
    });
    // No Lead event campaign on this offer: a named skip.
    expect(le).toMatchObject({ status: "done", outcome: "skipped", skipReason: "no_leg" });
  });

  it("the step route's fact (a reply rung by step) records a Lead event too", async () => {
    const unit = await leadEventUnit();

    const res = await postStep("conversation", "lead-9");

    expect(res.status).toBe(200);
    const [le] = await leadEvents();
    expect(le).toMatchObject({ leadId: "lead-9", outcome: "ran", ranCampaignIds: [unit.id] });
    expect(le.detail).toMatchObject({ sourceTriggerId: REPLY, sourceStep: "conversation" });
  });

  it("our own actions (Lead found, Email sent) and a Lead event itself record no Lead event", async () => {
    await leadEventUnit();

    await postEvent({ triggerId: "lead_found", leadId: "lead-1" });
    await postEvent({ triggerId: "email_sent", leadId: "lead-1" });
    await postEvent({ triggerId: LEAD_EVENT, leadId: "lead-1" });

    const rows = await leadEvents();
    // Only the one recorded directly (internal door), never one derived from it.
    expect(rows).toHaveLength(1);
    expect(rows[0].recordedVia).toBe("trigger_events");
  });

  it("a member named by a merged id resolves (follow_up_date_reached -> follow_up_due)", async () => {
    await postEvent({ triggerId: "follow_up_date_reached", leadId: "lead-3" });
    const [le] = await leadEvents();
    expect(le.detail).toMatchObject({ sourceTriggerId: "follow_up_due" });
  });

  it("a fact replayed (same idempotency key) or fired again never records a second Lead event", async () => {
    await postEvent({ triggerId: SIGNUP, leadId: "lead-4", idempotencyKey: "signup-4" });
    await postEvent({ triggerId: SIGNUP, leadId: "lead-4", idempotencyKey: "signup-4" });
    expect(await leadEvents()).toHaveLength(1);
  });

  it("a fact planned for later records its Lead event when it falls due, not before", async () => {
    await postEvent({ triggerId: SIGNUP, leadId: "lead-5", dueAt: new Date(Date.now() + 60_000).toISOString() });
    expect(await leadEvents()).toHaveLength(0);

    await fireDueTriggerEvents(new Date(Date.now() + 120_000));
    const [le] = await leadEvents();
    expect(le.detail).toMatchObject({ sourceTriggerId: SIGNUP });
  });

  it("three facts in a row for one person: one run, the next ones wait (run_in_flight), never in parallel", async () => {
    const unit = await leadEventUnit();
    mockExecute.mockImplementation(async () => {
      mockListRuns.mockResolvedValue({ runs: [{ id: "live", status: "running", campaignId: unit.id, startedAt: new Date().toISOString() }] });
      return { runId: "wf-run-1" };
    });

    await postEvent({ triggerId: "website_visited", leadId: "lead-6" });
    await postEvent({ triggerId: SIGNUP, leadId: "lead-6" });
    await postEvent({ triggerId: "paid_client", leadId: "lead-6" });
    await settleCompositeFires();

    expect(mockExecute).toHaveBeenCalledTimes(1);
    const rows = await leadEvents();
    expect(rows.map((r) => r.outcome).sort()).toEqual(["ran", "skipped", "skipped"]);
    expect(rows.filter((r) => r.outcome === "skipped").map((r) => r.skipReason)).toEqual(["run_in_flight", "run_in_flight"]);
  });

  it("a condition member (Signup not paid in 30 min) is watched as soon as a Lead event campaign is live, on its scope", async () => {
    const cat = catalogue() as unknown as Parameters<typeof detectableTriggers>[0];
    expect(await detectableTriggers(cat, "delay", readDelayParams)).toEqual([]);

    await leadEventUnit();
    const [watched] = await detectableTriggers(cat, "delay", readDelayParams);
    expect(watched).toMatchObject({ type: { id: "signup_not_paid_30_min" }, transitions: [], composites: [{ type: { id: LEAD_EVENT } }] });
    expect(await liveScopesBehind(watched)).toEqual([{ orgId: ORG, brandId: BRAND, offerId: OFFER }]);
  });

  it("the summary counts Lead event occurrences per fact", async () => {
    await postEvent({ triggerId: REPLY, leadId: "lead-a" });
    await postEvent({ triggerId: REPLY, leadId: "lead-b" });
    await postEvent({ triggerId: SIGNUP, leadId: "lead-c" });

    const res = await request(app)
      .get(`/internal/offers/${OFFER}/trigger-events/summary`)
      .query({ brandId: BRAND, from: new Date(Date.now() - 3_600_000).toISOString() })
      .set("x-api-key", API_KEY)
      .set("x-org-id", ORG);

    expect(res.status).toBe(200);
    const row = res.body.triggers.find((t: { triggerId: string }) => t.triggerId === LEAD_EVENT);
    expect(row).toMatchObject({ events: 3, skipped: 3 });
    expect(row.bySourceTrigger).toEqual([
      { sourceTriggerId: REPLY, events: 2, ran: 0, skipped: 2, pending: 0 },
      { sourceTriggerId: SIGNUP, events: 1, ran: 0, skipped: 1, pending: 0 },
    ]);
    expect(res.body.triggers.find((t: { triggerId: string }) => t.triggerId === REPLY).bySourceTrigger).toEqual([]);
  });

  it("OFFER-FROM-LIVE-CAMPAIGNS-1024: trigger-offers names the brand's offers whose live campaign answers a member fact", async () => {
    const other = "4c1d2e3f-0000-4000-8000-0000000001f6";
    await leadEventUnit();
    await leadEventUnit({ offerId: other, status: "stopped" });
    const ask = (triggerId: string, brandId = BRAND) =>
      request(app).get(`/internal/brands/${brandId}/trigger-offers`).query({ triggerId }).set("x-api-key", API_KEY).set("x-org-id", ORG);

    // A website visit is a member of Lead event: the ongoing Lead event unit's offer runs it; the stopped one does not.
    const visit = await ask("website_visited");
    expect(visit.status).toBe(200);
    expect(visit.body).toEqual({ triggerId: "website_visited", offerIds: [OFFER] });
    // Our own action is no member: nothing live runs it.
    expect((await ask("email_sent")).body).toEqual({ triggerId: "email_sent", offerIds: [] });
    // Another brand of the org: nothing.
    expect((await ask("website_visited", "11111111-0000-4000-8000-000000000001")).body.offerIds).toEqual([]);
    expect((await ask("no_such_trigger")).status).toBe(400);
    expect((await request(app).get(`/internal/brands/${BRAND}/trigger-offers`).query({ triggerId: "website_visited" }).set("x-api-key", API_KEY)).status).toBe(400);
  });
});
