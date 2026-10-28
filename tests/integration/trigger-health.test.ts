import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { db } from "../../src/db/index.js";
import { triggerEvents, triggerHealthDays, triggerSilenceWatch } from "../../src/db/schema.js";
import { cleanTestData, closeDb, insertTestCampaign } from "../helpers/test-db.js";

const { mockCatalogue, mockReachers } = vi.hoisted(() => ({ mockCatalogue: vi.fn(), mockReachers: vi.fn() }));
vi.mock("../../src/lib/channel-operator-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/channel-operator-client.js")>()),
  fetchChannelCatalogue: mockCatalogue,
}));
vi.mock("../../src/lib/step-reach-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/step-reach-client.js")>()),
  fetchStepReachers: mockReachers,
}));

import app from "../../src/index.js";
import { StepNotObservableError } from "../../src/lib/step-reach-client.js";
import { checkTriggerHealth, readTriggerHealth, resetTriggerHealthClock } from "../../src/lib/trigger-health.js";

const API_KEY = process.env.CAMPAIGN_SERVICE_API_KEY || "test-api-key";
const ORG = "a1b2c3d4-0000-4000-8000-000000002028";
const BRAND = "b1b2c3d4-0000-4000-8000-000000002028";
const OFFER = "c1b2c3d4-0000-4000-8000-000000002028";
const DAY = 24 * 60 * 60_000;
const FORM = "form_submitted";
const BOOKING = "booking_call_started";
const LEG_FORM = "form_submitted_to_conversation";
const LEG_BOOKING = "booking_call_to_meeting_booked";

function catalogue() {
  return {
    ok: true,
    operatorBySlug: new Map(),
    legsBySlug: new Map(),
    stepKeys: new Set(["form_submitted", "booking_call", "conversation", "meeting_booked"]),
    legs: [],
    triggers: new Map([
      [FORM, { id: FORM, label: "Form submitted", fromStepKey: "form_submitted", firedBy: "crm-service", coded: true, kind: "event" }],
      [BOOKING, { id: BOOKING, label: "Booking call", fromStepKey: "booking_call", firedBy: "lead-service", coded: true, kind: "event" }],
    ]),
    triggerTransitions: [
      { featureSlug: "ai-instant-call", legKey: LEG_FORM, triggerId: FORM },
      { featureSlug: "ai-meeting-booking", legKey: LEG_BOOKING, triggerId: BOOKING },
    ],
  };
}

const live = (featureSlug: string, legKey: string) =>
  insertTestCampaign(ORG, { brandIds: [BRAND], brandId: BRAND, status: "ongoing", featureSlug, workflowSlug: "w", offerId: OFFER, legKey });

const event = (triggerId: string, at: Date) =>
  db.insert(triggerEvents).values({
    orgId: ORG, brandId: BRAND, offerId: OFFER, triggerId, recordedVia: "trigger_events",
    occurredAt: at, dueAt: at, status: "done", outcome: "ran", createdAt: at,
  });

const watchSince = (triggerId: string, at: Date) => db.insert(triggerSilenceWatch).values({ triggerId, watchedSince: at });

