import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";

const { mockExecuteCampaignWorkflow } = vi.hoisted(() => ({
  mockExecuteCampaignWorkflow: vi.fn(),
}));

vi.mock("../../src/lib/workflows.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/lib/workflows.js")>();
  return {
    ...original,
    executeCampaignWorkflow: mockExecuteCampaignWorkflow,
  };
});

vi.mock("../../src/lib/gate-check.js", () => ({
  runGateChecks: vi.fn().mockResolvedValue({ allowed: true }),
}));

vi.mock("@distribute/runs-client", () => ({
  createRun: vi.fn().mockResolvedValue({ id: "mock-run-id" }),
  updateRun: vi.fn().mockResolvedValue({}),
  listRuns: vi.fn().mockResolvedValue({ runs: [] }),
  getStatsBudget: vi.fn().mockResolvedValue({ windows: [] }),
}));

import app from "../../src/index.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";

const API_KEY = process.env.CAMPAIGN_SERVICE_API_KEY || "test-api-key";

const validBody = {
  name: "Activation Test Campaign",
  workflowSlug: "sales-email-cold-outreach",
  orgId: "org_activation_test",

  brandIds: [crypto.randomUUID()],
};
const attribution = {
  activeGoalId: "goal_activation_test",
  brandProfileId: "brand_profile_activation_test",
  audienceId: "audience_activation_test",
};

/** Helper: create a campaign with all required headers */
function createCampaign(body: Record<string, unknown> = validBody) {
  return request(app)
    .post("/campaigns")
    .set("x-api-key", API_KEY)
    .set("x-org-id", "org_activation_test")
    .set("x-user-id", "user_activation_test")
    .set("x-run-id", crypto.randomUUID())
    .set("x-feature-slug", "sales-cold-email-v1")
    .send(body);
}

