import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";

const { mockExecute, mockCatalogue, mockFunding, mockListRuns, mockResolveSlug, mockGetStatsBudget } = vi.hoisted(() => ({
  mockGetStatsBudget: vi.fn(),
  mockExecute: vi.fn(),
  mockCatalogue: vi.fn(),
  mockFunding: vi.fn(),
  mockListRuns: vi.fn(),
  mockResolveSlug: vi.fn(),
}));

vi.mock("@distribute/runs-client", () => ({
  createRun: vi.fn(),
  updateRun: vi.fn(),
  listRuns: mockListRuns,
  getStatsBudget: (p: { featureSlug?: string }) => (p?.featureSlug?.startsWith("sourcing-") ? Promise.resolve({ windows: [] }) : mockGetStatsBudget(p)),
}));


vi.mock("../../src/lib/workflows.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/lib/workflows.js")>();
  return { ...original, executeCampaignWorkflow: mockExecute };
});

vi.mock("../../src/lib/channel-operator-client.js", () => ({ fetchChannelCatalogue: mockCatalogue }));

vi.mock("../../src/lib/features-workflow-projection-client.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/lib/features-workflow-projection-client.js")>();
  return { ...original, resolveSelectionForTrigger: mockResolveSlug };
});

// The dispatched campaigns are sales funnel UNITS: their money is their funnel's caps, driven here
// by `mockFunding` (funded = runs; not funded = held, `kind` defaulting to `unfunded`).
vi.mock("../../src/lib/sales-funnel-campaigns.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/lib/sales-funnel-campaigns.js")>();
  return {
    ...original,
    salesFunnelUnitMoney: async () => {
      const f = await mockFunding();
      return f.funded
        ? { run: true, pace: { spentCents: 0, ceilingCents: f.ceilingCents } }
        : { run: false, kind: f.kind ?? "unfunded", reason: "Unfunded", detail: f.reason, nextRunAt: new Date(Date.now() + 600_000) };
    },
  };
});
import app from "../../src/index.js";
import { cleanTestData, closeDb, insertTestCampaign } from "../helpers/test-db.js";

const API_KEY = process.env.CAMPAIGN_SERVICE_API_KEY || "test-api-key";
const ORG = "b645207b-0000-4000-8000-000000000001";
const BRAND = "75d7e3e8-0000-4000-8000-000000000002";
const OFFER = "231bb036-0000-4000-8000-000000000003";
const STEP = "conversation";
const LEG_OUT = "conversation" + "_to_" + ["meeting", "booked"].join("_");

const post = (body: Record<string, unknown>, orgId: string | null = ORG) => {
  const req = request(app)
    .post("/internal/campaigns/trigger-for-step")
    .set("x-api-key", API_KEY);
  if (orgId) req.set("x-org-id", orgId);
  return req.send(body);
};

const body = { brandId: BRAND, offerId: OFFER, step: STEP };

/**
 * A prospect who states a sales interest and hears nothing for a day is the problem this closes.
 * These assert what a CALLER can observe: the responsible campaign runs, and every reason it might
 * not is a readable 200 rather than something indistinguishable from a failure.
 */
