import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";

// MIGRATE-1105 S8 (BACKLINK-ENGINE-1109): a campaign is Target + start + budget + brief. Launched with a target and no
// sales funnel, it owns ONE unit with no channel, born on that outcome's Engine, and the scheduler dispatches it there.

const { mockExecute, mockPlan, mockCatalogue, mockFunnel, mockSelection } = vi.hoisted(() => ({
  mockExecute: vi.fn(),
  mockPlan: vi.fn(),
  mockCatalogue: vi.fn(),
  mockFunnel: vi.fn(),
  mockSelection: vi.fn(),
}));

vi.mock("@distribute/runs-client", () => ({
  createRun: vi.fn(async () => ({ id: crypto.randomUUID() })),
  updateRun: vi.fn(),
  listRuns: vi.fn(async () => ({ runs: [] })),
  getStatsBudget: vi.fn(),
}));

vi.mock("../../src/lib/startable-pair.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/startable-pair.js")>()),
  resolveSalesFunnelPlan: mockPlan,
}));

vi.mock("../../src/lib/channel-operator-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/channel-operator-client.js")>()),
  fetchChannelCatalogue: mockCatalogue,
}));

vi.mock("../../src/lib/sales-funnel-catalogue-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/sales-funnel-catalogue-client.js")>()),
  fetchSalesFunnel: mockFunnel,
}));

vi.mock("../../src/lib/features-workflow-projection-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/features-workflow-projection-client.js")>()),
  resolveSelectionForTrigger: mockSelection,
}));

vi.mock("../../src/lib/workflows.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/workflows.js")>()),
  executeCampaignWorkflow: mockExecute,
}));

// Funded: the dispatch under test is the Engine's.
vi.mock("../../src/lib/sales-funnel-campaigns.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/sales-funnel-campaigns.js")>()),
  salesFunnelUnitMoney: vi.fn().mockResolvedValue({ run: true, pace: { spentCents: 0, ceilingCents: 500 } }),
}));

import app from "../../src/index.js";
import { eq } from "drizzle-orm";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { campaigns, salesFunnelCampaigns } from "../../src/db/schema.js";
import { EngineStateUnreadableError, liveEngineFor } from "../../src/lib/engine-dispatch.js";
import { reRunDueCampaigns } from "../../src/lib/scheduler.js";
import { completeSalesFunnelUnits } from "../../src/lib/sales-funnel-unit-completion.js";
import { runSalesFunnelNameRepair } from "../../src/lib/sales-funnel-name.js";
import { dryRunPlans } from "../../src/lib/sales-funnel-plan.js";
import { repairSalesFunnelUnitLegWorkflows } from "../../src/lib/sales-funnel-unit-workflows.js";

const API_KEY = process.env.CAMPAIGN_SERVICE_API_KEY || "test-api-key";
const ORG = "b645207b-0000-4000-8000-0000000000c1";
const BRAND = "75d7e3e8-0000-4000-8000-0000000000c2";
const OFFER = "231bb036-0000-4000-8000-0000000000c3";
const TARGET = "backlink_earned";

const CATALOGUE = {
  ok: true,
  operatorBySlug: new Map(),
  legsBySlug: new Map(),
  legs: [],
  stepKeys: new Set(["lead_found", "paid_client", "backlink_earned", "industry_news_found"]),
};

const withPerson = (r: request.Test) =>
  r.set("x-api-key", API_KEY).set("x-org-id", ORG).set("x-user-id", "user_target_only").set("x-run-id", crypto.randomUUID());
const launch = (body: Record<string, unknown>) =>
  withPerson(request(app).post("/sales-funnel-campaigns")).send({ brandId: BRAND, offerId: OFFER, status: "ongoing", target: TARGET, ...body });
const patch = (id: string, body: Record<string, unknown>) => withPerson(request(app).patch(`/sales-funnel-campaigns/${id}`)).send(body);

const live = (outcome: string) => ({ outcome, fromOutcome: "start" });

