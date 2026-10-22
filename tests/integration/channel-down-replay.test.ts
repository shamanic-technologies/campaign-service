import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";

const { mockExecute, mockCatalogue, mockListRuns, mockResolveSlug, mockGetStatsBudget, mockFile, mockDue, mockJev } =
  vi.hoisted(() => ({
    mockGetStatsBudget: vi.fn(),
    mockExecute: vi.fn(),
    mockCatalogue: vi.fn(),
    mockListRuns: vi.fn(),
    mockResolveSlug: vi.fn(),
    mockFile: vi.fn(),
    mockDue: vi.fn(),
    mockJev: vi.fn(),
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
vi.mock("../../src/lib/sales-funnel-campaigns.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/lib/sales-funnel-campaigns.js")>();
  return { ...original, salesFunnelUnitMoney: async () => ({ run: true, pace: { spentCents: 0, ceilingCents: 5000 } }) };
});
vi.mock("../../src/lib/sales-funnel-people.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/lib/sales-funnel-people.js")>();
  return { ...original, fileNamedPerson: mockFile, scheduleNamedPersonDue: mockDue };
});
vi.mock("../../src/lib/jev-client.js", () => ({ judgeNoul: mockJev }));

import { eq } from "drizzle-orm";
import app from "../../src/index.js";
import { db } from "../../src/db/index.js";
import { triggerEventDeliveries, triggerEvents } from "../../src/db/schema.js";
import { cleanTestData, closeDb, insertTestCampaign } from "../helpers/test-db.js";
import { fireDueTriggerEvents } from "../../src/lib/trigger-events.js";
import { settleTriggerDelivery } from "../../src/lib/trigger-deliveries.js";
import {
  CHANNEL_DOWN_REPLAY_DELAYS_MS,
  CHANNEL_DOWN_REPLAY_MAX_AGE_MS,
  CHANNEL_UNAVAILABLE_HOLD,
  hastenReplaysOnChannelBack,
  judgeRefusals,
  replayChannelDownRefusals,
  resetChannelDownSweepClock,
  scheduleChannelDownReplays,
  waitsOnlyOnChannel,
} from "../../src/lib/channel-down-replay.js";

const API_KEY = process.env.CAMPAIGN_SERVICE_API_KEY || "test-api-key";
const ORG = "b645207b-0000-4000-8000-000000000041";
const BRAND = "75d7e3e8-0000-4000-8000-000000000042";
const OFFER = "231bb036-0000-4000-8000-000000000043";
const USER = "7a3b1c22-0000-4000-8000-000000000044";
const GIVEN = "whatsapp_number_given";
const LEG = "start_to_signup";

function catalogue() {
  return {
    ok: true,
    operatorBySlug: new Map(),
    legsBySlug: new Map(),
    stepKeys: new Set(["signup"]),
    legs: [{ legKey: LEG, fromStepKey: null, toStepKey: "signup" }],
    triggers: new Map([[GIVEN, { id: GIVEN, label: "WhatsApp Number Given", fromStepKey: null, firedBy: "crm-service", coded: true }]]),
    triggerTransitions: [{ featureSlug: "cold-whatsapp-outreach", legKey: LEG, triggerId: GIVEN }],
  };
}

const answering = () =>
  insertTestCampaign(ORG, {
    brandIds: [BRAND],
    brandId: BRAND,
    status: "ongoing",
    featureSlug: "cold-whatsapp-outreach",
    workflowSlug: "cold-whatsapp-outreach-zaurak",
    createdByUserId: USER,
    parentRunId: "9f0d1c22-0000-4000-8000-000000000049",
    offerId: OFFER,
    legKey: LEG,
    salesFunnelCampaignId: crypto.randomUUID(),
    salesFunnelId: "sf-whatsapp",
  });

const PERSON = { name: "Jeremy", phone: "+15555550123" };
const ITEM = { kind: "phone_given", phone: "+15555550123", firstName: "Jeremy" };
// What crm-service answers while the brand's WhatsApp is logged out (verbatim shape of prod's refusal).
const CHANNEL_DOWN = {
  state: "refused" as const,
  code: "whatsapp_not_connected",
  reason: "WhatsApp logged out +15555550100 at 2026-10-19 14:39 UTC. Relink it from the Integrations page.",
};
const ABOUT_THE_PERSON = {
  state: "refused" as const,
  code: "human_in_conversation",
  reason: "Someone of the brand wrote to +15555550123 by hand on WhatsApp: the conversation is theirs.",
};

