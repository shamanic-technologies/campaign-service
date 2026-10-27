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
import {
  DELIVERY_SETTLE_AFTER_MS,
  TRIGGER_DELIVERY_MAX,
  deliveryOf,
  resetDeliverySettleClock,
  settleTriggerDelivery,
  settleUnreportedDeliveries,
} from "../../src/lib/trigger-deliveries.js";
import { WorkflowExecutionRefusedError } from "../../src/lib/workflow-refusal.js";

const API_KEY = process.env.CAMPAIGN_SERVICE_API_KEY || "test-api-key";
const ORG = "b645207b-0000-4000-8000-000000000031";
const BRAND = "75d7e3e8-0000-4000-8000-000000000032";
const OFFER = "231bb036-0000-4000-8000-000000000033";
const USER = "7a3b1c22-0000-4000-8000-000000000034";
const PUSHED = "email_pushed_via_api";
const LEG = "start_to_email_sent";
const POLLED = "item_polled";
const POLL_LEG = "lead_found_to_conversation";

function catalogue() {
  return {
    ok: true,
    operatorBySlug: new Map(),
    legsBySlug: new Map(),
    stepKeys: new Set(["email_sent", "lead_found", "conversation"]),
    legs: [
      { legKey: LEG, fromStepKey: null, toStepKey: "email_sent" },
      { legKey: POLL_LEG, fromStepKey: "lead_found", toStepKey: "conversation" },
    ],
    triggers: new Map([
      [PUSHED, { id: PUSHED, label: "Email Pushed Via API", fromStepKey: null, firedBy: "api-service", coded: true }],
      [POLLED, { id: POLLED, label: "Item Polled", fromStepKey: "lead_found", firedBy: "campaign-service", coded: false }],
    ]),
    triggerTransitions: [
      { featureSlug: "email-sending", legKey: LEG, triggerId: PUSHED },
      { featureSlug: "other-channel", legKey: POLL_LEG, triggerId: POLLED },
    ],
  };
}

const emailSending = () =>
  insertTestCampaign(ORG, {
    brandIds: [BRAND],
    brandId: BRAND,
    status: "ongoing",
    featureSlug: "email-sending",
    workflowSlug: "email-sending-bubup",
    createdByUserId: USER,
    parentRunId: "9f0d1c22-0000-4000-8000-000000000039",
    offerId: OFFER,
    legKey: LEG,
    salesFunnelCampaignId: crypto.randomUUID(),
    salesFunnelId: "sf-email-sending",
  });

const PERSON = { email: "jane.doe@example.com", name: "Jane Doe" };
const ITEM = { subject: "Pushed via API", bodyText: "Hi Jane,\nwritten by the client." };

const postEvent = (body: Record<string, unknown>) =>
  request(app).post("/internal/trigger-events").set("x-api-key", API_KEY).set("x-org-id", ORG).send(body);
const eventRow = async (id: string) => (await db.select().from(triggerEvents).where(eq(triggerEvents.id, id)))[0];
const deliveries = async (eventId: string) =>
  db.select().from(triggerEventDeliveries).where(eq(triggerEventDeliveries.eventId, eventId));

let runSeq = 0;
const nextRun = () => `wf-run-${++runSeq}`;

