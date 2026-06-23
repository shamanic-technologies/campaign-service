import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";

const {
  mockCreateRun,
  mockUpdateRun,
  mockListRuns,
  mockExecute,
  mockGateChecks,
  mockFetchBrandRuntimeContext,
  mockSelectAudienceForRun,
  mockFetchCandidates,
} = vi.hoisted(() => ({
  mockCreateRun: vi.fn(),
  mockUpdateRun: vi.fn(),
  mockListRuns: vi.fn(),
  mockExecute: vi.fn(),
  mockGateChecks: vi.fn(),
  mockFetchBrandRuntimeContext: vi.fn(),
  mockSelectAudienceForRun: vi.fn(),
  mockFetchCandidates: vi.fn(),
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

vi.mock("../../src/lib/features-audience-client.js", () => ({
  selectAudienceForRun: mockSelectAudienceForRun,
}));

vi.mock("../../src/lib/features-candidates-client.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/lib/features-candidates-client.js")>();
  return {
    ...original, // keep the real pure audienceIdsForWorkflow
    fetchCandidates: mockFetchCandidates,
  };
});

import app from "../../src/index.js";
import { db } from "../../src/db/index.js";
import { campaigns } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
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

const defaultAudience = {
  audienceId: "customer-profile-best",
  brandProfileId: "brand-profile-current",
  audience: {
    id: "customer-profile-best",
    name: "Revenue leaders",
    status: "active",
    filters: {
      titles: ["VP Sales", "Head of Growth"],
    },
  },
  evidence: {
    contacted: 120,
    websiteClicks: 24,
    positiveReplies: 6,
  },
  metrics: {
    cpcCents: 500,
    cpprCents: 2000,
  },
};

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
    mockSelectAudienceForRun.mockResolvedValue(defaultAudience);
    mockFetchCandidates.mockResolvedValue([]);
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
      // audienceId (from audience-stats), not the stored column.
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
        audience: defaultAudience,
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
      expect(mockSelectAudienceForRun).toHaveBeenCalledWith(
        expect.objectContaining({
          featureSlug: "sales-cold-email-v1",
          brandId: brandIds[0],
          goal: "signup",
          brandProfileId: "brand-profile-current",
          identity: expect.objectContaining({ runId: "parent-run-1" }),
        }),
      );
    });

    it("should scope the audience exploration to the chosen workflow's audiences (audience-grain candidates)", async () => {
      const mkCandidate = (slug: string, audienceId: string | null) => ({
        audienceId,
        workflow: { workflowDynastySlug: slug, workflowDynastyName: slug },
        goal: "signup" as const,
        costPerOutcomeUsd: null,
        cost: { costPerLeadUsd: 100, clickUsd: null, replyUsd: null },
        sampleSize: { runs: 1, contacted: 100, clicks: 5, replies: 2 },
      });
      // Two audiences ran the campaign's workflow; one belongs to a different workflow.
      mockFetchCandidates.mockResolvedValueOnce([
        mkCandidate("sales-email-cold-outreach", "aud-1"),
        mkCandidate("sales-email-cold-outreach", "aud-2"),
        mkCandidate("sales-email-cold-outreach", null), // coarse fallback row — excluded
        mkCandidate("some-other-workflow", "aud-3"), //      other workflow — excluded
      ]);
      const campaign = await insertTestCampaign(orgId, { brandIds });

      await request(app)
        .post("/start-run")
        .set(pipelineHeaders({ "x-org-id": orgId, "x-campaign-id": campaign.id }))
        .expect(200);

      const passed = mockSelectAudienceForRun.mock.calls.at(-1)![0];
      expect([...passed.eligibleAudienceIds].sort()).toEqual(["aud-1", "aud-2"]);
    });

    it("should not scope audiences when the workflow has no audience-grain candidates (fail-soft)", async () => {
      mockFetchCandidates.mockResolvedValueOnce([]);
      const campaign = await insertTestCampaign(orgId, { brandIds });

      await request(app)
        .post("/start-run")
        .set(pipelineHeaders({ "x-org-id": orgId, "x-campaign-id": campaign.id }))
        .expect(200);

      const passed = mockSelectAudienceForRun.mock.calls.at(-1)![0];
      expect(passed.eligibleAudienceIds).toBeUndefined();
    });

    it("should still select an audience when fetchCandidates throws (fail-soft)", async () => {
      mockFetchCandidates.mockRejectedValueOnce(new Error("features-service down"));
      const campaign = await insertTestCampaign(orgId, { brandIds });

      const res = await request(app)
        .post("/start-run")
        .set(pipelineHeaders({ "x-org-id": orgId, "x-campaign-id": campaign.id }))
        .expect(200);

      expect(res.body.audienceId).toBe("customer-profile-best");
      const passed = mockSelectAudienceForRun.mock.calls.at(-1)![0];
      expect(passed.eligibleAudienceIds).toBeUndefined();
    });

    it("should stamp the selected audience on the run (x-audience-id) and return it", async () => {
      const campaign = await insertTestCampaign(orgId, { brandIds });

      const res = await request(app)
        .post("/start-run")
        .set(pipelineHeaders({ "x-org-id": orgId, "x-campaign-id": campaign.id }))
        .expect(200);

      // audience.id == the selected persona/profile id (customer-profile-best from the mock)
      expect(res.body.audienceId).toBe("customer-profile-best");
      expect(mockCreateRun).toHaveBeenCalledWith(
        expect.objectContaining({ audienceId: "customer-profile-best" }),
      );
    });

    it("should return audienceId: null and not stamp the run when no audience is selected", async () => {
      mockSelectAudienceForRun.mockResolvedValueOnce(null);
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

    it("should enrich featureInputs searchParams with current brand profile and best persona", async () => {
      const campaign = await insertTestCampaign(orgId, {
        brandIds,
        featureInputs: { mediaType: "podcast", region: "US" },
      });

      const res = await request(app)
        .post("/start-run")
        .set(pipelineHeaders({ "x-org-id": orgId, "x-campaign-id": campaign.id }))
        .expect(200);

      expect(res.body.searchParams).toEqual({
        mediaType: "podcast",
        region: "US",
        brandProfile: { ...defaultBrandProfile, brandId: brandIds[0] },
        audience: defaultAudience,
      });
    });

    it("should include audience: null when FeatureService has no audience rows", async () => {
      mockSelectAudienceForRun.mockResolvedValueOnce(null);
      const campaign = await insertTestCampaign(orgId, { brandIds });

      const res = await request(app)
        .post("/start-run")
        .set(pipelineHeaders({ "x-org-id": orgId, "x-campaign-id": campaign.id }))
        .expect(200);

      expect(res.body.searchParams).toEqual({
        brandProfile: { ...defaultBrandProfile, brandId: brandIds[0] },
        audience: null,
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

    it("should auto-stop campaign and NOT re-trigger when stopCampaign is true", async () => {
      const campaign = await insertTestCampaign(orgId, {
        brandIds,
        status: "ongoing",
      });

      mockListRuns.mockResolvedValue({
        runs: [
          { id: "run-789", status: "running", startedAt: new Date().toISOString() },
        ],
      });

      const res = await request(app)
        .post("/end-run")
        .set(pipelineHeaders({ "x-org-id": orgId, "x-campaign-id": campaign.id }))
        .send({ success: true, stopCampaign: true })
        .expect(200);

      expect(res.body.status).toBe("completed");
      expect(mockUpdateRun).toHaveBeenCalledWith("run-789", "completed", expect.objectContaining({ orgId }));

      // Wait for async auto-stop
      await new Promise((r) => setTimeout(r, 100));

      // Should NOT re-trigger
      expect(mockExecute).not.toHaveBeenCalled();

      // Should auto-stop in DB and NOT set nextRunAt
      const updated = await db.query.campaigns.findFirst({
        where: eq(campaigns.id, campaign.id),
      });
      expect(updated!.status).toBe("stopped");
      expect(updated!.nextRunAt).toBeNull();
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
