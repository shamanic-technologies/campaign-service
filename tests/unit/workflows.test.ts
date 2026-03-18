import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("Workflow module", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("executeCampaignWorkflow", () => {
    it("should use workflowName directly in URL", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "run-123", status: "queued" }),
      });

      const { executeCampaignWorkflow } = await import("../../src/lib/workflows.js");
      await executeCampaignWorkflow("sales-email-cold-outreach", {
        campaignId: "campaign-1",
        orgId: "org_test",
        brandId: "brand-abc",
      });

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe("https://workflow.test.local/workflows/by-name/sales-email-cold-outreach/execute");
      expect(opts.method).toBe("POST");

      const body = JSON.parse(opts.body);
      expect(body).not.toHaveProperty("appId");
      expect(body).not.toHaveProperty("orgId");
      expect(body.inputs).toEqual({
        campaignId: "campaign-1",
        orgId: "org_test",
      });
    });

    it("should set x-run-id header when runId is provided", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "run-123", status: "queued" }),
      });

      const { executeCampaignWorkflow } = await import("../../src/lib/workflows.js");
      await executeCampaignWorkflow("sales-email-cold-outreach", {
        campaignId: "campaign-1",
        orgId: "org_test",
        brandId: "brand-abc",
        userId: "user_test",
        runId: "run-parent-456",
      });

      expect(mockFetch).toHaveBeenCalledOnce();
      const [, opts] = mockFetch.mock.calls[0];
      expect(opts.headers["x-org-id"]).toBe("org_test");
      expect(opts.headers["x-user-id"]).toBe("user_test");
      expect(opts.headers["x-run-id"]).toBe("run-parent-456");
    });

    it("should set tracking headers (x-campaign-id, x-brand-id, x-workflow-name) when provided", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "run-123", status: "queued" }),
      });

      const { executeCampaignWorkflow } = await import("../../src/lib/workflows.js");
      await executeCampaignWorkflow("sales-email-cold-outreach", {
        campaignId: "campaign-1",
        orgId: "org_test",
        brandId: "brand-abc",
      });

      expect(mockFetch).toHaveBeenCalledOnce();
      const [, opts] = mockFetch.mock.calls[0];
      expect(opts.headers["x-campaign-id"]).toBe("campaign-1");
      expect(opts.headers["x-brand-id"]).toBe("brand-abc");
      expect(opts.headers["x-workflow-name"]).toBe("sales-email-cold-outreach");
    });

    it("should always set x-brand-id header (required)", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "run-123", status: "queued" }),
      });

      const { executeCampaignWorkflow } = await import("../../src/lib/workflows.js");
      await executeCampaignWorkflow("pr-outreach", {
        campaignId: "campaign-2",
        orgId: "org_test",
        brandId: "brand-xyz",
      });

      expect(mockFetch).toHaveBeenCalledOnce();
      const [, opts] = mockFetch.mock.calls[0];
      expect(opts.headers["x-campaign-id"]).toBe("campaign-2");
      expect(opts.headers["x-brand-id"]).toBe("brand-xyz");
      expect(opts.headers["x-workflow-name"]).toBe("pr-outreach");
    });

    it("should not throw when execution fails", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: async () => "Workflow not found",
      });

      const { executeCampaignWorkflow } = await import("../../src/lib/workflows.js");
      await expect(
        executeCampaignWorkflow("sales-email-cold-outreach", {
          campaignId: "campaign-1",
          orgId: "org_test",
          brandId: "brand-abc",
        })
      ).resolves.not.toThrow();
    });

    it("should not throw when workflow-service env vars are missing", async () => {
      const originalUrl = process.env.WORKFLOW_SERVICE_URL;
      delete process.env.WORKFLOW_SERVICE_URL;

      const { executeCampaignWorkflow } = await import("../../src/lib/workflows.js");
      await expect(
        executeCampaignWorkflow("any-workflow", {
          campaignId: "campaign-1",
          orgId: "org_test",
          brandId: "brand-abc",
        })
      ).resolves.not.toThrow();
      expect(mockFetch).not.toHaveBeenCalled();

      process.env.WORKFLOW_SERVICE_URL = originalUrl;
    });
  });
});