describe("a campaign on its target alone (no sales funnel), run by its Engine", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await cleanTestData();
    mockCatalogue.mockResolvedValue(CATALOGUE);
    mockExecute.mockResolvedValue({ runId: "engine-run-1" });
    vi.mocked(liveEngineFor).mockImplementation(async (c) => (c.workflowSlug?.startsWith("engine:") ? live(c.workflowSlug.slice(7)) : null));
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("is born with ONE unit, no channel, on its Engine, without reading any sales funnel; launched twice it is one campaign", async () => {
    const res = await launch({ brief: "Earn backlinks from industry blogs." }).expect(201);
    const fc = res.body.salesFunnelCampaign;
    expect(res.body).toMatchObject({ created: true, started: true });
    expect(fc).toMatchObject({
      salesFunnelId: TARGET,
      salesFunnelName: TARGET,
      target: TARGET,
      mode: "proactive",
      triggerId: null,
      followsPlan: false,
      status: "ongoing",
      brief: "Earn backlinks from industry blogs.",
    });
    expect(fc.units).toHaveLength(1);
    expect(fc.units[0]).toMatchObject({ pipeId: null, featureSlug: null, legKey: null, workflowSlug: "engine:backlink_earned", status: "ongoing", salesFunnelId: TARGET });
    expect(mockPlan).not.toHaveBeenCalled();
    expect(liveEngineFor).toHaveBeenCalledWith({ featureSlug: null, legKey: null, workflowSlug: "engine:backlink_earned" }, ORG);

    const [unit] = await db.select().from(campaigns).where(eq(campaigns.salesFunnelCampaignId, fc.id));
    expect(unit).toMatchObject({ acquisitionChannel: null, featureSlug: null, legKey: null, brandId: BRAND, offerId: OFFER, salesFunnelId: TARGET });
    expect(unit.nextRunAt).not.toBeNull();

    const again = await launch({}).expect(200);
    expect(again.body).toMatchObject({ created: false });
    expect(again.body.salesFunnelCampaign.id).toBe(fc.id);
    expect(await db.select().from(salesFunnelCampaigns)).toHaveLength(1);
  });

  it("refuses, by name and writing nothing, what a campaign on its target alone cannot do", async () => {
    expect((await launch({ target: undefined }).expect(400)).body.reason).toBe("target_required");
    expect((await launch({ followsPlan: true }).expect(400)).body.reason).toBe("follows_plan_needs_sales_funnel");
    expect((await launch({ people: [{ email: "staff@distribute.you" }] }).expect(400)).body.reason).toBe("people_need_reactive_funnel");
    expect((await launch({ githubIssue: { repo: "shamanic-technologies/campaign-service", number: 1 } }).expect(400)).body.reason).toBe("github_issue_needs_github_trigger");
    expect((await launch({ target: "not_a_step" }).expect(400)).body.reason).toBe("unknown_target_step");

    vi.mocked(liveEngineFor).mockResolvedValueOnce(null);
    const notLive = await launch({}).expect(409);
    expect(notLive.body.reason).toBe("engine_not_live");
    expect(notLive.body.error).toContain("backlink_earned");

    vi.mocked(liveEngineFor).mockRejectedValueOnce(new EngineStateUnreadableError("workflow-service down"));
    expect((await launch({}).expect(502)).body.reason).toBe("engine_state_unavailable");

    expect(await db.select().from(salesFunnelCampaigns)).toHaveLength(0);
    expect(await db.select().from(campaigns)).toHaveLength(0);
  });

  it("keeps its target (its unit IS that Engine) and follows no plan; everything else edits as on any campaign", async () => {
    const fc = (await launch({ status: "stopped" }).expect(201)).body.salesFunnelCampaign;
    expect((await patch(fc.id, { target: "industry_news_found" }).expect(409)).body.reason).toBe("target_fixed");
    expect((await patch(fc.id, { followsPlan: true }).expect(400)).body.reason).toBe("follows_plan_needs_sales_funnel");
    const edited = (await patch(fc.id, { target: TARGET, brief: "Only DR50+ sites." }).expect(200)).body.salesFunnelCampaign;
    expect(edited).toMatchObject({ target: TARGET, brief: "Only DR50+ sites.", salesFunnelId: TARGET });
    const started = (await patch(fc.id, { status: "activate" }).expect(200)).body.salesFunnelCampaign;
    expect(started.units.map((u: { status: string }) => u.status)).toEqual(["ongoing"]);
  });

  it("is dispatched by the scheduler to its Engine: no audience pick, no workflow pick, no channel", async () => {
    const fc = (await launch({}).expect(201)).body.salesFunnelCampaign;
    await db.update(campaigns).set({ nextRunAt: new Date(Date.now() - 1_000) }).where(eq(campaigns.salesFunnelCampaignId, fc.id));

    await reRunDueCampaigns();

    expect(mockSelection).not.toHaveBeenCalled();
    expect(mockExecute).toHaveBeenCalledTimes(1);
    const [slug, inputs, engine] = mockExecute.mock.calls[0];
    expect(slug).toBe("engine:backlink_earned");
    expect(engine).toEqual(live(TARGET));
    expect(inputs).toMatchObject({ campaignId: fc.units[0].campaignId, orgId: ORG, brandId: BRAND, featureSlug: null, audienceId: null, noAudience: true });
  });

  it("is a failed dispatch, never a workflow run, when its Engine stops running the org's campaigns", async () => {
    const fc = (await launch({}).expect(201)).body.salesFunnelCampaign;
    await db.update(campaigns).set({ nextRunAt: new Date(Date.now() - 1_000) }).where(eq(campaigns.salesFunnelCampaignId, fc.id));
    vi.mocked(liveEngineFor).mockResolvedValue(null);

    await reRunDueCampaigns();

    expect(mockExecute).not.toHaveBeenCalled();
    const [unit] = await db.select().from(campaigns).where(eq(campaigns.salesFunnelCampaignId, fc.id));
    expect(unit.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it("is left alone by the staff jobs that work on sales funnels (none throws, none lists it)", async () => {
    await launch({}).expect(201);
    // A funnel id the catalogue does not serve: any job that asked it about this campaign would throw or list it.
    mockFunnel.mockResolvedValue({ ok: false, notFound: true, detail: "404" });

    const completion = await completeSalesFunnelUnits({ apply: true, orgId: ORG });
    expect(completion.funnelCampaigns).toEqual([]);

    const names = await runSalesFunnelNameRepair({ apply: false, orgId: ORG, fetchFunnel: mockFunnel });
    expect(names).toMatchObject({ renamed: [], skipped: [] });

    expect(await dryRunPlans({ orgId: ORG })).toEqual([]);

    const legs = await repairSalesFunnelUnitLegWorkflows({ apply: false, orgId: ORG, identity: { orgId: ORG, userId: "u", runId: "r" } });
    expect(legs.units).toEqual([]);
    expect(mockFunnel).not.toHaveBeenCalled();
  });
});
