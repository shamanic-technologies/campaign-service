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
import { triggerEvents } from "../../src/db/schema.js";
import { cleanTestData, closeDb, insertTestCampaign } from "../helpers/test-db.js";
import { fireDueTriggerEvents, serializeTriggerEvent } from "../../src/lib/trigger-events.js";
import { OWED_EVENT_RECHECK_MS, PERSON_NOT_KNOWN_RETRY_MS, PERSON_NOT_KNOWN_WAIT_MS } from "../../src/lib/trigger-person.js";

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

const PERSON = { email: "  Jane.Doe@Example.com ", name: "Jane Doe", phone: "+33600000000", crmContact: { provider: "gohighlevel", contactId: "ghl-123" } };
const ITEM = { formName: "Doc Dinners signup", answers: { "What do you want?": "A dinner in Paris" }, submittedAt: "2026-10-12T15:00:00.000Z" };

const postEvent = (body: Record<string, unknown>) =>
  request(app).post("/internal/trigger-events").set("x-api-key", API_KEY).set("x-org-id", ORG).send(body);
const allEvents = () => db.select().from(triggerEvents);

describe("an event naming a person by identity (lib/trigger-person.ts)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await cleanTestData();
    mockCatalogue.mockResolvedValue(catalogue());
    mockFunding.mockResolvedValue({ funded: true, ceilingCents: 5000 });
    mockListRuns.mockResolvedValue({ runs: [] });
    mockResolveSlug.mockResolvedValue({ workflowSlug: "ai-meeting-booking-v1", audienceId: null });
    mockExecute.mockResolvedValue(undefined);
    mockFile.mockResolvedValue({ ok: true, leadId: "lead-jane", filed: true });
    mockDue.mockResolvedValue({ ok: true });
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("PUSHED-PERSON-TZ-1014: the phone and a stated timezone ride the filing; an offset is refused by name, nothing written", async () => {
    const campaign = await meetingBooking("ongoing");
    const res = await postEvent({ triggerId: FORM, brandId: BRAND, offerId: OFFER, person: { email: "uk@example.com", phone: "+44 7700 900123", timezone: "America/New_York" } });
    expect(res.status).toBe(201);
    expect(res.body.event.detail.person).toMatchObject({ phone: "+44 7700 900123", timezone: "America/New_York" });
    expect(mockFile).toHaveBeenCalledWith(expect.objectContaining({ campaignId: campaign.id, phone: "+44 7700 900123", timezone: "America/New_York" }));

    mockFile.mockClear();
    const bad = await postEvent({ triggerId: FORM, brandId: BRAND, offerId: OFFER, person: { email: "x@example.com", timezone: "GMT+1" } });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).toContain("person.timezone must be an IANA timezone");
    expect(mockFile).not.toHaveBeenCalled();
    expect((await allEvents()).length).toBe(1);

    const none = await postEvent({ triggerId: FORM, brandId: BRAND, offerId: OFFER, person: { email: "n@example.com", phone: "+44 7700 900124" } });
    expect(none.status).toBe(201);
    expect("timezone" in none.body.event.detail.person).toBe(false);
    expect(mockFile).toHaveBeenCalledWith(expect.objectContaining({ phone: "+44 7700 900124", timezone: null }));
  });

  it("REPLY-PHONE-ONLY-1015: a person known only by phone + name is recorded, filed and made due BY PHONE, and reaches the pipe", async () => {
    const campaign = await meetingBooking("ongoing");
    const res = await postEvent({ triggerId: FORM, brandId: BRAND, offerId: OFFER, person: { phone: "+44 7700 900123", name: "Velveteen (WA)" }, item: ITEM });
    expect(res.status).toBe(201);
    expect(res.body.event).toMatchObject({ status: "done", outcome: "ran", ranCampaignIds: [campaign.id] });
    expect(res.body.event.detail.person).toMatchObject({ email: null, phone: "+447700900123", name: "Velveteen (WA)" });
    expect(mockFile).toHaveBeenCalledWith(expect.objectContaining({
      campaignId: campaign.id,
      email: null,
      phone: "+447700900123",
      name: "Velveteen (WA)",
      statedBy: { triggerEventId: res.body.event.id, triggerId: FORM },
    }));
    expect(mockDue).toHaveBeenCalledWith(expect.objectContaining({ campaignId: campaign.id, email: null, phone: "+447700900123" }));
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(mockExecute.mock.calls[0][1].trigger).toMatchObject({
      leadId: "lead-jane",
      person: { email: null, phone: "+447700900123", name: "Velveteen (WA)" },
    });
  });

  it("REPLY-PHONE-ONLY-1015: a person with neither email nor an E.164 phone is refused by name, nothing written", async () => {
    await meetingBooking("ongoing");
    for (const person of [{ name: "Nobody" }, { phone: "07700 900123", name: "Local number" }]) {
      const bad = await postEvent({ triggerId: FORM, brandId: BRAND, offerId: OFFER, person });
      expect(bad.status).toBe(400);
      expect(JSON.stringify(bad.body)).toContain("phone in E.164");
    }
    expect(mockFile).not.toHaveBeenCalled();
    expect(await allEvents()).toHaveLength(0);
  });

  it("a live campaign on the pipe: the person is filed and made due on it, and the workflow receives them + the item", async () => {
    const campaign = await meetingBooking("ongoing");
    const started = Date.now();
    const res = await postEvent({ triggerId: FORM, brandId: BRAND, offerId: OFFER, person: PERSON, item: ITEM, idempotencyKey: "form:sub-1" });
    console.log(`[timing] occurrence -> workflow dispatched in ${Date.now() - started} ms`);

    expect(res.status).toBe(201);
    expect(res.body.event).toMatchObject({ triggerId: FORM, step: FORM, status: "done", outcome: "ran", ranCampaignIds: [campaign.id] });
    expect(res.body.event.detail.person).toMatchObject({ email: "jane.doe@example.com", name: "Jane Doe" });
    // PUSHED-EVENT-LEAD-1014: the answer names the lead the person was filed as on each campaign that ran.
    expect(res.body.event.leadId).toBeNull();
    expect(res.body.event.ranLeads).toEqual([{ campaignId: campaign.id, leadId: "lead-jane" }]);
    const list = await request(app)
      .get(`/internal/offers/${OFFER}/trigger-events`)
      .query({ brandId: BRAND })
      .set("x-api-key", API_KEY)
      .set("x-org-id", ORG);
    expect(list.status).toBe(200);
    expect(list.body.events[0].ranLeads).toEqual([{ campaignId: campaign.id, leadId: "lead-jane" }]);
    expect(mockFile).toHaveBeenCalledWith(expect.objectContaining({ orgId: ORG, campaignId: campaign.id, email: "jane.doe@example.com" }));
    expect(mockDue).toHaveBeenCalledWith(expect.objectContaining({ orgId: ORG, campaignId: campaign.id, email: "jane.doe@example.com" }));
    expect(mockExecute).toHaveBeenCalledTimes(1);
    const inputs = mockExecute.mock.calls[0][1];
    expect(inputs.trigger).toEqual({
      eventId: res.body.event.id,
      triggerId: FORM,
      leadId: "lead-jane",
      item: ITEM,
      person: {
        email: "jane.doe@example.com",
        name: "Jane Doe",
        phone: "+33600000000",
        crmContact: { provider: "gohighlevel", contactId: "ghl-123" },
      },
    });

    // The same submission again: the first event, nothing fired twice.
    const again = await postEvent({ triggerId: FORM, brandId: BRAND, offerId: OFFER, person: PERSON, item: ITEM, idempotencyKey: "form:sub-1" });
    expect(again.status).toBe(200);
    expect(again.body.replayed).toBe(true);
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(await allEvents()).toHaveLength(1);
  });

  it("the occurrence is the org naming the person: the filing carries it as statedBy (event + trigger) and the name", async () => {
    const campaign = await meetingBooking("ongoing");
    const res = await postEvent({ triggerId: FORM, brandId: BRAND, offerId: OFFER, person: PERSON, item: ITEM });
    expect(res.body.event.outcome).toBe("ran");
    expect(mockFile).toHaveBeenCalledWith(
      expect.objectContaining({
        campaignId: campaign.id,
        email: "jane.doe@example.com",
        statedBy: { triggerEventId: res.body.event.id, triggerId: FORM },
        name: "Jane Doe",
      }),
    );
  });

  it("a stated person lead-service suppresses (unsubscribed...): skipped `person_suppressed` at once, never retried, nothing run", async () => {
    await meetingBooking("ongoing");
    mockFile.mockResolvedValueOnce({ ok: false, code: "person_suppressed", detail: "lead-service 409 unsubscribed" });
    const res = await postEvent({ triggerId: FORM, brandId: BRAND, offerId: OFFER, person: PERSON, item: ITEM });
    expect(res.status).toBe(201);
    expect(res.body.event).toMatchObject({ status: "done", outcome: "skipped", skipReason: "person_suppressed" });
    expect(mockDue).not.toHaveBeenCalled();
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("a stopped campaign: recorded skipped `campaign_off`, nobody filed, nothing run", async () => {
    await meetingBooking("stopped");
    const res = await postEvent({ triggerId: FORM, brandId: BRAND, offerId: OFFER, person: PERSON, item: ITEM });
    expect(res.status).toBe(201);
    expect(res.body.event).toMatchObject({ status: "done", outcome: "skipped", skipReason: "campaign_off" });
    expect(mockFile).not.toHaveBeenCalled();
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("a person the brand does not know yet: the event waits on a short retry, then runs once they are known", async () => {
    const campaign = await meetingBooking("ongoing");
    mockFile.mockResolvedValueOnce({ ok: false, code: "person_not_known", detail: "lead-service 404" });
    const res = await postEvent({ triggerId: FORM, brandId: BRAND, offerId: OFFER, person: PERSON, item: ITEM });
    expect(res.status).toBe(201);
    expect(res.body.event.status).toBe("pending");
    const due = new Date(res.body.event.dueAt).getTime();
    expect(due - Date.now()).toBeGreaterThan(PERSON_NOT_KNOWN_RETRY_MS - 10_000);
    expect(mockExecute).not.toHaveBeenCalled();

    expect(await fireDueTriggerEvents(new Date(due + 1000))).toBe(1);
    const [event] = await allEvents();
    expect(event).toMatchObject({ status: "done", outcome: "ran", ranCampaignIds: [campaign.id] });
    expect(mockExecute.mock.calls[0][1].trigger).toMatchObject({ leadId: "lead-jane", item: ITEM });
  });

  it("a run of the campaign in flight: nobody is made due, the event retries, and its OWN run carries the person", async () => {
    const campaign = await meetingBooking("ongoing");
    mockListRuns.mockResolvedValueOnce({ runs: [{ id: "run-live", status: "running" }] });
    const res = await postEvent({ triggerId: FORM, brandId: BRAND, offerId: OFFER, person: PERSON, item: ITEM });
    expect(res.body.event.status).toBe("pending");
    expect(mockFile).not.toHaveBeenCalled();
    expect(mockDue).not.toHaveBeenCalled();
    expect(mockExecute).not.toHaveBeenCalled();

    expect(await fireDueTriggerEvents(new Date(new Date(res.body.event.dueAt).getTime() + 1000))).toBe(1);
    const [event] = await allEvents();
    expect(event).toMatchObject({ status: "done", outcome: "ran", ranCampaignIds: [campaign.id] });
    expect(mockDue).toHaveBeenCalledTimes(1);
    expect(mockExecute.mock.calls[0][1].trigger).toMatchObject({ leadId: "lead-jane", item: ITEM, person: { email: "jane.doe@example.com" } });
  });

  it("a campaign in failure backoff: nobody is made due and the event retries instead of recording a skip", async () => {
    const campaign = await meetingBooking("ongoing");
    const { db: d } = await import("../../src/db/index.js");
    const { campaigns } = await import("../../src/db/schema.js");
    const { eq } = await import("drizzle-orm");
    await d.update(campaigns).set({
      consecutiveRunFailures: 4,
      lastRunFailureAt: new Date(),
      nextRunAt: new Date(Date.now() + 5 * 60_000),
    }).where(eq(campaigns.id, campaign.id));
    const res = await postEvent({ triggerId: FORM, brandId: BRAND, offerId: OFFER, person: PERSON, item: ITEM });
    expect(res.body.event.status).toBe("pending");
    expect(mockFile).not.toHaveBeenCalled();
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("a your-team campaign beside a held-back AI campaign: the event retries for the AI one only", async () => {
    const yourTeam = await insertTestCampaign(ORG, {
      brandIds: [BRAND], brandId: BRAND, status: "ongoing", featureSlug: "your-team-meeting-booking",
      createdByUserId: USER, offerId: OFFER, legKey: LEG, salesFunnelCampaignId: crypto.randomUUID(), salesFunnelId: "sf-form",
    });
    const { campaigns } = await import("../../src/db/schema.js");
    const { eq } = await import("drizzle-orm");
    await db.update(campaigns).set({ workflowSlug: null }).where(eq(campaigns.id, yourTeam.id));
    const ai = await meetingBooking("ongoing");
    mockListRuns.mockImplementation(async (p: { campaignId?: string }) => ({ runs: p.campaignId === ai.id ? [{ id: "run-live" }] : [] }));
    const res = await postEvent({ triggerId: FORM, brandId: BRAND, offerId: OFFER, person: PERSON, item: ITEM });
    expect(res.body.event.status).toBe("pending");
    expect(res.body.event.detail.retryCampaignIds).toEqual([ai.id]);
    expect(res.body.event.detail.skipped.map((x: { reason: string }) => x.reason).sort()).toEqual(["no_workflow", "run_in_flight"]);

    mockListRuns.mockResolvedValue({ runs: [] });
    expect(await fireDueTriggerEvents(new Date(new Date(res.body.event.dueAt).getTime() + 1000))).toBe(1);
    const [event] = await allEvents();
    expect(event).toMatchObject({ status: "done", outcome: "ran", ranCampaignIds: [ai.id] });
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect((event.detail as Record<string, unknown>).retryCampaignIds).toBeUndefined();
  });

  it("one campaign ran, another was held back: the retry asks only the held-back one, and both count as ran", async () => {
    const first = await meetingBooking("ongoing");
    const second = await insertTestCampaign(ORG, {
      brandIds: [BRAND], brandId: BRAND, status: "ongoing", featureSlug: "other-meeting-booking",
      workflowSlug: "other-v1", createdByUserId: USER, parentRunId: "9f0d1c22-0000-4000-8000-000000000030", offerId: OFFER, legKey: LEG,
      salesFunnelCampaignId: crypto.randomUUID(), salesFunnelId: "sf-form",
    });
    mockListRuns.mockImplementation(async (p: { campaignId?: string }) => ({ runs: p.campaignId === second.id ? [{ id: "run-live" }] : [] }));
    mockFile.mockImplementation(async (p: { campaignId: string }) => ({ ok: true, leadId: `lead-${p.campaignId}`, filed: true }));
    const res = await postEvent({ triggerId: FORM, brandId: BRAND, offerId: OFFER, person: PERSON, item: ITEM });
    expect(res.body.event.status).toBe("pending");
    expect(res.body.event.ranLeads).toEqual([{ campaignId: first.id, leadId: `lead-${first.id}` }]);
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(mockExecute.mock.calls[0][1].campaignId).toBe(first.id);

    mockListRuns.mockResolvedValue({ runs: [] });
    expect(await fireDueTriggerEvents(new Date(new Date(res.body.event.dueAt).getTime() + 1000))).toBe(1);
    expect(mockExecute).toHaveBeenCalledTimes(2);
    expect(mockExecute.mock.calls[1][1].campaignId).toBe(second.id);
    const [event] = await allEvents();
    expect(event.status).toBe("done");
    expect(event.outcome).toBe("ran");
    expect([...(event.ranCampaignIds ?? [])].sort()).toEqual([first.id, second.id].sort());
    // Each campaign's lead is kept across attempts (the retry's own runs name only the second).
    expect(serializeTriggerEvent(event).ranLeads.sort((a, b) => a.campaignId.localeCompare(b.campaignId))).toEqual(
      [first.id, second.id].sort().map((id) => ({ campaignId: id, leadId: `lead-${id}` })),
    );
  });

  it("still unknown after the wait: recorded skipped `person_not_known`", async () => {
    await meetingBooking("ongoing");
    mockFile.mockResolvedValue({ ok: false, code: "person_not_known", detail: "lead-service 404" });
    const occurredAt = new Date(Date.now() - PERSON_NOT_KNOWN_WAIT_MS - 60_000).toISOString();
    const res = await postEvent({ triggerId: FORM, brandId: BRAND, offerId: OFFER, person: PERSON, occurredAt, dueAt: occurredAt });
    expect(res.body.event).toMatchObject({ status: "done", outcome: "skipped", skipReason: "person_not_known" });
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("NEVER-NO-FOLLOWUP-1014: a future-dated occurrence fires at its date on the live unit, the person due on it and named on /execute", async () => {
    const campaign = await meetingBooking("ongoing");
    const dueAt = new Date(Date.now() + 3 * 24 * 3600_000);
    const res = await postEvent({ triggerId: FORM, brandId: BRAND, offerId: OFFER, person: PERSON, dueAt: dueAt.toISOString(), idempotencyKey: "followup:send-1" });
    expect(res.status).toBe(201);
    expect(res.body.event.status).toBe("pending");
    expect(mockFile).not.toHaveBeenCalled();

    // At its date a run of the unit is in flight: held, not given up although it was RECORDED 3 days earlier.
    mockListRuns.mockResolvedValueOnce({ runs: [{ id: "run-live", status: "running" }] });
    expect(await fireDueTriggerEvents(new Date(dueAt.getTime() + 1000))).toBe(0);
    let [event] = await allEvents();
    expect(event.status).toBe("pending");
    expect(event.dueAt.getTime() - dueAt.getTime()).toBeLessThanOrEqual(PERSON_NOT_KNOWN_RETRY_MS + 1000);

    expect(await fireDueTriggerEvents(new Date(event.dueAt.getTime() + 1000))).toBe(1);
    [event] = await allEvents();
    expect(event).toMatchObject({ status: "done", outcome: "ran", ranCampaignIds: [campaign.id] });
    expect(mockDue).toHaveBeenCalledWith(expect.objectContaining({ campaignId: campaign.id, email: "jane.doe@example.com" }));
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(mockExecute.mock.calls[0][1].trigger).toMatchObject({ eventId: event.id, leadId: "lead-jane", person: { email: "jane.doe@example.com" } });
  });

  it("NEVER-NO-FOLLOWUP-1014: a campaign without room long past the hour keeps the occurrence pending, then fires it once when room returns", async () => {
    const campaign = await meetingBooking("ongoing");
    mockFunding.mockResolvedValue({ funded: false, kind: "cap_reached", reason: "cap reached for the month" });
    const longAgo = new Date(Date.now() - 5 * PERSON_NOT_KNOWN_WAIT_MS).toISOString();
    const res = await postEvent({ triggerId: FORM, brandId: BRAND, offerId: OFFER, person: PERSON, occurredAt: longAgo, dueAt: longAgo });
    expect(res.body.event.status).toBe("pending");
    expect(res.body.event.detail.retryCampaignIds).toEqual([campaign.id]);
    const retryIn = new Date(res.body.event.dueAt).getTime() - Date.now();
    expect(retryIn).toBeGreaterThan(OWED_EVENT_RECHECK_MS - 10_000);
    expect(mockFile).not.toHaveBeenCalled();
    expect(mockExecute).not.toHaveBeenCalled();

    // Still no room on the next try: still pending.
    expect(await fireDueTriggerEvents(new Date(Date.now() + OWED_EVENT_RECHECK_MS + 1000))).toBe(0);
    let [event] = await allEvents();
    expect(event.status).toBe("pending");

    // Room returns (period rolled over): fired once, never again.
    mockFunding.mockResolvedValue({ funded: true, ceilingCents: 5000 });
    expect(await fireDueTriggerEvents(new Date(event.dueAt.getTime() + 1000))).toBe(1);
    [event] = await allEvents();
    expect(event).toMatchObject({ status: "done", outcome: "ran", ranCampaignIds: [campaign.id] });
    expect(await fireDueTriggerEvents(new Date(Date.now() + 24 * 3600_000))).toBe(0);
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  it("NEVER-NO-FOLLOWUP-1014: an occurrence held for money whose campaign the customer turns Off is done `campaign_off`, nothing run", async () => {
    const campaign = await meetingBooking("ongoing");
    mockFunding.mockResolvedValue({ funded: false, kind: "cap_reached", reason: "cap reached" });
    const res = await postEvent({ triggerId: FORM, brandId: BRAND, offerId: OFFER, person: PERSON });
    expect(res.body.event.status).toBe("pending");
    const { campaigns } = await import("../../src/db/schema.js");
    const { eq } = await import("drizzle-orm");
    await db.update(campaigns).set({ status: "stopped" }).where(eq(campaigns.id, campaign.id));
    mockFunding.mockResolvedValue({ funded: true, ceilingCents: 5000 });
    expect(await fireDueTriggerEvents(new Date(new Date(res.body.event.dueAt).getTime() + 1000))).toBe(1);
    const [event] = await allEvents();
    expect(event).toMatchObject({ status: "done", outcome: "skipped", skipReason: "campaign_off" });
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("a person with no email address is a 400 and records nothing", async () => {
    const res = await postEvent({ triggerId: FORM, brandId: BRAND, offerId: OFFER, person: { name: "Jane" } });
    expect(res.status).toBe(400);
    expect(await allEvents()).toHaveLength(0);
  });
});
