import { describe, it, expect, beforeEach, vi } from "vitest";

const { mockFindMany } = vi.hoisted(() => ({ mockFindMany: vi.fn() }));

vi.mock("../../src/db/index.js", () => ({
  db: { query: { campaigns: { findMany: mockFindMany } } },
}));

vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => ({ and: args }),
  eq: (a: unknown, b: unknown) => ({ eq: [a, b] }),
  arrayContains: (a: unknown, b: unknown) => ({ arrayContains: [a, b] }),
}));

vi.mock("../../src/db/schema.js", () => ({
  campaigns: { orgId: "org_id", status: "status", brandIds: "brand_ids" },
}));

const { mockCatalogue, mockFunding, mockLiveCampaign, mockLiveCohort, mockAnchor, mockResolveSlug, mockExecute } =
  vi.hoisted(() => ({
    mockCatalogue: vi.fn(),
    mockFunding: vi.fn(),
    mockLiveCampaign: vi.fn(),
    mockLiveCohort: vi.fn(),
    mockAnchor: vi.fn(),
    mockResolveSlug: vi.fn(),
    mockExecute: vi.fn(),
  }));

vi.mock("../../src/lib/channel-operator-client.js", () => ({ fetchChannelCatalogue: mockCatalogue }));
vi.mock("../../src/lib/campaign-funding.js", () => ({ campaignFunding: mockFunding }));
vi.mock("../../src/lib/scheduler.js", () => ({
  hasLiveRunForCampaign: mockLiveCampaign,
  STUCK_RUN_FRESHNESS_THRESHOLD_MS: 900_000,
}));
vi.mock("../../src/lib/funnel-campaigns.js", () => ({
  hasLiveRunForBrandCohort: mockLiveCohort,
  serializationCohort: (slug: string) => `cohort:${slug}`,
}));
vi.mock("../../src/lib/trigger-run.js", () => ({ ensureCampaignRunId: mockAnchor }));
vi.mock("../../src/lib/features-workflow-projection-client.js", () => ({
  resolveWorkflowSlugForTrigger: mockResolveSlug,
}));
vi.mock("../../src/lib/workflows.js", () => ({ executeCampaignWorkflow: mockExecute }));

import {
  triggerCampaignsForStep,
  StepTriggerScopeError,
  STEP_TRIGGER_SKIPS,
} from "../../src/lib/step-trigger.js";

const ORG = "b645207b-0000-4000-8000-000000000001";
const BRAND = "75d7e3e8-0000-4000-8000-000000000002";
const OFFER = "231bb036-0000-4000-8000-000000000003";
const OTHER_OFFER = "9f0d1c22-0000-4000-8000-000000000004";
const CAMPAIGN = "16705a37-0000-4000-8000-000000000005";

/** The leg the customer buys out of a stated sales interest, exactly as features-service spells it. */
const LEG_OUT = "conversation" + "_to_" + ["meeting", "booked"].join("_");
const LEG_ELSEWHERE = ["meeting", "booked"].join("_") + "_to_" + ["meeting", "attended"].join("_");
const STEP = "conversation";

function catalogueAnswers() {
  mockCatalogue.mockResolvedValue({
    ok: true,
    operatorBySlug: new Map(),
    legsBySlug: new Map(),
    stepKeys: new Set([STEP, "meeting_booked", "meeting_attended", "paid_client"]),
    legs: [
      {
        legKey: LEG_OUT,
        fromStepKey: STEP,
        funnelKeys: new Set(["sales_meetings_from_conversation", "sales_meetings_from_website"]),
      },
      {
        legKey: LEG_ELSEWHERE,
        fromStepKey: "meeting_booked",
        funnelKeys: new Set(["sales_meetings_from_conversation"]),
      },
    ],
  });
}

