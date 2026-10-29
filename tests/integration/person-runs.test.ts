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
vi.mock("../../src/lib/sales-funnel-people.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/lib/sales-funnel-people.js")>();
  return { ...original, fileNamedPerson: mockFile, scheduleNamedPersonDue: mockDue };
});

import app from "../../src/index.js";
import { db } from "../../src/db/index.js";
import { triggerEventDeliveries, triggerEvents } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import { cleanTestData, closeDb, insertTestCampaign } from "../helpers/test-db.js";
import { fireDueTriggerEvents, heldBackDueAt } from "../../src/lib/trigger-events.js";
import { campaigns } from "../../src/db/schema.js";
import { settleGateRefusedDelivery, settleTriggerDelivery } from "../../src/lib/trigger-deliveries.js";
import { PERSON_RUNS_PER_CAMPAIGN_MAX, personRunsInFlight, wakeOccurrencesHeldBy } from "../../src/lib/person-runs.js";
import { blockedByAnotherRun } from "../../src/lib/gate-check.js";

const API_KEY = process.env.CAMPAIGN_SERVICE_API_KEY || "test-api-key";
const ORG = "b645207b-0000-4000-8000-000000000021";
const BRAND = "75d7e3e8-0000-4000-8000-000000000022";
const OFFER = "231bb036-0000-4000-8000-000000000023";
const USER = "7a3b1c22-0000-4000-8000-000000000024";
const FORM = "form_submitted";
const LEG = "form_submitted_to_meeting_booked";

function catalogue() {
  return {
    ok: true,
    operatorBySlug: new Map(),
    legsBySlug: new Map(),
    stepKeys: new Set([FORM, "meeting_booked"]),
    legs: [{ legKey: LEG, fromStepKey: FORM, toStepKey: "meeting_booked" }],
    triggers: new Map([[FORM, { id: FORM, label: "Form Submitted", fromStepKey: FORM, firedBy: "crm-service", coded: true }]]),
    triggerTransitions: [
      { featureSlug: "ai-meeting-booking", legKey: LEG, triggerId: FORM },
      { featureSlug: "your-team-meeting-booking", legKey: LEG, triggerId: FORM },
      { featureSlug: "other-meeting-booking", legKey: LEG, triggerId: FORM },
    ],
  };
}

const meetingBooking = (status: "ongoing" | "stopped") =>
  insertTestCampaign(ORG, {
    brandIds: [BRAND],
    brandId: BRAND,
    status,
    featureSlug: "ai-meeting-booking",
    workflowSlug: "ai-meeting-booking-v1",
    createdByUserId: USER,
    parentRunId: "9f0d1c22-0000-4000-8000-000000000029",
    offerId: OFFER,
    legKey: LEG,
    salesFunnelCampaignId: crypto.randomUUID(),
    salesFunnelId: "sf-form",
  });


const postEvent = (body: Record<string, unknown>) =>
  request(app).post("/internal/trigger-events").set("x-api-key", API_KEY).set("x-org-id", ORG).send(body);
const postEvent2 = (email: string) =>
  postEvent({ triggerId: FORM, brandId: BRAND, offerId: OFFER, person: { email, name: email }, item: { formName: "Newsletter click" } });

