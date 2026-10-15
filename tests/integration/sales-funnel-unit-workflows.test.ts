import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { cleanTestData, closeDb, insertTestCampaign } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { campaigns } from "../../src/db/schema.js";
import { adoptSalesFunnelUnitWorkflows, repairSalesFunnelUnitLegWorkflows } from "../../src/lib/sales-funnel-unit-workflows.js";

const ORG = "a1c00000-0000-4000-8000-0000000000a1";
const BRAND = "a1c00000-0000-4000-8000-0000000000a2";
const OFFER = "a1c00000-0000-4000-8000-0000000000a3";
const AIC = "ai-instant-call";
const TEAM = "your-team-booking-calls";
const AIC_LEG = "conversation_to_booking_call";
const TEAM_LEG = "booking_call_to_meeting_booked";
const FUNNEL = `${AIC_LEG}@${AIC}+${TEAM_LEG}`;
const SFC = "a1c00000-0000-4000-8000-0000000000a4";
const IDENTITY = { orgId: ORG, userId: "user_staff", runId: "run_staff" };

const deps = (opts: { allowed?: number | null; workflow?: string | null } = {}) => ({
  catalogue: async () => ({
    ok: true as const,
    operatorBySlug: new Map([[AIC, "platform" as const], [TEAM, "customer" as const]]),
    legsBySlug: new Map<string, ReadonlySet<string>>([[AIC, new Set([AIC_LEG])], [TEAM, new Set([TEAM_LEG])]]),
    legs: [],
    stepKeys: new Set<string>(),
  }),
  salesFunnel: async () => ({
    ok: true as const,
    value: {
      id: FUNNEL,
      name: "Moving",
      pipeIds: [`${AIC}|${AIC_LEG}`, `${TEAM}|${TEAM_LEG}`],
      legs: [
        { legKey: AIC_LEG, pipe: { id: `${AIC}|${AIC_LEG}` } },
        { legKey: TEAM_LEG, pipe: { id: `${TEAM}|${TEAM_LEG}` } },
      ],
    },
  }),
  pipe: async () => ({
    ok: true as const,
    value: {
      channelSlug: AIC,
      legKey: AIC_LEG,
      mode: "reactive",
      play: opts.allowed === undefined || opts.allowed === null
        ? null
        : { allowedActiveWorkflowCount: opts.allowed, excludedWorkflowDynastySlugs: [] },
    },
  }),
  workflow: async () => ({ ok: true as const, workflowSlug: opts.workflow === undefined ? "ai-instant-call-belenos-v2" : opts.workflow }),
}) as never;

async function unit(featureSlug: string, legKey: string, status = "ongoing") {
  const row = await insertTestCampaign(ORG, {
    status, featureSlug, legKey, brandIds: [BRAND], brandId: BRAND, offerId: OFFER,
    salesFunnelCampaignId: SFC, salesFunnelId: FUNNEL, nextRunAt: null,
  });
  await db.update(campaigns).set({ workflowSlug: null }).where(eq(campaigns.id, row.id));
  return row.id;
}
const rowOf = async (id: string) => (await db.query.campaigns.findFirst({ where: eq(campaigns.id, id) }))!;

