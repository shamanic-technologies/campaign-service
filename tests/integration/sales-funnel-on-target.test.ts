import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";

vi.mock("@distribute/runs-client", () => ({
  createRun: vi.fn(async () => ({ id: crypto.randomUUID() })),
  updateRun: vi.fn(),
  listRuns: vi.fn(async () => ({ runs: [] })),
  getStatsBudget: vi.fn(),
}));

import app from "../../src/index.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { campaigns, campaignStatusTransitions, salesFunnelCampaigns, salesFunnelPlanChanges } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import { insertSalesFunnelCampaignWithUnits, TRANSITION_SOURCES } from "../../src/lib/campaign-status-history.js";
import { acquisitionChannelForFeature } from "../../src/lib/campaign-identity.js";
import { checkSalesFunnelCampaignPlan, dryRunPlans, switchOffPlan, RED_PLAN_STATES, type PlanDeps } from "../../src/lib/sales-funnel-plan.js";
import { moveOnTarget, runsOnItsTarget } from "../../src/lib/sales-funnel-on-target.js";

const API_KEY = process.env.CAMPAIGN_SERVICE_API_KEY || "test-api-key";
const ORG = "b645207b-0000-4000-8000-0000000000e1";
const OTHER_ORG = "b645207b-0000-4000-8000-0000000000e9";
const BRAND = "75d7e3e8-0000-4000-8000-0000000000e2";
const OFFER = "231bb036-0000-4000-8000-0000000000e3";
const USER = "cfe148ed-0000-4000-8000-0000000000e4";
const RUN = "9a1b2c3d-0000-4000-8000-0000000000e5";

const SEND = "email-sending";
const MEETING = "ai-meeting-booking";
const ATTEND = "your-team-meeting-attendance";
const OWN = `start_to_conversation@${SEND}+conversation_to_meeting_booked@${MEETING}+meeting_booked_to_meeting_attended`;
const PLAN = `start_to_conversation@${SEND}+conversation_to_paid_client`;
const TARGET = "meeting_attended";
const PIPES = [
  { featureSlug: SEND, legKey: "start_to_conversation", workflowSlug: `${SEND}-wf` },
  { featureSlug: MEETING, legKey: "conversation_to_meeting_booked", workflowSlug: `${MEETING}-wf` },
  { featureSlug: ATTEND, legKey: "meeting_booked_to_meeting_attended", workflowSlug: null },
];

async function bornCampaign(opts: { orgId?: string; target?: string | null; followsPlan?: boolean; status?: "ongoing" | "stopped" } = {}) {
  const id = crypto.randomUUID();
  await insertSalesFunnelCampaignWithUnits({
    id,
    orgId: opts.orgId ?? ORG,
    brandId: BRAND,
    offerId: OFFER,
    salesFunnelId: OWN,
    salesFunnelName: "API Email Meetings",
    status: opts.status ?? "ongoing",
    createdByUserId: USER,
    parentRunId: RUN,
    target: opts.target === undefined ? TARGET : opts.target,
    followsPlan: opts.followsPlan ?? true,
    // Its own brief: two campaigns of one identity differ by their brief.
    brief: `Brief of ${id}`,
    units: PIPES.map((u) => ({
      ...u,
      acquisitionChannel: acquisitionChannelForFeature(u.featureSlug)!,
      name: `API Email Meetings ${id.slice(0, 8)} - ${u.featureSlug}|${u.legKey}`,
    })),
  });
  return id;
}

const unitsOf = (id: string) => db.select().from(campaigns).where(eq(campaigns.salesFunnelCampaignId, id));
const rowOf = async (id: string) => (await db.select().from(salesFunnelCampaigns).where(eq(salesFunnelCampaigns.id, id)))[0];
const changesOf = (id: string) => db.select().from(salesFunnelPlanChanges).where(eq(salesFunnelPlanChanges.salesFunnelCampaignId, id));
const drain = (id: string, featureSlug: string) =>
  db.update(campaigns).set({ planRole: "draining" }).where(eq(campaigns.id, id)).then(() => featureSlug);
const post = (body: Record<string, unknown>) => request(app).post("/internal/sales-funnel-campaigns/target-move").set("x-api-key", API_KEY).send(body);

// A plan that would put the campaign back on pipes, were it still followed.
function planDeps(): PlanDeps {
  return {
    plan: vi.fn(async () => ({
      ok: true as const,
      plan: { status: "ok", failure: null, computedAt: "2026-11-24T09:58:14.000Z", pipeVerdicts: [], plan: { shadow: { funnelId: PLAN, legs: [] }, launchedNamedPipes: [] } },
    })),
    resolve: vi.fn(async (salesFunnelId: string) => ({
      ok: true as const,
      plan: {
        salesFunnelId,
        salesFunnelName: "x",
        units: PIPES.map((u) => ({ pipeId: `${u.featureSlug}|${u.legKey}`, featureSlug: u.featureSlug, legKey: u.legKey, mode: "proactive" as const, workflowSlug: u.workflowSlug, runsOnTriggerId: null })),
      },
    })),
  };
}

