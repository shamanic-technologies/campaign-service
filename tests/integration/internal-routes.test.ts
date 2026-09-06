import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";

const {
  mockCreateRun,
  mockUpdateRun,
  mockListRuns,
  mockExecute,
  mockGateChecks,
  mockFetchBrandRuntimeContext,
  mockFetchCandidates,
  mockFetchArbitration,
} = vi.hoisted(() => ({
  mockCreateRun: vi.fn(),
  mockUpdateRun: vi.fn(),
  mockListRuns: vi.fn(),
  mockExecute: vi.fn(),
  mockGateChecks: vi.fn(),
  mockFetchBrandRuntimeContext: vi.fn(),
  mockFetchCandidates: vi.fn(),
  mockFetchArbitration: vi.fn(),
}));

vi.mock("@distribute/runs-client", () => ({
  createRun: mockCreateRun,
  updateRun: mockUpdateRun,
  listRuns: mockListRuns,
  getStatsBudget: vi.fn(),
}));

vi.mock("../../src/lib/workflows.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/lib/workflows.js")>();
  return {
    ...original,
    executeCampaignWorkflow: mockExecute,
  };
});

vi.mock("../../src/lib/gate-check.js", () => ({
  runGateChecks: mockGateChecks,
}));

vi.mock("../../src/lib/brand-runtime-client.js", () => ({
  fetchBrandRuntimeContext: mockFetchBrandRuntimeContext,
}));

vi.mock("../../src/lib/features-workflow-projection-client.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/lib/features-workflow-projection-client.js")>();
  return {
    ...original, // keep the real pure selectAudienceFromProjection / hasServeableAudienceInProjection
    fetchWorkflowProjectionRows: mockFetchCandidates,
    fetchGoalArbitration: mockFetchArbitration,
  };
});

import app from "../../src/index.js";
import { db } from "../../src/db/index.js";
import { campaigns, campaignAudienceExhaustion } from "../../src/db/schema.js";
import { eq, and } from "drizzle-orm";
import { NO_SERVEABLE_AUDIENCE_RECHECK_MS } from "../../src/lib/audience-exhaustion.js";
import { cleanTestData, closeDb, insertTestCampaign } from "../helpers/test-db.js";

const API_KEY = process.env.CAMPAIGN_SERVICE_API_KEY || "test-api-key";

const defaultBrandProfile = {
  id: "brand-profile-current",
  brandId: "brand-current",
  version: 3,
  fields: {
    positioning: "Automates outbound sales for B2B teams",
    targetAudience: ["B2B SaaS founders", "Revenue leaders"],
  },
  createdAt: "2026-06-18T00:00:00.000Z",
};

// Audience selection now runs the REAL selectAudienceFromProjection over the rows returned by
// (mocked) fetchWorkflowProjectionRows. A projection row for the default workflow slug used in
// pipelineHeaders ("sales-email-cold-outreach"); a single candidate → deterministic pick.
const DEFAULT_AUDIENCE_ID = "customer-profile-best";
const DEFAULT_WORKFLOW_SLUG = "sales-email-cold-outreach";

function projectionRow(
  audienceId: string | null,
  slug: string = DEFAULT_WORKFLOW_SLUG,
  withEvidence = true,
) {
  return {
    audienceId,
    workflow: { workflowDynastySlug: slug, workflowDynastyName: slug },
    audienceEvidence: withEvidence && audienceId
      ? { spentUsd: 12, observedContacted: 120, observedClicks: 24, observedPositiveReplies: 6, resolvedOutcomeCount: 6 }
      : null,
    resolved: { grain: audienceId ? "audience" : "brand", costPerOutcomeUsd: 10 },
  };
}

const defaultRows = [projectionRow(DEFAULT_AUDIENCE_ID)];

/** All required pipeline headers for a valid DAG request */
function pipelineHeaders(overrides: Record<string, string> = {}) {
  return {
    "x-api-key": API_KEY,
    "x-org-id": overrides["x-org-id"] ?? "org_internal_test",
    "x-campaign-id": overrides["x-campaign-id"] ?? crypto.randomUUID(),
    "x-user-id": overrides["x-user-id"] ?? "user_test",
    "x-run-id": overrides["x-run-id"] ?? crypto.randomUUID(),
    "x-workflow-slug": overrides["x-workflow-slug"] ?? "sales-email-cold-outreach",
    "x-feature-slug": overrides["x-feature-slug"] ?? "sales-cold-email-v1",
  };
}