describe("adopt-workflows: a platform unit born with no workflow takes its pipe's (AIC-COMMON-1015)", () => {
  beforeEach(async () => {
    await cleanTestData();
  });

  it("dry run lists the AI Instant Call unit, writes nothing, and never lists a Your team unit", async () => {
    const aic = await unit(AIC, AIC_LEG);
    await unit(TEAM, TEAM_LEG);
    const out = await adoptSalesFunnelUnitWorkflows({ apply: false, orgId: ORG, identity: IDENTITY, deps: deps() });
    expect(out.units.map((u) => [u.campaignId, u.workflowSlug])).toEqual([[aic, "ai-instant-call-belenos-v2"]]);
    expect(out.counts).toEqual({ candidates: 1, adopted: 0, skipped: 0 });
    expect((await rowOf(aic)).workflowSlug).toBeNull();
  });

  it("apply writes the workflow, makes an ongoing unit due, leaves its status, and is idempotent", async () => {
    const aic = await unit(AIC, AIC_LEG);
    const out = await adoptSalesFunnelUnitWorkflows({ apply: true, orgId: ORG, identity: IDENTITY, deps: deps() });
    expect(out.counts.adopted).toBe(1);
    const row = await rowOf(aic);
    expect(row.workflowSlug).toBe("ai-instant-call-belenos-v2");
    expect(row.status).toBe("ongoing");
    expect(row.nextRunAt).not.toBeNull();
    const again = await adoptSalesFunnelUnitWorkflows({ apply: true, orgId: ORG, identity: IDENTITY, deps: deps() });
    expect(again.counts.candidates).toBe(0);
  });

  it("a stopped unit takes its workflow and stays not due", async () => {
    const aic = await unit(AIC, AIC_LEG, "stopped");
    await adoptSalesFunnelUnitWorkflows({ apply: true, orgId: ORG, identity: IDENTITY, deps: deps() });
    const row = await rowOf(aic);
    expect(row.workflowSlug).toBe("ai-instant-call-belenos-v2");
    expect(row.status).toBe("stopped");
    expect(row.nextRunAt).toBeNull();
  });

  it("a play allowing no workflow, or a channel with none active, is skipped and nothing is written", async () => {
    const aic = await unit(AIC, AIC_LEG);
    const held = await adoptSalesFunnelUnitWorkflows({ apply: true, orgId: ORG, identity: IDENTITY, deps: deps({ allowed: 0 }) });
    expect(held.units[0].skipped).toBe("play_allows_no_workflow");
    const none = await adoptSalesFunnelUnitWorkflows({ apply: true, orgId: ORG, identity: IDENTITY, deps: deps({ workflow: null }) });
    expect(none.units[0].skipped).toBe("no_workflow");
    expect((await rowOf(aic)).workflowSlug).toBeNull();
  });
});