afterAll(async () => {
  await cleanTestData();
  await closeDb();
});

describe("a funnel campaign is moved onto its Target's Engine (PLAN-RECURSIVE-PER-ENGINE-1124-CS)", () => {
  beforeEach(async () => {
    await cleanTestData();
  });

  it("a dry run (the default) says what would move and writes nothing", async () => {
    const id = await bornCampaign();
    const before = await unitsOf(id);
    await drain(before.find((u) => u.featureSlug === ATTEND)!.id, ATTEND);
    const noTarget = await bornCampaign({ target: null });

    const res = await post({ orgId: ORG });
    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(false);
    expect(res.body.moved).toBeUndefined();
    expect(res.body.wouldMove).toHaveLength(1);
    expect(res.body.wouldMove[0]).toMatchObject({
      salesFunnelCampaignId: id,
      orgId: ORG,
      brandId: BRAND,
      salesFunnelName: "API Email Meetings",
      status: "ongoing",
      target: TARGET,
      followsPlan: true,
      pipesBefore: [`${MEETING}|conversation_to_meeting_booked`, `${SEND}|start_to_conversation`],
      pipesAfter: [`engine:${TARGET}`],
    });
    expect(res.body.wouldMove[0].units).toHaveLength(3);
    expect(res.body.wouldMove[0].units.filter((u: { action: string }) => u.action === "draining")).toHaveLength(2);
    expect(res.body.wouldMove[0].units.at(-1)).toEqual({ campaignId: null, pipeId: `engine:${TARGET}`, action: "born" });
    expect(res.body.skipped).toEqual([{ salesFunnelCampaignId: noTarget, orgId: ORG, reason: "no_target" }]);

    // Nothing written.
    const after = await unitsOf(id);
    expect(after).toHaveLength(3);
    expect(after.filter((u) => u.planRole === "draining")).toHaveLength(1);
    expect(await rowOf(id)).toMatchObject({ followsPlan: true, salesFunnelId: OWN });
    expect(await changesOf(id)).toHaveLength(0);
  });

  it("apply: ONE Engine unit born on its target, its pipes drain (never stopped), its funnel id kept, recorded; a second apply skips it", async () => {
    const id = await bornCampaign();
    const pipes = await unitsOf(id);
    const alreadyDraining = pipes.find((u) => u.featureSlug === ATTEND)!;
    await drain(alreadyDraining.id, ATTEND);
    const elsewhere = await bornCampaign({ orgId: OTHER_ORG });

    const res = await post({ apply: true, salesFunnelCampaignIds: [id] });
    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(true);
    expect(res.body.wouldMove).toBeUndefined();
    expect(res.body.moved).toHaveLength(1);
    expect(res.body.moved[0].error).toBeUndefined();

    const after = await unitsOf(id);
    expect(after).toHaveLength(4);
    const engine = after.filter((u) => u.workflowSlug === `engine:${TARGET}`);
    expect(engine).toHaveLength(1);
    expect(engine[0]).toMatchObject({
      featureSlug: null,
      legKey: null,
      acquisitionChannel: null,
      salesFunnelId: OWN,
      salesFunnelCampaignId: id,
      status: "ongoing",
      planRole: null,
      orgId: ORG,
      brandId: BRAND,
      offerId: OFFER,
    });
    expect(engine[0].name).toBe(`API Email Meetings ${id.slice(0, 8)}`);
    // Due now: the scheduler claims it on its next tick.
    expect(engine[0].nextRunAt).not.toBeNull();
    expect(engine[0].nextRunAt!.getTime()).toBeLessThanOrEqual(Date.now());
    const [birth] = await db.select().from(campaignStatusTransitions).where(eq(campaignStatusTransitions.campaignId, engine[0].id));
    expect(birth).toMatchObject({ fromStatus: null, toStatus: "ongoing", source: TRANSITION_SOURCES.SALES_FUNNEL_PLAN });

    // Every unit per pipe drains, still ON.
    for (const u of after.filter((x) => x.featureSlug)) expect(u).toMatchObject({ planRole: "draining", status: "ongoing", salesFunnelId: OWN });

    const parent = await rowOf(id);
    expect(parent).toMatchObject({ salesFunnelId: OWN, runningSalesFunnelId: OWN, followsPlan: false, status: "ongoing", target: TARGET });
    expect(runsOnItsTarget(parent, after)).toBe(true);

    const changes = await changesOf(id);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ reason: "on_target", fromSalesFunnelId: OWN, toSalesFunnelId: `engine:${TARGET}`, orgId: ORG });
    const changeUnits = changes[0].units as Array<{ campaignId: string; pipeId: string; action: string }>;
    // The one already draining is not listed again.
    expect(changeUnits.filter((u) => u.action === "draining").map((u) => u.pipeId).sort()).toEqual([`${MEETING}|conversation_to_meeting_booked`, `${SEND}|start_to_conversation`]);
    expect(changeUnits.find((u) => u.action === "born")).toEqual({ campaignId: engine[0].id, pipeId: `engine:${TARGET}`, action: "born" });
    expect(changeUnits.some((u) => u.campaignId === alreadyDraining.id)).toBe(false);
    expect(res.body.moved[0].units).toEqual(changeUnits);

    // Out of scope: untouched.
    expect(await unitsOf(elsewhere)).toHaveLength(3);
    expect((await rowOf(elsewhere)).followsPlan).toBe(true);

    // Idempotent.
    const again = await post({ apply: true, salesFunnelCampaignIds: [id] });
    expect(again.body).toEqual({ applied: true, moved: [], skipped: [{ salesFunnelCampaignId: id, orgId: ORG, reason: "already_on_target" }] });
    expect(await unitsOf(id)).toHaveLength(4);
    expect(await changesOf(id)).toHaveLength(1);
  });

  it("a stopped campaign moves in its status: its Engine unit is born stopped, never due", async () => {
    const id = await bornCampaign({ status: "stopped", followsPlan: false });
    const out = await moveOnTarget({ salesFunnelCampaignIds: [id] }, { apply: true });
    expect(out.moves).toHaveLength(1);
    const engine = (await unitsOf(id)).find((u) => u.workflowSlug === `engine:${TARGET}`)!;
    expect(engine).toMatchObject({ status: "stopped", nextRunAt: null });
    expect((await rowOf(id)).status).toBe("stopped");
  });

  it("the scope: followsPlanOnly leaves a campaign on a fixed funnel alone; orgId scopes to its org", async () => {
    const following = await bornCampaign({ followsPlan: true });
    const fixed = await bornCampaign({ followsPlan: false });
    const elsewhere = await bornCampaign({ orgId: OTHER_ORG });
    const dry = await moveOnTarget({ orgId: ORG, followsPlanOnly: true }, { apply: false });
    expect(dry.moves.map((m) => m.salesFunnelCampaignId)).toEqual([following]);
    const all = await moveOnTarget({}, { apply: false });
    const mine = new Set([following, fixed, elsewhere]);
    expect(all.moves.map((m) => m.salesFunnelCampaignId).filter((id) => mine.has(id)).sort()).toEqual([...mine].sort());
  });

  it("nothing moves it back: the plan check answers on_target (not red) and un-drains nothing, the switch-off restore and the dry run skip it", async () => {
    const id = await bornCampaign();
    await moveOnTarget({ salesFunnelCampaignIds: [id] }, { apply: true });
    const deps = planDeps();

    // Even switched back on by hand, a plan of pipes never applies.
    await db.update(salesFunnelCampaigns).set({ followsPlan: true }).where(eq(salesFunnelCampaigns.id, id));
    const check = await checkSalesFunnelCampaignPlan(await rowOf(id), { apply: true }, deps);
    expect(check.check.state).toBe("on_target");
    expect(RED_PLAN_STATES.has(check.check.state)).toBe(false);
    expect(deps.plan).not.toHaveBeenCalled();

    await db.update(salesFunnelCampaigns).set({ followsPlan: false }).where(eq(salesFunnelCampaigns.id, id));
    expect(await switchOffPlan(await rowOf(id), deps)).toBeNull();
    expect(deps.resolve).not.toHaveBeenCalled();
    expect(await dryRunPlans({ orgId: ORG }, deps)).toEqual([]);

    const after = await unitsOf(id);
    expect(after).toHaveLength(4);
    for (const u of after.filter((x) => x.featureSlug)) expect(u.planRole).toBe("draining");
    expect(await changesOf(id)).toHaveLength(1);
  });

  it("a person cannot put it back on a plan of pipes nor move its target (its Engine unit is its target's)", async () => {
    const id = await bornCampaign();
    await moveOnTarget({ salesFunnelCampaignIds: [id] }, { apply: true });
    const headers = { "x-api-key": API_KEY, "x-org-id": ORG, "x-user-id": USER, "x-run-id": RUN };
    const plan = await request(app).patch(`/sales-funnel-campaigns/${id}`).set(headers).send({ followsPlan: true });
    expect(plan.status).toBe(400);
    expect(plan.body.reason).toBe("follows_plan_needs_sales_funnel");
    const target = await request(app).patch(`/sales-funnel-campaigns/${id}`).set(headers).send({ target: "paid_client" });
    expect(target.status).toBe(409);
    expect(target.body.reason).toBe("target_fixed");
    expect(await rowOf(id)).toMatchObject({ followsPlan: false, target: TARGET });
  });

  it("the body is strict", async () => {
    expect((await post({ apply: true, brandId: BRAND })).status).toBe(400);
    expect((await post({ salesFunnelCampaignIds: [] })).status).toBe(400);
    expect((await post({ salesFunnelCampaignIds: ["not-a-uuid"] })).status).toBe(400);
  });
});
