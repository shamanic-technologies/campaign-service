import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { db } from "../../src/db/index.js";
import { triggerEventDeliveries, triggerEvents } from "../../src/db/schema.js";
import { cleanTestData, closeDb, insertTestCampaign } from "../helpers/test-db.js";
import app from "../../src/index.js";
import {
  heldBackBy,
  readStuckOccurrences,
  waitsInMovingQueue,
  waitsOnlyOnMoney,
} from "../../src/lib/stuck-occurrences.js";

const API_KEY = process.env.CAMPAIGN_SERVICE_API_KEY || "test-api-key";
const ORG = "a1b2c3d4-0000-4000-8000-000000001028";
const BRAND = "b1b2c3d4-0000-4000-8000-000000001028";
const OFFER = "c1b2c3d4-0000-4000-8000-000000001028";
const USER = "d1b2c3d4-0000-4000-8000-000000001028";
const NOW = new Date();
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000);

const fetchMock = vi.fn();

async function occurrence(over: Partial<typeof triggerEvents.$inferInsert> = {}) {
  const [row] = await db
    .insert(triggerEvents)
    .values({
      orgId: ORG,
      brandId: BRAND,
      offerId: OFFER,
      triggerId: "lead_event",
      recordedVia: "composite_trigger",
      occurredAt: ago(90),
      dueAt: new Date(NOW.getTime() + 2 * 60_000),
      status: "pending",
      attempts: 12,
      detail: { person: { email: "staff+prospect@distribute.you", name: "Pat" } },
      ...over,
      createdAt: over.createdAt ?? over.occurredAt ?? ago(90),
    })
    .returning();
  return row;
}

const campaign = () =>
  insertTestCampaign(ORG, {
    name: "Lead Follow-up f1ab54e3",
    brandIds: [BRAND],
    createdByUserId: USER,
    featureSlug: "ai-follow-up-email",
    workflowSlug: "ai-follow-up-email-algenib-v26",
  });

