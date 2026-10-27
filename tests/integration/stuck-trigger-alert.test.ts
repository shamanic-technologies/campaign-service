import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { triggerEvents } from "../../src/db/schema.js";
import { cleanTestData, closeDb, insertTestCampaign } from "../helpers/test-db.js";
import {
  alertStuckOccurrences,
  heldBackBy,
  resetStuckOccurrenceSweepClock,
  STUCK_OCCURRENCE_EVENT,
  waitsOnlyOnMoney,
} from "../../src/lib/stuck-trigger-alert.js";

const ORG = "a1b2c3d4-0000-4000-8000-000000001015";
const BRAND = "b1b2c3d4-0000-4000-8000-000000001015";
const OFFER = "c1b2c3d4-0000-4000-8000-000000001015";
const USER = "d1b2c3d4-0000-4000-8000-000000001015";
const NOW = new Date("2026-10-15T10:15:00Z");

const fetchMock = vi.fn();

async function occurrence(over: Partial<typeof triggerEvents.$inferInsert> = {}) {
  const [row] = await db
    .insert(triggerEvents)
    .values({
      orgId: ORG,
      brandId: BRAND,
      offerId: OFFER,
      triggerId: "form_submitted",
      recordedVia: "api",
      occurredAt: new Date("2026-10-14T20:00:31Z"),
      dueAt: new Date("2026-10-15T10:20:00Z"),
      status: "pending",
      attempts: 109,
      detail: { person: { email: "staff+prospect@distribute.you", name: "Pat" } },
      ...over,
      // Recorded when its fact happened, unless the case states otherwise (a backfill records it later).
      createdAt: over.createdAt ?? over.occurredAt ?? new Date("2026-10-14T20:00:31Z"),
    })
    .returning();
  return row;
}

describe("a prospect waiting on an undeliverable occurrence is told to staff (lib/stuck-trigger-alert.ts)", () => {
  beforeEach(async () => {
    await cleanTestData();
    resetStuckOccurrenceSweepClock();
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ results: [{ sent: true }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    process.env.TRANSACTIONAL_EMAIL_SERVICE_URL = "http://tes.test";
    process.env.TRANSACTIONAL_EMAIL_SERVICE_API_KEY = "tes-key";
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await cleanTestData();
    await closeDb();
  });

  it("alerts ONCE for the Doc Dinners shape: a form waiting 14 h behind a failure backoff", async () => {
    const campaign = await insertTestCampaign(ORG, {
      name: "Affection - ai-meeting-booking",
      brandIds: [BRAND],
      createdByUserId: USER,
      featureSlug: "ai-meeting-booking",
      workflowSlug: "ai-meeting-booking-fulu",
    });
    const event = await occurrence({ lastError: `${campaign.id} failure_backoff: staff+prospect@distribute.you, retried in 10 min` });

    expect(await alertStuckOccurrences(NOW)).toEqual([event.id]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://tes.test/platform-send");
    expect(init.headers).toMatchObject({ "x-org-id": ORG, "x-user-id": USER });
    const body = JSON.parse(init.body);
    expect(body.eventType).toBe(STUCK_OCCURRENCE_EVENT);
    expect(body.metadata).toMatchObject({
      occurrenceId: event.id,
      triggerId: "form_submitted",
      campaignId: campaign.id,
      campaignName: "Affection - ai-meeting-booking",
      brandId: BRAND,
      waitingSince: "2026-10-14T20:00:31.000Z",
      attempts: "109",
      prospect: "Pat <staff+prospect@distribute.you>",
    });
    expect(body).not.toHaveProperty("recipientEmail");

    // Latched: the next sweep says nothing more about it.
    resetStuckOccurrenceSweepClock();
    expect(await alertStuckOccurrences(new Date(NOW.getTime() + 20 * 60_000))).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("says nothing about an occurrence held only by the customer's money (cap reached, not funded)", async () => {
    await occurrence({ lastError: "11111111-1111-4111-8111-111111111111 sales_funnel_cap, retried in 10 min" });
    await occurrence({ lastError: "11111111-1111-4111-8111-111111111111 unfunded, retried in 10 min" });
    expect(await alertStuckOccurrences(NOW)).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("says nothing about a young occurrence, one carrying nobody, or one barely retried", async () => {
    const err = "11111111-1111-4111-8111-111111111111 failure_backoff, retried in 2 min";
    await occurrence({ lastError: err, occurredAt: new Date(NOW.getTime() - 5 * 60_000) });
    await occurrence({ lastError: err, detail: {} });
    await occurrence({ lastError: err, attempts: 1 });
    await occurrence({ lastError: err, status: "done" });
    expect(await alertStuckOccurrences(NOW)).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a refused send releases the latch, so the next sweep tries again", async () => {
    const event = await occurrence({ lastError: "dispatch threw: runs-service unavailable" });
    fetchMock.mockResolvedValueOnce(new Response("nope", { status: 400 }));
    expect(await alertStuckOccurrences(NOW)).toEqual([]);
    const [after] = await db.select().from(triggerEvents).where(eq(triggerEvents.id, event.id));
    expect(after.detail).not.toHaveProperty("stuckAlertedAt");

    resetStuckOccurrenceSweepClock();
    expect(await alertStuckOccurrences(NOW)).toEqual([event.id]);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).metadata.campaignId).toBe("none");
  });
  it("an occurrence RECORDED minutes ago for a fact of yesterday has waited minutes, not a day: no alert yet (LEAD-EVENT-WHATSAPP-1027)", async () => {
    await occurrence({
      lastError: "6c54479c-2300-4e21-afca-59fa8c4adfe5 cohort_run_in_flight: staff+prospect@distribute.you, retried in 2 min",
      occurredAt: new Date("2026-10-14T10:00:00Z"),
      createdAt: new Date(NOW.getTime() - 10 * 60_000),
      attempts: 5,
    });
    expect(await alertStuckOccurrences(NOW)).toEqual([]);
  });
});

describe("reading last_error", () => {
  it("names the first held-back campaign and every reason", () => {
    expect(heldBackBy("11111111-1111-4111-8111-111111111111 failure_backoff, 22222222-2222-4222-8222-222222222222 unfunded: a@b.c, retried in 10 min"))
      .toEqual({ campaignId: "11111111-1111-4111-8111-111111111111", reasons: ["failure_backoff", "unfunded"] });
    expect(heldBackBy(null)).toEqual({ campaignId: null, reasons: [] });
  });

  it("only money holds are the customer's", () => {
    expect(waitsOnlyOnMoney("11111111-1111-4111-8111-111111111111 sales_funnel_cap")).toBe(true);
    expect(waitsOnlyOnMoney("11111111-1111-4111-8111-111111111111 sales_funnel_cap, 22222222-2222-4222-8222-222222222222 failure_backoff")).toBe(false);
    expect(waitsOnlyOnMoney("catalogue unreadable: boom")).toBe(false);
  });

});
