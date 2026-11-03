import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { db } from "../../src/db/index.js";
import { triggerEventDeliveries, triggerEvents } from "../../src/db/schema.js";
import { cleanTestData, closeDb, insertTestCampaign } from "../helpers/test-db.js";
import app from "../../src/index.js";
import { answerState, readUnsentAnswers, type CampaignDelivery } from "../../src/lib/unsent-answers.js";

const API_KEY = process.env.CAMPAIGN_SERVICE_API_KEY || "test-api-key";
const ORG = "a1b2c3d4-0000-4000-8000-000000001029";
const BRAND = "b1b2c3d4-0000-4000-8000-000000001029";
const OFFER = "c1b2c3d4-0000-4000-8000-000000001029";
const USER = "d1b2c3d4-0000-4000-8000-000000001029";
const NOW = new Date();
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000);
const today = NOW.toISOString().slice(0, 10);

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
      occurredAt: ago(60),
      dueAt: ago(60),
      status: "done",
      outcome: "ran",
      attempts: 1,
      detail: { person: { email: "staff+prospect@distribute.you", name: "Pat" } },
      ...over,
      createdAt: over.createdAt ?? over.occurredAt ?? ago(60),
    })
    .returning();
  return row;
}

async function delivery(eventId: string, campaignId: string, over: Partial<typeof triggerEventDeliveries.$inferInsert> = {}) {
  await db.insert(triggerEventDeliveries).values({
    eventId,
    campaignId,
    runId: crypto.randomUUID(),
    status: "completed",
    dispatchedAt: ago(30),
    endedAt: ago(29),
    ...over,
  });
}

const campaign = () =>
  insertTestCampaign(ORG, {
    name: "Lead Follow-up 1029",
    brandIds: [BRAND],
    createdByUserId: USER,
    featureSlug: "ai-follow-up-email",
    workflowSlug: "ai-follow-up-email-algenib-v26",
  });