describe("stuck occurrences are red on the Monitoring hub, never an email (lib/stuck-occurrences.ts, REACTIVE-THROUGHPUT-1028)", () => {
  beforeEach(async () => {
    await cleanTestData();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await cleanTestData();
    await closeDb();
  });

  it("a person queued behind runs that keep finishing is NOT stuck: green, counted as queued", async () => {
    const c = await campaign();
    await occurrence({ occurredAt: ago(45), lastError: `${c.id} run_in_flight: Pat <staff+prospect@distribute.you>, retried in 2 min` });
    await db.insert(triggerEventDeliveries).values({ eventId: crypto.randomUUID(), campaignId: c.id, runId: crypto.randomUUID(), status: "completed", dispatchedAt: ago(3), endedAt: ago(2) });
    const read = await readStuckOccurrences(7, NOW);
    expect(read).toMatchObject({ status: "ok", stuck: 0, queued: 1, stuckOccurrences: [], oldestWaitingMinutes: 45 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a queue that moves but leaves a person waiting over an hour IS stuck: red (ONE-AI-CONVERSES-1029-QUEUE)", async () => {
    const c = await campaign();
    const ev = await occurrence({ occurredAt: ago(6 * 60), lastError: `${c.id} run_in_flight: 4 runs of this campaign are already answering other people` });
    await db.insert(triggerEventDeliveries).values({ eventId: crypto.randomUUID(), campaignId: c.id, runId: crypto.randomUUID(), status: "completed", dispatchedAt: ago(3), endedAt: ago(2) });
    const read = await readStuckOccurrences(7, NOW);
    expect(read).toMatchObject({ status: "red", stuck: 1, queued: 0, queuedTooLongMinutes: 60, oldestWaitingMinutes: 360 });
    expect(read.stuckOccurrences[0]).toMatchObject({ occurrenceId: ev.id, reasons: ["run_in_flight"] });
  });

  it("the daily series serves how long the people answered waited (p50, p90, max minutes)", async () => {
    await occurrence({ status: "done", outcome: "ran", occurredAt: ago(100), processedAt: ago(99) });
    await occurrence({ status: "done", outcome: "ran", occurredAt: ago(100), processedAt: ago(98) });
    await occurrence({ status: "done", outcome: "ran", occurredAt: ago(100), processedAt: ago(40) });
    const { byDay } = await readStuckOccurrences(7, NOW);
    const day = byDay.find((d) => d.answered === 3)!;
    expect(day.waitMinutes).toEqual({ p50: 2, p90: 48.4, max: 60 });
    expect(byDay.filter((d) => d.answered === 0).every((d) => d.waitMinutes.p50 === null)).toBe(true);
  });

  it("a run in flight with no run moving for the campaign IS stuck: red, named with its person and campaign", async () => {
    const c = await campaign();
    const ev = await occurrence({ lastError: `${c.id} run_in_flight: Pat, retried in 10 min` });
    const read = await readStuckOccurrences(7, NOW);
    expect(read.status).toBe("red");
    expect(read.stuckOccurrences).toEqual([
      expect.objectContaining({
        occurrenceId: ev.id,
        campaignId: c.id,
        campaignName: "Lead Follow-up f1ab54e3",
        person: { name: "Pat", email: "staff+prospect@distribute.you", phone: null },
        reasons: ["run_in_flight"],
        attempts: 12,
      }),
    ]);
    expect(read.stuckByReason).toEqual([expect.objectContaining({ reason: "run_in_flight", count: 1 })]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a failure backoff is stuck whatever the queue does", async () => {
    const c = await campaign();
    await occurrence({ lastError: `${c.id} failure_backoff, retried in 10 min` });
    await db.insert(triggerEventDeliveries).values({ eventId: crypto.randomUUID(), campaignId: c.id, runId: crypto.randomUUID(), status: "failed", dispatchedAt: ago(3), endedAt: ago(2) });
    expect((await readStuckOccurrences(7, NOW)).stuck).toBe(1);
  });

  it("money holds, channel outages, young, barely-tried, empty and done occurrences raise nothing", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    await occurrence({ lastError: `${id} sales_funnel_cap, retried in 10 min` });
    await occurrence({ lastError: `${id} channel_unavailable` });
    await occurrence({ lastError: `${id} failure_backoff`, occurredAt: ago(5) });
    await occurrence({ lastError: `${id} failure_backoff`, attempts: 1 });
    await occurrence({ lastError: `${id} failure_backoff`, detail: {} });
    await occurrence({ lastError: `${id} failure_backoff`, status: "done", outcome: "ran" });
    expect(await readStuckOccurrences(7, NOW)).toMatchObject({ status: "ok", stuck: 0 });
  });

  it("an occurrence RECORDED minutes ago for a fact of yesterday has waited minutes, not a day (LEAD-EVENT-WHATSAPP-1027)", async () => {
    await occurrence({
      lastError: "6c54479c-2300-4e21-afca-59fa8c4adfe5 failure_backoff, retried in 2 min",
      occurredAt: ago(24 * 60),
      createdAt: ago(10),
    });
    expect((await readStuckOccurrences(7, NOW)).stuck).toBe(0);
  });

  it("the daily series counts answered, answered late, skipped, failed and waiting per day the person acted", async () => {
    await occurrence({ status: "done", outcome: "ran", processedAt: ago(85) });
    await occurrence({ status: "done", outcome: "ran", processedAt: ago(10) });
    await occurrence({ status: "done", outcome: "skipped" });
    await occurrence({ status: "done", outcome: "failed" });
    await occurrence({ lastError: null });
    await occurrence({ status: "done", outcome: "ran", detail: {} });
    const { byDay } = await readStuckOccurrences(7, NOW);
    const total = byDay.reduce(
      (t, d) => ({ answered: t.answered + d.answered, late: t.late + d.answeredLate, skipped: t.skipped + d.skipped, failed: t.failed + d.failed, waiting: t.waiting + d.waiting }),
      { answered: 0, late: 0, skipped: 0, failed: 0, waiting: 0 },
    );
    expect(total).toEqual({ answered: 2, late: 1, skipped: 1, failed: 1, waiting: 1 });
  });

  it("GET /internal/ops/stuck-occurrences serves it (staff key), 400 on a bad window", async () => {
    const c = await campaign();
    await occurrence({ lastError: `${c.id} dispatch_refused` });
    const res = await request(app).get("/internal/ops/stuck-occurrences?days=3").set("x-api-key", API_KEY);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ days: 3, status: "red", stuck: 1, stuckAfterMinutes: 30 });
    expect((await request(app).get("/internal/ops/stuck-occurrences?days=0").set("x-api-key", API_KEY)).status).toBe(400);
    expect((await request(app).get("/internal/ops/stuck-occurrences")).status).toBe(401);
  });
});

describe("reading last_error", () => {
  it("names every held-back campaign and every reason", () => {
    expect(heldBackBy("11111111-1111-4111-8111-111111111111 failure_backoff, 22222222-2222-4222-8222-222222222222 unfunded: a@b.c, retried in 10 min"))
      .toEqual({
        campaignId: "11111111-1111-4111-8111-111111111111",
        campaignIds: ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"],
        reasons: ["failure_backoff", "unfunded"],
      });
    expect(heldBackBy(null)).toEqual({ campaignId: null, campaignIds: [], reasons: [] });
  });

  it("only money holds are the customer's", () => {
    expect(waitsOnlyOnMoney("11111111-1111-4111-8111-111111111111 sales_funnel_cap")).toBe(true);
    expect(waitsOnlyOnMoney("11111111-1111-4111-8111-111111111111 sales_funnel_cap, 22222222-2222-4222-8222-222222222222 failure_backoff")).toBe(false);
    expect(waitsOnlyOnMoney("catalogue unreadable: boom")).toBe(false);
  });

  it("a moving queue needs every hold to be a busy run behind a campaign that moved", () => {
    const a = "11111111-1111-4111-8111-111111111111";
    const b = "22222222-2222-4222-8222-222222222222";
    expect(waitsInMovingQueue(`${a} run_in_flight`, new Set([a]))).toBe(true);
    expect(waitsInMovingQueue(`${a} run_in_flight, ${b} cohort_run_in_flight`, new Set([a]))).toBe(false);
    expect(waitsInMovingQueue(`${a} failure_backoff`, new Set([a]))).toBe(false);
    expect(waitsInMovingQueue("catalogue unreadable", new Set([a]))).toBe(false);
  });
});
