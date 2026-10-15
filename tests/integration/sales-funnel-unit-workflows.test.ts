import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { cleanTestData, closeDb, insertTestCampaign } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { campaigns } from "../../src/db/schema.js";
import { adoptSalesFunnelUnitWorkflows } from "../../src/lib/sales-funnel-unit-workflows.js";

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

afterAll(async () => {
  await cleanTestData();
  await closeDb();
});