describe("Workflow trigger", () => {
  beforeEach(async () => {
    await cleanTestData();
    vi.clearAllMocks();
    mockExecuteCampaignWorkflow.mockResolvedValue(undefined);
  });

  afterAll(async () => {
    await cleanTestData();
  });

  describe("on campaign creation", () => {
    it("should trigger workflow immediately when campaign is created", async () => {
      const createRes = await createCampaign({ ...validBody, ...attribution }).expect(201);

      const campaignId = createRes.body.campaign.id;

      // Wait a tick for the fire-and-forget promise
      await new Promise((r) => setTimeout(r, 50));

      expect(mockExecuteCampaignWorkflow).toHaveBeenCalledOnce();
      expect(mockExecuteCampaignWorkflow).toHaveBeenCalledWith(
        "sales-email-cold-outreach",
        expect.objectContaining({
          campaignId,
          orgId: "org_activation_test",
          brandId: validBody.brandIds.join(","),
          userId: "user_activation_test",
          featureSlug: "sales-cold-email-v1",
          ...attribution,
        }),
      );
    });

    it("should still return 201 even if initial workflow execution fails", async () => {
      mockExecuteCampaignWorkflow.mockRejectedValue(new Error("Windmill down"));

      const createRes = await createCampaign().expect(201);

      expect(createRes.body.campaign).toBeDefined();
      expect(createRes.body.campaign.status).toBe("ongoing");
    });
  });

  describe("on PATCH activate", () => {
    it("should trigger workflow when status is set to activate", async () => {
      // Create campaign (triggers workflow once)
      const createRes = await createCampaign().expect(201);
      const campaignId = createRes.body.campaign.id;

      // Stop it first so we can activate
      await request(app)
        .patch(`/campaigns/${campaignId}`)
        .set("x-api-key", API_KEY)
        .set("x-org-id", "org_activation_test")
        .send({ status: "stop" })
        .expect(200);

      vi.clearAllMocks();
      mockExecuteCampaignWorkflow.mockResolvedValue(undefined);

      // Activate (requires tracking headers)
      const activateRes = await request(app)
        .patch(`/campaigns/${campaignId}`)
        .set("x-api-key", API_KEY)
        .set("x-org-id", "org_activation_test")
        .set("x-user-id", "user_activation_test")
        .set("x-run-id", crypto.randomUUID())
        .set("x-feature-slug", "sales-cold-email-v1")
        .send({ status: "activate" })
        .expect(200);

      expect(activateRes.body.campaign.status).toBe("ongoing");

      // Wait a tick for the fire-and-forget promise
      await new Promise((r) => setTimeout(r, 50));

      expect(mockExecuteCampaignWorkflow).toHaveBeenCalledOnce();
      expect(mockExecuteCampaignWorkflow).toHaveBeenCalledWith(
        "sales-email-cold-outreach",
        expect.objectContaining({
          campaignId,
          orgId: "org_activation_test",
          activeGoalId: null,
          brandProfileId: null,
          audienceId: null,
        }),
      );
    });

    it("should preserve persona/profile attribution when activating a campaign", async () => {
      const createRes = await createCampaign({
        ...validBody,
        name: "Attributed Activation Campaign",
        ...attribution,
      }).expect(201);
      const campaignId = createRes.body.campaign.id;

      await request(app)
        .patch(`/campaigns/${campaignId}`)
        .set("x-api-key", API_KEY)
        .set("x-org-id", "org_activation_test")
        .send({ status: "stop" })
        .expect(200);

      await new Promise((r) => setTimeout(r, 50));
      vi.clearAllMocks();
      mockExecuteCampaignWorkflow.mockResolvedValue(undefined);

      await request(app)
        .patch(`/campaigns/${campaignId}`)
        .set("x-api-key", API_KEY)
        .set("x-org-id", "org_activation_test")
        .set("x-user-id", "user_activation_test")
        .set("x-run-id", crypto.randomUUID())
        .set("x-feature-slug", "sales-cold-email-v1")
        .send({ status: "activate" })
        .expect(200);

      await new Promise((r) => setTimeout(r, 50));

      expect(mockExecuteCampaignWorkflow).toHaveBeenCalledOnce();
      expect(mockExecuteCampaignWorkflow).toHaveBeenCalledWith(
        "sales-email-cold-outreach",
        expect.objectContaining({
          campaignId,
          ...attribution,
        }),
      );
    });

    it("should NOT trigger workflow on stop (only creation trigger)", async () => {
      const createRes = await createCampaign().expect(201);
      const campaignId = createRes.body.campaign.id;

      // Clear mocks after creation trigger
      await new Promise((r) => setTimeout(r, 50));
      vi.clearAllMocks();
      mockExecuteCampaignWorkflow.mockResolvedValue(undefined);

      await request(app)
        .patch(`/campaigns/${campaignId}`)
        .set("x-api-key", API_KEY)
        .set("x-org-id", "org_activation_test")
        .send({ status: "stop" })
        .expect(200);

      await new Promise((r) => setTimeout(r, 50));

      expect(mockExecuteCampaignWorkflow).not.toHaveBeenCalled();
    });

    it("should NOT trigger workflow when updating non-status fields", async () => {
      const createRes = await createCampaign().expect(201);
      const campaignId = createRes.body.campaign.id;

      // Clear mocks after creation trigger
      await new Promise((r) => setTimeout(r, 50));
      vi.clearAllMocks();
      mockExecuteCampaignWorkflow.mockResolvedValue(undefined);

      await request(app)
        .patch(`/campaigns/${campaignId}`)
        .set("x-api-key", API_KEY)
        .set("x-org-id", "org_activation_test")
        .send({ name: "Updated Name" })
        .expect(200);

      await new Promise((r) => setTimeout(r, 50));

      expect(mockExecuteCampaignWorkflow).not.toHaveBeenCalled();
    });

    it("should still return 200 even if workflow execution fails on activate", async () => {
      const createRes = await createCampaign().expect(201);
      const campaignId = createRes.body.campaign.id;

      // Stop then activate with failing mock
      await request(app)
        .patch(`/campaigns/${campaignId}`)
        .set("x-api-key", API_KEY)
        .set("x-org-id", "org_activation_test")
        .send({ status: "stop" })
        .expect(200);

      mockExecuteCampaignWorkflow.mockRejectedValue(new Error("Windmill down"));

      const activateRes = await request(app)
        .patch(`/campaigns/${campaignId}`)
        .set("x-api-key", API_KEY)
        .set("x-org-id", "org_activation_test")
        .set("x-user-id", "user_activation_test")
        .set("x-run-id", crypto.randomUUID())
        .set("x-feature-slug", "sales-cold-email-v1")
        .send({ status: "activate" })
        .expect(200);

      expect(activateRes.body.campaign.status).toBe("ongoing");
    });
  });
});