describe("an occurrence carrying something is consumed only by a run that did its work (lib/trigger-deliveries.ts)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await cleanTestData();
    mockCatalogue.mockResolvedValue(catalogue());
    mockFunding.mockResolvedValue({ funded: true, ceilingCents: 5000 });
    mockListRuns.mockResolvedValue({ runs: [] });
    mockResolveSlug.mockResolvedValue({ workflowSlug: "email-sending-bubup", audienceId: null });
    mockExecute.mockImplementation(async () => ({ runId: nextRun() }));
    mockFile.mockResolvedValue({ ok: true, leadId: "lead-jane", filed: true });
    mockDue.mockResolvedValue({ ok: true });
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("a run that FAILS (via /end-run) redelivers the occurrence to that campaign with the SAME event and item, once it recovers", async () => {
    const campaign = await emailSending();
    const res = await postEvent({ triggerId: PUSHED, brandId: BRAND, offerId: OFFER, person: PERSON, item: ITEM });
    expect(res.body.event).toMatchObject({ status: "done", outcome: "ran", ranCampaignIds: [campaign.id] });
    const eventId = res.body.event.id as string;
    const [first] = await deliveries(eventId);
    expect(first).toMatchObject({ campaignId: campaign.id, status: "dispatched" });

    // The DAG ends its run unfinished (instantly-service timed out).
    await request(app)
      .post("/end-run")
      .set({
        "x-api-key": API_KEY,
        "x-org-id": ORG,
        "x-campaign-id": campaign.id,
        "x-user-id": USER,
        "x-run-id": first.runId,
        "x-workflow-slug": "email-sending-bubup",
        "x-feature-slug": "email-sending",
      })
      .send({ success: false, stopCampaign: false })
      .expect(200);
    let pending = await eventRow(eventId);
    for (let i = 0; i < 50 && pending.status !== "pending"; i++) {
      await new Promise((r) => setTimeout(r, 50));
      pending = await eventRow(eventId);
    }
    expect(pending).toMatchObject({ status: "pending", outcome: null, ranCampaignIds: [] });
    expect((pending.detail as Record<string, unknown>).retryCampaignIds).toEqual([campaign.id]);
    expect(pending.lastError).toContain("did not complete its work");
    expect((await deliveries(eventId))[0].status).toBe("failed");

    // The campaign's failure backoff is not what is tested here.
    await db.update(campaigns).set({ consecutiveRunFailures: 0 }).where(eq(campaigns.id, campaign.id));

    // Downstream recovered: the tick redelivers it.
    expect(await fireDueTriggerEvents(new Date(pending.dueAt.getTime() + 1000))).toBe(1);
    expect(mockExecute).toHaveBeenCalledTimes(2);
    const redelivered = mockExecute.mock.calls[1][1].trigger;
    expect(redelivered).toMatchObject({ eventId, triggerId: PUSHED, item: ITEM, person: expect.objectContaining({ email: PERSON.email }) });
    expect(mockFile).toHaveBeenCalledTimes(2);
    expect(mockDue).toHaveBeenCalledTimes(2);
    const done = await eventRow(eventId);
    expect(done).toMatchObject({ status: "done", outcome: "ran", ranCampaignIds: [campaign.id] });

    // The redelivered run sends: settled, never delivered again.
    const second = (await deliveries(eventId)).find((d) => d.status === "dispatched")!;
    expect((await settleTriggerDelivery(second.runId, { success: true, stopCampaign: false })).kind).toBe("completed");
    expect(await eventRow(eventId)).toMatchObject({ status: "done", outcome: "ran" });
    expect(await fireDueTriggerEvents(new Date(Date.now() + 24 * 3_600_000))).toBe(0);
    expect(mockExecute).toHaveBeenCalledTimes(2);
  });

  it("a run that SUCCEEDED is never redelivered", async () => {
    await emailSending();
    const res = await postEvent({ triggerId: PUSHED, brandId: BRAND, offerId: OFFER, person: PERSON, item: ITEM });
    const [d] = await deliveries(res.body.event.id);
    expect((await settleTriggerDelivery(d.runId, { success: true, stopCampaign: false })).kind).toBe("completed");
    // A second end of the same run settles nothing.
    expect((await settleTriggerDelivery(d.runId, { success: false, stopCampaign: false })).kind).toBe("not_a_delivery");
    expect(await eventRow(res.body.event.id)).toMatchObject({ status: "done", outcome: "ran" });
    expect(await fireDueTriggerEvents(new Date(Date.now() + 24 * 3_600_000))).toBe(0);
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  it("a run that reports NOTHING TO DO did not deliver: redelivered", async () => {
    await emailSending();
    const res = await postEvent({ triggerId: PUSHED, brandId: BRAND, offerId: OFFER, person: PERSON, item: ITEM });
    const [d] = await deliveries(res.body.event.id);
    expect((await settleTriggerDelivery(d.runId, { success: true, stopCampaign: false, noWorkAvailable: true })).kind).toBe("redelivered");
    expect((await eventRow(res.body.event.id)).status).toBe("pending");
  });

  it(`after ${TRIGGER_DELIVERY_MAX} failed runs the occurrence is DONE failed, naming why and every run`, async () => {
    const campaign = await emailSending();
    const res = await postEvent({ triggerId: PUSHED, brandId: BRAND, offerId: OFFER, person: PERSON, item: ITEM });
    const eventId = res.body.event.id as string;
    const runIds: string[] = [];
    for (let i = 1; i <= TRIGGER_DELIVERY_MAX; i++) {
      const live = (await deliveries(eventId)).find((d) => d.status === "dispatched")!;
      runIds.push(live.runId);
      const settled = await settleTriggerDelivery(live.runId, { success: false, stopCampaign: false });
      if (i < TRIGGER_DELIVERY_MAX) {
        expect(settled.kind).toBe("redelivered");
        await db.update(campaigns).set({ consecutiveRunFailures: 0 }).where(eq(campaigns.id, campaign.id));
        const pending = await eventRow(eventId);
        expect(await fireDueTriggerEvents(new Date(pending.dueAt.getTime() + 1000))).toBe(1);
      } else {
        expect(settled.kind).toBe("gave_up");
      }
    }
    expect(mockExecute).toHaveBeenCalledTimes(TRIGGER_DELIVERY_MAX);
    const event = await eventRow(eventId);
    expect(event).toMatchObject({ status: "done", outcome: "failed", skipReason: "run_failed", ranCampaignIds: [] });
    expect(event.lastError).toContain(`all ${TRIGGER_DELIVERY_MAX} runs failed`);
    expect((event.detail as Record<string, unknown>).failedDeliveries).toEqual([
      expect.objectContaining({ campaignId: campaign.id, runIds: expect.arrayContaining(runIds) }),
    ]);
    expect(await fireDueTriggerEvents(new Date(Date.now() + 24 * 3_600_000))).toBe(0);
  });

  it("an item with no person (any trigger, e.g. a polled item) is delivered the same way", async () => {
    const campaign = await insertTestCampaign(ORG, {
      brandIds: [BRAND],
      brandId: BRAND,
      status: "ongoing",
      featureSlug: "other-channel",
      workflowSlug: "other-v1",
      createdByUserId: USER,
      parentRunId: "9f0d1c22-0000-4000-8000-000000000039",
      offerId: OFFER,
      legKey: POLL_LEG,
      salesFunnelCampaignId: crypto.randomUUID(),
      salesFunnelId: "sf-other-channel",
    });
    const res = await postEvent({ triggerId: POLLED, brandId: BRAND, offerId: OFFER, item: { id: "item-1" } });
    expect(res.body.event.ranCampaignIds).toEqual([campaign.id]);
    const [d] = await deliveries(res.body.event.id);
    expect((await settleTriggerDelivery(d.runId, { success: false, stopCampaign: false })).kind).toBe("redelivered");
  });

  it("pushed while the campaign is not funded YET: it waits, and goes out once billing says funded", async () => {
    const campaign = await emailSending();
    mockFunding.mockResolvedValueOnce({ funded: false, reason: "no ceiling yet" });
    const res = await postEvent({ triggerId: PUSHED, brandId: BRAND, offerId: OFFER, person: PERSON, item: ITEM });
    expect(res.body.event.status).toBe("pending");
    expect(res.body.event.detail.retryCampaignIds).toEqual([campaign.id]);
    expect(mockExecute).not.toHaveBeenCalled();
    expect(await fireDueTriggerEvents(new Date(new Date(res.body.event.dueAt).getTime() + 1000))).toBe(1);
    expect(await eventRow(res.body.event.id)).toMatchObject({ status: "done", outcome: "ran", ranCampaignIds: [campaign.id] });
    expect(mockExecute.mock.calls[0][1].trigger).toMatchObject({ eventId: res.body.event.id, item: ITEM });
  });

  const endRun = (campaignId: string, runId: string, body: Record<string, unknown>) =>
    request(app)
      .post("/end-run")
      .set({
        "x-api-key": API_KEY,
        "x-org-id": ORG,
        "x-campaign-id": campaignId,
        "x-user-id": USER,
        "x-run-id": runId,
        "x-workflow-slug": "email-sending-bubup",
        "x-feature-slug": "email-sending",
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
  const REFUSAL = {
    state: "refused",
    code: "recent_brand_contact",
    reason: "jane.doe@example.com was already emailed for this brand inside the re-contact window. No email was sent and nothing was billed.",
  };

  it("a SENDER REFUSAL on a run that says success:true ends the occurrence REFUSED with the reason, never ran, never redelivered", async () => {
    const campaign = await emailSending();
    const res = await postEvent({ triggerId: PUSHED, brandId: BRAND, offerId: OFFER, person: PERSON, item: ITEM });
    const eventId = res.body.event.id as string;
    // Fired, run in flight: the push answer says so (not "delivered").
    expect(res.body.event.delivery).toEqual({ state: "in_flight", refusals: [] });
    const [d] = await deliveries(eventId);

    await endRun(campaign.id, d.runId, { success: true, stopCampaign: false, delivery: REFUSAL }).expect(200);
    let event = await eventRow(eventId);
    for (let i = 0; i < 50 && event.outcome !== "refused"; i++) {
      await new Promise((r) => setTimeout(r, 50));
      event = await eventRow(eventId);
    }
    expect(event).toMatchObject({ status: "done", outcome: "refused", skipReason: "recent_brand_contact", ranCampaignIds: [] });
    expect(event.lastError).toContain(REFUSAL.reason);
    expect(await deliveries(eventId)).toEqual([
      expect.objectContaining({ status: "refused", refusalCode: "recent_brand_contact", refusalReason: REFUSAL.reason }),
    ]);
    expect(await listed(eventId)).toMatchObject({
      outcome: "refused",
      delivery: { state: "refused", refusals: [{ campaignId: campaign.id, code: "recent_brand_contact", reason: REFUSAL.reason }] },
    });
    // Zero redeliveries.
    expect(await fireDueTriggerEvents(new Date(Date.now() + 24 * 3_600_000))).toBe(0);
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  it("a refusal on a REDELIVERED run (after a transient failure) is final at once, success:false included", async () => {
    const campaign = await emailSending();
    const res = await postEvent({ triggerId: PUSHED, brandId: BRAND, offerId: OFFER, person: PERSON, item: ITEM });
    const eventId = res.body.event.id as string;
    const [first] = await deliveries(eventId);
    expect((await settleTriggerDelivery(first.runId, { success: false, stopCampaign: false })).kind).toBe("redelivered");
    expect((await listed(eventId)).delivery).toEqual({ state: "owed", refusals: [] });
    await db.update(campaigns).set({ consecutiveRunFailures: 0 }).where(eq(campaigns.id, campaign.id));
    const pending = await eventRow(eventId);
    expect(await fireDueTriggerEvents(new Date(pending.dueAt.getTime() + 1000))).toBe(1);
    const second = (await deliveries(eventId)).find((d) => d.status === "dispatched")!;
    const verdict = { state: "refused" as const, code: "email_not_verified", reason: "not sent: our verifier's verdict is invalid" };
    expect((await settleTriggerDelivery(second.runId, { success: false, stopCampaign: false, delivery: verdict })).kind).toBe("refused");
    const event = await eventRow(eventId);
    expect(event).toMatchObject({ status: "done", outcome: "refused", skipReason: "email_not_verified", ranCampaignIds: [] });
    expect((event.detail as Record<string, unknown>).retryCampaignIds).toBeUndefined();
    expect(await fireDueTriggerEvents(new Date(Date.now() + 24 * 3_600_000))).toBe(0);
    expect(mockExecute).toHaveBeenCalledTimes(2);
  });

  it("a run stating delivered reads delivered; a transient failure (no delivery) keeps the bounded redelivery", async () => {
    const campaign = await emailSending();
    const a = await postEvent({ triggerId: PUSHED, brandId: BRAND, offerId: OFFER, person: PERSON, item: ITEM, idempotencyKey: "a" });
    const [da] = await deliveries(a.body.event.id);
    await endRun(campaign.id, da.runId, { success: true, stopCampaign: false, delivery: { state: "delivered" } }).expect(200);
    let read = await listed(a.body.event.id);
    for (let i = 0; i < 50 && (read.delivery as { state: string }).state !== "delivered"; i++) {
      await new Promise((r) => setTimeout(r, 50));
      read = await listed(a.body.event.id);
    }
    expect(read).toMatchObject({ outcome: "ran", delivery: { state: "delivered", refusals: [] } });
  });

  it("/end-run refuses a malformed delivery (refused without a code)", async () => {
    const campaign = await emailSending();
    await endRun(campaign.id, "wf-run-x", { success: true, stopCampaign: false, delivery: { state: "refused", reason: "x" } }).expect(400);
  });

  it("lead-service keeping the person OFF the queue (handed to the team) = final named skip, nothing dispatched", async () => {
    await emailSending();
    mockDue.mockResolvedValue({ ok: false, code: "person_not_due", detail: "Handed to the brand's team: the automated responder could not answer this reply." });
    const res = await postEvent({ triggerId: PUSHED, brandId: BRAND, offerId: OFFER, person: PERSON, item: ITEM });
    expect(res.body.event).toMatchObject({ status: "done", outcome: "skipped", skipReason: "person_not_due", delivery: { state: "skipped" } });
    expect(mockExecute).not.toHaveBeenCalled();
    // The occurrence named the person: lead-service is told so.
    expect(mockDue.mock.calls[0][0]).toMatchObject({ statedBy: { triggerEventId: res.body.event.id, triggerId: PUSHED } });
    expect(await fireDueTriggerEvents(new Date(Date.now() + 24 * 3_600_000))).toBe(0);
  });

  it("a person the pipe does NOT admit (/end-run personNotAdmitted) is a FINAL named skip, never redelivered (REPLY-ANY-LEAD-1015)", async () => {
    const campaign = await emailSending();
    const res = await postEvent({ triggerId: PUSHED, brandId: BRAND, offerId: OFFER, person: PERSON, item: ITEM });
    const eventId = res.body.event.id as string;
    const [d] = await deliveries(eventId);
    await request(app)
      .post("/end-run")
      .set({
        "x-api-key": API_KEY,
        "x-org-id": ORG,
        "x-campaign-id": campaign.id,
        "x-user-id": USER,
        "x-run-id": d.runId,
        "x-workflow-slug": "email-sending-bubup",
        "x-feature-slug": "email-sending",
      })
      .send({ success: true, stopCampaign: false, personNotAdmitted: { reason: "relationship_personal" } })
      .expect(200);
    let event = await eventRow(eventId);
    for (let i = 0; i < 50 && event.outcome !== "skipped"; i++) {
      await new Promise((r) => setTimeout(r, 50));
      event = await eventRow(eventId);
    }
    expect(event).toMatchObject({ status: "done", outcome: "skipped", skipReason: "person_not_admitted", ranCampaignIds: [] });
    expect((event.detail as Record<string, unknown>).notAdmitted).toEqual([
      expect.objectContaining({ campaignId: campaign.id, runId: d.runId, reason: "relationship_personal" }),
    ]);
    expect((await deliveries(eventId))[0].status).toBe("not_admitted");
    expect(await fireDueTriggerEvents(new Date(Date.now() + 24 * 3_600_000))).toBe(0);
    expect(mockExecute).toHaveBeenCalledTimes(1);
    // The campaign waits on the idle cadence, it did not fail.
    const [row] = await db.select().from(campaigns).where(eq(campaigns.id, campaign.id));
    expect(row.consecutiveRunFailures ?? 0).toBe(0);
  });

  it("a not-admitted person while ANOTHER campaign ran for the occurrence keeps the outcome ran", async () => {
    const campaign = await emailSending();
    const res = await postEvent({ triggerId: PUSHED, brandId: BRAND, offerId: OFFER, person: PERSON, item: ITEM });
    const eventId = res.body.event.id as string;
    const [d] = await deliveries(eventId);
    // Another campaign (another pipe answering the same occurrence) ran for it too.
    const other = crypto.randomUUID();
    await db.update(triggerEvents).set({ ranCampaignIds: [campaign.id, other] }).where(eq(triggerEvents.id, eventId));
    expect((await settleTriggerDelivery(d.runId, { success: true, stopCampaign: false, personNotAdmitted: { reason: "relationship_customer" } })).kind).toBe("not_admitted");
    expect(await eventRow(eventId)).toMatchObject({ status: "done", outcome: "ran", skipReason: null, ranCampaignIds: [other] });
  });

  it("personNotAdmitted on a FAILED run is a failure (redelivered), never a decline", async () => {
    await emailSending();
    const res = await postEvent({ triggerId: PUSHED, brandId: BRAND, offerId: OFFER, person: PERSON, item: ITEM });
    const [d] = await deliveries(res.body.event.id);
    expect((await settleTriggerDelivery(d.runId, { success: false, personNotAdmitted: { reason: "x" } })).kind).toBe("redelivered");
  });

  it("an occurrence carrying nothing records no delivery (byte-identical to before)", async () => {
    await emailSending();
    const res = await postEvent({ triggerId: PUSHED, brandId: BRAND, offerId: OFFER });
    expect(res.body.event.outcome).toBe("ran");
    expect(res.body.event.delivery).toBeNull();
    expect(await deliveries(res.body.event.id)).toHaveLength(0);
  });

  // LEAD-EVENT-WHATSAPP-1027 (prod 2026-10-27, campaign 6c54479c): two lead_event occurrences fired in the same second
  // for one campaign; workflow-service reserved ONE run and answered the second execute with that same reservation
  // (`use_existing`, no run id yet). The second occurrence was recorded ran, no run ever carried it, nobody answered.
  it("two carrying occurrences dispatched together for ONE campaign: the one workflow-service refuses is never ran, and gets its own run next", async () => {
    const campaign = await emailSending();
    let calls = 0;
    mockExecute.mockImplementation(async () => {
      calls += 1;
      if (calls === 2) {
        throw new WorkflowExecutionRefusedError({
          workflowSlug: "email-sending-bubup",
          campaignId: campaign.id,
          status: 409,
          body: JSON.stringify({ error: "Active workflow execution already exists for this campaign" }),
        });
      }
      return { runId: nextRun() };
    });
    const OTHER = { email: "john.roe@example.com", name: "John Roe" };
    // Both pass the runs-service check (it lags the dispatch): the race only workflow-service can settle.
    const [a, b] = await Promise.all([
      postEvent({ triggerId: PUSHED, brandId: BRAND, offerId: OFFER, person: PERSON, item: ITEM }),
      postEvent({ triggerId: PUSHED, brandId: BRAND, offerId: OFFER, person: OTHER, item: ITEM }),
    ]);
    // Every trigger dispatch asks workflow-service to refuse rather than answer another run as its own.
    for (const call of mockExecute.mock.calls) expect(call[1]).toMatchObject({ conflictPolicy: "reject" });

    const rows = await Promise.all([eventRow(a.body.event.id), eventRow(b.body.event.id)]);
    const ran = rows.filter((r) => r.outcome === "ran");
    const held = rows.filter((r) => r.status === "pending");
    expect(ran).toHaveLength(1);
    expect(held).toHaveLength(1);
    const [waiting] = held;
    expect(waiting.outcome).toBeNull();
    expect(waiting.ranCampaignIds ?? []).toEqual([]);
    expect(waiting.lastError).toContain(`${campaign.id} run_in_flight`);
    expect(await deliveries(waiting.id)).toHaveLength(0);
    expect(await deliveries(ran[0].id)).toHaveLength(1);

    // The first run ends; the held occurrence gets its OWN run, carrying its own event.
    const [firstDelivery] = await deliveries(ran[0].id);
    await settleTriggerDelivery(firstDelivery.runId, { success: true });
    expect(await fireDueTriggerEvents(new Date(waiting.dueAt.getTime() + 1000))).toBe(1);
    expect(mockExecute.mock.calls[2][1].trigger).toMatchObject({ eventId: waiting.id });
    expect(await eventRow(waiting.id)).toMatchObject({ status: "done", outcome: "ran", ranCampaignIds: [campaign.id] });
    const [own] = await deliveries(waiting.id);
    expect(own).toMatchObject({ campaignId: campaign.id, status: "dispatched" });
    expect(own.runId).not.toBe(firstDelivery.runId);
  });

  it("a delivery whose run never reported does not hold a new occurrence of the same person: it runs", async () => {
    const campaign = await emailSending();
    const first = await postEvent({ triggerId: PUSHED, brandId: BRAND, offerId: OFFER, person: PERSON, item: ITEM });
    expect((await deliveries(first.body.event.id))[0].status).toBe("dispatched");
    // Its run ended without /end-run: runs-service no longer reads it alive.
    mockListRuns.mockResolvedValue({ runs: [] });
    const second = await postEvent({ triggerId: PUSHED, brandId: BRAND, offerId: OFFER, person: PERSON, item: { subject: "Again", bodyText: "Hi again" } });
    expect(second.body.event).toMatchObject({ status: "done", outcome: "ran", ranCampaignIds: [campaign.id] });
    expect(await deliveries(second.body.event.id)).toHaveLength(1);
  });

  it("a delivery whose run never reported is settled by time: redelivered while recent, timed_out (unconfirmed) when days old", async () => {
    const campaign = await emailSending();
    const recent = await postEvent({ triggerId: PUSHED, brandId: BRAND, offerId: OFFER, person: PERSON, item: ITEM });
    const old = await postEvent({ triggerId: PUSHED, brandId: BRAND, offerId: OFFER, person: { email: "old.lead@example.com" }, item: ITEM });
    const now = new Date();
    await db.update(triggerEventDeliveries)
      .set({ dispatchedAt: new Date(now.getTime() - DELIVERY_SETTLE_AFTER_MS - 60_000) })
      .where(eq(triggerEventDeliveries.eventId, recent.body.event.id));
    await db.update(triggerEventDeliveries)
      .set({ dispatchedAt: new Date(now.getTime() - 3 * 24 * 3_600_000) })
      .where(eq(triggerEventDeliveries.eventId, old.body.event.id));

    resetDeliverySettleClock();
    const settled = await settleUnreportedDeliveries(now);
    expect(settled.map((s) => s.settlement.kind).sort()).toEqual(["redelivered", "timed_out"]);
    // A second look in the same window does nothing.
    expect(await settleUnreportedDeliveries(now)).toEqual([]);

    expect((await deliveries(recent.body.event.id))[0].status).toBe("failed");
    const pending = await eventRow(recent.body.event.id);
    expect(pending).toMatchObject({ status: "pending", ranCampaignIds: [] });
    expect((pending.detail as Record<string, unknown>).retryCampaignIds).toEqual([campaign.id]);

    expect((await deliveries(old.body.event.id))[0].status).toBe("timed_out");
    expect(await eventRow(old.body.event.id)).toMatchObject({ status: "done", outcome: "ran" });
    expect(deliveryOf(await eventRow(old.body.event.id), await deliveries(old.body.event.id))?.state).toBe("unconfirmed");

    // A late /end-run of the timed-out run changes nothing.
    const [late] = await deliveries(old.body.event.id);
    expect((await settleTriggerDelivery(late.runId, { success: true })).kind).toBe("not_a_delivery");
  });
});