describe("POST /internal/campaigns/trigger-for-step", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await cleanTestData();
    mockCatalogue.mockResolvedValue({
      ok: true,
      operatorBySlug: new Map(),
      legsBySlug: new Map(),
      stepKeys: new Set([STEP, "meeting_booked", "paid_client"]),
      legs: [{ legKey: LEG_OUT, fromStepKey: STEP, toStepKey: "meeting_booked" }],
    });
    mockFunding.mockResolvedValue({ funded: true, ceilingCents: 5000 });
    mockListRuns.mockResolvedValue({ runs: [] });
    mockResolveSlug.mockResolvedValue({ workflowSlug: "aurora-v3", audienceId: null });
    mockExecute.mockResolvedValue(undefined);
  });

  afterAll(async () => {
    await closeDb();
  });

  it("runs the campaign bought for the leg out of the step", async () => {
    const campaign = await insertTestCampaign(ORG, {
      brandIds: [BRAND],
      brandId: BRAND,
      status: "ongoing",
      featureSlug: "sales-cold-email-outreach",
      workflowSlug: "aurora-v3",
      createdByUserId: "user-1",
      parentRunId: "9f0d1c22-0000-4000-8000-000000000009",
      offerId: OFFER,
      legKey: LEG_OUT,
      salesFunnelCampaignId: crypto.randomUUID(),
      salesFunnelId: "sf-reply",
    });

    const res = await post(body);

    expect(res.status).toBe(200);
    expect(res.body.legKeys).toEqual([LEG_OUT]);
    expect(res.body.triggered).toEqual([
      { campaignId: campaign.id, legKey: LEG_OUT, workflowSlug: "aurora-v3" },
    ]);
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  it("runs a campaign PARKED on the idle cadence immediately — the event path never consults nextRunAt", async () => {
    // A channel that answers one prospect per run parks on the ~10min idle cadence when nobody is
    // owed an answer. The whole point is that a prospect stating an interest does not wait for it.
    const campaign = await insertTestCampaign(ORG, {
      brandIds: [BRAND],
      brandId: BRAND,
      status: "ongoing",
      featureSlug: "ai-meeting-booking",
      workflowSlug: "aurora-v3",
      createdByUserId: "user-1",
      parentRunId: "9f0d1c22-0000-4000-8000-000000000009",
      offerId: OFFER,
      legKey: LEG_OUT,
      salesFunnelCampaignId: crypto.randomUUID(),
      salesFunnelId: "sf-reply",
      nextRunAt: new Date(Date.now() + 10 * 60_000),
    });

    const res = await post(body);

    expect(res.status).toBe(200);
    expect(res.body.triggered).toEqual([
      { campaignId: campaign.id, legKey: LEG_OUT, workflowSlug: "aurora-v3" },
    ]);
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  it("a live campaign that is NOT a sales funnel unit is skipped `not_a_sales_funnel_campaign` and never dispatched", async () => {
    const campaign = await insertTestCampaign(ORG, {
      brandIds: [BRAND],
      brandId: BRAND,
      status: "ongoing",
      featureSlug: "ai-meeting-booking",
      workflowSlug: "aurora-v3",
      createdByUserId: "user-1",
      parentRunId: "9f0d1c22-0000-4000-8000-000000000009",
      offerId: OFFER,
      legKey: LEG_OUT,
    });

    const res = await post(body);

    expect(res.status).toBe(200);
    expect(res.body.triggered).toEqual([]);
    expect(res.body.skipped).toEqual([
      expect.objectContaining({ campaignId: campaign.id, legKey: LEG_OUT, reason: "not_a_sales_funnel_campaign" }),
    ]);
    expect(mockFunding).not.toHaveBeenCalled();
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("answers a scope with no such campaign as an ordinary, empty 200", async () => {
    const res = await post(body);

    expect(res.status).toBe(200);
    expect(res.body.triggered).toEqual([]);
    expect(res.body.skipped).toEqual([]);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("does not run a STOPPED campaign, and says nothing ran", async () => {
    await insertTestCampaign(ORG, {
      brandIds: [BRAND],
      brandId: BRAND,
      status: "stopped",
      featureSlug: "sales-cold-email-outreach",
      createdByUserId: "user-1",
      offerId: OFFER,
      legKey: LEG_OUT,
      salesFunnelCampaignId: crypto.randomUUID(),
      salesFunnelId: "sf-reply",
    });

    const res = await post(body);

    expect(res.status).toBe(200);
    expect(res.body.triggered).toEqual([]);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("never lets the event make an out-of-budget campaign spend", async () => {
    const campaign = await insertTestCampaign(ORG, {
      brandIds: [BRAND],
      brandId: BRAND,
      status: "ongoing",
      featureSlug: "sales-cold-email-outreach",
      workflowSlug: "aurora-v3",
      createdByUserId: "user-1",
      parentRunId: "9f0d1c22-0000-4000-8000-000000000009",
      offerId: OFFER,
      legKey: LEG_OUT,
      salesFunnelCampaignId: crypto.randomUUID(),
      salesFunnelId: "sf-reply",
    });
    mockFunding.mockResolvedValue({ funded: false, reason: "the leg is funded at zero" });

    const res = await post(body);

    expect(res.status).toBe(200);
    expect(res.body.triggered).toEqual([]);
    expect(res.body.skipped).toEqual([
      {
        campaignId: campaign.id,
        legKey: LEG_OUT,
        reason: "unfunded",
        detail: "the leg is funded at zero",
      },
    ]);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("refuses a step nobody publishes — an unresolvable scope is never a quiet zero", async () => {
    const res = await post({ ...body, step: "smoke_signal" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("smoke_signal");
  });

  it("ignores a sales funnel a caller still sends — it narrows nothing and is never refused", async () => {
    const res = await post({ ...body, funnelKey: "combinedSales" });
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty("funnelKey");
    expect(res.body.legKeys).toEqual([LEG_OUT]);
  });

  it("502s when the leg catalogue cannot be read", async () => {
    mockCatalogue.mockResolvedValue({ ok: false, detail: "HTTP 503" });
    const res = await post(body);
    expect(res.status).toBe(502);
  });

  it("requires the org, the api key and a well-formed body", async () => {
    expect((await post(body, null)).status).toBe(400);
    expect((await post({ ...body, offerId: "not-a-uuid" })).status).toBe(400);
    expect(
      (await request(app).post("/internal/campaigns/trigger-for-step").send(body)).status,
    ).toBe(401);
  });
});