// ── The FIRST run is selected like every other one ──────────────────────────────────────────
//
// Prod 2026-09-24, campaign c8133eca (leg start_to_conversation): created with a cheap-tier
// workflow its leg's model rule excludes, and that workflow ran as the campaign's first run before
// the selector ever saw it. The stored slug is the selector's FALLBACK, never what runs by fiat.
describe("a person-started run goes through the leg's model rule", () => {
  const originalFetch = global.fetch;
  const LEG = "start_to_conversation";
  const INELIGIBLE = "sales-cold-email-outreach-maelstrom";
  const ELIGIBLE = "sales-cold-email-outreach-atoll";

  function json(body: unknown) {
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  }
  function gridRow(slug: string, costPerOutcomeUsd: number) {
    return {
      audienceId: "aud-A",
      workflow: { workflowDynastySlug: slug, workflowDynastyName: slug },
      resolved: { grain: "brand", costPerOutcomeUsd },
    };
  }
  function verdictRow(slug: string, eligible: boolean) {
    return {
      ...gridRow(slug, 21),
      modelEligibility: {
        modelAlias: eligible ? "pro" : "glm-flash",
        modelTier: eligible ? "strong" : "cheap",
        eligible,
        ineligibleReason: eligible ? null : "cheap tier cannot sell a conversation",
        unknownTierReason: null,
      },
    };
  }

  beforeEach(async () => {
    await cleanTestData();
    vi.clearAllMocks();
    mockExecuteCampaignWorkflow.mockResolvedValue(undefined);
    process.env.FEATURES_SERVICE_URL = "https://features.test";
    process.env.FEATURES_SERVICE_API_KEY = "k";
    // The ineligible workflow is the CHEAPEST cell, so without the rule it would win on price too.
    global.fetch = vi.fn(async (url: URL | string) => {
      const u = new URL(String(url));
      if (u.host !== "features.test") return json({});
      if (u.searchParams.has("leg")) {
        return json({ rows: [verdictRow(INELIGIBLE, false), verdictRow(ELIGIBLE, true)] });
      }
      return json({ rows: [gridRow(INELIGIBLE, 5), gridRow(ELIGIBLE, 30)] });
    }) as unknown as typeof fetch;
  });

  afterAll(async () => {
    global.fetch = originalFetch;
    delete process.env.FEATURES_SERVICE_URL;
    delete process.env.FEATURES_SERVICE_API_KEY;
    await cleanTestData();
    await closeDb();
  });

  const salesBody = () => ({
    name: `Leg rule ${crypto.randomUUID()}`,
    workflowSlug: INELIGIBLE,
    orgId: "org_activation_test",
    brandIds: [crypto.randomUUID()],
    funnelKey: "sales_meetings_from_conversation",
    legKey: LEG,
  });
  const create = (body: Record<string, unknown>) =>
    request(app)
      .post("/campaigns")
      .set("x-api-key", API_KEY)
      .set("x-org-id", "org_activation_test")
      .set("x-user-id", "user_activation_test")
      .set("x-run-id", crypto.randomUUID())
      .set("x-feature-slug", "sales-cold-email-outreach")
      .send(body);

  it("creating with an ineligible stored workflow runs an ELIGIBLE one first — and keeps the row as stored", async () => {
    const res = await create(salesBody());
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    await new Promise((r) => setTimeout(r, 100));

    expect(mockExecuteCampaignWorkflow).toHaveBeenCalledOnce();
    expect(mockExecuteCampaignWorkflow.mock.calls[0][0]).toBe(ELIGIBLE);
    expect(mockExecuteCampaignWorkflow.mock.calls[0][1]).toMatchObject({
      campaignId: res.body.campaign.id,
      audienceId: "aud-A",
    });
    // The creation is never rejected and the stored slug is untouched: it stays the fallback.
    expect(res.body.campaign.workflowSlug).toBe(INELIGIBLE);
  });

  it("activating a campaign whose stored workflow is ineligible runs an ELIGIBLE one", async () => {
    const res = await create(salesBody()).expect(201);
    const campaignId = res.body.campaign.id;
    await request(app)
      .patch(`/campaigns/${campaignId}`)
      .set("x-api-key", API_KEY)
      .set("x-org-id", "org_activation_test")
      .send({ status: "stop" })
      .expect(200);
    await new Promise((r) => setTimeout(r, 100));
    mockExecuteCampaignWorkflow.mockClear();

    await request(app)
      .patch(`/campaigns/${campaignId}`)
      .set("x-api-key", API_KEY)
      .set("x-org-id", "org_activation_test")
      .set("x-user-id", "user_activation_test")
      .set("x-run-id", crypto.randomUUID())
      .set("x-feature-slug", "sales-cold-email-outreach")
      .send({ status: "activate" })
      .expect(200);
    await new Promise((r) => setTimeout(r, 100));

    expect(mockExecuteCampaignWorkflow).toHaveBeenCalledOnce();
    expect(mockExecuteCampaignWorkflow.mock.calls[0][0]).toBe(ELIGIBLE);
  });
});
