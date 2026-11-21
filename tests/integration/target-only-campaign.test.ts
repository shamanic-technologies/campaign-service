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
  getOutcomePerformerStats: vi.fn(),
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
  fetchSalesFunnelCaps: vi.fn(),
}));

import app from "../../src/index.js";
import { eq } from "drizzle-orm";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { campaigns, salesFunnelCampaigns } from "../../src/db/schema.js";
import { EngineStateUnreadableError, liveEngineFor } from "../../src/lib/engine-dispatch.js";
import { fetchSalesFunnelCaps } from "../../src/lib/sales-funnel-campaigns.js";
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
  stepKeys: new Set(["lead_found", "paid_client", "backlink_earned", "industry_news_found", "unlabelled_outcome"]),
  stepLabels: new Map([["backlink_earned", "Backlink earned"], ["industry_news_found", "Industry news found"]]),
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

  it("is born with ONE unit, no channel, on its Engine, without reading any sales funnel; launched twice it is one campaign", async () => {
    const res = await launch({ brief: "Earn backlinks from industry blogs." }).expect(201);
    const fc = res.body.salesFunnelCampaign;
    expect(res.body).toMatchObject({ created: true, started: true });
    expect(fc).toMatchObject({
      salesFunnelId: TARGET,
      // The outcome's label as the catalogue publishes it, never its key.
      salesFunnelName: "Backlink earned",
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
    expect(unit.name).toBe(`Backlink earned ${fc.id.slice(0, 8)}`);
    expect(unit.nextRunAt).not.toBeNull();

    const again = await launch({}).expect(200);
    expect(again.body).toMatchObject({ created: false });
    expect(again.body.salesFunnelCampaign.id).toBe(fc.id);
    expect(await db.select().from(salesFunnelCampaigns)).toHaveLength(1);
  });

  it("two campaigns of one brand on the same target live side by side, each under its own launchKey and brief (OUTREACH-3WAYS-1121)", async () => {
    // Today's call (no launchKey): the brand's one campaign on the target.
    const first = (await launch({ brief: "Earn backlinks from industry blogs." }).expect(201)).body.salesFunnelCampaign;
    expect(first.launchKey).toBeNull();

    const investors = await launch({ launchKey: "Investors", brief: "Start a conversation with equity investors." }).expect(201);
    const peers = await launch({ launchKey: "industry-peers", brief: "Network with peers in our industry." }).expect(201);
    const inv = investors.body.salesFunnelCampaign;
    const peer = peers.body.salesFunnelCampaign;
    expect(investors.body).toMatchObject({ created: true, started: true });
    expect(inv).toMatchObject({ launchKey: "investors", target: TARGET, salesFunnelId: TARGET, brief: "Start a conversation with equity investors." });
    expect(peer).toMatchObject({ launchKey: "industry-peers", target: TARGET, salesFunnelId: TARGET, brief: "Network with peers in our industry." });
    expect(new Set([first.id, inv.id, peer.id]).size).toBe(3);
    // Each owns its own unit (its own Engine run, its own caps at billing: keyed on the funnel campaign id).
    expect(new Set([first.units[0].campaignId, inv.units[0].campaignId, peer.units[0].campaignId]).size).toBe(3);

    // No create ever rewrites another campaign's brief.
    const rows = await db.select().from(salesFunnelCampaigns);
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.id === first.id)!.brief).toBe("Earn backlinks from industry blogs.");

    // The same key again hands that campaign back (key compared case-insensitively), never a third.
    const invAgain = await launch({ launchKey: "investors" }).expect(200);
    expect(invAgain.body).toMatchObject({ created: false });
    expect(invAgain.body.salesFunnelCampaign.id).toBe(inv.id);
    expect(invAgain.body.salesFunnelCampaign.brief).toBe("Start a conversation with equity investors.");

    // An old-style call (no launchKey) still answers the brand's one campaign, never a keyed one.
    const old = await launch({}).expect(200);
    expect(old.body).toMatchObject({ created: false });
    expect(old.body.salesFunnelCampaign.id).toBe(first.id);
    expect(await db.select().from(salesFunnelCampaigns)).toHaveLength(3);
  });

  it("refuses a launchKey that is not a short name", async () => {
    expect((await launch({ launchKey: "" }).expect(400)).body).toBeDefined();
    expect((await launch({ launchKey: "two words" }).expect(400)).body).toBeDefined();
    expect((await launch({ launchKey: "x".repeat(65) }).expect(400)).body).toBeDefined();
    expect(await db.select().from(salesFunnelCampaigns)).toHaveLength(0);
  });

  it("refuses, by name and writing nothing, what a campaign on its target alone cannot do", async () => {
    expect((await launch({ target: undefined }).expect(400)).body.reason).toBe("target_required");
    expect((await launch({ followsPlan: true }).expect(400)).body.reason).toBe("follows_plan_needs_sales_funnel");
    expect((await launch({ people: [{ email: "staff@distribute.you" }] }).expect(400)).body.reason).toBe("people_need_reactive_funnel");
    expect((await launch({ githubIssue: { repo: "shamanic-technologies/campaign-service", number: 1 } }).expect(400)).body.reason).toBe("github_issue_needs_github_trigger");
    expect((await launch({ target: "not_a_step" }).expect(400)).body.reason).toBe("unknown_target_step");

    // An outcome the catalogue publishes no label for: refused loud, never named after its key.
    const unlabelled = await launch({ target: "unlabelled_outcome" }).expect(502);
    expect(unlabelled.body.reason).toBe("target_label_missing");

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

  it("born under its key before labels were read, is renamed to its outcome's label by the name repair (row + unit)", async () => {
    const fc = (await launch({}).expect(201)).body.salesFunnelCampaign;
    const tag = fc.id.slice(0, 8);
    // The rows #883 wrote (prod 0380de8a): the key as name.
    await db.update(salesFunnelCampaigns).set({ salesFunnelName: TARGET }).where(eq(salesFunnelCampaigns.id, fc.id));
    await db.update(campaigns).set({ name: `${TARGET} ${tag}` }).where(eq(campaigns.salesFunnelCampaignId, fc.id));

    const dry = await runSalesFunnelNameRepair({ apply: false, orgId: ORG, fetchFunnel: mockFunnel });
    expect(dry.renamed).toHaveLength(1);
    expect(dry.renamed[0]).toMatchObject({ salesFunnelCampaignId: fc.id, from: TARGET, to: "Backlink earned", nameSource: "catalogue" });
    expect(dry.renamed[0].units).toEqual([{ campaignId: fc.units[0].campaignId, from: `${TARGET} ${tag}`, to: `Backlink earned ${tag}` }]);

    await runSalesFunnelNameRepair({ apply: true, orgId: ORG, fetchFunnel: mockFunnel });
    const [row] = await db.select().from(salesFunnelCampaigns).where(eq(salesFunnelCampaigns.id, fc.id));
    expect(row).toMatchObject({ salesFunnelName: "Backlink earned", salesFunnelId: TARGET, target: TARGET });
    const [unit] = await db.select().from(campaigns).where(eq(campaigns.salesFunnelCampaignId, fc.id));
    expect(unit.name).toBe(`Backlink earned ${tag}`);
    // Idempotent.
    expect((await runSalesFunnelNameRepair({ apply: true, orgId: ORG, fetchFunnel: mockFunnel })).renamed).toEqual([]);
    expect(mockFunnel).not.toHaveBeenCalled();
  });

  it("is skipped by name, never renamed to its key, when the catalogue publishes no label for its target", async () => {
    const fc = (await launch({}).expect(201)).body.salesFunnelCampaign;
    mockCatalogue.mockResolvedValue({ ...CATALOGUE, stepLabels: new Map() });
    const res = await runSalesFunnelNameRepair({ apply: true, orgId: ORG, fetchFunnel: mockFunnel });
    expect(res.renamed).toEqual([]);
    expect(res.skipped).toEqual([expect.objectContaining({ salesFunnelCampaignId: fc.id, reason: expect.stringContaining("target_label_missing") })]);
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

// DISTRY-CALL-IS-CAMPAIGN-1121 (owner 2026-11-21): a campaign is Target + start + budget + brief; the OFFER is optional on
// a campaign on its target alone. Every answer says WHEN its first run will happen; a progress read says what it made.
describe("a campaign on its target alone naming NO offer", () => {
  const launchNoOffer = (body: Record<string, unknown> = {}) =>
    withPerson(request(app).post("/sales-funnel-campaigns")).send({ brandId: BRAND, status: "ongoing", target: TARGET, brief: "One backlink.", ...body });

  beforeEach(async () => {
    vi.clearAllMocks();
    await cleanTestData();
    mockCatalogue.mockResolvedValue(CATALOGUE);
    mockExecute.mockResolvedValue({ runId: "engine-run-1" });
    vi.mocked(liveEngineFor).mockImplementation(async (c) => (c.workflowSlug?.startsWith("engine:") ? live(c.workflowSlug.slice(7)) : null));
  });

  it("is born with offerId null on the row and its unit, and its answer names its first run", async () => {
    const res = await launchNoOffer().expect(201);
    const fc = res.body.salesFunnelCampaign;
    expect(fc).toMatchObject({ offerId: null, target: TARGET, salesFunnelId: TARGET, status: "ongoing" });
    expect(res.body.nextRun).toMatchObject({ state: "scheduled", withinSeconds: 60, reason: null });
    expect(Date.parse(res.body.nextRun.at)).toBeLessThanOrEqual(Date.now() + 1000);
    const [unit] = await db.select().from(campaigns).where(eq(campaigns.salesFunnelCampaignId, fc.id));
    expect(unit).toMatchObject({ offerId: null, workflowSlug: "engine:backlink_earned", status: "ongoing" });
  });

  it("is ONE campaign per (org, brand, no offer, target): launched again it is handed back; naming an offer is another", async () => {
    const first = await launchNoOffer().expect(201);
    const again = await launchNoOffer().expect(200);
    expect(again.body).toMatchObject({ created: false });
    expect(again.body.salesFunnelCampaign.id).toBe(first.body.salesFunnelCampaign.id);
    expect(again.body.nextRun.state).toBe("scheduled");
    const withOffer = await launch({}).expect(201);
    expect(withOffer.body.salesFunnelCampaign).toMatchObject({ offerId: OFFER });
    expect(await db.select().from(salesFunnelCampaigns)).toHaveLength(2);
  });

  it("refuses a SALES FUNNEL with no offer (a funnel sells one), writing nothing", async () => {
    const res = await launchNoOffer({ salesFunnelId: "lead_found_to_paid_client@x" }).expect(400);
    expect(res.body.reason).toBe("offer_required");
    expect(mockPlan).not.toHaveBeenCalled();
    expect(await db.select().from(salesFunnelCampaigns)).toHaveLength(0);
  });

  it("stopped then started: the stop says stopped, the start names its first run", async () => {
    const born = await launchNoOffer({ status: "stopped" }).expect(201);
    expect(born.body.nextRun).toMatchObject({ state: "stopped", at: null });
    const started = await patch(born.body.salesFunnelCampaign.id, { status: "activate" }).expect(200);
    expect(started.body.nextRun).toMatchObject({ state: "scheduled" });
  });

  it("serves its progress: spend from the ledger, caps from billing (named when unreadable, never 0), and its next run", async () => {
    const { getStatsBudget } = await import("@distribute/runs-client");
    vi.mocked(getStatsBudget).mockResolvedValue({
      windows: [{ label: "all", totalCostInUsdCents: "42.5", actualCostInUsdCents: "42.5", provisionedCostInUsdCents: "0", netTotalCostInUsdCents: "40" } as never],
    });
    vi.mocked(fetchSalesFunnelCaps).mockResolvedValue({ ok: false, detail: "billing not configured" } as never);
    const born = await launchNoOffer().expect(201);
    const res = await withPerson(request(app).get(`/sales-funnel-campaigns/${born.body.salesFunnelCampaign.id}/progress`)).expect(200);
    expect(res.body).toMatchObject({
      salesFunnelCampaignId: born.body.salesFunnelCampaign.id,
      status: "ongoing",
      target: TARGET,
      spend: { spentCents: 40, spentBeforeDiscountCents: 42.5 },
      finished: false,
      nextRun: { state: "scheduled" },
    });
    // runs-service's Units read is not mocked here: the units figure says why it is missing, never a 0.
    expect(res.body.units.made).toBeNull();
    expect(res.body.units.unavailableReason).toMatch(/^runs_unavailable/);
    await withPerson(request(app).get(`/sales-funnel-campaigns/${crypto.randomUUID()}/progress`)).expect(404);
  });

  // DISTRY-CALL-IS-CAMPAIGN-1121 follow-up (prod 2026-11-21 campaign 47f39eea: 16 newsletter drafts, $1 one-off budget,
  // no max volume, progress said made null `no_max_volume`).
  it("budget-only: counts the Units of its target its runs produced since birth, off the ledger", async () => {
    const { getStatsBudget, getOutcomePerformerStats } = await import("@distribute/runs-client");
    vi.mocked(getStatsBudget).mockResolvedValue({ windows: [{ label: "all", totalCostInUsdCents: "41.38", actualCostInUsdCents: "41.38", provisionedCostInUsdCents: "0" } as never] });
    vi.mocked(fetchSalesFunnelCaps).mockResolvedValue({ ok: true, caps: { maxBudget: { amountCents: "100", period: "one_off", consumedCents: "41.38", reached: false }, maxVolume: null } } as never);
    vi.mocked(getOutcomePerformerStats).mockResolvedValue({ since: "", until: "", groupBy: ["outcomeKey"], groups: [], totals: { count: 16, quantity: "16" } });
    const born = await launchNoOffer().expect(201);
    const id = born.body.salesFunnelCampaign.id;
    const res = await withPerson(request(app).get(`/sales-funnel-campaigns/${id}/progress`)).expect(200);
    expect(res.body.units).toEqual({ made: 16, maxVolume: null, period: null, unit: TARGET, unavailableReason: null });
    expect(res.body.spend).toMatchObject({ spentCents: 41.38 });
    const [unit] = await db.select().from(campaigns).where(eq(campaigns.salesFunnelCampaignId, id));
    expect(vi.mocked(getOutcomePerformerStats)).toHaveBeenCalledWith(expect.objectContaining({
      orgId: ORG, campaignId: unit.id, outcomeKey: TARGET, until: new Date().toISOString().slice(0, 10),
    }));
  });

  it("budget-only, ledger unreadable: made null with the reason, never 0", async () => {
    const { getStatsBudget, getOutcomePerformerStats } = await import("@distribute/runs-client");
    vi.mocked(getStatsBudget).mockResolvedValue({ windows: [] });
    vi.mocked(fetchSalesFunnelCaps).mockResolvedValue({ ok: true, caps: { maxBudget: null, maxVolume: null } } as never);
    vi.mocked(getOutcomePerformerStats).mockRejectedValue(new Error("runs-service GET down: 503"));
    const born = await launchNoOffer().expect(201);
    const res = await withPerson(request(app).get(`/sales-funnel-campaigns/${born.body.salesFunnelCampaign.id}/progress`)).expect(200);
    expect(res.body.units.made).toBeNull();
    expect(res.body.units.unavailableReason).toMatch(/^runs_unavailable: runs-service GET down/);
  });

  it("volume-capped: billing's figure and cap, unchanged; the ledger is not asked", async () => {
    const { getStatsBudget, getOutcomePerformerStats } = await import("@distribute/runs-client");
    vi.mocked(getStatsBudget).mockResolvedValue({ windows: [] });
    vi.mocked(fetchSalesFunnelCaps).mockResolvedValue({ ok: true, caps: { maxBudget: null, maxVolume: { count: 5, period: "one_off", unit: "outcomes_produced", consumed: 3, reached: false, consumedUnavailableReason: null } } } as never);
    const born = await launchNoOffer().expect(201);
    const res = await withPerson(request(app).get(`/sales-funnel-campaigns/${born.body.salesFunnelCampaign.id}/progress`)).expect(200);
    expect(res.body.units).toEqual({ made: 3, maxVolume: 5, period: "one_off", unit: "outcomes_produced", unavailableReason: null });
    expect(vi.mocked(getOutcomePerformerStats)).not.toHaveBeenCalled();
  });
});

afterAll(async () => {
  await cleanTestData();
  await closeDb();
});
