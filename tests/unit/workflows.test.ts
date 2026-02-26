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
        appId: "mcpfactory",
      });

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe("https://workflow.test.local/workflows/by-name/sales-email-cold-outreach/execute");
      expect(opts.method).toBe("POST");

      const body = JSON.parse(opts.body);
      expect(body.appId).toBe("mcpfactory");
      expect(body.orgId).toBe("org_test");
      expect(body.inputs).toEqual({
        campaignId: "campaign-1",
        orgId: "org_test",
      });
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
          appId: "mcpfactory",
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
          appId: "mcpfactory",
        })
      ).resolves.not.toThrow();
      expect(mockFetch).not.toHaveBeenCalled();

      process.env.WORKFLOW_SERVICE_URL = originalUrl;
    });
  });
});