function campaign(over: Record<string, unknown> = {}) {
  return {
    id: CAMPAIGN,
    orgId: ORG,
    status: "ongoing",
    createdByUserId: "user-1",
    parentRunId: "run-anchor",
    workflowSlug: "aurora-v3",
    brandIds: [BRAND],
    featureSlug: "sales-cold-email-outreach",
    activeGoalId: null,
    brandProfileId: null,
    audienceId: null,
    funnelKey: "sales_meetings_from_conversation",
    dailyBudgetCents: null,
    offerId: OFFER,
    legKey: LEG_OUT,
    ...over,
  };
}

const request = {
  orgId: ORG,
  brandId: BRAND,
  offerId: OFFER,
  funnelKey: "sales_meetings_from_conversation",
  step: STEP,
};

describe("a lead reaching a step runs the campaign bought for the leg out of it", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    catalogueAnswers();
    mockFunding.mockResolvedValue({ funded: true, ceilingCents: 5000 });
    mockLiveCampaign.mockResolvedValue(false);
    mockLiveCohort.mockResolvedValue(false);
    mockAnchor.mockResolvedValue("run-anchor");
    mockResolveSlug.mockResolvedValue("aurora-v3");
    mockExecute.mockResolvedValue(undefined);
  });

  it("executes the campaign of that (brand, offer, funnel) stating that leg", async () => {
    mockFindMany.mockResolvedValue([campaign()]);

    const outcome = await triggerCampaignsForStep(request);

    expect(outcome.legKeys).toEqual([LEG_OUT]);
    expect(outcome.triggered).toEqual([
      { campaignId: CAMPAIGN, legKey: LEG_OUT, workflowSlug: "aurora-v3" },
    ]);
    expect(outcome.skipped).toEqual([]);
    // The dispatch is the scheduler's own — same anchor run, same greedy pick, same /execute — so
    // the run starts at gate-check exactly as a scheduled one does.
    expect(mockExecute).toHaveBeenCalledWith("aurora-v3", expect.objectContaining({
      campaignId: CAMPAIGN,
      orgId: ORG,
      brandId: BRAND,
      runId: "run-anchor",
      featureSlug: "sales-cold-email-outreach",
    }));
  });

  it("is a clean no-op, not an error, when no campaign performs the leg", async () => {
    mockFindMany.mockResolvedValue([campaign({ legKey: LEG_ELSEWHERE })]);

    const outcome = await triggerCampaignsForStep(request);

    expect(outcome.legKeys).toEqual([LEG_OUT]);
    expect(outcome.triggered).toEqual([]);
    expect(outcome.skipped).toEqual([]);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("does not run another OFFER's campaign, and never infers an offer for one stating none", async () => {
    mockFindMany.mockResolvedValue([
      campaign({ id: "other", offerId: OTHER_OFFER }),
      campaign({ id: "offerless", offerId: null }),
    ]);

    const outcome = await triggerCampaignsForStep(request);

    expect(outcome.triggered).toEqual([]);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("does not run a campaign of another funnel, even on the same leg", async () => {
    mockFindMany.mockResolvedValue([campaign({ funnelKey: "website_purchases" })]);

    const outcome = await triggerCampaignsForStep(request);

    expect(outcome.triggered).toEqual([]);
  });

  it("reads the campaign's funnel under the pre-rename spelling too", async () => {
    mockFindMany.mockResolvedValue([campaign({ funnelKey: "reply_meeting" })]);

    const outcome = await triggerCampaignsForStep({ ...request, funnelKey: "reply_meeting" });

    expect(outcome.triggered).toHaveLength(1);
  });

  it("never lets a reply make a DEFUNDED campaign spend", async () => {
    mockFindMany.mockResolvedValue([campaign()]);
    mockFunding.mockResolvedValue({ funded: false, reason: "funnel is funded at zero" });

    const outcome = await triggerCampaignsForStep(request);

    expect(outcome.triggered).toEqual([]);
    expect(outcome.skipped).toEqual([
      {
        campaignId: CAMPAIGN,
        legKey: LEG_OUT,
        reason: STEP_TRIGGER_SKIPS.UNFUNDED,
        detail: "funnel is funded at zero",
      },
    ]);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("prices the hold on the LEG the campaign was bought for", async () => {
    mockFindMany.mockResolvedValue([campaign()]);

    await triggerCampaignsForStep(request);

    expect(mockFunding).toHaveBeenCalledWith(
      expect.objectContaining({ legKey: LEG_OUT, offerId: OFFER }),
      BRAND,
      { orgId: ORG },
    );
  });

  it("does not fire a second run of a campaign that is already running", async () => {
    mockFindMany.mockResolvedValue([campaign()]);
    mockLiveCampaign.mockResolvedValue(true);

    const outcome = await triggerCampaignsForStep(request);

    expect(outcome.skipped[0].reason).toBe(STEP_TRIGGER_SKIPS.RUN_IN_FLIGHT);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("does not fire alongside a run of the brand's same cohort", async () => {
    mockFindMany.mockResolvedValue([campaign()]);
    mockLiveCohort.mockResolvedValue(true);

    const outcome = await triggerCampaignsForStep(request);

    expect(outcome.skipped[0].reason).toBe(STEP_TRIGGER_SKIPS.COHORT_RUN_IN_FLIGHT);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("fires ONE campaign per cohort in a single pass", async () => {
    mockFindMany.mockResolvedValue([campaign(), campaign({ id: "twin" })]);

    const outcome = await triggerCampaignsForStep(request);

    expect(outcome.triggered).toHaveLength(1);
    expect(outcome.skipped[0].reason).toBe(STEP_TRIGGER_SKIPS.COHORT_RUN_IN_FLIGHT);
  });

  it("never runs a campaign whose channel the CUSTOMER operates — it has no DAG", async () => {
    mockFindMany.mockResolvedValue([campaign({ workflowSlug: null })]);

    const outcome = await triggerCampaignsForStep(request);

    expect(outcome.skipped[0].reason).toBe(STEP_TRIGGER_SKIPS.NO_WORKFLOW);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("reports a refused dispatch rather than swallowing it", async () => {
    mockFindMany.mockResolvedValue([campaign()]);
    mockExecute.mockRejectedValue(new Error("workflow-service refused (502)"));

    const outcome = await triggerCampaignsForStep(request);

    expect(outcome.triggered).toEqual([]);
    expect(outcome.skipped[0].reason).toBe(STEP_TRIGGER_SKIPS.DISPATCH_REFUSED);
    expect(outcome.skipped[0].detail).toContain("502");
  });

  it("answers a TERMINAL step with an empty, honest nothing", async () => {
    mockFindMany.mockResolvedValue([campaign()]);

    const outcome = await triggerCampaignsForStep({ ...request, step: "paid_client" });

    expect(outcome.legKeys).toEqual([]);
    expect(outcome.triggered).toEqual([]);
    // Nothing is even looked up: no leg means no campaign can be responsible.
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  describe("a scope that cannot be resolved fails LOUD", () => {
    it("refuses a step features-service does not publish", async () => {
      await expect(triggerCampaignsForStep({ ...request, step: "smoke_signal" }))
        .rejects.toMatchObject({ name: "StepTriggerScopeError", status: 400 });
    });

    it("refuses a funnel naming none of the four", async () => {
      await expect(triggerCampaignsForStep({ ...request, funnelKey: "combinedSales" }))
        .rejects.toBeInstanceOf(StepTriggerScopeError);
    });

    it("refuses when the catalogue cannot be read — never 'nobody performs this leg'", async () => {
      mockCatalogue.mockResolvedValue({ ok: false, detail: "HTTP 503" });

      await expect(triggerCampaignsForStep(request))
        .rejects.toMatchObject({ status: 502 });
      expect(mockFindMany).not.toHaveBeenCalled();
    });
  });
});