const postEvent = (body: Record<string, unknown>) =>
  request(app).post("/internal/trigger-events").set("x-api-key", API_KEY).set("x-org-id", ORG).send(body);
const eventRow = async (id: string) => (await db.select().from(triggerEvents).where(eq(triggerEvents.id, id)))[0];
const deliveries = async (eventId: string) =>
  (await db.select().from(triggerEventDeliveries).where(eq(triggerEventDeliveries.eventId, eventId))).sort(
    (a, b) => a.dispatchedAt.getTime() - b.dispatchedAt.getTime(),
  );
const dispatched = async (eventId: string) => (await deliveries(eventId)).find((d) => d.status === "dispatched")!;
const minutes = (m: number) => m * 60_000;

let runSeq = 0;
const nextRun = () => `wa-run-${++runSeq}`;

/** Jev, as the test states it: only a refusal about the sender's channel is "channel down". */
const jevSays = (state: { refusalCode: string }) => Promise.resolve(state.refusalCode === CHANNEL_DOWN.code ? 0.97 : 0.03);

async function refusedOccurrence(refusal: typeof CHANNEL_DOWN | typeof ABOUT_THE_PERSON, at: Date) {
  const campaign = await answering();
  const res = await postEvent({ triggerId: GIVEN, brandId: BRAND, offerId: OFFER, person: PERSON, item: ITEM });
  expect(res.body).toMatchObject({ event: expect.anything() });
  const eventId = res.body.event.id as string;
  const d = await dispatched(eventId);
  expect((await settleTriggerDelivery(d.runId, { success: true, stopCampaign: false, delivery: refusal }, at)).kind).toBe("refused");
  expect(await eventRow(eventId)).toMatchObject({ status: "done", outcome: "refused", skipReason: refusal.code });
  return { campaign, eventId };
}