describe("trigger health is red on Monitoring, never an email (TRIGGER-SILENCE-NO-EMAIL-1028)", () => {
  const now = new Date();
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    await cleanTestData();
    resetTriggerHealthClock();
    mockCatalogue.mockResolvedValue(catalogue());
    mockReachers.mockResolvedValue([]);
    fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await cleanTestData();
    await closeDb();
  });

  it("a QUIET trigger that fired before and has no unanswered fact is ok, however long the silence", async () => {
    await live("ai-instant-call", LEG_FORM);
    await watchSince(FORM, new Date(now.getTime() - 14 * DAY));
    await event(FORM, new Date(now.getTime() - 5 * DAY));

    const [v] = await checkTriggerHealth(now);
    expect(v).toMatchObject({ triggerId: FORM, status: "ok", reason: null, factsWithoutEvent: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a trigger that NEVER fired while a live campaign waited 3+ days is red never_fired; younger is ok", async () => {
    await live("ai-meeting-booking", LEG_BOOKING);
    mockReachers.mockRejectedValue(new StepNotObservableError("booking_call", "step_not_observable"));

    expect((await checkTriggerHealth(now))[0]).toMatchObject({ triggerId: BOOKING, status: "ok", factsWithoutEvent: null });

    resetTriggerHealthClock();
    const later = new Date(now.getTime() + 3 * DAY + 60_000);
    const [v] = await checkTriggerHealth(later);
    expect(v).toMatchObject({ triggerId: BOOKING, status: "red", reason: "never_fired" });
    expect(v.sentence).toBe("Never fired in 3 days while 1 live campaign waits on it.");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("people lead-service saw reach the step with no event reaching us is red facts_without_event; an event clears it", async () => {
    await live("ai-instant-call", LEG_FORM);
    await watchSince(FORM, new Date(now.getTime() - 14 * DAY));
    await event(FORM, new Date(now.getTime() - 10 * DAY));
    const reached = new Date(now.getTime() - 2 * DAY);
    mockReachers.mockResolvedValue([
      { email: "a@x.com", name: null, phone: null, reachedAt: reached },
      { email: "b@x.com", name: null, phone: null, reachedAt: new Date(now.getTime() - 10 * 60_000) }, // still settling
    ]);

    const [v] = await checkTriggerHealth(now);
    expect(v).toMatchObject({ status: "red", reason: "facts_without_event", factsWithoutEvent: 1 });
    expect(v.missing).toEqual([{ orgId: ORG, brandId: BRAND, people: 1, firstReachedAt: reached.toISOString() }]);
    expect(mockReachers).toHaveBeenCalledWith(expect.objectContaining({ orgId: ORG, brandId: BRAND, step: "form_submitted" }));

    await event(FORM, new Date(reached.getTime() + 60_000));
    resetTriggerHealthClock();
    expect((await checkTriggerHealth(now))[0]).toMatchObject({ status: "ok", factsWithoutEvent: 0 });
  });

  it("lead-service unreadable is unknown, never ok nor red on a guess", async () => {
    await live("ai-instant-call", LEG_FORM);
    await watchSince(FORM, new Date(now.getTime() - 14 * DAY));
    await event(FORM, new Date(now.getTime() - 5 * DAY));
    mockReachers.mockRejectedValue(new Error("lead-service GET step-reached (form_submitted) failed: 503"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect((await checkTriggerHealth(now))[0]).toMatchObject({ status: "unknown", reason: "facts_unreadable" });
  });

  it("stores one verdict per trigger per day, served with the daily occurrence counts; no live campaign = not watched", async () => {
    await live("ai-meeting-booking", LEG_BOOKING);
    await watchSince(BOOKING, new Date(now.getTime() - 5 * DAY));
    mockReachers.mockRejectedValue(new StepNotObservableError("booking_call", "step_not_observable"));
    await checkTriggerHealth(now);
    resetTriggerHealthClock();
    await checkTriggerHealth(new Date(now.getTime() + 60_000));
    expect(await db.select().from(triggerHealthDays)).toHaveLength(1);

    const res = await request(app).get("/internal/ops/trigger-health?days=3").set("x-api-key", API_KEY);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("red");
    expect(res.body.triggers).toHaveLength(1);
    expect(res.body.triggers[0]).toMatchObject({ triggerId: BOOKING, label: "Booking call", watched: true, status: "red", reason: "never_fired", liveCampaigns: 1 });
    expect(res.body.triggers[0].byDay).toHaveLength(3);
    expect(res.body.triggers[0].byDay[2]).toMatchObject({ events: 0, status: "red" });

    expect((await request(app).get("/internal/ops/trigger-health?days=0").set("x-api-key", API_KEY)).status).toBe(400);
    expect((await request(app).get("/internal/ops/trigger-health")).status).toBe(401);

    // The campaign stops: the type is no longer watched, its history stays, the hub is not red.
    await cleanCampaignsOnly();
    resetTriggerHealthClock();
    await checkTriggerHealth(new Date(now.getTime() + 2 * 60 * 60_000));
    const after = await readTriggerHealth(3, new Date(now.getTime() + 2 * 60 * 60_000));
    expect(after.status).toBe("ok");
    expect(after.triggers[0]).toMatchObject({ watched: false, status: null });
  });
});

async function cleanCampaignsOnly() {
  const { campaigns } = await import("../../src/db/schema.js");
  await db.delete(campaigns);
}
