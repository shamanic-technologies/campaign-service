import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const VALID_INPUTS = {
  campaignId: "campaign-1",
  orgId: "org_test",
  brandId: "brand-abc",
  userId: "user_test",
  runId: "run-parent-456",
  featureSlug: "sales-cold-email-v1",
} as const;

describe("Workflow module", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("validateWorkflowInputs", () => {
    it("should return empty array when all fields are present", async () => {
      const { validateWorkflowInputs } = await import("../../src/lib/workflows.js");
      expect(validateWorkflowInputs(VALID_INPUTS)).toEqual([]);
    });

    it("should return missing field names", async () => {
      const { validateWorkflowInputs } = await import("../../src/lib/workflows.js");
      expect(validateWorkflowInputs({
        campaignId: "c1",
        orgId: "o1",
        brandId: "b1",
        userId: "",
        runId: "",
        featureSlug: "",
      })).toEqual(["userId", "runId", "featureSlug"]);
    });
  });

  describe("executeCampaignWorkflow", () => {
    it("should use workflowSlug directly in URL and send all required headers", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "run-123", status: "queued" }),
      });

      const { executeCampaignWorkflow } = await import("../../src/lib/workflows.js");
      await executeCampaignWorkflow("sales-email-cold-outreach", VALID_INPUTS);

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe("https://workflow.test.local/workflows/by-slug/sales-email-cold-outreach/execute");
      expect(opts.method).toBe("POST");

      // All 7 tracking headers must be present
      expect(opts.headers["x-org-id"]).toBe("org_test");
      expect(opts.headers["x-user-id"]).toBe("user_test");
      expect(opts.headers["x-run-id"]).toBe("run-parent-456");
      expect(opts.headers["x-brand-id"]).toBe("brand-abc");
      expect(opts.headers["x-campaign-id"]).toBe("campaign-1");
      expect(opts.headers["x-feature-slug"]).toBe("sales-cold-email-v1");
      expect(opts.headers["x-workflow-slug"]).toBe("sales-email-cold-outreach");

      const body = JSON.parse(opts.body);
      expect(body).not.toHaveProperty("appId");
      expect(body.inputs).toEqual({
        campaignId: "campaign-1",
        orgId: "org_test",
        brandId: "brand-abc",
        featureSlug: "sales-cold-email-v1",
        activeGoalId: null,
        brandProfileId: null,
        customerPersonaId: null,
        audienceId: null,
      });
      expect(opts.headers).not.toHaveProperty("x-active-goal-id");
      expect(opts.headers).not.toHaveProperty("x-brand-profile-id");
      expect(opts.headers).not.toHaveProperty("x-customer-persona-id");
      expect(opts.headers).not.toHaveProperty("x-audience-id");
    });

    it("should send optional persona/profile attribution in headers and body", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "run-123", status: "queued" }),
      });

      const { executeCampaignWorkflow } = await import("../../src/lib/workflows.js");
      await executeCampaignWorkflow("sales-email-cold-outreach", {
        ...VALID_INPUTS,
        activeGoalId: "goal-1",
        brandProfileId: "brand-profile-1",
        customerPersonaId: "persona-1",
        audienceId: "customer-profile-1",
      });

      const [, opts] = mockFetch.mock.calls[0];
      expect(opts.headers["x-active-goal-id"]).toBe("goal-1");
      expect(opts.headers["x-brand-profile-id"]).toBe("brand-profile-1");
      expect(opts.headers["x-customer-persona-id"]).toBe("persona-1");
      expect(opts.headers["x-audience-id"]).toBe("customer-profile-1");

      const body = JSON.parse(opts.body);
      expect(body.inputs).toMatchObject({
        activeGoalId: "goal-1",
        brandProfileId: "brand-profile-1",
        customerPersonaId: "persona-1",
        audienceId: "customer-profile-1",
      });
    });

    it("should throw when required fields are missing", async () => {
      const { executeCampaignWorkflow } = await import("../../src/lib/workflows.js");
      await expect(
        executeCampaignWorkflow("sales-email-cold-outreach", {
          ...VALID_INPUTS,
          userId: "",
          featureSlug: "",
        } as any)
      ).rejects.toThrow("missing required fields: userId, featureSlug");
    });

    it("should not throw when execution fails (non-ok response)", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: async () => "Workflow not found",
      });

      const { executeCampaignWorkflow } = await import("../../src/lib/workflows.js");
      await expect(
        executeCampaignWorkflow("sales-email-cold-outreach", VALID_INPUTS)
      ).resolves.not.toThrow();
    });

    it("should not throw when workflow-service env vars are missing", async () => {
      const originalUrl = process.env.WORKFLOW_SERVICE_URL;
      delete process.env.WORKFLOW_SERVICE_URL;

      const { executeCampaignWorkflow } = await import("../../src/lib/workflows.js");
      await expect(
        executeCampaignWorkflow("any-workflow", VALID_INPUTS)
      ).resolves.not.toThrow();
      expect(mockFetch).not.toHaveBeenCalled();

      process.env.WORKFLOW_SERVICE_URL = originalUrl;
    });
  });
});
