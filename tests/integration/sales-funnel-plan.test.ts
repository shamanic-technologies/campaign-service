import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";

vi.mock("../../src/lib/sales-funnel-cap-key.js", async () => vi.importActual("../../src/lib/sales-funnel-cap-key.js"));

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
import { insertSalesFunnelCampaignWithUnits } from "../../src/lib/campaign-status-history.js";
import { acquisitionChannelForFeature } from "../../src/lib/campaign-identity.js";
import { checkSalesFunnelCampaignPlan, runPlanFollowerPass, type PlanDeps } from "../../src/lib/sales-funnel-plan.js";
import { fetchSalesFunnelCaps, resetSalesFunnelCapsCache } from "../../src/lib/sales-funnel-campaigns.js";
import { resetSalesFunnelCapKeyCache } from "../../src/lib/sales-funnel-cap-key.js";
import type { SalesFunnelUnitPlan } from "../../src/lib/startable-pair.js";

const API_KEY = process.env.CAMPAIGN_SERVICE_API_KEY || "test-api-key";
const ORG = "b645207b-0000-4000-8000-0000000000c1";
const BRAND = "75d7e3e8-0000-4000-8000-0000000000c2";
const OFFER = "231bb036-0000-4000-8000-0000000000c3";
const USER = "cfe148ed-0000-4000-8000-0000000000c4";
const RUN = "9a1b2c3d-0000-4000-8000-0000000000c5";

const SOURCE = "lead-sourcing";
const COLD = "sales-cold-email-outreach";
const MEETING = "ai-meeting-booking";
const CALL = "ai-instant-call";
const FUNNEL_A = `start_to_lead_found@${SOURCE}+lead_found_to_conversation@${COLD}+conversation_to_meeting_booked@${MEETING}`;
const FUNNEL_B = `start_to_lead_found@${SOURCE}+lead_found_to_conversation@${COLD}~valid-only+conversation_to_meeting_booked@${CALL}`;
const FUNNEL_C = `start_to_lead_found@${SOURCE}+lead_found_to_conversation@${COLD}~valid-only+conversation_to_meeting_booked@${MEETING}`;

const unitPlan = (featureSlug: string, legKey: string, mode: "proactive" | "reactive", workflowSlug: string | null = `${featureSlug}-wf`, play = ""): SalesFunnelUnitPlan => ({
  pipeId: `${featureSlug}|${legKey}${play}`,
  featureSlug,
  legKey,
  mode,
  workflowSlug,
  runsOnTriggerId: null,
});
const A_UNITS = [unitPlan(SOURCE, "start_to_lead_found", "proactive"), unitPlan(COLD, "lead_found_to_conversation", "proactive"), unitPlan(MEETING, "conversation_to_meeting_booked", "reactive")];
const B_UNITS = [unitPlan(SOURCE, "start_to_lead_found", "proactive"), unitPlan(COLD, "lead_found_to_conversation", "proactive", undefined, "~valid-only"), unitPlan(CALL, "conversation_to_meeting_booked", "reactive")];
const C_UNITS = [unitPlan(SOURCE, "start_to_lead_found", "proactive"), unitPlan(COLD, "lead_found_to_conversation", "proactive", undefined, "~valid-only"), unitPlan(MEETING, "conversation_to_meeting_booked", "reactive")];

async function bornCampaign(opts: { followsPlan: boolean; status?: "ongoing" | "stopped" }) {
  const id = crypto.randomUUID();
  const born = await insertSalesFunnelCampaignWithUnits({
    id,
    orgId: ORG,
    brandId: BRAND,
    offerId: OFFER,
    salesFunnelId: FUNNEL_A,
    salesFunnelName: "Epiphany",
    status: opts.status ?? "ongoing",
    createdByUserId: USER,
    parentRunId: RUN,
    followsPlan: opts.followsPlan,
    units: A_UNITS.map((u) => ({
      featureSlug: u.featureSlug,
      legKey: u.legKey,
      workflowSlug: u.workflowSlug,
      acquisitionChannel: acquisitionChannelForFeature(u.featureSlug)!,
      name: `Epiphany ${id.slice(0, 8)} - ${u.pipeId}`,
    })),
  });
  return born;
}

/** The plan features-service serves, and the catalogue reads the follower makes. */
function deps(planFunnel: string | null, opts: { planned?: SalesFunnelUnitPlan[]; planFails?: boolean } = {}): PlanDeps {
  return {
    plan: vi.fn(async () =>
      opts.planFails
        ? { ok: false as const, notComputed: false as const, detail: "features-service HTTP 503" }
        : {
            ok: true as const,
            plan: { status: "ok", failure: null, computedAt: "2026-10-29T09:00:00.000Z", plan: planFunnel ? { shadow: { funnelId: planFunnel, legs: [] } } : { shadow: null, shadowUnavailableReason: "no_line" } },
          },
    ),
    resolve: vi.fn(async (salesFunnelId: string) => ({
      ok: true as const,
      plan: { salesFunnelId, salesFunnelName: "Plan", units: opts.planned ?? (salesFunnelId === FUNNEL_B ? B_UNITS : salesFunnelId === FUNNEL_C ? C_UNITS : A_UNITS) },
    })),
  };
}