describe("an answer we owed and never sent is red on the Monitoring hub (lib/unsent-answers.ts, ONE-AI-REFUSED-ANSWERS-1029)", () => {
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

  it("a Lead event answer the sender refused (not_on_whatsapp) is red today, with its code, person and campaign", async () => {
    const c = await campaign();
    const ev = await occurrence();
    await delivery(ev.id, c.id, { status: "refused", refusalCode: "not_on_whatsapp", refusalReason: "+33600000000 is not on WhatsApp.", replayState: "final" });
    const read = await readUnsentAnswers(7, NOW);
    expect(read).toMatchObject({ status: "red", brokenLast24h: 1 });
    expect(read.unsent).toEqual([
      expect.objectContaining({
        occurrenceId: ev.id,
        campaignId: c.id,
        campaignName: "Lead Follow-up 1029",
        triggerId: "lead_event",
        state: "refused",
        refusalCode: "not_on_whatsapp",
        refusalReason: "+33600000000 is not on WhatsApp.",
        person: { name: "Pat", email: "staff+prospect@distribute.you", phone: null },
      }),
    ]);
    expect(read.byDay.at(-1)).toMatchObject({ day: today, refused: 1, refusedByCode: [{ code: "not_on_whatsapp", count: 1 }] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a refusal because the brand's team answered by hand (human_in_conversation) is NOT red", async () => {
    const c = await campaign();
    const ev = await occurrence();
    await delivery(ev.id, c.id, { status: "refused", refusalCode: "human_in_conversation", refusalReason: "Someone of the brand wrote by hand.", replayState: "final" });
    const read = await readUnsentAnswers(7, NOW);
    expect(read).toMatchObject({ status: "ok", brokenLast24h: 0, unsent: [] });
    expect(read.byDay.at(-1)).toMatchObject({ day: today, answeredByTeam: 1, refused: 0 });
  });

  it("a channel-down refusal being replayed is a normal 'not yet'; an answered occurrence counts answered", async () => {
    const c = await campaign();
    const down = await occurrence({ status: "pending", outcome: null, detail: { person: { email: "staff+a@distribute.you" }, retryCampaignIds: [c.id] } });
    await delivery(down.id, c.id, { status: "refused", refusalCode: "whatsapp_not_connected", refusalReason: "logged out", replayState: "scheduled" });
    const ok = await occurrence();
    await delivery(ok.id, c.id, { status: "failed", dispatchedAt: ago(40), endedAt: ago(39) });
    await delivery(ok.id, c.id);
    const read = await readUnsentAnswers(7, NOW);
    expect(read.status).toBe("ok");
    expect(read.byDay.at(-1)).toMatchObject({ replaying: 1, answered: 1, refused: 0, failed: 0 });
  });

  it("an answer whose runs all failed and was given up is red; one still being redelivered is not counted", async () => {
    const c = await campaign();
    const gaveUp = await occurrence({ outcome: "failed", skipReason: "run_failed" });
    await delivery(gaveUp.id, c.id, { status: "failed" });
    const retrying = await occurrence({ status: "pending", outcome: null, detail: { person: { email: "staff+b@distribute.you" }, retryCampaignIds: [c.id] } });
    await delivery(retrying.id, c.id, { status: "failed" });
    const off = await occurrence({ outcome: "skipped", skipReason: "campaign_off" });
    await delivery(off.id, c.id, { status: "failed" });
    const read = await readUnsentAnswers(7, NOW);
    expect(read.status).toBe("red");
    expect(read.unsent.map((u) => [u.occurrenceId, u.state])).toEqual([[gaveUp.id, "failed"]]);
  });

  it("one campaign failing while another answers the same person is NOT red", async () => {
    const c = await campaign();
    const other = await insertTestCampaign(ORG, { name: "Lead Follow-up other", brandIds: [BRAND], createdByUserId: USER, featureSlug: "ai-follow-up-email", workflowSlug: "ai-follow-up-email-algenib-v26" });
    const ev = await occurrence();
    await delivery(ev.id, c.id, { status: "failed", dispatchedAt: ago(50), endedAt: ago(45) });
    await delivery(ev.id, other.id);
    const read = await readUnsentAnswers(7, NOW);
    expect(read).toMatchObject({ status: "ok", unsent: [] });
    expect(read.byDay.at(-1)).toMatchObject({ answered: 1, failed: 0 });
  });

  it("a refusal older than 24 h stays on its day but leaves the card green; quiet days are served with zeros", async () => {
    const c = await campaign();
    const ev = await occurrence({ occurredAt: ago(3 * 1440), dueAt: ago(3 * 1440) });
    await delivery(ev.id, c.id, { status: "refused", refusalCode: "email_not_verified", refusalReason: "invalid", replayState: "final", dispatchedAt: ago(3 * 1440), endedAt: ago(3 * 1440) });
    const read = await readUnsentAnswers(7, NOW);
    expect(read).toMatchObject({ status: "ok", brokenLast24h: 0 });
    expect(read.unsent).toHaveLength(1);
    expect(read.byDay).toHaveLength(7);
    expect(read.byDay.filter((d) => d.refused > 0).map((d) => d.day)).toEqual([ago(3 * 1440).toISOString().slice(0, 10)]);
  });

  it("a person a LATER run of the same campaign answered (answered_after_fact) is NOT red, whatever the failed run says (Tari)", async () => {
    const c = await campaign();
    const ev = await occurrence({ outcome: "skipped", skipReason: "answered_after_fact", detail: {
      person: { email: "staff+tari@distribute.you", name: "Tari" },
      skipped: [{ campaignId: c.id, reason: "answered_after_fact", detail: "run x of this campaign answered them" }],
    } });
    await delivery(ev.id, c.id, { status: "failed", dispatchedAt: ago(50), endedAt: ago(49) });
    await delivery(ev.id, c.id, { status: "failed", dispatchedAt: ago(45), endedAt: ago(44) });
    const read = await readUnsentAnswers(7, NOW);
    expect(read).toMatchObject({ status: "ok", brokenLast24h: 0, unsent: [] });
    expect(read.byDay.at(-1)).toMatchObject({ answered: 1, failed: 0 });
  });

  it("a person ANOTHER campaign / occurrence answered after their message (another channel or line) is NOT red", async () => {
    const c = await campaign();
    const other = await insertTestCampaign(ORG, { name: "AI line", brandIds: [BRAND], createdByUserId: USER, featureSlug: "ai-follow-up-email", workflowSlug: "ai-follow-up-email-algenib-v26" });
    // By email.
    const byEmail = await occurrence({ triggerId: "hot_lead", outcome: "failed", skipReason: "run_failed", occurredAt: ago(60), detail: { person: { email: "Staff+Sam@distribute.you" } } });
    await delivery(byEmail.id, c.id, { status: "failed" });
    const answer1 = await occurrence({ occurredAt: ago(40), detail: { person: { email: "staff+sam@distribute.you", phone: "+33600000001" } } });
    await delivery(answer1.id, other.id, { dispatchedAt: ago(35), endedAt: ago(34) });
    // By the human an item names (no email, no phone: a WhatsApp-only hot lead).
    const byHuman = await occurrence({ triggerId: "hot_lead", outcome: "failed", skipReason: "run_failed", occurredAt: ago(60), detail: { item: { kind: "hot_lead", humanId: "h-1103", emails: [], phones: [] } } });
    await delivery(byHuman.id, c.id, { status: "failed" });
    const answer2 = await occurrence({ occurredAt: ago(40), detail: { item: { humanId: "h-1103" } } });
    await delivery(answer2.id, other.id, { dispatchedAt: ago(35), endedAt: ago(34) });
    const read = await readUnsentAnswers(7, NOW);
    expect(read).toMatchObject({ status: "ok", unsent: [] });
  });

  it("an answer to the person sent BEFORE their message does not count: still red", async () => {
    const c = await campaign();
    const ev = await occurrence({ outcome: "failed", skipReason: "run_failed", occurredAt: ago(30), detail: { person: { email: "staff+late@distribute.you" } } });
    await delivery(ev.id, c.id, { status: "failed", dispatchedAt: ago(20), endedAt: ago(19) });
    const earlier = await occurrence({ occurredAt: ago(120), detail: { person: { email: "staff+late@distribute.you" } } });
    await delivery(earlier.id, c.id, { dispatchedAt: ago(110), endedAt: ago(109) });
    // Another person answered later does not count either.
    const someoneElse = await occurrence({ occurredAt: ago(15), detail: { person: { email: "staff+else@distribute.you" } } });
    await delivery(someoneElse.id, c.id, { dispatchedAt: ago(10), endedAt: ago(9) });
    const read = await readUnsentAnswers(7, NOW);
    expect(read.status).toBe("red");
    expect(read.unsent.map((u) => [u.occurrenceId, u.state])).toEqual([[ev.id, "failed"]]);
  });

  it("runs that all ended NOTHING TO DO are not 'every run failed': counted nothingToDo, not red", async () => {
    const c = await campaign();
    const ev = await occurrence({ triggerId: "hot_lead", outcome: "skipped", skipReason: "no_work", detail: { item: { kind: "hot_lead", humanId: "h-nothing" } } });
    for (const m of [50, 40, 30]) await delivery(ev.id, c.id, { status: "no_work", dispatchedAt: ago(m), endedAt: ago(m - 1) });
    const read = await readUnsentAnswers(7, NOW);
    expect(read).toMatchObject({ status: "ok", brokenLast24h: 0, unsent: [] });
    expect(read.byDay.at(-1)).toMatchObject({ nothingToDo: 1, failed: 0 });
  });

  it("a truly unanswered person (runs failed, nobody answered after) stays red", async () => {
    const c = await campaign();
    const ev = await occurrence({ outcome: "failed", skipReason: "run_failed", detail: { person: { email: "staff+nobody@distribute.you" } } });
    await delivery(ev.id, c.id, { status: "failed", dispatchedAt: ago(50), endedAt: ago(49) });
    await delivery(ev.id, c.id, { status: "no_work", dispatchedAt: ago(40), endedAt: ago(39) });
    const read = await readUnsentAnswers(7, NOW);
    expect(read).toMatchObject({ status: "red", brokenLast24h: 1 });
    expect(read.unsent.map((u) => [u.occurrenceId, u.state])).toEqual([[ev.id, "failed"]]);
  });

  it("a fact its caller WITHDREW (our own bot taken for a lead) owes nobody: not counted", async () => {
    const c = await campaign();
    const ev = await occurrence({ triggerId: "hot_lead", outcome: "failed", skipReason: "run_failed", detail: { item: { kind: "hot_lead", humanId: "bot" }, withdrawnAt: ago(5).toISOString(), withdrawnReason: "own_bot" } });
    await delivery(ev.id, c.id, { status: "failed" });
    const read = await readUnsentAnswers(7, NOW);
    expect(read).toMatchObject({ status: "ok", unsent: [] });
  });

  describe("asks crm-service whether the brand wrote to the person after their fact (any channel, anyone)", () => {
    beforeEach(() => {
      process.env.CRM_SERVICE_URL = "http://crm.test";
      process.env.CRM_SERVICE_API_KEY = "crm-key";
    });
    afterAll(() => {
      delete process.env.CRM_SERVICE_URL;
      delete process.env.CRM_SERVICE_API_KEY;
    });
    const crmAnswers = (people: unknown[]) => fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ people }), { status: 200 }));

    it("our AI line answered on WhatsApp outside any campaign (Senthil): not red; the brand's team typing by hand = answeredByTeam", async () => {
      const c = await campaign();
      const ai = await occurrence({ triggerId: "hot_lead", outcome: "failed", skipReason: "run_failed", detail: { item: { kind: "hot_lead", relationKey: "rel:p1:pro", humanId: "h-senthil", emails: [], phones: [] } } });
      await delivery(ai.id, c.id, { status: "failed" });
      const team = await occurrence({ outcome: "failed", skipReason: "run_failed", detail: { person: { email: "staff+team@distribute.you", phone: "+33600000002" } } });
      await delivery(team.id, c.id, { status: "failed" });
      crmAnswers([
        { ref: ai.id, status: "sent", firstSent: { at: ago(30).toISOString(), sentBy: "automation" } },
        { ref: team.id, status: "sent", firstSent: { at: ago(30).toISOString(), sentBy: "person" } },
      ]);
      const read = await readUnsentAnswers(7, NOW);
      expect(read).toMatchObject({ status: "ok", unsent: [] });
      expect(read.byDay.at(-1)).toMatchObject({ answered: 1, answeredByTeam: 1, failed: 0 });
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("http://crm.test/internal/people/sent-after");
      const body = JSON.parse(init.body);
      expect(body).toMatchObject({ orgId: ORG, brandId: BRAND });
      expect(body.people).toEqual(expect.arrayContaining([
        { ref: ai.id, after: ago(60).toISOString(), relationKey: "rel:p1:pro", humanId: "h-senthil" },
        { ref: team.id, after: ago(60).toISOString(), email: "staff+team@distribute.you", phone: "+33600000002" },
      ]));
    });

    it("crm says nothing sent, or cannot be read: the person stays red", async () => {
      const c = await campaign();
      const ev = await occurrence({ outcome: "failed", skipReason: "run_failed", detail: { person: { email: "staff+none@distribute.you" } } });
      await delivery(ev.id, c.id, { status: "failed" });
      crmAnswers([{ ref: ev.id, status: "nothing_sent", firstSent: null }]);
      expect((await readUnsentAnswers(7, NOW)).unsent.map((u) => u.occurrenceId)).toEqual([ev.id]);
      fetchMock.mockResolvedValueOnce(new Response("boom", { status: 502 }));
      expect((await readUnsentAnswers(7, NOW)).status).toBe("red");
      crmAnswers([{ ref: ev.id, status: "unreadable", firstSent: null }]);
      expect((await readUnsentAnswers(7, NOW)).status).toBe("red");
    });
  });

  it("serves the staff read on /internal/ops/unsent-answers", async () => {
    const c = await campaign();
    const ev = await occurrence();
    await delivery(ev.id, c.id, { status: "refused", refusalCode: "named_lead_unwritable", refusalReason: "no name", replayState: "final" });
    const res = await request(app).get("/internal/ops/unsent-answers?days=3").set("x-api-key", API_KEY);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ days: 3, status: "red", brokenLast24h: 1, redWindowHours: 24 });
    expect((await request(app).get("/internal/ops/unsent-answers?days=0").set("x-api-key", API_KEY)).status).toBe(400);
    expect((await request(app).get("/internal/ops/unsent-answers")).status).toBe(401);
  });
});

