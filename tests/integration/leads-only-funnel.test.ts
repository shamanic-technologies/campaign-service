import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";

/**
 * LEADS-ONLY-FUNNEL-CAMPAIGN (owner 2026-10-12, "start -> lead found -> paid client, COMME CA PAS D'EMAIL ENVOYE";
 * "EVERY PIPE IS INDEPENDENT OF THE OTHERS"): a sourcing unit finds leads on its own once the catalogue reads its leg
 * proactive (lib/on-demand-mode.ts). Here: the funnel's restart brings its source back, the sibling read says the
 * source runs on its own, and an outreach unit fed by such a source reads "no lead" as idle, never as exhaustion.
 */
const { mockListRuns, mockUpdateRun } = vi.hoisted(() => ({ mockListRuns: vi.fn(), mockUpdateRun: vi.fn() }));
vi.mock("@distribute/runs-client", () => ({
  createRun: vi.fn().mockResolvedValue({ id: "run-1" }),
  updateRun: mockUpdateRun,
  listRuns: mockListRuns,
  getStatsBudget: vi.fn(),
}));
// The real source reads (tests/setup.ts stubs them for everyone else).
vi.mock("../../src/lib/source-campaign-store.js", async (importOriginal) => importOriginal());

import app from "../../src/index.js";
import { and, eq } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { campaignAudienceExhaustion, campaigns, campaignStatusTransitions } from "../../src/db/schema.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { insertSalesFunnelCampaignWithUnits, setSalesFunnelCampaignStatus } from "../../src/lib/campaign-status-history.js";
import { readDispatchCatalogue } from "../../src/lib/on-demand-mode.js";

const API_KEY = process.env.CAMPAIGN_SERVICE_API_KEY || "test-api-key";
const ORG = "b645207b-0000-4000-8000-0000000001e1";
const BRAND = "75d7e3e8-0000-4000-8000-0000000001e2";
const OFFER = "231bb036-0000-4000-8000-0000000001e3";
const CF = "sourcing-apollo-cold-filters";
const SRC_LEG = "start_to_lead_found";
const TEAM = "your-team-closing-calls";
const COLD = "sales-cold-email-outreach";
const COLD_LEG = "lead_found_to_conversation";

const unit = (featureSlug: string, legKey: string, workflowSlug: string | null) => ({
  featureSlug, legKey, workflowSlug, name: `Funnel ${randomUUID()}`, acquisitionChannel: featureSlug.replace(/-/g, "_"),
});

const born = (units: ReturnType<typeof unit>[]) =>
  insertSalesFunnelCampaignWithUnits({
    id: randomUUID(), orgId: ORG, brandId: BRAND, offerId: OFFER, salesFunnelId: `${SRC_LEG}@${CF}+team`, salesFunnelName: "Leads only",
    status: "ongoing", createdByUserId: null, parentRunId: null, units,
  });

const proactive = {
  ok: true as const,
  operatorBySlug: new Map(),
  legsBySlug: new Map([[CF, new Set([SRC_LEG])]]),
  legs: [],
  stepKeys: new Set<string>(),
  triggerTransitions: [],
};

