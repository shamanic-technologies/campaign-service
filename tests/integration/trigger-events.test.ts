import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";

const { mockExecute, mockCatalogue, mockFunding, mockListRuns, mockResolveSlug, mockGetStatsBudget } = vi.hoisted(() => ({
  mockGetStatsBudget: vi.fn(),
  mockExecute: vi.fn(),
  mockCatalogue: vi.fn(),
  mockFunding: vi.fn(),
  mockListRuns: vi.fn(),
  mockResolveSlug: vi.fn(),
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
// by `mockFunding` (funded = runs; not funded = held, `kind` defaulting to `unfunded`).
vi.mock("../../src/lib/sales-funnel-campaigns.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/lib/sales-funnel-campaigns.js")>();
  return {
    ...original,
    salesFunnelUnitMoney: async () => {
      const f = await mockFunding();
      return f.funded
        ? { run: true, pace: { spentCents: 0, ceilingCents: f.ceilingCents } }
        : { run: false, kind: f.kind ?? "unfunded", reason: "Unfunded", detail: f.reason, nextRunAt: new Date(Date.now() + 600_000) };
    },
  };
});
import app from "../../src/index.js";
import { db } from "../../src/db/index.js";
import { triggerEvents, triggerSilenceWatch } from "../../src/db/schema.js";
import { cleanTestData, closeDb, insertTestCampaign } from "../helpers/test-db.js";
import { fireDueTriggerEvents } from "../../src/lib/trigger-events.js";
import { alertSilentTriggers, resetTriggerSilenceSweepClock, TRIGGER_SILENT_EVENT } from "../../src/lib/trigger-silence.js";

const API_KEY = process.env.CAMPAIGN_SERVICE_API_KEY || "test-api-key";
const ORG = "b645207b-0000-4000-8000-000000000011";
const BRAND = "75d7e3e8-0000-4000-8000-000000000012";
const OFFER = "231bb036-0000-4000-8000-000000000013";
const USER = "7a3b1c22-0000-4000-8000-000000000014";
const STEP = "conversation";
const LEG_OUT = "conversation" + "_to_" + "booking_call";
const REPLY = "positive_reply_received";
const MEETING = "meeting_booked";

function catalogue() {
  return {
    ok: true,
    operatorBySlug: new Map(),
    legsBySlug: new Map(),
    stepKeys: new Set([STEP, "booking_call", "meeting_booked", "meeting_attended", "paid_client"]),
    legs: [
      { legKey: LEG_OUT, fromStepKey: STEP, toStepKey: "booking_call" },
      { legKey: "meeting_booked_to_meeting_attended", fromStepKey: "meeting_booked", toStepKey: "meeting_attended" },
    ],
    triggers: new Map([
      [REPLY, { id: REPLY, label: "Positive reply", fromStepKey: STEP, firedBy: "instantly-service", coded: true }],
      [MEETING, { id: MEETING, label: "Meeting booked", fromStepKey: "meeting_booked", firedBy: "lead-service", coded: false }],
      ["lead_requested", { id: "lead_requested", label: "Lead requested", fromStepKey: null, firedBy: "lead-service", coded: true }],
    ]),
    triggerTransitions: [
      { featureSlug: "ai-meeting-booking", legKey: LEG_OUT, triggerId: REPLY },
      { featureSlug: "agency-meeting-attendance", legKey: "meeting_booked_to_meeting_attended", triggerId: MEETING },
    ],
  };
}

const meetingBooking = (status: "ongoing" | "stopped") =>
  insertTestCampaign(ORG, {
    brandIds: [BRAND],
    brandId: BRAND,
    status,
    featureSlug: "ai-meeting-booking",
    workflowSlug: "aurora-v3",
    createdByUserId: USER,
    parentRunId: "9f0d1c22-0000-4000-8000-000000000019",
    offerId: OFFER,
    legKey: LEG_OUT,
    salesFunnelCampaignId: crypto.randomUUID(),
    salesFunnelId: "sf-meeting",
  });

const postStep = (body: Record<string, unknown>) =>
  request(app).post("/internal/campaigns/trigger-for-step").set("x-api-key", API_KEY).set("x-org-id", ORG).send(body);
const postEvent = (body: Record<string, unknown>) =>
  request(app).post("/internal/trigger-events").set("x-api-key", API_KEY).set("x-org-id", ORG).send(body);
const allEvents = () => db.select().from(triggerEvents);

describe("trigger events", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await cleanTestData();
    mockCatalogue.mockResolvedValue(catalogue());
    mockFunding.mockResolvedValue({ funded: true, ceilingCents: 5000 });
    mockListRuns.mockResolvedValue({ runs: [] });
    mockResolveSlug.mockResolvedValue({ workflowSlug: "aurora-v3", audienceId: null });
    mockExecute.mockResolvedValue(undefined);
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  describe("the step call (instantly-service today)", () => {
    it("a positive reply with the AI meeting booking campaign ON records exactly one event, ran, naming it", async () => {
      const campaign = await meetingBooking("ongoing");

      const res = await postStep({ brandId: BRAND, offerId: OFFER, step: STEP });

      expect(res.status).toBe(200);
      // Today's answer, unchanged, plus the event.
      expect(res.body.triggered).toEqual([{ campaignId: campaign.id, legKey: LEG_OUT, workflowSlug: "aurora-v3" }]);
      expect(res.body.skipped).toEqual([]);
      expect(res.body.triggerId).toBe(REPLY);
      const events = await allEvents();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        id: res.body.eventId,
        triggerId: REPLY,
        step: STEP,
        orgId: ORG,
        brandId: BRAND,
        offerId: OFFER,
        status: "done",
        outcome: "ran",
        skipReason: null,
        ranCampaignIds: [campaign.id],
        recordedVia: "trigger_for_step",
      });
    });

    it("with the campaign OFF, one event skipped `campaign_off`, and the answer is today's empty one", async () => {
      await meetingBooking("stopped");

      const res = await postStep({ brandId: BRAND, offerId: OFFER, step: STEP, leadId: "lead-1" });

      expect(res.status).toBe(200);
      expect(res.body.triggered).toEqual([]);
      expect(res.body.skipped).toEqual([]);
      const events = await allEvents();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ outcome: "skipped", skipReason: "campaign_off", leadId: "lead-1" });
      expect(mockExecute).not.toHaveBeenCalled();
    });

    it("nobody bought the leg: skipped `no_campaign`", async () => {
      await postStep({ brandId: BRAND, offerId: OFFER, step: STEP });
      const [event] = await allEvents();
      expect(event).toMatchObject({ outcome: "skipped", skipReason: "no_campaign" });
    });

    it("an unknown step is still a 400 and records nothing", async () => {
      const res = await postStep({ brandId: BRAND, offerId: OFFER, step: "nonsense" });
      expect(res.status).toBe(400);
      expect(await allEvents()).toHaveLength(0);
    });
  });

  describe("POST /internal/trigger-events", () => {
    it("an unknown trigger id is refused with a named 400 and records nothing", async () => {
      const res = await postEvent({ triggerId: "made_up", brandId: BRAND, offerId: OFFER });
      expect(res.status).toBe(400);
      expect(res.body.reason).toBe("unknown_trigger");
      expect(await allEvents()).toHaveLength(0);
    });

    it("an unreadable catalogue is a 502 and records nothing", async () => {
      mockCatalogue.mockResolvedValue({ ok: false, detail: "HTTP 503" });
      const res = await postEvent({ triggerId: REPLY, brandId: BRAND, offerId: OFFER });
      expect(res.status).toBe(502);
      expect(res.body.reason).toBe("catalogue_unavailable");
      expect(await allEvents()).toHaveLength(0);
    });

    it("due now: fires the campaign bought for the (channel, leg) the trigger names", async () => {
      const campaign = await meetingBooking("ongoing");
      const res = await postEvent({ triggerId: REPLY, brandId: BRAND, offerId: OFFER, leadId: "lead-2" });
      expect(res.status).toBe(201);
      expect(res.body.event).toMatchObject({ triggerId: REPLY, status: "done", outcome: "ran", ranCampaignIds: [campaign.id], leadId: "lead-2" });
      expect(mockExecute).toHaveBeenCalledTimes(1);
    });

    it("a planned event is recorded pending and fires at its due time from the tick", async () => {
      const campaign = await meetingBooking("ongoing");
      const dueAt = new Date(Date.now() + 3 * 60 * 60_000);

      const res = await postEvent({ triggerId: REPLY, brandId: BRAND, offerId: OFFER, dueAt: dueAt.toISOString() });
      expect(res.status).toBe(201);
      expect(res.body.event).toMatchObject({ status: "pending", outcome: null });
      expect(mockExecute).not.toHaveBeenCalled();

      // A tick before the due time fires nothing.
      expect(await fireDueTriggerEvents(new Date(dueAt.getTime() - 60_000))).toBe(0);
      expect(mockExecute).not.toHaveBeenCalled();

      // The tick at the due time fires it, with the same rules.
      expect(await fireDueTriggerEvents(new Date(dueAt.getTime() + 1_000))).toBe(1);
      expect(mockExecute).toHaveBeenCalledTimes(1);
      const [event] = await allEvents();
      expect(event).toMatchObject({ status: "done", outcome: "ran", ranCampaignIds: [campaign.id], attempts: 1 });

      // And never twice.
      expect(await fireDueTriggerEvents(new Date(dueAt.getTime() + 60_000))).toBe(0);
      expect(mockExecute).toHaveBeenCalledTimes(1);
    });

    it("a planned event whose campaign was turned off by then is skipped `campaign_off`", async () => {
      await meetingBooking("stopped");
      const dueAt = new Date(Date.now() + 60_000);
      await postEvent({ triggerId: REPLY, brandId: BRAND, offerId: OFFER, dueAt: dueAt.toISOString() });
      await fireDueTriggerEvents(new Date(dueAt.getTime() + 1_000));
      const [event] = await allEvents();
      expect(event).toMatchObject({ status: "done", outcome: "skipped", skipReason: "campaign_off" });
    });

    it("an event the caller already performed is recorded as is, nothing dispatched", async () => {
      const source = await insertTestCampaign(ORG, {
        brandIds: [BRAND], brandId: BRAND, status: "ongoing", featureSlug: "sourcing-apollo-cold-filters",
        offerId: OFFER, legKey: "start_to_lead_found", createdByUserId: USER,
      });
      const res = await postEvent({
        triggerId: "lead_requested", brandId: BRAND, offerId: OFFER, leadId: "lead-3",
        requestedByCampaignId: "outreach-1", performed: { outcome: "ran", campaignId: source.id },
      });
      expect(res.status).toBe(201);
      expect(res.body.event).toMatchObject({
        triggerId: "lead_requested", status: "done", outcome: "ran", ranCampaignIds: [source.id],
        performedByCaller: true, requestedByCampaignId: "outreach-1", step: null,
      });
      expect(mockExecute).not.toHaveBeenCalled();
    });

    it("a performed `ran` naming no campaign of the org is a named 400", async () => {
      const res = await postEvent({ triggerId: "lead_requested", brandId: BRAND, offerId: OFFER, performed: { outcome: "ran", campaignId: "nope" } });
      expect(res.status).toBe(400);
      expect(res.body.reason).toBe("unknown_campaign");
      expect(await allEvents()).toHaveLength(0);
    });

    it("an idempotency key records the event once and replays it", async () => {
      const body = { triggerId: "lead_requested", brandId: BRAND, offerId: OFFER, idempotencyKey: "serve-1", performed: { outcome: "skipped", reason: "sources_off" } };
      const first = await postEvent(body);
      const second = await postEvent(body);
      expect(first.status).toBe(201);
      expect(second.status).toBe(200);
      expect(second.body).toMatchObject({ replayed: true, event: { id: first.body.event.id, skipReason: "sources_off" } });
      expect(await allEvents()).toHaveLength(1);
    });
  });

  describe("GET /internal/offers/:offerId/trigger-events/summary", () => {
    it("counts per trigger: events, ran, skipped by reason, pending", async () => {
      await meetingBooking("ongoing");
      await postStep({ brandId: BRAND, offerId: OFFER, step: STEP });
      mockFunding.mockResolvedValue({ funded: false, reason: "no ceiling" });
      await postStep({ brandId: BRAND, offerId: OFFER, step: STEP });
      await postEvent({ triggerId: REPLY, brandId: BRAND, offerId: OFFER, dueAt: new Date(Date.now() + 3_600_000).toISOString() });

      const res = await request(app)
        .get(`/internal/offers/${OFFER}/trigger-events/summary`)
        .query({ brandId: BRAND, from: new Date(Date.now() - 3_600_000).toISOString() })
        .set("x-api-key", API_KEY)
        .set("x-org-id", ORG);

      expect(res.status).toBe(200);
      expect(res.body.recordedSince).not.toBeNull();
      expect(res.body.triggers).toEqual([
        {
          triggerId: REPLY,
          events: 3,
          ran: 1,
          skipped: 1,
          pending: 1,
          skippedByReason: [{ reason: "unfunded", count: 1 }],
          lastOccurredAt: expect.any(String),
        },
      ]);

      const list = await request(app)
        .get(`/internal/offers/${OFFER}/trigger-events`)
        .query({ brandId: BRAND })
        .set("x-api-key", API_KEY)
        .set("x-org-id", ORG);
      expect(list.status).toBe(200);
      expect(list.body.events).toHaveLength(3);
    });

    it("requires x-org-id", async () => {
      const res = await request(app)
        .get(`/internal/offers/${OFFER}/trigger-events/summary`)
        .query({ brandId: BRAND, from: new Date().toISOString() })
        .set("x-api-key", API_KEY);
      expect(res.status).toBe(400);
    });
  });

  describe("GET /internal/offers/:offerId/trigger-events/for-person", () => {
    const LEAD = "6b1f3c2e-0000-4000-8000-0000000000aa";
    const insert = (over: Partial<typeof triggerEvents.$inferInsert>) =>
      db.insert(triggerEvents).values({
        id: crypto.randomUUID(),
        orgId: ORG,
        brandId: BRAND,
        offerId: OFFER,
        triggerId: MEETING,
        recordedVia: "trigger_events",
        occurredAt: new Date("2026-10-16T10:00:00Z"),
        dueAt: new Date("2026-10-16T10:00:00Z"),
        status: "done",
        ...over,
      }).returning();
    const ask = (q: Record<string, string>) =>
      request(app)
        .get(`/internal/offers/${OFFER}/trigger-events/for-person`)
        .query({ brandId: BRAND, triggerId: MEETING, ...q })
        .set("x-api-key", API_KEY)
        .set("x-org-id", ORG);

    it("answers the FIRST event of the trigger about the person, by lead, email (case-folded) or phone, any caller", async () => {
      const [pushed] = await insert({ detail: { person: { email: "Ann@Acme.com", phone: "+33612345678" } } });
      await insert({ leadId: LEAD, occurredAt: new Date("2026-10-16T11:00:00Z"), idempotencyKey: "lead-service:outcome:x" });

      const byEmail = await ask({ email: "ann@acme.com" });
      expect(byEmail.status).toBe(200);
      expect(byEmail.body.event).toMatchObject({ id: pushed.id, triggerId: MEETING });
      expect((await ask({ phone: "+33612345678" })).body.event.id).toBe(pushed.id);
      // Lead OR email: the earliest of either wins.
      expect((await ask({ leadId: LEAD, email: "ann@acme.com" })).body.event.id).toBe(pushed.id);
      const byLead = await ask({ leadId: LEAD });
      expect(byLead.body.event.leadId).toBe(LEAD);
      expect(byLead.body.idempotencyKey).toBe("lead-service:outcome:x");
      expect(byEmail.body.idempotencyKey).toBeNull();
    });

    it("another trigger, offer or person is none", async () => {
      await insert({ triggerId: REPLY, detail: { person: { email: "ann@acme.com" } } });
      await insert({ offerId: crypto.randomUUID(), detail: { person: { email: "ann@acme.com" } } });
      await insert({ detail: { person: { email: "bob@acme.com" } } });
      const res = await ask({ email: "ann@acme.com" });
      expect(res.status).toBe(200);
      expect(res.body.event).toBeNull();
    });

    it("names a person or refuses", async () => {
      expect((await ask({})).status).toBe(400);
      const noOrg = await request(app)
        .get(`/internal/offers/${OFFER}/trigger-events/for-person`)
        .query({ brandId: BRAND, triggerId: MEETING, email: "ann@acme.com" })
        .set("x-api-key", API_KEY);
      expect(noOrg.status).toBe(400);
    });
  });

  describe("silence alert", () => {
    const DAY = 24 * 60 * 60_000;
    let sends: Array<{ url: string; body: Record<string, unknown> }>;

    beforeEach(() => {
      resetTriggerSilenceSweepClock();
      process.env.TRANSACTIONAL_EMAIL_SERVICE_URL = "https://email.test.local";
      process.env.TRANSACTIONAL_EMAIL_SERVICE_API_KEY = "k";
      sends = [];
      vi.stubGlobal("fetch", vi.fn(async (url: string, init: { body: string }) => {
        sends.push({ url, body: JSON.parse(init.body) });
        return new Response("{}", { status: 200 });
      }));
    });

    it("fires when a coded trigger with a live campaign has had no event for 3 days", async () => {
      await meetingBooking("ongoing");
      const now = new Date();
      await db.insert(triggerSilenceWatch).values({ triggerId: REPLY, watchedSince: new Date(now.getTime() - 4 * DAY) });

      const alerted = await alertSilentTriggers(now);

      vi.unstubAllGlobals();
      expect(alerted.map((a) => a.triggerId)).toEqual([REPLY]);
      expect(sends).toHaveLength(1);
      expect(sends[0].url).toBe("https://email.test.local/platform-send");
      expect(sends[0].body).toMatchObject({
        eventType: TRIGGER_SILENT_EVENT,
        metadata: { triggerId: REPLY, triggerLabel: "Positive reply", liveCampaignCount: "1", firedBy: "instantly-service" },
      });

      // Latched: the next sweep the same day sends nothing.
      resetTriggerSilenceSweepClock();
      vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
      expect(await alertSilentTriggers(new Date(now.getTime() + 60 * 60_000))).toEqual([]);
      vi.unstubAllGlobals();
    });

    it("does not fire when the trigger had an event inside the window", async () => {
      await meetingBooking("ongoing");
      const now = new Date();
      await db.insert(triggerSilenceWatch).values({ triggerId: REPLY, watchedSince: new Date(now.getTime() - 10 * DAY) });
      await db.insert(triggerEvents).values({
        orgId: ORG, brandId: BRAND, offerId: OFFER, triggerId: REPLY, recordedVia: "trigger_for_step",
        occurredAt: new Date(now.getTime() - DAY), dueAt: new Date(now.getTime() - DAY), status: "done", outcome: "ran",
      });

      const alerted = await alertSilentTriggers(now);
      vi.unstubAllGlobals();
      expect(alerted).toEqual([]);
      expect(sends).toHaveLength(0);
    });

    it("never calls a trigger silent for days nobody was watching it, nor without a live campaign behind it", async () => {
      const now = new Date();
      // No live campaign: no watch, no alert.
      expect(await alertSilentTriggers(now)).toEqual([]);
      expect(await db.select().from(triggerSilenceWatch)).toEqual([]);

      // A live campaign appears: the watch starts NOW, so 3 silent days are counted from here.
      await meetingBooking("ongoing");
      resetTriggerSilenceSweepClock();
      expect(await alertSilentTriggers(now)).toEqual([]);
      resetTriggerSilenceSweepClock();
      expect(await alertSilentTriggers(new Date(now.getTime() + 2 * DAY))).toEqual([]);
      resetTriggerSilenceSweepClock();
      const late = await alertSilentTriggers(new Date(now.getTime() + 3 * DAY + 60_000));
      vi.unstubAllGlobals();
      expect(late.map((a) => a.triggerId)).toEqual([REPLY]);
    });
  });

  describe("one trigger per fact: follow_up_date_reached merged into follow_up_due (STD-VOCAB-CONDITION-1016)", () => {
    const FOLLOW_UP = "follow_up_due";
    const MERGED = "follow_up_date_reached";
    const FOLLOW_UP_LEG = "start_to_conversation";
    const mergedCatalogue = () => {
      const base = catalogue();
      return {
        ...base,
        triggers: new Map([...base.triggers, [FOLLOW_UP, { id: FOLLOW_UP, label: "Follow-up Due", fromStepKey: null, firedBy: "campaign-service", coded: true, kind: "reported" }]]),
        triggerTransitions: [...base.triggerTransitions, { featureSlug: "ai-follow-up-email", legKey: FOLLOW_UP_LEG, triggerId: FOLLOW_UP }],
        triggerAliases: new Map([[MERGED, FOLLOW_UP]]),
      };
    };
    const followUp = () =>
      insertTestCampaign(ORG, {
        brandIds: [BRAND],
        brandId: BRAND,
        status: "ongoing",
        featureSlug: "ai-follow-up-email",
        workflowSlug: "ai-follow-up-email-alasia",
        createdByUserId: USER,
        parentRunId: "9f0d1c22-0000-4000-8000-000000000019",
        offerId: OFFER,
        legKey: FOLLOW_UP_LEG,
        salesFunnelCampaignId: crypto.randomUUID(),
        salesFunnelId: "sf-follow-up",
      });

    beforeEach(() => {
      mockCatalogue.mockResolvedValue(mergedCatalogue());
    });

    it("an occurrence reported under the merged id is recorded and fired as the one trigger, the stated id kept", async () => {
      const campaign = await followUp();
      const res = await postEvent({ triggerId: MERGED, brandId: BRAND, offerId: OFFER, leadId: "lead-9" });
      expect(res.status).toBe(201);
      expect(res.body.event).toMatchObject({ triggerId: FOLLOW_UP, status: "done", outcome: "ran", ranCampaignIds: [campaign.id] });
      const [event] = await allEvents();
      expect(event.triggerId).toBe(FOLLOW_UP);
      expect(event.detail).toMatchObject({ statedTriggerId: MERGED });
      expect(mockExecute).toHaveBeenCalledTimes(1);
    });

    it("an occurrence reported under the one trigger fires the same campaign, nothing stated beside it", async () => {
      const campaign = await followUp();
      const res = await postEvent({ triggerId: FOLLOW_UP, brandId: BRAND, offerId: OFFER, leadId: "lead-9" });
      expect(res.body.event).toMatchObject({ triggerId: FOLLOW_UP, outcome: "ran", ranCampaignIds: [campaign.id] });
      const [event] = await allEvents();
      expect((event.detail as Record<string, unknown>)?.statedTriggerId).toBeUndefined();
    });

    it("an occurrence recorded under the merged id BEFORE the merge still fires once at its due time", async () => {
      const campaign = await followUp();
      const dueAt = new Date(Date.now() + 60_000);
      await db.insert(triggerEvents).values({
        orgId: ORG, brandId: BRAND, offerId: OFFER, triggerId: MERGED, leadId: "lead-7", recordedVia: "trigger_events",
        occurredAt: new Date(), dueAt, status: "pending",
      });
      expect(await fireDueTriggerEvents(new Date(dueAt.getTime() + 1_000))).toBe(1);
      const [event] = await allEvents();
      expect(event).toMatchObject({ status: "done", outcome: "ran", ranCampaignIds: [campaign.id] });
      expect(mockExecute).toHaveBeenCalledTimes(1);
      expect(await fireDueTriggerEvents(new Date(dueAt.getTime() + 60_000))).toBe(0);
      expect(mockExecute).toHaveBeenCalledTimes(1);
    });

    it("before features-service serves the merge, the merged id is still the declared trigger it was (byte-identical)", async () => {
      const base = catalogue();
      mockCatalogue.mockResolvedValue({ ...base, triggers: new Map([...base.triggers, [MERGED, { id: MERGED, label: "Follow-up Date Reached", fromStepKey: null, firedBy: "campaign-service", coded: false, kind: "reported" }]]) });
      const res = await postEvent({ triggerId: MERGED, brandId: BRAND, offerId: OFFER, leadId: "lead-9" });
      expect(res.status).toBe(201);
      expect(res.body.event.triggerId).toBe(MERGED);
    });
  });
});