describe("leg-workflow-repair: a unit stores a workflow features-service assigns to ITS leg (CAMPAIGN-FALLBACK-WORKFLOW-LEG-1015)", () => {
  const COLD = "sales-cold-email-outreach";
  const REPLY = "lead_found_to_conversation";
  const VISIT = "lead_found_to_website_visit";
  const COLD_FUNNEL = `${REPLY}@${COLD}+conversation_to_paid_client`;
  // features-service's leg ranking (first choice first), and the play's exclusion on the reply pipe.
  const assignedByLeg: Record<string, string[]> = {
    [REPLY]: [`${COLD}-uklun`, `${COLD}-miaplacidus`, `${COLD}-mebsuta`],
    [VISIT]: [`${COLD}-lyonesse`, `${COLD}-denebola`],
  };
  const repairDeps = (over: { assigned?: (i: { legKey: string }) => Promise<string[] | null> } = {}) => ({
    catalogue: async () => ({
      ok: true as const,
      operatorBySlug: new Map([[COLD, "platform" as const], [TEAM, "customer" as const]]),
      legsBySlug: new Map<string, ReadonlySet<string>>([[COLD, new Set([REPLY, VISIT])]]),
      legs: [],
      stepKeys: new Set<string>(),
    }),
    salesFunnel: async () => ({
      ok: true as const,
      value: {
        id: COLD_FUNNEL,
        name: "Merrily",
        pipeIds: [`${COLD}|${REPLY}`, `${COLD}|${VISIT}`],
        legs: [
          { legKey: REPLY, pipe: { id: `${COLD}|${REPLY}` } },
          { legKey: VISIT, pipe: { id: `${COLD}|${VISIT}` } },
        ],
      },
    }),
    pipe: async (id: string) => ({
      ok: true as const,
      value: {
        channelSlug: COLD,
        legKey: id.split("|")[1],
        mode: "proactive",
        play: id.endsWith(REPLY)
          ? { allowedActiveWorkflowCount: 2, excludedWorkflowDynastySlugs: [`${COLD}-mebsuta`] }
          : null,
      },
    }),
    assigned: over.assigned ?? (async (i: { legKey: string }) => assignedByLeg[i.legKey]),
    // A stored VERSION slug belongs to its dynasty (workflow-service's statement).
    dynasties: async () => ({ ok: true as const, dynastyBySlug: new Map([[`${COLD}-miaplacidus-v3`, `${COLD}-miaplacidus`]]) }),
  }) as never;

  async function coldUnit(legKey: string, workflowSlug: string, status = "ongoing") {
    const row = await insertTestCampaign(ORG, {
      status, featureSlug: COLD, legKey, brandIds: [BRAND], brandId: BRAND, offerId: OFFER,
      salesFunnelCampaignId: SFC, salesFunnelId: COLD_FUNNEL, nextRunAt: null, workflowSlug,
    });
    return row.id;
  }

  beforeEach(async () => {
    await cleanTestData();
  });

  it("dry run lists the reply unit storing a website-visit workflow, writes nothing; an eligible version slug is kept", async () => {
    const merrily = await coldUnit(REPLY, `${COLD}-denebola`);
    const version = await coldUnit(REPLY, `${COLD}-miaplacidus-v3`);
    const landmark = await coldUnit(VISIT, `${COLD}-denebola`, "stopped");
    const out = await repairSalesFunnelUnitLegWorkflows({ apply: false, orgId: ORG, identity: IDENTITY, deps: repairDeps() });
    const byId = new Map(out.units.map((u) => [u.campaignId, u]));
    expect(byId.get(merrily)).toMatchObject({ eligible: false, workflowSlug: `${COLD}-uklun`, storedWorkflowSlug: `${COLD}-denebola` });
    expect(byId.get(version)).toMatchObject({ eligible: true, workflowSlug: null });
    expect(byId.get(landmark)).toMatchObject({ eligible: true });
    expect(out.counts).toMatchObject({ checked: 3, eligible: 2, ineligible: 1, ineligibleOngoing: 1, repaired: 0 });
    expect((await rowOf(merrily)).workflowSlug).toBe(`${COLD}-denebola`);
  });

  it("apply writes features-service's first choice, never touches status or next_run_at, and is idempotent", async () => {
    const merrily = await coldUnit(REPLY, `${COLD}-denebola`);
    const out = await repairSalesFunnelUnitLegWorkflows({ apply: true, orgId: ORG, identity: IDENTITY, deps: repairDeps() });
    expect(out.counts.repaired).toBe(1);
    const row = await rowOf(merrily);
    expect(row.workflowSlug).toBe(`${COLD}-uklun`);
    expect(row.status).toBe("ongoing");
    expect(row.nextRunAt).toBeNull();
    const again = await repairSalesFunnelUnitLegWorkflows({ apply: true, orgId: ORG, identity: IDENTITY, deps: repairDeps() });
    expect(again.counts).toMatchObject({ ineligible: 0, repaired: 0 });
  });

  it("a workflow the pipe's PLAY rules out is not eligible either, and is replaced by an allowed one", async () => {
    const unitId = await coldUnit(REPLY, `${COLD}-mebsuta`);
    await repairSalesFunnelUnitLegWorkflows({ apply: true, orgId: ORG, identity: IDENTITY, deps: repairDeps() });
    expect((await rowOf(unitId)).workflowSlug).toBe(`${COLD}-uklun`);
  });

  it("a channel features-service does not rank, or a leg with nothing left, is listed and never written", async () => {
    const unitId = await coldUnit(REPLY, `${COLD}-denebola`);
    const unranked = await repairSalesFunnelUnitLegWorkflows({ apply: true, orgId: ORG, identity: IDENTITY, deps: repairDeps({ assigned: async () => null }) });
    expect(unranked.units[0].skipped).toBe("channel_not_ranked");
    const empty = await repairSalesFunnelUnitLegWorkflows({ apply: true, orgId: ORG, identity: IDENTITY, deps: repairDeps({ assigned: async () => [] }) });
    expect(empty.units[0]).toMatchObject({ eligible: false, skipped: "no_eligible_workflow" });
    expect((await rowOf(unitId)).workflowSlug).toBe(`${COLD}-denebola`);
  });

  it("a unit whose funnel the catalogue no longer knows is listed, and the pass goes on", async () => {
    const gone = await coldUnit(REPLY, `${COLD}-denebola`);
    const deps = repairDeps() as unknown as Record<string, unknown>;
    const out = await repairSalesFunnelUnitLegWorkflows({
      apply: true, orgId: ORG, identity: IDENTITY,
      deps: { ...deps, salesFunnel: async () => ({ ok: false as const, notFound: true as const, detail: "404" }) } as never,
    });
    expect(out.units).toEqual([expect.objectContaining({ campaignId: gone, skipped: "sales_funnel_not_found" })]);
    expect((await rowOf(gone)).workflowSlug).toBe(`${COLD}-denebola`);
  });

  it("a customer-operated unit is never checked", async () => {
    const row = await insertTestCampaign(ORG, {
      status: "ongoing", featureSlug: TEAM, legKey: TEAM_LEG, brandIds: [BRAND], brandId: BRAND, offerId: OFFER,
      salesFunnelCampaignId: SFC, salesFunnelId: COLD_FUNNEL, nextRunAt: null, workflowSlug: "anything",
    });
    const out = await repairSalesFunnelUnitLegWorkflows({ apply: false, orgId: ORG, identity: IDENTITY, deps: repairDeps() });
    expect(out.units.map((u) => u.campaignId)).not.toContain(row.id);
  });
});

afterAll(async () => {
  await cleanTestData();
  await closeDb();
});
