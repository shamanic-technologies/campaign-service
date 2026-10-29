import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";

vi.mock("@distribute/runs-client", () => ({
  createRun: vi.fn(async () => ({ id: crypto.randomUUID() })),
  updateRun: vi.fn(),
  listRuns: vi.fn(async () => ({ runs: [] })),
  getStatsBudget: vi.fn(),
}));

// The campaign's own funnel, read when the switch turns off (the PATCH has no deps to inject).
const resolveMock = vi.hoisted(() => vi.fn());
vi.mock("../../src/lib/startable-pair.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/startable-pair.js")>()),
  resolveSalesFunnelPlan: resolveMock,
}));

import app from "../../src/index.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { campaigns, salesFunnelCampaigns, salesFunnelPlanChanges } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import { insertSalesFunnelCampaignWithUnits } from "../../src/lib/campaign-status-history.js";
import { acquisitionChannelForFeature } from "../../src/lib/campaign-identity.js";
import { checkSalesFunnelCampaignPlan, runPlanFollowerPass, switchOffPlan, type PlanCheck, type PlanDeps } from "../../src/lib/sales-funnel-plan.js";
import type { SalesFunnelUnitPlan } from "../../src/lib/startable-pair.js";
import type { ChannelCatalogueRead } from "../../src/lib/channel-operator-client.js";

const API_KEY = process.env.CAMPAIGN_SERVICE_API_KEY || "test-api-key";
const ORG = "b645207b-0000-4000-8000-0000000000d1";
const BRAND = "75d7e3e8-0000-4000-8000-0000000000d2";
const OFFER = "231bb036-0000-4000-8000-0000000000d3";
const USER = "cfe148ed-0000-4000-8000-0000000000d4";
const RUN = "9a1b2c3d-0000-4000-8000-0000000000d5";

// Definitejobs' shape (2026-10-29): its funnel = Email Sending + AI Meeting Booking + your team; the plan dropped
// AI Meeting Booking for "your team answers the replies".
const SEND = "email-sending";
const MEETING = "ai-meeting-booking";
const ATTEND = "your-team-meeting-attendance";
const REPLY = "your-team-reply-closing";
const OWN = `start_to_conversation@${SEND}+conversation_to_meeting_booked@${MEETING}+meeting_booked_to_meeting_attended`;
const PLAN = `start_to_conversation@${SEND}+conversation_to_paid_client`;

const unitPlan = (featureSlug: string, legKey: string, mode: "proactive" | "reactive"): SalesFunnelUnitPlan => ({
  pipeId: `${featureSlug}|${legKey}`,
  featureSlug,
  legKey,
  mode,
  workflowSlug: featureSlug.startsWith("your-team") ? null : `${featureSlug}-wf`,
  runsOnTriggerId: null,
});
const OWN_UNITS = [unitPlan(SEND, "start_to_conversation", "proactive"), unitPlan(MEETING, "conversation_to_meeting_booked", "reactive"), unitPlan(ATTEND, "meeting_booked_to_meeting_attended", "reactive")];
const PLAN_UNITS = [unitPlan(SEND, "start_to_conversation", "proactive"), unitPlan(REPLY, "conversation_to_paid_client", "reactive")];
const unitsFor = (id: string) => (id === PLAN ? PLAN_UNITS : OWN_UNITS);

const BRIEF =
  "Use only these channels:\nUse Email Sending (Start to Positive reply).\nUse AI Meeting Booking (Positive reply to Meeting booked): Leads only.";

async function bornCampaign(opts: { brief?: string } = {}) {
  const id = crypto.randomUUID();
  const born = await insertSalesFunnelCampaignWithUnits({
    id,
    orgId: ORG,
    brandId: BRAND,
    offerId: OFFER,
    salesFunnelId: OWN,
    salesFunnelName: "API Email Meetings",
    status: "ongoing",
    createdByUserId: USER,
    parentRunId: RUN,
    followsPlan: true,
    units: OWN_UNITS.map((u) => ({
      featureSlug: u.featureSlug,
      legKey: u.legKey,
      workflowSlug: u.workflowSlug,
      acquisitionChannel: acquisitionChannelForFeature(u.featureSlug)!,
      name: `API Email Meetings ${id.slice(0, 8)} - ${u.pipeId}`,
    })),
  });
  if (opts.brief) await db.update(salesFunnelCampaigns).set({ brief: opts.brief }).where(eq(salesFunnelCampaigns.id, id));
  const [row] = await db.select().from(salesFunnelCampaigns).where(eq(salesFunnelCampaigns.id, id));
  return { row, units: born.units };
}

