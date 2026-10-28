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
import { fireDueTriggerEvents } from "../../src/lib/trigger-events.js";
import { settleTriggerDelivery } from "../../src/lib/trigger-deliveries.js";
import { PERSON_RUNS_PER_CAMPAIGN_MAX, wakeOccurrencesHeldBy } from "../../src/lib/person-runs.js";

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

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
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

  it("two occurrences about the SAME person never run at once; the second runs once the first ended", async () => {
    await meetingBooking("ongoing");
    const [a, b] = await Promise.all([postEvent2("same@example.com"), postEvent2("same@example.com")]);
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect([a.body.event.status, b.body.event.status].sort()).toEqual(["done", "pending"]);
    expect(concurrentSamePerson).toBe(false);

    const [delivery] = await db.select().from(triggerEventDeliveries);
    await settleTriggerDelivery(delivery.runId, { success: true });
    const held = a.body.event.status === "pending" ? a : b;
    await db.update(triggerEvents).set({ dueAt: new Date(Date.now() - 1000) }).where(eq(triggerEvents.id, held.body.event.id));
    expect(await fireDueTriggerEvents(new Date())).toBe(1);
    expect(mockExecute).toHaveBeenCalledTimes(2);
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