async function unitsOf(id: string) {
  return db.select().from(campaigns).where(eq(campaigns.salesFunnelCampaignId, id));
}

describe("a funnel campaign that follows its plan (FACTORY-P1-FOLLOW-PLAN)", () => {
  beforeEach(async () => {
    await cleanTestData();
    resetSalesFunnelCapKeyCache();
    resetSalesFunnelCapsCache();
  });
  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("a plan change reconciles the pipes: new pipe born, in-plan pipes move to the plan's plays, the leaving pipe drains (never stopped), recorded", async () => {
    const { salesFunnelCampaign } = await bornCampaign({ followsPlan: true });
    const before = await unitsOf(salesFunnelCampaign.id);
    const result = await checkSalesFunnelCampaignPlan(salesFunnelCampaign, { apply: true }, deps(FUNNEL_B));
    expect(result.check.state).toBe("applied");

    const after = await unitsOf(salesFunnelCampaign.id);
    expect(after).toHaveLength(4);
    const by = (slug: string) => after.filter((u) => u.featureSlug === slug);
    // Kept, now on the plan's funnel (so features-service reads the plan's play for it).
    expect(by(COLD)[0].salesFunnelId).toBe(FUNNEL_B);
    expect(by(COLD)[0].id).toBe(before.find((u) => u.featureSlug === COLD)!.id);
    // Born on the new pipe, ongoing like its campaign.
    expect(by(CALL)).toHaveLength(1);
    expect(by(CALL)[0].status).toBe("ongoing");
    expect(by(CALL)[0].salesFunnelId).toBe(FUNNEL_B);
    // Left the plan: still ON (its follow-ups go on), draining, never stopped.
    expect(by(MEETING)[0].status).toBe("ongoing");
    expect(by(MEETING)[0].planRole).toBe("draining");
    const transitions = await db.select().from(campaignStatusTransitions).where(eq(campaignStatusTransitions.campaignId, by(MEETING)[0].id));
    expect(transitions.every((t) => t.toStatus === "ongoing")).toBe(true);

    // The campaign's identity and status never move: its caps key stays.
    const [row] = await db.select().from(salesFunnelCampaigns).where(eq(salesFunnelCampaigns.id, salesFunnelCampaign.id));
    expect(row.salesFunnelId).toBe(FUNNEL_A);
    expect(row.status).toBe("ongoing");
    expect(row.runningSalesFunnelId).toBe(FUNNEL_B);
    const changes = await db.select().from(salesFunnelPlanChanges).where(eq(salesFunnelPlanChanges.salesFunnelCampaignId, row.id));
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ fromSalesFunnelId: FUNNEL_A, toSalesFunnelId: FUNNEL_B });
    expect((changes[0].units as Array<{ action: string }>).map((u) => u.action).sort()).toEqual(["born", "draining", "kept", "kept"]);

    // A pipe coming back into the plan takes its old unit back (no second unit), out of draining.
    const again = await checkSalesFunnelCampaignPlan(row, { apply: true }, deps(FUNNEL_C));
    expect(again.check.state).toBe("applied");
    const third = await unitsOf(row.id);
    expect(third).toHaveLength(4);
    expect(third.find((u) => u.featureSlug === MEETING)!.planRole).toBeNull();
    expect(third.find((u) => u.featureSlug === MEETING)!.salesFunnelId).toBe(FUNNEL_C);
    expect(third.find((u) => u.featureSlug === CALL)!.planRole).toBe("draining");
    expect(third.find((u) => u.featureSlug === CALL)!.status).toBe("ongoing");
  });

  it("the same plan as what runs changes nothing", async () => {
    const { salesFunnelCampaign } = await bornCampaign({ followsPlan: true });
    const result = await checkSalesFunnelCampaignPlan(salesFunnelCampaign, { apply: true }, deps(FUNNEL_A));
    expect(result.check.state).toBe("following");
    expect(await db.select().from(salesFunnelPlanChanges)).toHaveLength(0);
  });

  it("a plan read failure keeps the last run: nothing moves, the check is red", async () => {
    const { salesFunnelCampaign } = await bornCampaign({ followsPlan: true });
    const before = await unitsOf(salesFunnelCampaign.id);
    const result = await checkSalesFunnelCampaignPlan(salesFunnelCampaign, { apply: true }, deps(FUNNEL_B, { planFails: true }));
    expect(result.check.state).toBe("plan_unreadable");
    const after = await unitsOf(salesFunnelCampaign.id);
    expect(after.map((u) => [u.id, u.status, u.salesFunnelId, u.planRole]).sort()).toEqual(before.map((u) => [u.id, u.status, u.salesFunnelId, u.planRole]).sort());
    const noPlan = await checkSalesFunnelCampaignPlan(salesFunnelCampaign, { apply: true }, deps(null));
    expect(noPlan.check.state).toBe("plan_not_ready");
  });

  it("a fixed funnel is never changed; a dry run says what following would do and writes nothing", async () => {
    const { salesFunnelCampaign } = await bornCampaign({ followsPlan: false });
    const dry = await checkSalesFunnelCampaignPlan(salesFunnelCampaign, { apply: true }, deps(FUNNEL_B));
    expect(dry.check.detail).toMatch(/Dry run/);
    expect(dry.pipesBefore).toEqual([`${COLD}|lead_found_to_conversation`, `${SOURCE}|start_to_lead_found`, `${MEETING}|conversation_to_meeting_booked`].sort());
    expect(dry.pipesAfter).toEqual([`${CALL}|conversation_to_meeting_booked`, `${COLD}|lead_found_to_conversation`, `${SOURCE}|start_to_lead_found`].sort());
    expect(dry.units!.filter((u) => u.action === "born").map((u) => u.pipeId)).toEqual([`${CALL}|conversation_to_meeting_booked`]);
    expect(await db.select().from(salesFunnelPlanChanges)).toHaveLength(0);
    expect(await unitsOf(salesFunnelCampaign.id)).toHaveLength(3);
    // The pass only looks at campaigns following their plan.
    expect(await runPlanFollowerPass(new Date(), deps(FUNNEL_B))).toMatchObject({ checked: 0 });
  });

  it("caps keep applying across plan changes: a unit on the plan's funnel reads the CAMPAIGN's caps key", async () => {
    const { salesFunnelCampaign } = await bornCampaign({ followsPlan: true });
    await checkSalesFunnelCampaignPlan(salesFunnelCampaign, { apply: true }, deps(FUNNEL_B));
    const call = (await unitsOf(salesFunnelCampaign.id)).find((u) => u.featureSlug === CALL)!;
    expect(call.salesFunnelId).toBe(FUNNEL_B);
    process.env.BILLING_SERVICE_URL = "http://billing.test";
    process.env.BILLING_SERVICE_API_KEY = "k";
    const urls: string[] = [];
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ stated: true, funded: true, fundedBy: "max_budget", maxBudget: { amountCents: 1000, period: "daily", consumedCents: 0, reached: false, consumedUnavailableReason: null }, maxVolume: null, pipes: null }), { status: 200 });
    });
    try {
      const read = await fetchSalesFunnelCaps({ orgId: ORG, brandId: BRAND, offerId: OFFER, salesFunnelId: call.salesFunnelId!, salesFunnelCampaignId: salesFunnelCampaign.id });
      expect(read.ok).toBe(true);
      expect(urls[0]).toContain(`/sales-funnels/${encodeURIComponent(FUNNEL_A)}/campaigns/${salesFunnelCampaign.id}/caps`);
    } finally {
      spy.mockRestore();
    }
  });

  it("the switch is settable and served on the public routes; the history reads back", async () => {
    const { salesFunnelCampaign } = await bornCampaign({ followsPlan: false, status: "stopped" });
    const headers = { "x-api-key": API_KEY, "x-org-id": ORG, "x-user-id": USER, "x-run-id": RUN };
    const patched = await request(app).patch(`/sales-funnel-campaigns/${salesFunnelCampaign.id}`).set(headers).send({ followsPlan: true });
    expect(patched.status).toBe(200);
    expect(patched.body.salesFunnelCampaign).toMatchObject({ followsPlan: true, salesFunnelId: FUNNEL_A, runningSalesFunnelId: FUNNEL_A, status: "stopped" });
    expect(patched.body.salesFunnelCampaign.units[0]).toMatchObject({ salesFunnelId: FUNNEL_A, planRole: null });
    const history = await request(app).get(`/sales-funnel-campaigns/${salesFunnelCampaign.id}/plan-changes`).set(headers);
    expect(history.status).toBe(200);
    expect(history.body).toMatchObject({ followsPlan: true, changes: [] });
    const off = await request(app).patch(`/sales-funnel-campaigns/${salesFunnelCampaign.id}`).set(headers).send({ followsPlan: false });
    expect(off.body.salesFunnelCampaign.followsPlan).toBe(false);
    const ops = await request(app).get("/internal/ops/plan-following?days=7").set("x-api-key", API_KEY);
    expect(ops.status).toBe(200);
    expect(ops.body.status).toBe("ok");
  });
});