const catalogue = async (): Promise<ChannelCatalogueRead> => ({
  ok: true,
  operatorBySlug: new Map(),
  legsBySlug: new Map(),
  legs: [],
  stepKeys: new Set(),
  nameBySlug: new Map([
    [SEND, "Email Sending"],
    [MEETING, "AI Meeting Booking"],
    [ATTEND, "Your team: meeting attendance"],
  ]),
});

function deps(opts: { judge?: PlanDeps["judgeBrief"] } = {}): PlanDeps {
  return {
    plan: vi.fn(async () => ({
      ok: true as const,
      plan: { status: "ok", failure: null, computedAt: "2026-10-29T09:58:14.000Z", plan: { shadow: { funnelId: PLAN, legs: [] } } },
    })),
    resolve: vi.fn(async (salesFunnelId: string) => ({ ok: true as const, plan: { salesFunnelId, salesFunnelName: "x", units: unitsFor(salesFunnelId) } })),
    catalogue,
    // The brief names Email Sending and AI Meeting Booking, not the your-team pipes.
    judgeBrief: opts.judge ?? vi.fn(async (_unitId: string, input: { channelSlug: string }) => (input.channelSlug === MEETING || input.channelSlug === SEND ? 0.95 : 0.05)),
  };
}

const unitsOf = (id: string) => db.select().from(campaigns).where(eq(campaigns.salesFunnelCampaignId, id));
afterAll(async () => {
  await cleanTestData();
  await closeDb();
});

const rowOf = async (id: string) => (await db.select().from(salesFunnelCampaigns).where(eq(salesFunnelCampaigns.id, id)))[0];

describe("switching a plan off puts the campaign back on its own funnel (PLAN-SWITCH-OFF-1029)", () => {
  beforeEach(async () => {
    await cleanTestData();
    resolveMock.mockReset();
    resolveMock.mockImplementation(async (salesFunnelId: string) => ({ ok: true, plan: { salesFunnelId, salesFunnelName: "x", units: unitsFor(salesFunnelId) } }));
  });

  it("PATCH followsPlan false: its funnel's units run again, plan-born units drain (never stopped), running funnel home, recorded", async () => {
    const { row } = await bornCampaign();
    const applied = await checkSalesFunnelCampaignPlan(row, { apply: true }, deps());
    expect(applied.check.state).toBe("applied");
    const onPlan = await unitsOf(row.id);
    expect(onPlan.find((u) => u.featureSlug === MEETING)!.planRole).toBe("draining");
    expect(onPlan.find((u) => u.featureSlug === SEND)!.salesFunnelId).toBe(PLAN);

    const headers = { "x-api-key": API_KEY, "x-org-id": ORG, "x-user-id": USER, "x-run-id": RUN };
    const off = await request(app).patch(`/sales-funnel-campaigns/${row.id}`).set(headers).send({ followsPlan: false });
    expect(off.status).toBe(200);
    expect(off.body.salesFunnelCampaign).toMatchObject({ followsPlan: false, salesFunnelId: OWN, runningSalesFunnelId: OWN });
    expect(off.body.salesFunnelCampaign.planCheck.state).toBe("switched_off");

    const after = await unitsOf(row.id);
    const by = (slug: string) => after.find((u) => u.featureSlug === slug)!;
    for (const slug of [SEND, MEETING, ATTEND]) {
      expect(by(slug)).toMatchObject({ planRole: null, salesFunnelId: OWN, status: "ongoing" });
    }
    // The plan-born pipe owes follow-ups: draining, still ON.
    expect(by(REPLY)).toMatchObject({ planRole: "draining", status: "ongoing" });
    expect(after).toHaveLength(4);

    const changes = await db.select().from(salesFunnelPlanChanges).where(eq(salesFunnelPlanChanges.salesFunnelCampaignId, row.id));
    const last = changes.find((c) => c.reason === "switched_off")!;
    expect(last).toMatchObject({ fromSalesFunnelId: PLAN, toSalesFunnelId: OWN });
    expect(changes.filter((c) => c.reason === "plan")).toHaveLength(1);

    const history = await request(app).get(`/sales-funnel-campaigns/${row.id}/plan-changes`).set(headers);
    expect(history.body.changes[0]).toMatchObject({ reason: "switched_off", toSalesFunnelId: OWN });

    // Already home: a second switch-off writes nothing more.
    expect(await switchOffPlan(await rowOf(row.id), deps())).toBeNull();
    expect(await db.select().from(salesFunnelPlanChanges).where(eq(salesFunnelPlanChanges.salesFunnelCampaignId, row.id))).toHaveLength(2);
  });

  it("a failed restore is red and the next pass brings it home", async () => {
    const { row } = await bornCampaign();
    await checkSalesFunnelCampaignPlan(row, { apply: true }, deps());
    resolveMock.mockResolvedValueOnce({ ok: false, refusal: { status: 502, code: "catalogue_unavailable", message: "down" } });
    const headers = { "x-api-key": API_KEY, "x-org-id": ORG, "x-user-id": USER, "x-run-id": RUN };
    const off = await request(app).patch(`/sales-funnel-campaigns/${row.id}`).set(headers).send({ followsPlan: false });
    expect(off.body.salesFunnelCampaign).toMatchObject({ followsPlan: false, runningSalesFunnelId: PLAN });
    expect(off.body.salesFunnelCampaign.planCheck.state).toBe("restore_failed");
    const ops = await request(app).get("/internal/ops/plan-following?days=7").set("x-api-key", API_KEY);
    expect(ops.body.status).toBe("red");
    expect(ops.body.red.map((r: { salesFunnelCampaignId: string }) => r.salesFunnelCampaignId)).toEqual([row.id]);

    await runPlanFollowerPass(new Date(), deps());
    const home = await rowOf(row.id);
    expect(home.runningSalesFunnelId).toBe(OWN);
    expect((home.planCheck as PlanCheck).state).toBe("switched_off");
    expect((await unitsOf(row.id)).find((u) => u.featureSlug === MEETING)!.planRole).toBeNull();
  });
});

