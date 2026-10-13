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

import { eq } from "drizzle-orm";
import app from "../../src/index.js";
import { db } from "../../src/db/index.js";
import { campaigns, triggerEventDeliveries, triggerEvents } from "../../src/db/schema.js";
import { cleanTestData, closeDb, insertTestCampaign } from "../helpers/test-db.js";
import { fireDueTriggerEvents } from "../../src/lib/trigger-events.js";
import { TRIGGER_DELIVERY_MAX, settleTriggerDelivery } from "../../src/lib/trigger-deliveries.js";

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
    mockSalesBudget.mockResolvedValue({ ok: true, mode: "campaigns" });
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
    });
    const res = await postEvent({ triggerId: POLLED, brandId: BRAND, offerId: OFFER, item: { id: "item-1" } });
    expect(res.body.event.ranCampaignIds).toEqual([campaign.id]);
    const [d] = await deliveries(res.body.event.id);
    expect((await settleTriggerDelivery(d.runId, { success: false, stopCampaign: false })).kind).toBe("redelivered");
  });

  it("an occurrence carrying nothing records no delivery (byte-identical to before)", async () => {
    await emailSending();
    const res = await postEvent({ triggerId: PUSHED, brandId: BRAND, offerId: OFFER });
    expect(res.body.event.outcome).toBe("ran");
    expect(await deliveries(res.body.event.id)).toHaveLength(0);
  });
});
