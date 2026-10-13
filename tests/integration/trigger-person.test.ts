import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";

const { mockExecute, mockCatalogue, mockFunding, mockListRuns, mockResolveSlug, mockSalesBudget, mockGetStatsBudget, mockFile, mockDue } =
  vi.hoisted(() => ({
    mockSalesBudget: vi.fn(),
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
vi.mock("../../src/lib/brand-sales-budget-client.js", () => ({ fetchBrandSalesBudget: mockSalesBudget }));
vi.mock("../../src/lib/workflows.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/lib/workflows.js")>();
  return { ...original, executeCampaignWorkflow: mockExecute };
});
vi.mock("../../src/lib/channel-operator-client.js", () => ({ fetchChannelCatalogue: mockCatalogue }));
vi.mock("../../src/lib/campaign-funding.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/lib/campaign-funding.js")>();
  return { ...original, campaignFunding: mockFunding };
});
vi.mock("../../src/lib/features-workflow-projection-client.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/lib/features-workflow-projection-client.js")>();
  return { ...original, resolveSelectionForTrigger: mockResolveSlug };
});
vi.mock("../../src/lib/sales-funnel-people.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/lib/sales-funnel-people.js")>();
  return { ...original, fileNamedPerson: mockFile, scheduleNamedPersonDue: mockDue };
});

import app from "../../src/index.js";
import { db } from "../../src/db/index.js";
import { triggerEvents } from "../../src/db/schema.js";
import { cleanTestData, closeDb, insertTestCampaign } from "../helpers/test-db.js";
import { fireDueTriggerEvents } from "../../src/lib/trigger-events.js";
import { PERSON_NOT_KNOWN_RETRY_MS, PERSON_NOT_KNOWN_WAIT_MS } from "../../src/lib/trigger-person.js";

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
    mockSalesBudget.mockResolvedValue({ ok: true, mode: "campaigns" });
    mockFile.mockResolvedValue({ ok: true, leadId: "lead-jane", filed: true });
    mockDue.mockResolvedValue({ ok: true });
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("a live campaign on the pipe: the person is filed and made due on it, and the workflow receives them + the item", async () => {
    const campaign = await meetingBooking("ongoing");
    const started = Date.now();
    const res = await postEvent({ triggerId: FORM, brandId: BRAND, offerId: OFFER, person: PERSON, item: ITEM, idempotencyKey: "form:sub-1" });
    console.log(`[timing] occurrence -> workflow dispatched in ${Date.now() - started} ms`);

    expect(res.status).toBe(201);
    expect(res.body.event).toMatchObject({ triggerId: FORM, step: FORM, status: "done", outcome: "ran", ranCampaignIds: [campaign.id] });
    expect(res.body.event.detail.person).toMatchObject({ email: "jane.doe@example.com", name: "Jane Doe" });
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
      createdByUserId: USER, offerId: OFFER, legKey: LEG,
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
    });
    mockListRuns.mockImplementation(async (p: { campaignId?: string }) => ({ runs: p.campaignId === second.id ? [{ id: "run-live" }] : [] }));
    const res = await postEvent({ triggerId: FORM, brandId: BRAND, offerId: OFFER, person: PERSON, item: ITEM });
    expect(res.body.event.status).toBe("pending");
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
  });

  it("still unknown after the wait: recorded skipped `person_not_known`", async () => {
    await meetingBooking("ongoing");
    mockFile.mockResolvedValue({ ok: false, code: "person_not_known", detail: "lead-service 404" });
    const occurredAt = new Date(Date.now() - PERSON_NOT_KNOWN_WAIT_MS - 60_000).toISOString();
    const res = await postEvent({ triggerId: FORM, brandId: BRAND, offerId: OFFER, person: PERSON, occurredAt, dueAt: occurredAt });
    expect(res.body.event).toMatchObject({ status: "done", outcome: "skipped", skipReason: "person_not_known" });
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("a person with no email address is a 400 and records nothing", async () => {
    const res = await postEvent({ triggerId: FORM, brandId: BRAND, offerId: OFFER, person: { name: "Jane" } });
    expect(res.status).toBe(400);
    expect(await allEvents()).toHaveLength(0);
  });
});
