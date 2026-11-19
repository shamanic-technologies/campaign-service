import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

const { mockExecute, mockFollowupDue } = vi.hoisted(() => ({ mockExecute: vi.fn(), mockFollowupDue: vi.fn() }));

// The real module (tests/setup.ts stubs it to "nobody owed"); who is owed on the unit's queue is mocked (lead-service).
vi.unmock("../../src/lib/owed-answer-retry.js");
vi.mock("../../src/lib/followup-due-client.js", () => ({ fetchFollowupDue: mockFollowupDue }));
vi.mock("../../src/lib/workflows.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/workflows.js")>()),
  executeCampaignWorkflow: mockExecute,
}));
vi.mock("@distribute/runs-client", () => ({
  listRuns: vi.fn().mockResolvedValue({ runs: [] }),
  createRun: vi.fn().mockResolvedValue({ id: crypto.randomUUID() }),
  updateRun: vi.fn(),
  getStatsBudget: vi.fn(),
}));

import { eq } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { campaigns, triggerEventDeliveries, triggerEvents } from "../../src/db/schema.js";
import { cleanTestData, closeDb, insertTestCampaign } from "../helpers/test-db.js";
import { reRunDueCampaigns } from "../../src/lib/scheduler.js";
import { OWED_RETRY_MAX, retryOwedAnswersOnTriggerUnit } from "../../src/lib/owed-answer-retry.js";

const ORG = "a1b2c3d4-0000-4000-8000-000000001119";
const BRAND = "b1b2c3d4-0000-4000-8000-000000001119";
const OFFER = "c1b2c3d4-0000-4000-8000-000000001119";
const USER = "d1b2c3d4-0000-4000-8000-000000001119";
const PERSON = "staff+owed-1119@distribute.you";
const ago = (min: number) => new Date(Date.now() - min * 60_000);

const unit = (over: Parameters<typeof insertTestCampaign>[1] = {}) =>
  insertTestCampaign(ORG, {
    brandIds: [BRAND],
    createdByUserId: USER,
    parentRunId: crypto.randomUUID(),
    featureSlug: "ai-follow-up-email",
    legKey: "start_to_paid_client",
    workflowSlug: "ai-follow-up-email-algenib",
    offerId: OFFER,
    salesFunnelCampaignId: crypto.randomUUID(),
    salesFunnelId: "trigger:lead_event+ai-follow-up-email|start_to_paid_client",
    runsOnTriggerId: "lead_event",
    nextRunAt: ago(1),
    ...over,
  });

async function occurrence(over: Partial<typeof triggerEvents.$inferInsert> = {}) {
  const [row] = await db
    .insert(triggerEvents)
    .values({
      orgId: ORG,
      brandId: BRAND,
      offerId: OFFER,
      triggerId: "lead_event",
      recordedVia: "composite_trigger",
      occurredAt: ago(120),
      dueAt: ago(120),
      status: "done",
      outcome: "skipped",
      skipReason: "refused",
      attempts: 1,
      detail: { person: { email: PERSON, name: "Pat" } },
      createdAt: ago(120),
      ...over,
    })
    .returning();
  return row;
}

async function delivery(eventId: string, campaignId: string, over: Partial<typeof triggerEventDeliveries.$inferInsert> = {}) {
  await db.insert(triggerEventDeliveries).values({
    eventId,
    campaignId,
    runId: crypto.randomUUID(),
    status: "refused",
    refusalCode: "no_script",
    refusalReason: "no live script of that Engine can run on nothing",
    channelDownP: 0.27,
    channelDownJudgedAt: ago(110),
    replayState: "final",
    dispatchedAt: ago(119),
    endedAt: ago(119),
    ...over,
  });
}

const eventRow = async (id: string) => (await db.select().from(triggerEvents).where(eq(triggerEvents.id, id)))[0];