describe("a burst of occurrences about different people runs side by side (lib/person-runs.ts, REACTIVE-THROUGHPUT-1028)", () => {
  let inFlightPeople: string[];
  let concurrentSamePerson: boolean;

  beforeEach(async () => {
    vi.clearAllMocks();
    await cleanTestData();
    inFlightPeople = [];
    concurrentSamePerson = false;
    mockCatalogue.mockResolvedValue(catalogue());
    mockFunding.mockResolvedValue({ funded: true, ceilingCents: 5000 });
    mockListRuns.mockResolvedValue({ runs: [] });
    mockResolveSlug.mockResolvedValue({ workflowSlug: "ai-meeting-booking-v1", audienceId: null });
    mockFile.mockImplementation(async (p: { email?: string }) => ({ ok: true, leadId: `lead-${p.email}`, filed: true }));
    mockDue.mockResolvedValue({ ok: true });
    // workflow-service takes a moment to answer: parallel fires overlap inside the dispatch.
    mockExecute.mockImplementation(async (_slug: string, inputs: { trigger?: { person?: { email?: string } } }) => {
      const email = inputs.trigger?.person?.email ?? "";
      if (inFlightPeople.includes(email)) concurrentSamePerson = true;
      inFlightPeople.push(email);
      await new Promise((r) => setTimeout(r, 20));
      return { runId: crypto.randomUUID() };
    });
  });

  it("50 people at once: exactly the ceiling dispatches, the rest wait their turn (owed), no deadlock", async () => {
    const campaign = await meetingBooking("ongoing");
    const answers = await Promise.all(Array.from({ length: 50 }, (_, i) => postEvent2(`burst${i}@example.com`)));
    expect(answers.every((a) => a.status === 201)).toBe(true);
    expect(mockExecute).toHaveBeenCalledTimes(PERSON_RUNS_PER_CAMPAIGN_MAX);
    const events = await db.select().from(triggerEvents);
    expect(events.filter((e) => e.status === "done" && e.outcome === "ran")).toHaveLength(PERSON_RUNS_PER_CAMPAIGN_MAX);
    const waiting = events.filter((e) => e.status === "pending");
    expect(waiting).toHaveLength(50 - PERSON_RUNS_PER_CAMPAIGN_MAX);
    expect(waiting.every((e) => e.lastError?.includes(`${campaign.id} run_in_flight`))).toBe(true);
    const deliveries = await db.select().from(triggerEventDeliveries);
    expect(deliveries).toHaveLength(PERSON_RUNS_PER_CAMPAIGN_MAX);

    // A run ends: its slot goes to the person who waited longest, at once (not on the 2-min retry).
    await settleTriggerDelivery(deliveries[0].runId, { success: true });
    expect(await wakeOccurrencesHeldBy(campaign.id)).toBe(PERSON_RUNS_PER_CAMPAIGN_MAX);
    expect(await fireDueTriggerEvents(new Date())).toBe(1);
    expect(mockExecute).toHaveBeenCalledTimes(PERSON_RUNS_PER_CAMPAIGN_MAX + 1);
    expect(concurrentSamePerson).toBe(false);
  });

  it("two occurrences about the SAME person never run at once; the second is folded into the first's answer (ONE-AI-CONVERSES-1029-QUEUE)", async () => {
    await meetingBooking("ongoing");
    const [a, b] = await Promise.all([postEvent2("same@example.com"), postEvent2("same@example.com")]);
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect([a.body.event.status, b.body.event.status].sort()).toEqual(["done", "pending"]);
    expect(concurrentSamePerson).toBe(false);

    const [delivery] = await db.select().from(triggerEventDeliveries);
    await settleTriggerDelivery(delivery.runId, { success: true });
    const held = a.body.event.status === "pending" ? a : b;
    await db.update(triggerEvents).set({ dueAt: new Date(Date.now() - 1000) }).where(eq(triggerEvents.id, held.body.event.id));
    await fireDueTriggerEvents(new Date());
    // The run dispatched AFTER this fact read the person's whole timeline: no second run, no slot spent.
    expect(mockExecute).toHaveBeenCalledTimes(1);
    const [after] = await db.select().from(triggerEvents).where(eq(triggerEvents.id, held.body.event.id));
    expect(after).toMatchObject({ status: "done", outcome: "skipped", skipReason: "answered_after_fact" });
  });

  it("a fact recorded AFTER the person's last run still gets its own run", async () => {
    await meetingBooking("ongoing");
    await postEvent2("again@example.com");
    const [delivery] = await db.select().from(triggerEventDeliveries);
    await settleTriggerDelivery(delivery.runId, { success: true });
    await new Promise((r) => setTimeout(r, 5));
    const later = await postEvent2("again@example.com");
    expect(later.body.event).toMatchObject({ status: "done", outcome: "ran" });
    expect(mockExecute).toHaveBeenCalledTimes(2);
  });

  it("a failed run never folds an older fact: it is still answered", async () => {
    await meetingBooking("ongoing");
    const [a, b] = await Promise.all([postEvent2("fail@example.com"), postEvent2("fail@example.com")]);
    const [delivery] = await db.select().from(triggerEventDeliveries);
    await settleTriggerDelivery(delivery.runId, { success: false });
    const held = a.body.event.status === "pending" ? a : b;
    await db.update(triggerEvents).set({ dueAt: new Date(Date.now() - 1000) }).where(eq(triggerEvents.id, held.body.event.id));
    await fireDueTriggerEvents(new Date());
    expect(mockExecute.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("a freed slot goes to the NEWEST fact, not the oldest backlog (ONE-AI-CONVERSES-1029-QUEUE)", async () => {
    const campaign = await meetingBooking("ongoing");
    for (let i = 0; i < PERSON_RUNS_PER_CAMPAIGN_MAX + 6; i++) {
      await postEvent2(`queue${i}@example.com`);
      await new Promise((r) => setTimeout(r, 3));
    }
    expect(mockExecute).toHaveBeenCalledTimes(PERSON_RUNS_PER_CAMPAIGN_MAX);
    const newest = `queue${PERSON_RUNS_PER_CAMPAIGN_MAX + 5}@example.com`;
    const [delivery] = await db.select().from(triggerEventDeliveries);
    await settleTriggerDelivery(delivery.runId, { success: true });
    expect(await wakeOccurrencesHeldBy(campaign.id)).toBe(PERSON_RUNS_PER_CAMPAIGN_MAX);
    const woken = (await db.select().from(triggerEvents)).filter((e) => e.status === "pending" && e.dueAt.getTime() <= Date.now());
    const wokenPeople = woken.map((e) => (e.detail as { person: { email: string } }).person.email).sort();
    expect(wokenPeople).toEqual([6, 7, 8, 9].map((i) => `queue${i}@example.com`));
    expect(await fireDueTriggerEvents(new Date())).toBe(1);
    expect(mockExecute.mock.calls.at(-1)![1].trigger.person.email).toBe(newest);
  });

  it("a run refused at its gate hands its slot back at once and its occurrence is owed again", async () => {
    const campaign = await meetingBooking("ongoing");
    const answer = await postEvent2("gate@example.com");
    expect(answer.body.event).toMatchObject({ status: "done", outcome: "ran" });
    const [delivery] = await db.select().from(triggerEventDeliveries);
    expect(await personRunsInFlight([campaign.id], new Date())).toHaveLength(1);

    const settled = await settleGateRefusedDelivery(delivery.runId, "A run is already in progress", new Date(), 1);
    expect(settled).toMatchObject({ kind: "requeued", eventId: answer.body.event.id });
    expect(await personRunsInFlight([campaign.id], new Date())).toHaveLength(0);
    const [event] = await db.select().from(triggerEvents).where(eq(triggerEvents.id, answer.body.event.id));
    expect(event.status).toBe("pending");
    expect(event.lastError).toContain(`${campaign.id} run_in_flight`);
    expect((event.detail as { retryCampaignIds: string[] }).retryCampaignIds).toEqual([campaign.id]);
    const [row] = await db.select().from(triggerEventDeliveries);
    expect(row.status).toBe("gate_refused");

    // Not a failed run: the next attempt runs it (not superseded, not counted toward the redelivery ceiling).
    await db.update(triggerEvents).set({ dueAt: new Date(Date.now() - 1000) }).where(eq(triggerEvents.id, event.id));
    await fireDueTriggerEvents(new Date());
    expect(mockExecute).toHaveBeenCalledTimes(2);
  });

  it("a gate refusal for a run carrying nothing settles nothing", async () => {
    expect(await settleGateRefusedDelivery(crypto.randomUUID(), "Campaign is not ongoing", new Date(), 1)).toEqual({ kind: "not_a_delivery" });
  });

  it("a person waiting does not block a different person on the same campaign", async () => {
    await meetingBooking("ongoing");
    await postEvent2("first@example.com");
    const other = await postEvent2("second@example.com");
    expect(other.body.event).toMatchObject({ status: "done", outcome: "ran" });
    expect(mockExecute).toHaveBeenCalledTimes(2);
    // workflow-service admits each run per PERSON (executionSubject), never campaign-wide.
    expect(mockExecute.mock.calls.map((c) => c[1].executionSubject)).toEqual(["email:first@example.com", "email:second@example.com"]);
  });
});

describe("the DAG's gate lets person runs run side by side (lib/gate-check.ts block 2, ONE-AI-CONVERSES-1029-QUEUE)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await cleanTestData();
  });

  const personDelivery = async (campaignId: string, email: string | null) => {
    const [event] = await db.insert(triggerEvents).values({
      orgId: ORG, brandId: BRAND, offerId: OFFER, triggerId: FORM, recordedVia: "api",
      occurredAt: new Date(), dueAt: new Date(), status: "done", outcome: "ran",
      detail: email ? { person: { email } } : { item: { x: 1 } },
    }).returning();
    const runId = crypto.randomUUID();
    await db.insert(triggerEventDeliveries).values({ eventId: event.id, campaignId, runId, status: "dispatched" });
    return runId;
  };
  const marker = (parentRunId: string | null) => ({
    id: crypto.randomUUID(), parentRunId, organizationId: ORG, userId: null, brandId: BRAND, campaignId: null,
    serviceName: "campaign-service", taskName: "c", status: "running", startedAt: new Date().toISOString(),
    completedAt: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });

  it("another person's run in flight never refuses a person run", async () => {
    const campaign = await meetingBooking("ongoing");
    const other = await personDelivery(campaign.id, "other@example.com");
    const mine = await personDelivery(campaign.id, "me@example.com");
    expect(await blockedByAnotherRun([marker(other)], mine)).toBe(false);
  });

  it("a population run in flight still refuses it, and person runs still refuse a population run", async () => {
    const campaign = await meetingBooking("ongoing");
    const person = await personDelivery(campaign.id, "me@example.com");
    const item = await personDelivery(campaign.id, null);
    expect(await blockedByAnotherRun([marker(crypto.randomUUID())], person)).toBe(true);
    expect(await blockedByAnotherRun([marker(item)], person)).toBe(true);
    expect(await blockedByAnotherRun([marker(person)], crypto.randomUUID())).toBe(true);
    expect(await blockedByAnotherRun([], crypto.randomUUID())).toBe(false);
  }, 15_000);
});