describe("a plan never drains a channel the brief names (PLAN-SWITCH-OFF-1029)", () => {
  beforeEach(async () => {
    await cleanTestData();
  });

  it("the named channel keeps running, the rest of the plan applies, red plan_contradicts_brief with the plan's id, and it stays red", async () => {
    const { row } = await bornCampaign({ brief: BRIEF });
    const d = deps();
    // The pass applies it and stores the verdict.
    await runPlanFollowerPass(new Date(), d);
    const check = (await rowOf(row.id)).planCheck as PlanCheck;
    expect(check).toMatchObject({ state: "plan_contradicts_brief", planSalesFunnelId: PLAN });
    expect(check.detail).toContain("AI Meeting Booking");

    const after = await unitsOf(row.id);
    const by = (slug: string) => after.find((u) => u.featureSlug === slug)!;
    expect(by(MEETING)).toMatchObject({ planRole: null, status: "ongoing", salesFunnelId: OWN });
    expect(by(ATTEND).planRole).toBe("draining");
    expect(by(SEND).salesFunnelId).toBe(PLAN);
    expect(by(REPLY).planRole).toBeNull();
    // Only the channels a drain was proposed for were judged.
    expect((d.judgeBrief as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1].channelSlug).sort()).toEqual([MEETING, ATTEND]);

    const [change] = await db.select().from(salesFunnelPlanChanges).where(eq(salesFunnelPlanChanges.salesFunnelCampaignId, row.id));
    expect((change.units as Array<{ pipeId: string; action: string }>).find((u) => u.pipeId.startsWith(MEETING))!.action).toBe("kept_by_brief");

    // The next pass: the plan still leaves it out, still red (and never re-judged).
    await runPlanFollowerPass(new Date(), d);
    expect((await rowOf(row.id)).planCheck).toMatchObject({ state: "plan_contradicts_brief", planSalesFunnelId: PLAN });
    expect((d.judgeBrief as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
  });

  it("the brief unjudgeable: nothing applied, red", async () => {
    const { row } = await bornCampaign({ brief: BRIEF });
    const before = await unitsOf(row.id);
    const result = await checkSalesFunnelCampaignPlan(row, { apply: true }, deps({ judge: vi.fn(async () => { throw new Error("chat-service 503"); }) }));
    expect(result.check.state).toBe("apply_failed");
    expect(result.check.detail).toContain("chat-service 503");
    const after = await unitsOf(row.id);
    expect(after.map((u) => [u.id, u.planRole, u.salesFunnelId]).sort()).toEqual(before.map((u) => [u.id, u.planRole, u.salesFunnelId]).sort());
    expect((await rowOf(row.id)).runningSalesFunnelId).toBeNull();
  });

  it("no brief: nothing judged, the plan drains as before", async () => {
    const { row } = await bornCampaign();
    const d = deps();
    const result = await checkSalesFunnelCampaignPlan(row, { apply: true }, d);
    expect(result.check.state).toBe("applied");
    expect(d.judgeBrief).not.toHaveBeenCalled();
    expect((await unitsOf(row.id)).find((u) => u.featureSlug === MEETING)!.planRole).toBe("draining");
  });
});