describe("a person owed our answer on a trigger-run unit is retried (lib/owed-answer-retry.ts, ANSWER-RETRY-TRIGGER-UNIT-1119)", () => {
  beforeEach(async () => {
    await cleanTestData();
    mockExecute.mockReset();
    mockFollowupDue.mockReset();
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("owed + a finally refused occurrence: the scheduler re-opens it for this unit, due now, and never runs the unit itself", async () => {
    const u = await unit();
    const ev = await occurrence();
    await delivery(ev.id, u.id);
    mockFollowupDue.mockResolvedValue({ owedNow: true, nextDueAt: null });

    await reRunDueCampaigns();

    expect(mockFollowupDue).toHaveBeenCalledWith({ orgId: ORG, actingCampaignId: u.id, campaignIds: [u.id] });
    expect(mockExecute).not.toHaveBeenCalled();
    const row = await eventRow(ev.id);
    expect(row.status).toBe("pending");
    expect(row.dueAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect(row.detail).toMatchObject({
      person: { email: PERSON },
      retryCampaignIds: [u.id],
      owedAnswerRetries: [expect.objectContaining({ campaignId: u.id, afterStatus: "refused", refusalCode: "no_script" })],
    });
    expect(row.lastError).toContain(`${u.id} owed_answer_retry`);
    const [parked] = await db.select().from(campaigns).where(eq(campaigns.id, u.id));
    expect(parked.nextRunAt!.getTime()).toBeGreaterThan(Date.now() + 9 * 60_000);
  });

  it("nobody owed: nothing re-opened, the unit never runs", async () => {
    const u = await unit();
    const ev = await occurrence();
    await delivery(ev.id, u.id);
    mockFollowupDue.mockResolvedValue({ owedNow: false, nextDueAt: null });

    await reRunDueCampaigns();

    expect(mockExecute).not.toHaveBeenCalled();
    expect((await eventRow(ev.id)).status).toBe("done");
  });

  it("lead-service unreadable: nothing re-opened on a guess", async () => {
    const u = await unit();
    const ev = await occurrence();
    await delivery(ev.id, u.id, { status: "failed", refusalCode: null, refusalReason: null, replayState: null, channelDownP: null, channelDownJudgedAt: null });
    mockFollowupDue.mockRejectedValue(new Error("lead-service 503"));

    expect(await retryOwedAnswersOnTriggerUnit({ id: u.id, orgId: ORG })).toEqual({ kind: "unreadable" });
    expect((await eventRow(ev.id)).status).toBe("done");
  });

  it("a failed run is re-opened; a team answer, a channel-down replay, a strategy refusal and a 'nothing to do' are not", async () => {
    const u = await unit();
    mockFollowupDue.mockResolvedValue({ owedNow: true, nextDueAt: null });
    const failed = await occurrence({ detail: { person: { email: "a+1119@distribute.you" } } });
    await delivery(failed.id, u.id, { status: "failed", refusalCode: null, refusalReason: null, replayState: null, channelDownP: null, channelDownJudgedAt: null });
    const team = await occurrence({ detail: { person: { email: "b+1119@distribute.you" } } });
    await delivery(team.id, u.id, { refusalCode: "human_in_conversation" });
    const channelDown = await occurrence({ detail: { person: { email: "c+1119@distribute.you" } } });
    await delivery(channelDown.id, u.id, { refusalCode: "whatsapp_not_connected", channelDownP: 0.95, replayState: "scheduled" });
    const notAdmitted = await occurrence({ detail: { person: { email: "d+1119@distribute.you" } } });
    await delivery(notAdmitted.id, u.id, { status: "not_admitted", refusalCode: null });
    const noWork = await occurrence({ detail: { person: { email: "e+1119@distribute.you" } } });
    await delivery(noWork.id, u.id, { status: "no_work", refusalCode: null });

    const out = await retryOwedAnswersOnTriggerUnit({ id: u.id, orgId: ORG });

    expect(out).toEqual({ kind: "reopened", eventIds: [failed.id] });
  });

  it("answered since by any run of the brand, withdrawn, or older than 7 days: not re-opened", async () => {
    const u = await unit();
    const other = await unit({ runsOnTriggerId: null, salesFunnelCampaignId: crypto.randomUUID(), featureSlug: "ai-whatsapp", name: "other" });
    mockFollowupDue.mockResolvedValue({ owedNow: true, nextDueAt: null });
    const answered = await occurrence();
    await delivery(answered.id, u.id);
    const later = await occurrence({ occurredAt: ago(30), dueAt: ago(30), createdAt: ago(30), outcome: "ran" });
    await delivery(later.id, other.id, { status: "completed", refusalCode: null, dispatchedAt: ago(29), endedAt: ago(28) });
    const withdrawn = await occurrence({ detail: { person: { email: "w+1119@distribute.you" }, withdrawnAt: ago(5).toISOString() } });
    await delivery(withdrawn.id, u.id);
    const old = await occurrence({ detail: { person: { email: "o+1119@distribute.you" } }, occurredAt: ago(8 * 1440), createdAt: ago(8 * 1440), dueAt: ago(8 * 1440) });
    await delivery(old.id, u.id, { dispatchedAt: ago(10), endedAt: ago(10) });

    expect(await retryOwedAnswersOnTriggerUnit({ id: u.id, orgId: ORG })).toEqual({ kind: "reopened", eventIds: [] });
  });

  it(`at most ${OWED_RETRY_MAX} re-opens per occurrence x unit`, async () => {
    const u = await unit();
    mockFollowupDue.mockResolvedValue({ owedNow: true, nextDueAt: null });
    const retries = Array.from({ length: OWED_RETRY_MAX }, () => ({ campaignId: u.id, at: ago(60).toISOString() }));
    const ev = await occurrence({ detail: { person: { email: PERSON }, owedAnswerRetries: retries } });
    await delivery(ev.id, u.id);

    expect(await retryOwedAnswersOnTriggerUnit({ id: u.id, orgId: ORG })).toEqual({ kind: "reopened", eventIds: [] });
  });
});