describe("answerState", () => {
  const d = (over: Partial<CampaignDelivery> = {}): CampaignDelivery => ({ campaignId: "a", status: "refused", refusalCode: "x", replayState: "final", anyCompleted: false, ...over });
  const done = { done: true, skipReason: null };
  it("classifies what the person finally got", () => {
    expect(answerState([d({ status: "failed" }), d({ campaignId: "b", anyCompleted: true })], done).state).toBe("answered");
    expect(answerState([d({ refusalCode: "human_in_conversation" })], done).state).toBe("answeredByTeam");
    expect(answerState([d({ replayState: "scheduled" })], { done: false, skipReason: null }).state).toBe("replaying");
    expect(answerState([d({ status: "failed" })], { done: false, skipReason: null }).state).toBeNull();
    expect(answerState([d({ replayState: "expired" })], done)).toMatchObject({ state: "refused", by: { campaignId: "a" } });
    expect(answerState([d({ replayState: null })], done).state).toBe("refused");
    expect(answerState([d({ status: "timed_out" })], done).state).toBe("failed");
    expect(answerState([d({ status: "failed" })], { done: true, skipReason: "campaign_off" }).state).toBeNull();
    expect(answerState([d({ status: "not_admitted" })], done).state).toBeNull();
    expect(answerState([d({ status: "no_work" })], done).state).toBe("nothingToDo");
    expect(answerState([d({ status: "no_work" }), d({ campaignId: "b", status: "failed" })], done).state).toBe("failed");
    expect(answerState([d({ status: "failed" })], { ...done, answeredAfterFact: true }).state).toBe("answered");
    expect(answerState([d({ replayState: null })], { ...done, answeredAfterFact: true }).state).toBe("answered");
  });
});