describe("a hold after a failed run never parks the queue for 10 min (ONE-AI-CONVERSES-1029-QUEUE)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await cleanTestData();
    mockCatalogue.mockResolvedValue(catalogue());
    mockFunding.mockResolvedValue({ funded: true, ceilingCents: 5000 });
    mockListRuns.mockResolvedValue({ runs: [] });
    mockResolveSlug.mockResolvedValue({ workflowSlug: "ai-meeting-booking-v1", audienceId: null });
    mockFile.mockImplementation(async (p: { email?: string }) => ({ ok: true, leadId: `lead-${p.email}`, filed: true }));
    mockDue.mockResolvedValue({ ok: true });
    mockExecute.mockImplementation(async () => ({ runId: crypto.randomUUID() }));
  });

  it("an OLD occurrence held by a failure backoff is re-checked when the backoff ends, not 10 min later", async () => {
    const campaign = await meetingBooking("ongoing");
    const failedAt = new Date();
    await db.update(campaigns).set({ consecutiveRunFailures: 5, lastRunFailureAt: failedAt }).where(eq(campaigns.id, campaign.id));
    const twoHoursAgo = new Date(Date.now() - 2 * 3600_000).toISOString();
    const res = await postEvent({ triggerId: FORM, brandId: BRAND, offerId: OFFER, person: { email: "old@example.com" }, occurredAt: twoHoursAgo, dueAt: twoHoursAgo });
    expect(res.body.event.status).toBe("pending");
    const [event] = await db.select().from(triggerEvents).where(eq(triggerEvents.id, res.body.event.id));
    expect(event.lastError).toContain(`${campaign.id} failure_backoff`);
    const skipped = (event.detail as { skipped: Array<{ retryAt?: string }> }).skipped[0];
    const end = Date.parse(skipped.retryAt!);
    expect(end).toBeGreaterThan(failedAt.getTime());
    expect(event.dueAt.getTime()).toBeLessThanOrEqual(end + 2000);
    expect(event.dueAt.getTime() - Date.now()).toBeLessThan(10 * 60_000 - 60_000);
  });

  it("a run ending wakes the occurrences a failure backoff held, newest first", async () => {
    const campaign = await meetingBooking("ongoing");
    await db.update(campaigns).set({ consecutiveRunFailures: 5, lastRunFailureAt: new Date() }).where(eq(campaigns.id, campaign.id));
    const held = await postEvent2("backoff@example.com");
    expect(held.body.event.status).toBe("pending");
    // The backoff clears (a run succeeded): the next run's end wakes it at once.
    await db.update(campaigns).set({ consecutiveRunFailures: 0 }).where(eq(campaigns.id, campaign.id));
    expect(await wakeOccurrencesHeldBy(campaign.id)).toBe(1);
    await fireDueTriggerEvents(new Date());
    const [event] = await db.select().from(triggerEvents).where(eq(triggerEvents.id, held.body.event.id));
    expect(event).toMatchObject({ status: "done", outcome: "ran" });
  });
});

describe("heldBackDueAt", () => {
  const now = new Date("2026-10-29T16:00:00Z");
  it("keeps the fixed delay when no hold states its end", () => {
    expect(heldBackDueAt([{}], now, 600_000).toISOString()).toBe("2026-10-29T16:10:00.000Z");
  });
  it("re-checks at the earliest stated end, never sooner than 5 s, never later than the fixed delay", () => {
    expect(heldBackDueAt([{ retryAt: "2026-10-29T16:02:00Z" }, {}], now, 600_000).toISOString()).toBe("2026-10-29T16:02:01.000Z");
    expect(heldBackDueAt([{ retryAt: "2026-10-29T15:00:00Z" }], now, 600_000).toISOString()).toBe("2026-10-29T16:00:05.000Z");
    expect(heldBackDueAt([{ retryAt: "2026-10-29T17:00:00Z" }], now, 600_000).toISOString()).toBe("2026-10-29T16:10:00.000Z");
  });
});

afterAll(async () => {
  await cleanTestData();
  await closeDb();
});