describe("a leads-only sales funnel campaign", () => {
  beforeEach(async () => {
    await cleanTestData();
    vi.clearAllMocks();
    mockListRuns.mockResolvedValue({ runs: [] });
    mockUpdateRun.mockResolvedValue({});
  });
  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("is born with its source unit due (the scheduler decides who dispatches it) and its team unit never due", async () => {
    const { units } = await born([unit(CF, SRC_LEG, "sourcing-apollo-cold-filters-scheat"), unit(TEAM, "lead_found_to_paid_client", null)]);
    expect(units.find((u) => u.featureSlug === CF)).toMatchObject({ status: "ongoing", nextRunAt: expect.any(Date) });
    expect(units.find((u) => u.featureSlug === TEAM)).toMatchObject({ status: "ongoing", nextRunAt: null });
  });

  it("a funnel stop then start brings its source back (nobody turned the source off); a person's Off stays off", async () => {
    const { salesFunnelCampaign: parent, units } = await born([unit(CF, SRC_LEG, "sourcing-apollo-cold-filters-scheat"), unit(TEAM, "lead_found_to_paid_client", null)]);
    const source = units.find((u) => u.featureSlug === CF)!;

    await setSalesFunnelCampaignStatus({ salesFunnelCampaignId: parent.id, orgId: ORG, toStatus: "stopped", reason: "manual" });
    await setSalesFunnelCampaignStatus({ salesFunnelCampaignId: parent.id, orgId: ORG, toStatus: "ongoing", reason: null });
    const [back] = await db.select().from(campaigns).where(eq(campaigns.id, source.id));
    expect(back).toMatchObject({ status: "ongoing", nextRunAt: expect.any(Date) });

    // A person turns the source itself off, then the funnel is stopped and started: the person's Off stands.
    await db.update(campaigns).set({ status: "stopped", stopReason: "manual", nextRunAt: null }).where(eq(campaigns.id, source.id));
    await db.insert(campaignStatusTransitions).values({ campaignId: source.id, orgId: ORG, fromStatus: "ongoing", toStatus: "stopped", reason: "manual", source: "patch" });
    await setSalesFunnelCampaignStatus({ salesFunnelCampaignId: parent.id, orgId: ORG, toStatus: "stopped", reason: "manual" });
    await setSalesFunnelCampaignStatus({ salesFunnelCampaignId: parent.id, orgId: ORG, toStatus: "ongoing", reason: null });
    const [still] = await db.select().from(campaigns).where(eq(campaigns.id, source.id));
    expect(still.status).toBe("stopped");
  });

  it("the sibling read says whether each source runs on its own (absent catalogue reading = on demand)", async () => {
    const { units } = await born([unit(COLD, COLD_LEG, "cold-v1"), unit(CF, SRC_LEG, "sourcing-apollo-cold-filters-scheat")]);
    const cold = units.find((u) => u.featureSlug === COLD)!;

    const today = await request(app).get(`/internal/campaigns/${cold.id}/source-campaigns`).set("x-api-key", API_KEY).expect(200);
    expect(today.body.sourceCampaigns).toEqual([expect.objectContaining({ featureSlug: CF, running: true, runsOnItsOwn: false })]);

    vi.mocked(readDispatchCatalogue).mockResolvedValueOnce(proactive);
    const flipped = await request(app).get(`/internal/campaigns/${cold.id}/source-campaigns`).set("x-api-key", API_KEY).expect(200);
    expect(flipped.body.sourceCampaigns).toEqual([expect.objectContaining({ featureSlug: CF, runsOnItsOwn: true })]);
  });

  it("an outreach unit fed by a source running on its own reads 'no lead' as idle: nothing exhausted, idle cadence", async () => {
    const { units } = await born([unit(COLD, COLD_LEG, "cold-v1"), unit(CF, SRC_LEG, "sourcing-apollo-cold-filters-scheat")]);
    const cold = units.find((u) => u.featureSlug === COLD)!;
    vi.mocked(readDispatchCatalogue).mockResolvedValue(proactive);
    const before = Date.now();

    await request(app)
      .post("/end-run")
      .set({
        "x-api-key": API_KEY, "x-org-id": ORG, "x-campaign-id": cold.id, "x-user-id": "user_test", "x-run-id": randomUUID(),
        "x-workflow-slug": "cold-v1", "x-feature-slug": COLD, "x-brand-id": BRAND, "x-audience-id": randomUUID(),
      })
      .send({ success: true, stopCampaign: true })
      .expect(200);
    await new Promise((r) => setTimeout(r, 400));

    const marks = await db.select().from(campaignAudienceExhaustion).where(eq(campaignAudienceExhaustion.campaignId, cold.id));
    expect(marks).toHaveLength(0);
    const [row] = await db.select().from(campaigns).where(and(eq(campaigns.id, cold.id)));
    expect(row.status).toBe("ongoing");
    expect(row.nextRunAt!.getTime()).toBeGreaterThanOrEqual(before + 9 * 60_000);
    vi.mocked(readDispatchCatalogue).mockReset();
  });

  it("the same 'no lead' with the source still on demand marks the audience exhausted, as today", async () => {
    const { units } = await born([unit(COLD, COLD_LEG, "cold-v1"), unit(CF, SRC_LEG, "sourcing-apollo-cold-filters-scheat")]);
    const cold = units.find((u) => u.featureSlug === COLD)!;
    vi.mocked(readDispatchCatalogue).mockResolvedValue({ ok: false, detail: "not read in tests" });
    const audienceId = randomUUID();

    await request(app)
      .post("/end-run")
      .set({
        "x-api-key": API_KEY, "x-org-id": ORG, "x-campaign-id": cold.id, "x-user-id": "user_test", "x-run-id": randomUUID(),
        "x-workflow-slug": "cold-v1", "x-feature-slug": COLD, "x-brand-id": BRAND, "x-audience-id": audienceId,
      })
      .send({ success: true, stopCampaign: true })
      .expect(200);
    await new Promise((r) => setTimeout(r, 400));

    const marks = await db.select().from(campaignAudienceExhaustion).where(eq(campaignAudienceExhaustion.campaignId, cold.id));
    expect(marks.map((m) => m.audienceId)).toEqual([audienceId]);
  });
});