describe("Pipeline routes", () => {
  const orgId = "org_internal_test";
  const brandIds = [crypto.randomUUID()];

  beforeEach(async () => {
    await cleanTestData();
    vi.clearAllMocks();

    // Default mock behaviors
    mockCreateRun.mockResolvedValue({ id: "run-123" });
    mockUpdateRun.mockResolvedValue({});
    mockListRuns.mockResolvedValue({ runs: [] });
    mockGateChecks.mockResolvedValue({ allowed: true });
    mockExecute.mockResolvedValue(undefined);
    mockFetchBrandRuntimeContext.mockResolvedValue({
      brand: { id: brandIds[0], name: "Test Brand" },
      currentGoal: "signup",
      brandProfile: { ...defaultBrandProfile, brandId: brandIds[0] },
    });
    mockFetchCandidates.mockResolvedValue(defaultRows);
    // No arbitration by default: brand-service has not declared an authorized goal set, so every
    // existing expectation keeps the pre-arbitration behaviour (campaign goal, else brand goal).
    mockFetchArbitration.mockResolvedValue(null);
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  // === POST /gate-check ===

  describe("POST /gate-check", () => {
    it("should return 400 if x-campaign-id header is missing", async () => {
      const headers = pipelineHeaders();
      delete (headers as any)["x-campaign-id"];
      await request(app)
        .post("/gate-check")
        .set(headers)
        .expect(400);
    });

    it("should return 400 if x-org-id header is missing", async () => {
      const headers = pipelineHeaders();
      delete (headers as any)["x-org-id"];
      await request(app)
        .post("/gate-check")
        .set(headers)
        .expect(400);
    });

    it("should return 400 if x-workflow-slug header is missing", async () => {
      const headers = pipelineHeaders();
      delete (headers as any)["x-workflow-slug"];
      await request(app)
        .post("/gate-check")
        .set(headers)
        .expect(400);
    });

    it("should return 400 if x-user-id header is missing", async () => {
      const headers = pipelineHeaders();
      delete (headers as any)["x-user-id"];
      await request(app)
        .post("/gate-check")
        .set(headers)
        .expect(400);
    });

    it("should return 400 if x-feature-slug header is missing", async () => {
      const headers = pipelineHeaders();
      delete (headers as any)["x-feature-slug"];
      await request(app)
        .post("/gate-check")
        .set(headers)
        .expect(400);
    });

    it("should return 404 if campaign not found", async () => {
      const res = await request(app)
        .post("/gate-check")
        .set(pipelineHeaders({ "x-org-id": "nonexistent-org" }))
        .expect(404);

      expect(res.body.error).toBe("Campaign not found");
    });

    it("should return allowed: true when gate checks pass", async () => {
      const campaign = await insertTestCampaign(orgId, { brandIds });

      const res = await request(app)
        .post("/gate-check")
        .set(pipelineHeaders({ "x-org-id": orgId, "x-campaign-id": campaign.id }))
        .expect(200);

      expect(res.body.allowed).toBe(true);
      expect(res.body.reason).toBeUndefined();
    });

    it("should return allowed: false with reason when gate checks fail", async () => {
      const campaign = await insertTestCampaign(orgId, { brandIds });

      mockGateChecks.mockResolvedValue({
        allowed: false,
        reason: "Brand daily budget reached",
      });

      const res = await request(app)
        .post("/gate-check")
        .set(pipelineHeaders({ "x-org-id": orgId, "x-campaign-id": campaign.id }))
        .expect(200);

      expect(res.body.allowed).toBe(false);
      expect(res.body.reason).toBe("Brand daily budget reached");
    });

    it("should return autoStopped flag when campaign is auto-stopped", async () => {
      const campaign = await insertTestCampaign(orgId, { brandIds });

      mockGateChecks.mockResolvedValue({
        allowed: false,
        reason: "Total budget exceeded",
        autoStopped: true,
      });

      const res = await request(app)
        .post("/gate-check")
        .set(pipelineHeaders({ "x-org-id": orgId, "x-campaign-id": campaign.id }))
        .expect(200);

      expect(res.body.allowed).toBe(false);
      expect(res.body.autoStopped).toBe(true);
    });

    it("should save nextRunAt to DB when gate-check returns it", async () => {
      const campaign = await insertTestCampaign(orgId, { brandIds });

      const nextWeek = new Date();
      nextWeek.setDate(nextWeek.getDate() + 7);
      nextWeek.setHours(0, 0, 0, 0);

      mockGateChecks.mockResolvedValue({
        allowed: false,
        reason: "weekly budget exceeded",
        nextRunAt: nextWeek,
      });

      await request(app)
        .post("/gate-check")
        .set(pipelineHeaders({ "x-org-id": orgId, "x-campaign-id": campaign.id }))
        .expect(200);

      const updated = await db.query.campaigns.findFirst({
        where: eq(campaigns.id, campaign.id),
      });
      expect(updated!.nextRunAt).not.toBeNull();
      expect(new Date(updated!.nextRunAt!).getTime()).toBe(nextWeek.getTime());
    });

    it("should NOT save nextRunAt when gate-check does not return it", async () => {
      const campaign = await insertTestCampaign(orgId, { brandIds });

      mockGateChecks.mockResolvedValue({
        allowed: false,
        reason: "Total budget exceeded",
        autoStopped: true,
      });

      await request(app)
        .post("/gate-check")
        .set(pipelineHeaders({ "x-org-id": orgId, "x-campaign-id": campaign.id }))
        .expect(200);

      const updated = await db.query.campaigns.findFirst({
        where: eq(campaigns.id, campaign.id),
      });
      expect(updated!.nextRunAt).toBeNull();
    });

    it("should persist a future nextRunAt when a blocked result has neither autoStopped nor nextRunAt", async () => {
      const campaign = await insertTestCampaign(orgId, { brandIds });

      // A no-decision block (e.g. "A run is already in progress" / "Lead stats unavailable")
      // must NOT leave nextRunAt null — otherwise claimStuckCampaigns re-claims the
      // (ongoing, nextRunAt=null) campaign every tick and re-fires the Windmill flow.
      mockGateChecks.mockResolvedValue({
        allowed: false,
        reason: "A run is already in progress",
      });

      const before = Date.now();
      await request(app)
        .post("/gate-check")
        .set(pipelineHeaders({ "x-org-id": orgId, "x-campaign-id": campaign.id }))
        .expect(200);

      const updated = await db.query.campaigns.findFirst({
        where: eq(campaigns.id, campaign.id),
      });
      expect(updated!.nextRunAt).not.toBeNull();
      expect(new Date(updated!.nextRunAt!).getTime()).toBeGreaterThan(before);
    });

    it("should pass campaign data to runGateChecks", async () => {
      const campaign = await insertTestCampaign(orgId, {
        brandIds,
        maxBudgetDailyUsd: "50.00",
        maxLeads: 100,
      });

      await request(app)
        .post("/gate-check")
        .set(pipelineHeaders({ "x-org-id": orgId, "x-campaign-id": campaign.id }))
        .expect(200);

      expect(mockGateChecks).toHaveBeenCalledWith(
        expect.objectContaining({
          campaignId: campaign.id,
          orgId,
          brandId: brandIds.join(","),
          featureSlug: "sales-cold-email-v1",
          status: "ongoing",
          maxBudgetDailyUsd: "50.00",
          maxLeads: 100,
        }),
      );
    });
  });

  // === POST /start-run ===

  describe("POST /start-run", () => {
    it("should return 400 if x-campaign-id header is missing", async () => {
      const headers = pipelineHeaders();
      delete (headers as any)["x-campaign-id"];
      await request(app)
        .post("/start-run")
        .set(headers)
        .expect(400);
    });

    it("should return 400 if x-user-id header is missing", async () => {
      const headers = pipelineHeaders();
      delete (headers as any)["x-user-id"];
      await request(app)
        .post("/start-run")
        .set(headers)
        .expect(400);
    });

    it("should return 404 if campaign not found", async () => {
      const res = await request(app)
        .post("/start-run")
        .set(pipelineHeaders({ "x-org-id": "nonexistent-org" }))
        .expect(404);

      expect(res.body.error).toBe("Campaign not found");
    });

    it("should return 400 if campaign has no brandIds", async () => {
      const campaign = await insertTestCampaign(orgId, {
        brandIds: undefined,
      });

      const res = await request(app)
        .post("/start-run")
        .set(pipelineHeaders({ "x-org-id": orgId, "x-campaign-id": campaign.id }))
        .expect(400);

      expect(res.body.error).toBe("Campaign has no brandIds");
    });

    it("should return 200 with campaign data and runId", async () => {
      const campaign = await insertTestCampaign(orgId, { brandIds });

      const res = await request(app)
        .post("/start-run")
        .set(pipelineHeaders({ "x-org-id": orgId, "x-campaign-id": campaign.id }))
        .expect(200);

      expect(res.body.runId).toBe("run-123");
      expect(res.body.campaignId).toBe(campaign.id);
      expect(res.body.orgId).toBe(orgId);
      expect(res.body.brandIds).toEqual(brandIds);
      expect(res.body.workflowSlug).toBe("sales-email-cold-outreach");
      expect(res.body.activeGoalId).toBeNull();
      expect(res.body.brandProfileId).toBeNull();
      expect(res.body).not.toHaveProperty("customerPersonaId");
      expect(res.body).not.toHaveProperty("customerProfileId");
      expect(res.body).not.toHaveProperty("appId");
      expect(res.body).not.toHaveProperty("keySource");
    });

    it("should return persona/profile attribution for attributed campaigns", async () => {
      // Stored campaign attribution surfaced on /start-run. The renamed audience column
      // is NOT round-tripped here — /start-run returns the per-run freshly-selected
      // audienceId (from the workflow-projection bandit), not the stored column.
      const attribution = {
        activeGoalId: "goal_internal_test",
        brandProfileId: "brand_profile_internal_test",
      };
      const campaign = await insertTestCampaign(orgId, {
        brandIds,
        ...attribution,
        audienceId: "stored_audience_internal_test",
      });

      const res = await request(app)
        .post("/start-run")
        .set(pipelineHeaders({ "x-org-id": orgId, "x-campaign-id": campaign.id }))
        .expect(200);

      expect(res.body).toMatchObject(attribution);
      expect(res.body).not.toHaveProperty("customerPersonaId");
      expect(res.body).not.toHaveProperty("customerProfileId");
    });

    it("should not return sales-specific fields", async () => {
      const campaign = await insertTestCampaign(orgId, { brandIds });

      const res = await request(app)
        .post("/start-run")
        .set(pipelineHeaders({ "x-org-id": orgId, "x-campaign-id": campaign.id }))
        .expect(200);

      expect(res.body).not.toHaveProperty("urgency");
      expect(res.body).not.toHaveProperty("scarcity");
      expect(res.body).not.toHaveProperty("riskReversal");
      expect(res.body).not.toHaveProperty("socialProof");
    });

    it("should include current brand profile and best persona in searchParams when no featureInputs", async () => {
      const campaign = await insertTestCampaign(orgId, { brandIds });

      const res = await request(app)
        .post("/start-run")
        .set(pipelineHeaders({ "x-org-id": orgId, "x-campaign-id": campaign.id, "x-run-id": "parent-run-1" }))
        .expect(200);

      expect(res.body.searchParams).toEqual({
        brandProfile: { ...defaultBrandProfile, brandId: brandIds[0] },
        // The audience object is NOT passed downstream — only its id (top-level audienceId).
        // Campaign v2 authoritative per-campaign config — null = inherit brand.
        servicesOffered: null,
        clickDestinationUrl: null,
      });
      // Audience is re-selected BEFORE the run row is created, so these fetches trace
      // under the parent (workflow/execute-workflow) run, not this campaign-service run.
      expect(mockFetchBrandRuntimeContext).toHaveBeenCalledWith(
        brandIds[0],
        expect.objectContaining({
          orgId,
          userId: "user_test",
          runId: "parent-run-1",
          campaignId: campaign.id,
          brandId: brandIds[0],
          workflowSlug: "sales-email-cold-outreach",
          featureSlug: "sales-cold-email-v1",
        }),
      );
      // The audience is now selected from the workflow-projection rows (single-endpoint).
      expect(mockFetchCandidates).toHaveBeenCalledWith(
        expect.objectContaining({
          featureSlug: "sales-cold-email-v1",
          brandId: brandIds[0],
          goal: "signup",
          identity: expect.objectContaining({ runId: "parent-run-1" }),
        }),
      );
      expect(res.body.audienceId).toBe(DEFAULT_AUDIENCE_ID);
    });

    // === Campaign v2: per-campaign own config ===

    it("should price on the FUNNEL the campaign states, not on any goal", async () => {
      // The brand's goal is 'signup' (mock default) and it is irrelevant here: the campaign states
      // the funnel it sells, which is the only word that separates a meeting bought with a positive
      // reply from one bought with a click onto the site.
      const campaign = await insertTestCampaign(orgId, {
        brandIds,
        funnelKey: "sales_meetings_from_website",
      });

      await request(app)
        .post("/start-run")
        .set(pipelineHeaders({ "x-org-id": orgId, "x-campaign-id": campaign.id }))
        .expect(200);

      expect(mockFetchCandidates).toHaveBeenCalledWith(
        expect.objectContaining({ funnelKey: "sales_meetings_from_website", goal: null }),
      );
    });

    it("should pace on the BRAND goal (inherit) when the campaign sets no own goal", async () => {
      const campaign = await insertTestCampaign(orgId, { brandIds });

      await request(app)
        .post("/start-run")
        .set(pipelineHeaders({ "x-org-id": orgId, "x-campaign-id": campaign.id }))
        .expect(200);

      // Mock brand runtime-context returns currentGoal 'signup'.
      expect(mockFetchCandidates).toHaveBeenCalledWith(
        expect.objectContaining({ goal: "signup" }),
      );
    });

    // The goal vocabulary is brand-service's, not ours. brand-service's own check constraint
    // already allows values this service never had a name for; a campaign paces on whatever
    // the brand says, forwarded verbatim, and features-service is the one that fails loud on
    // a goal it cannot resolve.
    it("should forward a brand goal this service has no enum for, verbatim", async () => {
      mockFetchBrandRuntimeContext.mockResolvedValueOnce({
        brand: { id: brandIds[0] },
        currentGoal: "combinedSales",
        brandProfile: null,
      });
      const campaign = await insertTestCampaign(orgId, { brandIds });

      await request(app)
        .post("/start-run")
        .set(pipelineHeaders({ "x-org-id": orgId, "x-campaign-id": campaign.id }))
        .expect(200);

      expect(mockFetchCandidates).toHaveBeenCalledWith(
        expect.objectContaining({ goal: "combinedSales" }),
      );
    });

    it("should ignore a legacy goal still stored on the row — the funnel is what it sells", async () => {
      // A row written before the goal stopped being written still carries one. It changes nothing:
      // pricing follows the funnel when there is one, and the brand's goal when there is not.
      const campaign = await insertTestCampaign(orgId, { brandIds, goal: "positiveReply" });

      await request(app)
        .post("/start-run")
        .set(pipelineHeaders({ "x-org-id": orgId, "x-campaign-id": campaign.id }))
        .expect(200);

      expect(mockFetchCandidates).toHaveBeenCalledWith(
        expect.objectContaining({ funnelKey: null, goal: "signup" }),
      );
    });

    // === Goal arbitration: features-service elects the goal, we do not deduce it ===

    it("should use the ARBITRATED goal's rows when its workflow is the one running", async () => {
      mockFetchArbitration.mockResolvedValueOnce({
        goal: "formSubmission",
        workflowSlug: DEFAULT_WORKFLOW_SLUG,
        rows: [projectionRow("aud-arbitrated")],
      });
      const campaign = await insertTestCampaign(orgId, { brandIds });

      const res = await request(app)
        .post("/start-run")
        .set(pipelineHeaders({ "x-org-id": orgId, "x-campaign-id": campaign.id }))
        .expect(200);

      // One answer carried both the goal and the rows → no second projection call.
      expect(mockFetchCandidates).not.toHaveBeenCalled();
      expect(res.body.audienceId).toBe("aud-arbitrated");
    });

    it("should keep the arbitrated GOAL but re-read rows when the elected workflow is not the one running", async () => {
      // The shared evidence snapshot rolled between the trigger and now, so the elected workflow
      // is no longer the DAG that is executing. Picking an audience from those rows would pick
      // for the wrong workflow.
      mockFetchArbitration.mockResolvedValueOnce({
        goal: "formSubmission",
        workflowSlug: "some-other-dynasty",
        rows: [projectionRow("aud-stale", "some-other-dynasty")],
      });
      const campaign = await insertTestCampaign(orgId, { brandIds });

      const res = await request(app)
        .post("/start-run")
        .set(pipelineHeaders({ "x-org-id": orgId, "x-campaign-id": campaign.id }))
        .expect(200);

      expect(mockFetchCandidates).toHaveBeenCalledWith(
        expect.objectContaining({ goal: "formSubmission" }),
      );
      expect(res.body.audienceId).toBe(DEFAULT_AUDIENCE_ID);
    });

    it("should NOT arbitrate a campaign that STATES ITS FUNNEL — the customer's funding decided it", async () => {
      const campaign = await insertTestCampaign(orgId, { brandIds, funnelKey: "form_magnet" });

      await request(app)
        .post("/start-run")
        .set(pipelineHeaders({ "x-org-id": orgId, "x-campaign-id": campaign.id }))
        .expect(200);

      expect(mockFetchArbitration).not.toHaveBeenCalled();
      expect(mockFetchCandidates).toHaveBeenCalledWith(
        expect.objectContaining({ funnelKey: "form_magnet", goal: null }),
      );
    });

    it("should fall back to the brand goal when nothing is arbitrated", async () => {
      const campaign = await insertTestCampaign(orgId, { brandIds });

      await request(app)
        .post("/start-run")
        .set(pipelineHeaders({ "x-org-id": orgId, "x-campaign-id": campaign.id }))
        .expect(200);

      expect(mockFetchArbitration).toHaveBeenCalled();
      expect(mockFetchCandidates).toHaveBeenCalledWith(
        expect.objectContaining({ goal: "signup" }),
      );
    });

    it("should still start the run when arbitration throws", async () => {
      mockFetchArbitration.mockRejectedValueOnce(new Error("features-service unavailable"));
      const campaign = await insertTestCampaign(orgId, { brandIds });

      const res = await request(app)
        .post("/start-run")
        .set(pipelineHeaders({ "x-org-id": orgId, "x-campaign-id": campaign.id }))
        .expect(200);

      // Fail-soft: a selection optimization never hard-fails a run.
      expect(res.body.audienceId).toBeNull();
    });

    it("should HARD-restrict the audience bandit to the campaign's targeted subset", async () => {
      // Rows contain a targeted (aud-a) and an untargeted (aud-z) audience under the workflow.
      mockFetchCandidates.mockResolvedValueOnce([
        projectionRow("aud-a"),
        projectionRow("aud-z"),
      ]);
      const campaign = await insertTestCampaign(orgId, {
        brandIds,
        audienceIds: ["aud-a", "aud-b"], // targets aud-a (present) + aud-b (absent)
      });

      const res = await request(app)
        .post("/start-run")
        .set(pipelineHeaders({ "x-org-id": orgId, "x-campaign-id": campaign.id }))
        .expect(200);

      // aud-z is untargeted and aud-b is absent → the only serveable targeted audience is aud-a.
      expect(res.body.audienceId).toBe("aud-a");
    });

    it("should inherit the brand's full active set when the campaign targets no subset", async () => {
      const campaign = await insertTestCampaign(orgId, { brandIds });

      const res = await request(app)
        .post("/start-run")
        .set(pipelineHeaders({ "x-org-id": orgId, "x-campaign-id": campaign.id }))
        .expect(200);

      // Default single-row projection → the default audience is picked (no subset restriction).
      expect(res.body.audienceId).toBe(DEFAULT_AUDIENCE_ID);
    });

    it("should expose the campaign's own config on the start-run response + searchParams", async () => {
      const campaign = await insertTestCampaign(orgId, {
        brandIds,
        goal: "meetingBooked",
        audienceIds: ["aud-x"],
        servicesOffered: ["seo", "ads"],
        clickDestinationUrl: "https://example.com/lp",
      });

      const res = await request(app)
        .post("/start-run")
        .set(pipelineHeaders({ "x-org-id": orgId, "x-campaign-id": campaign.id }))
        .expect(200);

      expect(res.body.goal).toBe("meetingBooked");
      expect(res.body.audienceIds).toEqual(["aud-x"]);
      expect(res.body.servicesOffered).toEqual(["seo", "ads"]);
      expect(res.body.clickDestinationUrl).toBe("https://example.com/lp");
      expect(res.body.searchParams.servicesOffered).toEqual(["seo", "ads"]);
      expect(res.body.searchParams.clickDestinationUrl).toBe("https://example.com/lp");
    });

    it("should return null own-config (inherit) when the campaign sets nothing", async () => {
      const campaign = await insertTestCampaign(orgId, { brandIds });

      const res = await request(app)
        .post("/start-run")
        .set(pipelineHeaders({ "x-org-id": orgId, "x-campaign-id": campaign.id }))
        .expect(200);

      expect(res.body.goal).toBeNull();
      expect(res.body.audienceIds).toBeNull();
      expect(res.body.servicesOffered).toBeNull();
      expect(res.body.clickDestinationUrl).toBeNull();
    });

    it("should scope the audience exploration to the chosen workflow's audiences", async () => {
      // Two audiences under the campaign's workflow; a third belongs to a different workflow.
      mockFetchCandidates.mockResolvedValueOnce([
        projectionRow("aud-1", "sales-email-cold-outreach"),
        projectionRow("aud-2", "sales-email-cold-outreach"),
        projectionRow(null, "sales-email-cold-outreach"), // brand-level row — ignored
        projectionRow("aud-3", "some-other-workflow"), //     other workflow — excluded
      ]);
      const campaign = await insertTestCampaign(orgId, { brandIds });

      const res = await request(app)
        .post("/start-run")
        .set(pipelineHeaders({ "x-org-id": orgId, "x-campaign-id": campaign.id }))
        .expect(200);

      // Only aud-1 / aud-2 ran the chosen workflow; aud-3 (other workflow) is never picked.
      expect(["aud-1", "aud-2"]).toContain(res.body.audienceId);
    });

    it("should fall back to all audiences when the chosen workflow has no rows (cold slug)", async () => {
      // No row for the chosen workflow → fall back to the audience present under another one.
      mockFetchCandidates.mockResolvedValueOnce([
        projectionRow("aud-other", "some-other-workflow"),
      ]);
      const campaign = await insertTestCampaign(orgId, { brandIds });

      const res = await request(app)
        .post("/start-run")
        .set(pipelineHeaders({ "x-org-id": orgId, "x-campaign-id": campaign.id }))
        .expect(200);

      expect(res.body.audienceId).toBe("aud-other");
    });

    it("should proceed with no audience (fail-soft) when the projection fetch throws", async () => {
      mockFetchCandidates.mockRejectedValueOnce(new Error("features-service down"));
      const campaign = await insertTestCampaign(orgId, { brandIds });

      const res = await request(app)
        .post("/start-run")
        .set(pipelineHeaders({ "x-org-id": orgId, "x-campaign-id": campaign.id }))
        .expect(200);

      // A selection failure never hard-fails the run — it proceeds with no chosen audience.
      expect(res.body.audienceId).toBeNull();
      expect(mockCreateRun).toHaveBeenCalledWith(
        expect.objectContaining({ audienceId: undefined }),
      );
    });

    it("should stamp the selected audience on the run (x-audience-id) and return it", async () => {
      const campaign = await insertTestCampaign(orgId, { brandIds });

      const res = await request(app)
        .post("/start-run")
        .set(pipelineHeaders({ "x-org-id": orgId, "x-campaign-id": campaign.id }))
        .expect(200);

      expect(res.body.audienceId).toBe(DEFAULT_AUDIENCE_ID);
      expect(mockCreateRun).toHaveBeenCalledWith(
        expect.objectContaining({ audienceId: DEFAULT_AUDIENCE_ID }),
      );
    });

    it("should return audienceId: null and not stamp the run when no audience is selected", async () => {
      mockFetchCandidates.mockResolvedValueOnce([]); // no audience rows → null pick
      const campaign = await insertTestCampaign(orgId, { brandIds });

      const res = await request(app)
        .post("/start-run")
        .set(pipelineHeaders({ "x-org-id": orgId, "x-campaign-id": campaign.id }))
        .expect(200);

      expect(res.body.audienceId).toBeNull();
      expect(mockCreateRun).toHaveBeenCalledWith(
        expect.objectContaining({ audienceId: undefined }),
      );
    });

    it("should pass x-run-id header as parentRunId to createRun", async () => {
      const parentRunId = crypto.randomUUID();
      const campaign = await insertTestCampaign(orgId, { brandIds });

      await request(app)
        .post("/start-run")
        .set(pipelineHeaders({
          "x-org-id": orgId,
          "x-campaign-id": campaign.id,
          "x-run-id": parentRunId,
        }))
        .expect(200);

      expect(mockCreateRun).toHaveBeenCalledWith(
        expect.objectContaining({ parentRunId }),
      );
    });

    it("should fall back to campaign.workflowSlug when header matches DB", async () => {
      const campaign = await insertTestCampaign(orgId, {
        brandIds,
        workflowSlug: "sales-email-cold-outreach",
      });

      await request(app)
        .post("/start-run")
        .set(pipelineHeaders({ "x-org-id": orgId, "x-campaign-id": campaign.id }))
        .expect(200);

      expect(mockCreateRun).toHaveBeenCalledWith(
        expect.objectContaining({ workflowSlug: "sales-email-cold-outreach" }),
      );
    });

    it("should prefer x-workflow-slug header over campaign.workflowSlug for createRun", async () => {
      const campaign = await insertTestCampaign(orgId, {
        brandIds,
        workflowSlug: "pr-cold-email-outreach-sophia-mistral",
      });

      await request(app)
        .post("/start-run")
        .set(pipelineHeaders({
          "x-org-id": orgId,
          "x-campaign-id": campaign.id,
          "x-workflow-slug": "pr-cold-email-outreach-sophia-mistral-v3",
        }))
        .expect(200);

      expect(mockCreateRun).toHaveBeenCalledWith(
        expect.objectContaining({ workflowSlug: "pr-cold-email-outreach-sophia-mistral-v3" }),
      );
    });

    it("should pass featureSlug to createRun", async () => {
      const campaign = await insertTestCampaign(orgId, { brandIds });

      await request(app)
        .post("/start-run")
        .set(pipelineHeaders({
          "x-org-id": orgId,
          "x-campaign-id": campaign.id,
          "x-feature-slug": "sales-cold-email-v1",
        }))
        .expect(200);

      expect(mockCreateRun).toHaveBeenCalledWith(
        expect.objectContaining({ featureSlug: "sales-cold-email-v1" }),
      );
    });

    it("should prefer x-feature-slug header over campaign.featureSlug", async () => {
      const campaign = await insertTestCampaign(orgId, {
        brandIds,
        featureSlug: "old-slug",
      });

      await request(app)
        .post("/start-run")
        .set(pipelineHeaders({
          "x-org-id": orgId,
          "x-campaign-id": campaign.id,
          "x-feature-slug": "header-slug",
        }))
        .expect(200);

      expect(mockCreateRun).toHaveBeenCalledWith(
        expect.objectContaining({ featureSlug: "header-slug" }),
      );
    });

    it("should return featureSlug and featureInputs when set", async () => {
      const campaign = await insertTestCampaign(orgId, {
        brandIds,
        featureSlug: "pr-media-pitch-v1",
        featureInputs: { mediaType: "podcast", region: "US" },
      });

      const res = await request(app)
        .post("/start-run")
        .set(pipelineHeaders({ "x-org-id": orgId, "x-campaign-id": campaign.id }))
        .expect(200);

      expect(res.body.featureSlug).toBe("pr-media-pitch-v1");
      expect(res.body.featureInputs).toEqual({ mediaType: "podcast", region: "US" });
    });

    it("should enrich featureInputs searchParams with current brand profile", async () => {
      const campaign = await insertTestCampaign(orgId, {
        brandIds,
        featureInputs: { mediaType: "podcast", region: "US" },
      });

      const res = await request(app)
        .post("/start-run")
        .set(pipelineHeaders({ "x-org-id": orgId, "x-campaign-id": campaign.id }))
        .expect(200);

      // The audience object is not in searchParams — it is threaded downstream by id only.
      expect(res.body.searchParams).toEqual({
        mediaType: "podcast",
        region: "US",
        brandProfile: { ...defaultBrandProfile, brandId: brandIds[0] },
        servicesOffered: null,
        clickDestinationUrl: null,
      });
    });

    it("should not include the audience object in searchParams (threaded by id only)", async () => {
      mockFetchCandidates.mockResolvedValueOnce([]); // no audience rows → null pick
      const campaign = await insertTestCampaign(orgId, { brandIds });

      const res = await request(app)
        .post("/start-run")
        .set(pipelineHeaders({ "x-org-id": orgId, "x-campaign-id": campaign.id }))
        .expect(200);

      expect(res.body.audienceId).toBeNull();
      expect(res.body.searchParams).not.toHaveProperty("audience");
      expect(res.body.searchParams).toEqual({
        brandProfile: { ...defaultBrandProfile, brandId: brandIds[0] },
        servicesOffered: null,
        clickDestinationUrl: null,
      });
    });

    it("should NOT call gate checks (gate check is a separate DAG node)", async () => {
      const campaign = await insertTestCampaign(orgId, { brandIds });

      await request(app)
        .post("/start-run")
        .set(pipelineHeaders({ "x-org-id": orgId, "x-campaign-id": campaign.id }))
        .expect(200);

      expect(mockGateChecks).not.toHaveBeenCalled();
    });

    it("should not pass appId to createRun", async () => {
      const campaign = await insertTestCampaign(orgId, { brandIds });

      await request(app)
        .post("/start-run")
        .set(pipelineHeaders({ "x-org-id": orgId, "x-campaign-id": campaign.id }))
        .expect(200);

      const callArgs = mockCreateRun.mock.calls[0][0];
      expect(callArgs).not.toHaveProperty("appId");
    });
  });

  // === POST /end-run ===

  describe("POST /end-run", () => {
    it("should return 400 if success field is missing from body", async () => {
      const campaign = await insertTestCampaign(orgId, { brandIds });
      await request(app)
        .post("/end-run")
        .set(pipelineHeaders({ "x-org-id": orgId, "x-campaign-id": campaign.id }))
        .send({})
        .expect(400);
    });

    it("should return 400 if stopCampaign field is missing from body", async () => {
      const campaign = await insertTestCampaign(orgId, { brandIds });
      await request(app)
        .post("/end-run")
        .set(pipelineHeaders({ "x-org-id": orgId, "x-campaign-id": campaign.id }))
        .send({ success: true })
        .expect(400);
    });

    it("should return 400 if x-campaign-id header is missing", async () => {
      const headers = pipelineHeaders();
      delete (headers as any)["x-campaign-id"];
      await request(app)
        .post("/end-run")
        .set(headers)
        .send({ success: true, stopCampaign: false })
        .expect(400);
    });

    it("should return 400 if x-workflow-slug header is missing", async () => {
      const headers = pipelineHeaders();
      delete (headers as any)["x-workflow-slug"];
      await request(app)
        .post("/end-run")
        .set(headers)
        .send({ success: true, stopCampaign: false })
        .expect(400);
    });

    it("should find and mark running run as completed when success is true", async () => {
      const campaign = await insertTestCampaign(orgId, { brandIds });

      mockListRuns.mockResolvedValue({
        runs: [
          { id: "run-123", status: "running", startedAt: new Date().toISOString() },
        ],
      });

      const res = await request(app)
        .post("/end-run")
        .set(pipelineHeaders({ "x-org-id": orgId, "x-campaign-id": campaign.id }))
        .send({ success: true, stopCampaign: false })
        .expect(200);

      expect(res.body.status).toBe("completed");
      expect(mockUpdateRun).toHaveBeenCalledWith("run-123", "completed", expect.objectContaining({ orgId }));
    });

    it("should find and mark running run as failed when success is false", async () => {
      const campaign = await insertTestCampaign(orgId, { brandIds });

      mockListRuns.mockResolvedValue({
        runs: [
          { id: "run-456", status: "running", startedAt: new Date().toISOString() },
        ],
      });

      const res = await request(app)
        .post("/end-run")
        .set(pipelineHeaders({ "x-org-id": orgId, "x-campaign-id": campaign.id }))
        .send({ success: false, stopCampaign: false })
        .expect(200);

      expect(res.body.status).toBe("failed");
      expect(mockUpdateRun).toHaveBeenCalledWith("run-456", "failed", expect.objectContaining({ orgId }));
    });

    it("should skip run update when no running runs exist (gate-check blocked)", async () => {
      const campaign = await insertTestCampaign(orgId, { brandIds });

      mockListRuns.mockResolvedValue({ runs: [] });

      const res = await request(app)
        .post("/end-run")
        .set(pipelineHeaders({ "x-org-id": orgId, "x-campaign-id": campaign.id }))
        .send({ success: false, stopCampaign: false })
        .expect(200);

      expect(res.body.status).toBe("failed");
      expect(mockUpdateRun).not.toHaveBeenCalled();
    });

    it("should call listRuns with parentRunId filter matching caller's x-run-id", async () => {
      const campaign = await insertTestCampaign(orgId, { brandIds });
      const callerRunId = crypto.randomUUID();

      mockListRuns.mockResolvedValue({
        runs: [{ id: "run-own", status: "running", startedAt: new Date().toISOString() }],
      });

      await request(app)
        .post("/end-run")
        .set(pipelineHeaders({ "x-org-id": orgId, "x-campaign-id": campaign.id, "x-run-id": callerRunId }))
        .send({ success: false, stopCampaign: false })
        .expect(200);

      expect(mockListRuns).toHaveBeenCalledWith(
        expect.objectContaining({
          orgId,
          serviceName: "campaign-service",
          taskName: campaign.id,
          parentRunId: callerRunId,
          status: "running",
        }),
      );
      // Bounded like every other runs read in this service — one marker row per parent run, and
      // no path can regress into pulling the campaign's history.
      expect(mockListRuns.mock.calls[0][0].limit).toBeGreaterThan(0);
      expect(mockUpdateRun).toHaveBeenCalledTimes(1);
      expect(mockUpdateRun).toHaveBeenCalledWith("run-own", "failed", expect.objectContaining({ orgId }));
    });

    it("should set nextRunAt=now+10s grace when success=true stopCampaign=false and campaign is ongoing", async () => {
      const campaign = await insertTestCampaign(orgId, {
        brandIds,
        status: "ongoing",
        workflowSlug: "sales-email-cold-outreach",
        featureSlug: "sales-cold-email-v1",
        createdByUserId: "user_test",
      });

      const before = Date.now();

      await request(app)
        .post("/end-run")
        .set(pipelineHeaders({ "x-org-id": orgId, "x-campaign-id": campaign.id }))
        .send({ success: true, stopCampaign: false })
        .expect(200);

      // Wait for async nextRunAt update
      await new Promise((r) => setTimeout(r, 100));

      const updated = await db.query.campaigns.findFirst({
        where: eq(campaigns.id, campaign.id),
      });
      expect(updated!.nextRunAt).not.toBeNull();
      const nextRunTime = new Date(updated!.nextRunAt!).getTime();
      // Should be ~now + 10s grace (lets the wrapping workflow run finish teardown
      // before the re-run tick, so the in-flight guard doesn't slam a +60s skip).
      expect(nextRunTime).toBeGreaterThanOrEqual(before + 9_000);
      expect(nextRunTime).toBeLessThan(before + 15_000);
      // Must NOT fire-and-forget
      expect(mockExecute).not.toHaveBeenCalled();
    });

    it("should set nextRunAt=now+60s when success=false stopCampaign=false and campaign is ongoing", async () => {
      const campaign = await insertTestCampaign(orgId, {
        brandIds,
        status: "ongoing",
        workflowSlug: "sales-email-cold-outreach",
        featureSlug: "sales-cold-email-v1",
        createdByUserId: "user_test",
      });

      const before = Date.now();

      await request(app)
        .post("/end-run")
        .set(pipelineHeaders({ "x-org-id": orgId, "x-campaign-id": campaign.id }))
        .send({ success: false, stopCampaign: false })
        .expect(200);

      await new Promise((r) => setTimeout(r, 100));

      const updated = await db.query.campaigns.findFirst({
        where: eq(campaigns.id, campaign.id),
      });
      expect(updated!.nextRunAt).not.toBeNull();
      const nextRunTime = new Date(updated!.nextRunAt!).getTime();
      // Should be ~now + 60s (within 5s tolerance)
      expect(nextRunTime).toBeGreaterThanOrEqual(before + 55_000);
      expect(nextRunTime).toBeLessThan(before + 65_000);
      expect(mockExecute).not.toHaveBeenCalled();
    });

    it("noWorkAvailable=true reschedules on the idle cadence (~10min), does NOT stop the campaign and marks nothing exhausted", async () => {
      const campaign = await insertTestCampaign(orgId, {
        brandIds,
        status: "ongoing",
        workflowSlug: "ai-meeting-booking-v1",
        featureSlug: "ai-meeting-booking",
        createdByUserId: "user_test",
      });

      const before = Date.now();

      const res = await request(app)
        .post("/end-run")
        .set(pipelineHeaders({ "x-org-id": orgId, "x-campaign-id": campaign.id }))
        .send({ success: true, stopCampaign: false, noWorkAvailable: true })
        .expect(200);

      expect(res.body.status).toBe("completed");
      await new Promise((r) => setTimeout(r, 100));

      const updated = await db.query.campaigns.findFirst({
        where: eq(campaigns.id, campaign.id),
      });
      // The reason it had nothing to do cannot change in ten seconds, so it waits on the idle
      // cadence instead of the run cadence.
      const nextRunTime = new Date(updated!.nextRunAt!).getTime();
      expect(nextRunTime).toBeGreaterThanOrEqual(before + 9 * 60_000);
      expect(nextRunTime).toBeLessThan(before + 11 * 60_000);
      // Nothing here stops a campaign or marks anything exhausted.
      expect(updated!.status).toBe("ongoing");
      expect(updated!.stopReason).toBeNull();
      const marks = await db.select().from(campaignAudienceExhaustion)
        .where(eq(campaignAudienceExhaustion.campaignId, campaign.id));
      expect(marks).toHaveLength(0);
      expect(mockExecute).not.toHaveBeenCalled();
    });

    it("noWorkAvailable=false is the run cadence — a run that DID work is unchanged", async () => {
      const campaign = await insertTestCampaign(orgId, {
        brandIds,
        status: "ongoing",
        workflowSlug: "ai-meeting-booking-v1",
        featureSlug: "ai-meeting-booking",
        createdByUserId: "user_test",
      });

      const before = Date.now();

      await request(app)
        .post("/end-run")
        .set(pipelineHeaders({ "x-org-id": orgId, "x-campaign-id": campaign.id }))
        .send({ success: true, stopCampaign: false, noWorkAvailable: false })
        .expect(200);

      await new Promise((r) => setTimeout(r, 100));

      const updated = await db.query.campaigns.findFirst({
        where: eq(campaigns.id, campaign.id),
      });
      const nextRunTime = new Date(updated!.nextRunAt!).getTime();
      expect(nextRunTime).toBeGreaterThanOrEqual(before + 9_000);
      expect(nextRunTime).toBeLessThan(before + 15_000);
    });

    it("a FAILED run claiming noWorkAvailable still takes the failure backoff", async () => {
      const campaign = await insertTestCampaign(orgId, {
        brandIds,
        status: "ongoing",
        workflowSlug: "ai-meeting-booking-v1",
        featureSlug: "ai-meeting-booking",
        createdByUserId: "user_test",
      });

      const before = Date.now();

      await request(app)
        .post("/end-run")
        .set(pipelineHeaders({ "x-org-id": orgId, "x-campaign-id": campaign.id }))
        .send({ success: false, stopCampaign: false, noWorkAvailable: true })
        .expect(200);

      await new Promise((r) => setTimeout(r, 100));

      const updated = await db.query.campaigns.findFirst({
        where: eq(campaigns.id, campaign.id),
      });
      const nextRunTime = new Date(updated!.nextRunAt!).getTime();
      // A failed run says nothing trustworthy about whether there was work to do.
      expect(nextRunTime).toBeGreaterThanOrEqual(before + 55_000);
      expect(nextRunTime).toBeLessThan(before + 65_000);
    });

    it("should NOT set nextRunAt if campaign is stopped", async () => {
      const campaign = await insertTestCampaign(orgId, {
        brandIds,
        status: "stopped",
      });

      await request(app)
        .post("/end-run")
        .set(pipelineHeaders({ "x-org-id": orgId, "x-campaign-id": campaign.id }))
        .send({ success: true, stopCampaign: false })
        .expect(200);

      await new Promise((r) => setTimeout(r, 100));

      const updated = await db.query.campaigns.findFirst({
        where: eq(campaigns.id, campaign.id),
      });
      expect(updated!.nextRunAt).toBeNull();
      expect(mockExecute).not.toHaveBeenCalled();
    });

    it("stopCampaign=true marks THIS run's audience exhausted and reschedules (does NOT stop) while other audiences remain serveable", async () => {
      const campaign = await insertTestCampaign(orgId, {
        brandIds,
        status: "ongoing",
        featureSlug: "sales-cold-email-v1",
        createdByUserId: "user_test",
      });

      mockListRuns.mockResolvedValue({
        runs: [
          { id: "run-789", status: "running", startedAt: new Date().toISOString() },
        ],
      });
      // A serveable (non-exhausted) audience still exists → the campaign must keep going.
      // hasServeableAudience reads the projection; aud-alive is present and not exhausted.
      mockFetchCandidates.mockResolvedValue([projectionRow("aud-alive")]);

      const res = await request(app)
        .post("/end-run")
        .set(pipelineHeaders({ "x-org-id": orgId, "x-campaign-id": campaign.id }))
        .set("x-audience-id", "aud-dry")
        .send({ success: true, stopCampaign: true })
        .expect(200);

      expect(res.body.status).toBe("completed");

      // Wait for async handling
      await new Promise((r) => setTimeout(r, 150));

      // The served audience is marked exhausted for this campaign.
      const marks = await db
        .select()
        .from(campaignAudienceExhaustion)
        .where(and(
          eq(campaignAudienceExhaustion.campaignId, campaign.id),
          eq(campaignAudienceExhaustion.audienceId, "aud-dry"),
        ));
      expect(marks).toHaveLength(1);

      // Campaign stays ongoing and is rescheduled (NOT stopped) — other audiences remain.
      const updated = await db.query.campaigns.findFirst({
        where: eq(campaigns.id, campaign.id),
      });
      expect(updated!.status).toBe("ongoing");
      expect(updated!.nextRunAt).not.toBeNull();

      // The stop-guard's brand read names the campaign's org: per-brand configuration is
      // per (org, brand), so a brand several orgs claim is only answerable with an org.
      expect(mockFetchBrandRuntimeContext).toHaveBeenCalledWith(
        brandIds[0],
        expect.objectContaining({ orgId }),
      );
    });

    it("stopCampaign=true auto-stops the campaign ONLY when no serveable audience remains (all exhausted)", async () => {
      const campaign = await insertTestCampaign(orgId, {
        brandIds,
        status: "ongoing",
        featureSlug: "sales-cold-email-v1",
        createdByUserId: "user_test",
      });

      mockListRuns.mockResolvedValue({
        runs: [
          { id: "run-790", status: "running", startedAt: new Date().toISOString() },
        ],
      });
      // No serveable audience left: the projection's only audience is the one we're marking
      // exhausted (aud-last) → after exclusion no audience remains → legitimate stop.
      mockFetchCandidates.mockResolvedValue([projectionRow("aud-last")]);

      const res = await request(app)
        .post("/end-run")
        .set(pipelineHeaders({ "x-org-id": orgId, "x-campaign-id": campaign.id }))
        .set("x-audience-id", "aud-last")
        .send({ success: true, stopCampaign: true })
        .expect(200);

      expect(res.body.status).toBe("completed");

      await new Promise((r) => setTimeout(r, 150));

      // NOT re-triggered, and stopped with nextRunAt cleared.
      expect(mockExecute).not.toHaveBeenCalled();
      const updated = await db.query.campaigns.findFirst({
        where: eq(campaigns.id, campaign.id),
      });
      expect(updated!.status).toBe("stopped");
      expect(updated!.nextRunAt).toBeNull();
      // And it says WHY. This is the one reason a campaign comes back on its own — the customer
      // is emailed asking them to extend an audience, so their doing it has to restart it. A stop
      // that does not record this reason is a campaign that stays stopped forever.
      expect(updated!.stopReason).toBe("audience_exhausted");
    });

    it("stopCampaign=true does NOT stop a campaign that has served nothing — no audience ran, so nothing was exhausted", async () => {
      const campaign = await insertTestCampaign(orgId, {
        brandIds,
        status: "ongoing",
        featureSlug: "sales-cold-email-v1",
        createdByUserId: "user_test",
      });

      mockListRuns.mockResolvedValue({
        runs: [
          { id: "run-791", status: "running", startedAt: new Date().toISOString() },
        ],
      });
      // Nothing serveable AND nothing ever exhausted — the degenerate case: the campaign was
      // created, its first serve came back empty carrying no audience id, and it has contacted
      // nobody. An empty remainder is not evidence it finished its people.
      mockFetchCandidates.mockResolvedValue([]);

      await request(app)
        .post("/end-run")
        // Deliberately NO x-audience-id: no audience ran, so there is nothing to mark.
        .set(pipelineHeaders({ "x-org-id": orgId, "x-campaign-id": campaign.id }))
        .send({ success: true, stopCampaign: true })
        .expect(200);

      await new Promise((r) => setTimeout(r, 150));

      const marks = await db
        .select()
        .from(campaignAudienceExhaustion)
        .where(eq(campaignAudienceExhaustion.campaignId, campaign.id));
      expect(marks).toHaveLength(0);

      // Stays ongoing and is rescheduled so it is looked at again, rather than parked on
      // `audience_exhausted` — a stop reason funding deliberately never resumes.
      const updated = await db.query.campaigns.findFirst({
        where: eq(campaigns.id, campaign.id),
      });
      expect(updated!.status).toBe("ongoing");
      expect(updated!.stopReason).toBeNull();
      expect(updated!.nextRunAt).not.toBeNull();

      // And it waits on the RECHECK cadence, not the run cadence: "nobody to contact" cannot
      // change in ten seconds, so rescheduling on RERUN_GRACE_MS fired a workflow every eleven
      // seconds forever for a campaign that could not do anything with it.
      const waitMs = updated!.nextRunAt!.getTime() - Date.now();
      expect(waitMs).toBeGreaterThan(NO_SERVEABLE_AUDIENCE_RECHECK_MS - 60_000);
      expect(waitMs).toBeLessThanOrEqual(NO_SERVEABLE_AUDIENCE_RECHECK_MS);
    });

    it("a campaign waiting for an audience comes back by itself once it has one — the wait is a reschedule, never a stop", async () => {
      const campaign = await insertTestCampaign(orgId, {
        brandIds,
        status: "ongoing",
        featureSlug: "sales-cold-email-v1",
        createdByUserId: "user_test",
      });

      mockListRuns.mockResolvedValue({
        runs: [
          { id: "run-792", status: "running", startedAt: new Date().toISOString() },
        ],
      });
      // First pass: nothing serveable, nothing ever exhausted → waits.
      mockFetchCandidates.mockResolvedValue([]);

      await request(app)
        .post("/end-run")
        .set(pipelineHeaders({ "x-org-id": orgId, "x-campaign-id": campaign.id }))
        .send({ success: true, stopCampaign: true })
        .expect(200);
      await new Promise((r) => setTimeout(r, 150));

      const waiting = await db.query.campaigns.findFirst({ where: eq(campaigns.id, campaign.id) });
      expect(waiting!.status).toBe("ongoing");

      // The customer activates an audience — the very next run finds somebody and the campaign
      // is rescheduled promptly, with no manual step and no stop to undo.
      mockFetchCandidates.mockResolvedValue([projectionRow("aud-fresh")]);

      await request(app)
        .post("/end-run")
        .set(pipelineHeaders({ "x-org-id": orgId, "x-campaign-id": campaign.id }))
        .send({ success: true, stopCampaign: false })
        .expect(200);
      await new Promise((r) => setTimeout(r, 150));

      const back = await db.query.campaigns.findFirst({ where: eq(campaigns.id, campaign.id) });
      expect(back!.status).toBe("ongoing");
      expect(back!.stopReason).toBeNull();
      expect(back!.nextRunAt!.getTime() - Date.now()).toBeLessThan(60_000);
    });

    it("should set nextRunAt and NOT fire-and-forget when stopCampaign is false", async () => {
      const campaign = await insertTestCampaign(orgId, {
        brandIds,
        status: "ongoing",
        featureSlug: "sales-cold-email-v1",
        createdByUserId: "user_test",
      });

      mockListRuns.mockResolvedValue({
        runs: [
          { id: "run-101", status: "running", startedAt: new Date().toISOString() },
        ],
      });

      await request(app)
        .post("/end-run")
        .set(pipelineHeaders({ "x-org-id": orgId, "x-campaign-id": campaign.id }))
        .send({ success: true, stopCampaign: false })
        .expect(200);

      await new Promise((r) => setTimeout(r, 100));

      const updated = await db.query.campaigns.findFirst({
        where: eq(campaigns.id, campaign.id),
      });
      expect(updated!.nextRunAt).not.toBeNull();
      expect(mockExecute).not.toHaveBeenCalled();
    });

    it("should not pass appId to listRuns", async () => {
      const campaign = await insertTestCampaign(orgId, { brandIds });

      mockListRuns.mockResolvedValue({ runs: [] });

      await request(app)
        .post("/end-run")
        .set(pipelineHeaders({ "x-org-id": orgId, "x-campaign-id": campaign.id }))
        .send({ success: true, stopCampaign: false })
        .expect(200);

      const callArgs = mockListRuns.mock.calls[0][0];
      expect(callArgs).not.toHaveProperty("appId");
    });

    it("should warn when run failed and reschedule via console.warn", async () => {
      const campaign = await insertTestCampaign(orgId, {
        brandIds,
        status: "ongoing",
        featureSlug: "sales-cold-email-v1",
        createdByUserId: "user_test",
      });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      try {
        await request(app)
          .post("/end-run")
          .set(pipelineHeaders({ "x-org-id": orgId, "x-campaign-id": campaign.id }))
          .send({ success: false, stopCampaign: false })
          .expect(200);

        await new Promise((r) => setTimeout(r, 100));

        const allWarns = warnSpy.mock.calls.flat().join(" ");
        expect(allWarns).toMatch(/Run failed — rescheduled campaign /);
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("should NOT warn when run completed (use console.log)", async () => {
      const campaign = await insertTestCampaign(orgId, {
        brandIds,
        status: "ongoing",
        featureSlug: "sales-cold-email-v1",
        createdByUserId: "user_test",
      });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      try {
        await request(app)
          .post("/end-run")
          .set(pipelineHeaders({ "x-org-id": orgId, "x-campaign-id": campaign.id }))
          .send({ success: true, stopCampaign: false })
          .expect(200);

        await new Promise((r) => setTimeout(r, 100));

        const allWarns = warnSpy.mock.calls.flat().join(" ");
        expect(allWarns).not.toMatch(/Run failed/);
        const allLogs = logSpy.mock.calls.flat().join(" ");
        expect(allLogs).toMatch(/Set nextRunAt=/);
      } finally {
        warnSpy.mockRestore();
        logSpy.mockRestore();
      }
    });
  });
});