describe("a refusal that only means the channel was unavailable is replayed once it is back (lib/channel-down-replay.ts)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await cleanTestData();
    resetChannelDownSweepClock();
    mockCatalogue.mockResolvedValue(catalogue());
    mockListRuns.mockResolvedValue({ runs: [] });
    mockResolveSlug.mockResolvedValue({ workflowSlug: "cold-whatsapp-outreach-zaurak", audienceId: null });
    mockExecute.mockImplementation(async () => ({ runId: nextRun() }));
    mockFile.mockResolvedValue({ ok: true, leadId: "lead-jeremy", filed: true });
    mockDue.mockResolvedValue({ ok: true });
    mockJev.mockImplementation(jevSays);
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("refused for channel down: owed again, replayed after its delay, refused again while still down, delivered once the channel is back", async () => {
    const t0 = new Date();
    const { campaign, eventId } = await refusedOccurrence(CHANNEL_DOWN, t0);

    // Judged once, then put back pending for that campaign only, due after the first delay.
    const sweep = await replayChannelDownRefusals(t0);
    expect(sweep?.judged).toBe(1);
    expect(sweep?.scheduled).toEqual([{ eventId, campaignId: campaign.id, dueAt: new Date(t0.getTime() + CHANNEL_DOWN_REPLAY_DELAYS_MS[0]) }]);
    let event = await eventRow(eventId);
    expect(event).toMatchObject({ status: "pending", outcome: null, skipReason: null });
    expect(event.lastError).toContain(`${campaign.id} ${CHANNEL_UNAVAILABLE_HOLD} (whatsapp_not_connected)`);
    expect((event.detail as Record<string, unknown>).retryCampaignIds).toEqual([campaign.id]);
    expect((await deliveries(eventId))[0]).toMatchObject({ replayState: "scheduled" });
    expect(mockJev).toHaveBeenCalledTimes(1);
    expect(mockJev.mock.calls[0][0]).toEqual({ refusalCode: CHANNEL_DOWN.code, refusalSentence: CHANNEL_DOWN.reason });

    // Not before its delay.
    expect(await fireDueTriggerEvents(new Date(t0.getTime() + minutes(5)))).toBe(0);
    expect(mockExecute).toHaveBeenCalledTimes(1);

    // Replayed: a second run carrying the SAME event; the channel is still down, refused again.
    const t1 = new Date(t0.getTime() + CHANNEL_DOWN_REPLAY_DELAYS_MS[0] + 1000);
    expect(await fireDueTriggerEvents(t1)).toBe(1);
    expect(mockExecute).toHaveBeenCalledTimes(2);
    expect(mockExecute.mock.calls[1][1].trigger).toMatchObject({ eventId, triggerId: GIVEN, item: ITEM, person: expect.objectContaining({ phone: PERSON.phone }) });
    const second = await dispatched(eventId);
    await settleTriggerDelivery(second.runId, { success: true, stopCampaign: false, delivery: CHANNEL_DOWN }, t1);

    // Same refusal text: Jev is not asked again; the next replay waits the second delay.
    resetChannelDownSweepClock();
    const sweep2 = await replayChannelDownRefusals(t1);
    expect(mockJev).toHaveBeenCalledTimes(1);
    expect(sweep2?.scheduled).toEqual([{ eventId, campaignId: campaign.id, dueAt: new Date(t1.getTime() + CHANNEL_DOWN_REPLAY_DELAYS_MS[1]) }]);

    // The channel is back: the replay delivers, the occurrence reads delivered.
    const t2 = new Date(t1.getTime() + CHANNEL_DOWN_REPLAY_DELAYS_MS[1] + 1000);
    expect(await fireDueTriggerEvents(t2)).toBe(1);
    const third = await dispatched(eventId);
    expect((await settleTriggerDelivery(third.runId, { success: true, stopCampaign: false, delivery: { state: "delivered" } }, t2)).kind).toBe("completed");
    event = await eventRow(eventId);
    expect(event).toMatchObject({ status: "done", outcome: "ran", ranCampaignIds: [campaign.id] });
    const read = await request(app)
      .get(`/internal/offers/${OFFER}/trigger-events?brandId=${BRAND}`)
      .set("x-api-key", API_KEY)
      .set("x-org-id", ORG)
      .expect(200);
    expect((read.body.events as Array<Record<string, unknown>>).find((e) => e.id === eventId)).toMatchObject({ delivery: { state: "delivered" } });

    // Nothing more to replay.
    resetChannelDownSweepClock();
    expect((await replayChannelDownRefusals(new Date(t2.getTime() + 86_400_000)))?.scheduled).toEqual([]);
    expect(await fireDueTriggerEvents(new Date(t2.getTime() + 86_400_000))).toBe(0);
    expect(mockExecute).toHaveBeenCalledTimes(3);
  });

  it("refused for any other reason: judged final, never replayed", async () => {
    const t0 = new Date();
    const { eventId } = await refusedOccurrence(ABOUT_THE_PERSON, t0);
    const sweep = await replayChannelDownRefusals(t0);
    expect(sweep).toMatchObject({ judged: 1, scheduled: [] });
    expect((await deliveries(eventId))[0]).toMatchObject({ replayState: "final" });
    expect(await eventRow(eventId)).toMatchObject({ status: "done", outcome: "refused", skipReason: "human_in_conversation" });
    resetChannelDownSweepClock();
    await replayChannelDownRefusals(new Date(t0.getTime() + 86_400_000));
    expect(await fireDueTriggerEvents(new Date(t0.getTime() + 86_400_000))).toBe(0);
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(mockJev).toHaveBeenCalledTimes(1);
  });

  it("a replay whose person opted out meanwhile is skipped `person_suppressed`, nothing dispatched", async () => {
    const t0 = new Date();
    const { eventId } = await refusedOccurrence(CHANNEL_DOWN, t0);
    await replayChannelDownRefusals(t0);
    mockFile.mockResolvedValueOnce({ ok: false, code: "person_suppressed", detail: "lead-service 409 opt_out" });
    expect(await fireDueTriggerEvents(new Date(t0.getTime() + CHANNEL_DOWN_REPLAY_DELAYS_MS[0] + 1000))).toBe(1);
    expect(await eventRow(eventId)).toMatchObject({ status: "done", outcome: "skipped", skipReason: "person_suppressed" });
    expect(mockExecute).toHaveBeenCalledTimes(1);
    // Never replayed again: the refusal was already acted on.
    resetChannelDownSweepClock();
    expect((await replayChannelDownRefusals(new Date(t0.getTime() + 86_400_000)))?.scheduled).toEqual([]);
  });

  it("a replay whose person someone of the brand already took over is skipped `person_not_due`, nothing dispatched", async () => {
    const t0 = new Date();
    const { eventId } = await refusedOccurrence(CHANNEL_DOWN, t0);
    await replayChannelDownRefusals(t0);
    mockDue.mockResolvedValueOnce({ ok: false, code: "person_not_due", detail: "Handed to the brand's team: they already wrote to this person." });
    expect(await fireDueTriggerEvents(new Date(t0.getTime() + CHANNEL_DOWN_REPLAY_DELAYS_MS[0] + 1000))).toBe(1);
    expect(await eventRow(eventId)).toMatchObject({ status: "done", outcome: "skipped", skipReason: "person_not_due" });
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  it("a replay the workflow refuses for a person reason (they paid, someone wrote to them) ends final with that reason", async () => {
    const t0 = new Date();
    const { eventId } = await refusedOccurrence(CHANNEL_DOWN, t0);
    await replayChannelDownRefusals(t0);
    const t1 = new Date(t0.getTime() + CHANNEL_DOWN_REPLAY_DELAYS_MS[0] + 1000);
    expect(await fireDueTriggerEvents(t1)).toBe(1);
    await settleTriggerDelivery((await dispatched(eventId)).runId, { success: true, stopCampaign: false, delivery: ABOUT_THE_PERSON }, t1);
    expect(await eventRow(eventId)).toMatchObject({ status: "done", outcome: "refused", skipReason: "human_in_conversation" });
    resetChannelDownSweepClock();
    expect((await replayChannelDownRefusals(new Date(t1.getTime() + 86_400_000)))?.scheduled).toEqual([]);
    expect(await fireDueTriggerEvents(new Date(t1.getTime() + 86_400_000))).toBe(0);
    expect(mockExecute).toHaveBeenCalledTimes(2);
  });

  it("a waiting replay fires NOW once another run of the same campaign delivered (the channel works again)", async () => {
    const t0 = new Date();
    const { campaign, eventId } = await refusedOccurrence(CHANNEL_DOWN, t0);
    // Push the replay far: several refusals already.
    await replayChannelDownRefusals(t0);
    await db.update(triggerEvents).set({ dueAt: new Date(t0.getTime() + minutes(240)) }).where(eq(triggerEvents.id, eventId));
    expect(await hastenReplaysOnChannelBack(new Date(t0.getTime() + minutes(1)))).toEqual([]);
    // Another occurrence of the same campaign goes out.
    await db.insert(triggerEventDeliveries).values({
      eventId: crypto.randomUUID(), campaignId: campaign.id, runId: "other-run", status: "completed", endedAt: new Date(t0.getTime() + minutes(2)),
    });
    const now = new Date(t0.getTime() + minutes(3));
    expect(await hastenReplaysOnChannelBack(now)).toEqual([eventId]);
    expect((await eventRow(eventId)).dueAt.getTime()).toBe(now.getTime());
  });

  it(`a channel still down ${CHANNEL_DOWN_REPLAY_MAX_AGE_MS / 86_400_000} days after the first refusal is given up: stays refused`, async () => {
    const t0 = new Date();
    const { eventId } = await refusedOccurrence(CHANNEL_DOWN, t0);
    await judgeRefusals(t0);
    const later = new Date(t0.getTime() + CHANNEL_DOWN_REPLAY_MAX_AGE_MS + 1000);
    expect(await scheduleChannelDownReplays(later)).toEqual({ scheduled: [], expired: 1 });
    expect((await deliveries(eventId))[0]).toMatchObject({ replayState: "expired" });
    expect(await eventRow(eventId)).toMatchObject({ status: "done", outcome: "refused" });
  });

  it("Jev unreachable: nothing judged, nothing replayed on a guess; judged on a later sweep", async () => {
    const t0 = new Date();
    const { eventId } = await refusedOccurrence(CHANNEL_DOWN, t0);
    mockJev.mockRejectedValueOnce(new Error("chat-service 503"));
    expect(await replayChannelDownRefusals(t0)).toMatchObject({ judged: 0, scheduled: [] });
    expect((await deliveries(eventId))[0]).toMatchObject({ channelDownJudgedAt: null, replayState: null });
    expect(await eventRow(eventId)).toMatchObject({ status: "done", outcome: "refused" });
    resetChannelDownSweepClock();
    expect((await replayChannelDownRefusals(new Date(t0.getTime() + minutes(3))))?.scheduled).toHaveLength(1);
  });

  it("the stuck-occurrence alert stays quiet for an occurrence waiting only on its channel", () => {
    expect(waitsOnlyOnChannel(`b645207b-0000-4000-8000-000000000041 ${CHANNEL_UNAVAILABLE_HOLD} (whatsapp_not_connected): x; replayed at y`)).toBe(true);
    expect(waitsOnlyOnChannel("b645207b-0000-4000-8000-000000000041 failure_backoff")).toBe(false);
    expect(waitsOnlyOnChannel(null)).toBe(false);
  });
});
