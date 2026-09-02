import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";

const { mockExecute, mockCatalogue, mockFunding, mockListRuns, mockResolveSlug } = vi.hoisted(() => ({
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
  getStatsBudget: vi.fn(),
}));

vi.mock("../../src/lib/workflows.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/lib/workflows.js")>();
  return { ...original, executeCampaignWorkflow: mockExecute };
});

vi.mock("../../src/lib/channel-operator-client.js", () => ({ fetchChannelCatalogue: mockCatalogue }));

vi.mock("../../src/lib/campaign-funding.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/lib/campaign-funding.js")>();
  return { ...original, campaignFunding: mockFunding };
});

vi.mock("../../src/lib/features-workflow-projection-client.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/lib/features-workflow-projection-client.js")>();
  return { ...original, resolveWorkflowSlugForTrigger: mockResolveSlug };
});

import app from "../../src/index.js";
import { cleanTestData, closeDb, insertTestCampaign } from "../helpers/test-db.js";

const API_KEY = process.env.CAMPAIGN_SERVICE_API_KEY || "test-api-key";
const ORG = "b645207b-0000-4000-8000-000000000001";
const BRAND = "75d7e3e8-0000-4000-8000-000000000002";
const OFFER = "231bb036-0000-4000-8000-000000000003";
const STEP = "conversation";
const LEG_OUT = "conversation" + "_to_" + ["meeting", "booked"].join("_");
const FUNNEL = "sales_meetings_from_conversation";

const post = (body: Record<string, unknown>, orgId: string | null = ORG) => {
  const req = request(app)
    .post("/internal/campaigns/trigger-for-step")
    .set("x-api-key", API_KEY);
  if (orgId) req.set("x-org-id", orgId);
  return req.send(body);
};

const body = { brandId: BRAND, offerId: OFFER, funnelKey: FUNNEL, step: STEP };

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
      legs: [{ legKey: LEG_OUT, fromStepKey: STEP, funnelKeys: new Set([FUNNEL]) }],
    });
    mockFunding.mockResolvedValue({ funded: true, ceilingCents: 5000 });
    mockListRuns.mockResolvedValue({ runs: [] });
    mockResolveSlug.mockResolvedValue("aurora-v3");
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
      funnelKey: FUNNEL,
      offerId: OFFER,
      legKey: LEG_OUT,
    });

    const res = await post(body);

    expect(res.status).toBe(200);
    expect(res.body.legKeys).toEqual([LEG_OUT]);
    expect(res.body.triggered).toEqual([
      { campaignId: campaign.id, legKey: LEG_OUT, workflowSlug: "aurora-v3" },
    ]);
    expect(mockExecute).toHaveBeenCalledTimes(1);
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
      funnelKey: FUNNEL,
      offerId: OFFER,
      legKey: LEG_OUT,
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
      funnelKey: FUNNEL,
      offerId: OFFER,
      legKey: LEG_OUT,
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

  it("refuses a funnel naming none of the four", async () => {
    const res = await post({ ...body, funnelKey: "combinedSales" });
    expect(res.status).toBe(400);
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
