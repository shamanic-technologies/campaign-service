import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { buildColdEmailDag, COLD_EMAIL_PROMPT, COLD_EMAIL_VARIABLES } from "../../src/lib/workflows.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("Workflow module", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("COLD_EMAIL_PROMPT", () => {
    it("should contain all variable placeholders", () => {
      for (const variable of COLD_EMAIL_VARIABLES) {
        expect(COLD_EMAIL_PROMPT).toContain(`{{${variable}}}`);
      }
    });
  });

  describe("buildColdEmailDag", () => {
    it("should produce a valid DAG with nodes and edges", () => {
      const dag = buildColdEmailDag();
      expect(dag.nodes).toBeDefined();
      expect(dag.edges).toBeDefined();
      expect(dag.nodes.length).toBe(4);
      expect(dag.edges.length).toBe(3);
    });

    it("should have the correct node sequence: start-run → email-generate → email-send → end-run", () => {
      const dag = buildColdEmailDag();
      const nodeIds = dag.nodes.map((n) => n.id);
      expect(nodeIds).toEqual(["start-run", "email-generate", "email-send", "end-run"]);
    });

    it("should have correct edge ordering", () => {
      const dag = buildColdEmailDag();
      expect(dag.edges).toEqual([
        { from: "start-run", to: "email-generate" },
        { from: "email-generate", to: "email-send" },
        { from: "email-send", to: "end-run" },
      ]);
    });

    it("should use http.call type for all nodes", () => {
      const dag = buildColdEmailDag();
      for (const node of dag.nodes) {
        expect(node.type).toBe("http.call");
        expect(node.config.service).toBeDefined();
        expect(node.config.method).toBeDefined();
        expect(node.config.path).toBeDefined();
      }
    });

    it("should reference correct services", () => {
      const dag = buildColdEmailDag();
      const serviceMap: Record<string, string> = {};
      for (const node of dag.nodes) {
        serviceMap[node.id] = node.config.service as string;
      }
      expect(serviceMap["start-run"]).toBe("campaign");
      expect(serviceMap["email-generate"]).toBe("emailgeneration");
      expect(serviceMap["email-send"]).toBe("email-gateway");
      expect(serviceMap["end-run"]).toBe("campaign");
    });

    it("should set retries: 0 at top-level on non-idempotent nodes", () => {
      const dag = buildColdEmailDag();
      const noRetryNodes = ["start-run", "email-generate", "email-send"];
      for (const nodeId of noRetryNodes) {
        const node = dag.nodes.find((n) => n.id === nodeId);
        // retries must be top-level on the node, NOT inside config
        expect(node?.retries).toBe(0);
        expect(node?.config.retries).toBeUndefined();
      }
    });

    it("should have validateResponse on email-send to catch success: false", () => {
      const dag = buildColdEmailDag();
      const emailSend = dag.nodes.find((n) => n.id === "email-send");
      expect(emailSend?.config.validateResponse).toEqual({
        field: "success",
        equals: true,
      });
    });

    it("should have onError handler pointing to end-run", () => {
      const dag = buildColdEmailDag();
      expect(dag.onError).toBe("end-run");
    });

    it("should set success: true in end-run body (overridden to false by onError)", () => {
      const dag = buildColdEmailDag();
      const endRun = dag.nodes.find((n) => n.id === "end-run");
      expect(endRun?.config.body).toEqual({ success: true });
    });

    it("should map all lead data fields from start-run to email-generate", () => {
      const dag = buildColdEmailDag();
      const emailGen = dag.nodes.find((n) => n.id === "email-generate");
      const mapping = emailGen?.inputMapping || {};

      // Lead fields
      expect(mapping["body.leadFirstName"]).toBe("$ref:start-run.output.lead.data.first_name");
      expect(mapping["body.leadLastName"]).toBe("$ref:start-run.output.lead.data.last_name");
      expect(mapping["body.leadEmail"]).toBe("$ref:start-run.output.lead.data.email");
      expect(mapping["body.leadCompanyName"]).toBe("$ref:start-run.output.lead.data.organization_name");

      // Client fields
      expect(mapping["body.clientCompanyName"]).toBe("$ref:start-run.output.clientData.companyName");
      expect(mapping["body.clientBrandUrl"]).toBe("$ref:start-run.output.clientData.brandUrl");

      // Campaign fields
      expect(mapping["body.targetOutcome"]).toBe("$ref:start-run.output.targetOutcome");
      expect(mapping["body.valueForTarget"]).toBe("$ref:start-run.output.valueForTarget");
    });

    it("should pass email-generate output to email-send", () => {
      const dag = buildColdEmailDag();
      const emailSend = dag.nodes.find((n) => n.id === "email-send");
      const mapping = emailSend?.inputMapping || {};

      expect(mapping["body.subject"]).toBe("$ref:email-generate.output.subject");
      expect(mapping["body.htmlBody"]).toBe("$ref:email-generate.output.bodyHtml");
      expect(mapping["body.metadata.emailGenerationId"]).toBe("$ref:email-generate.output.id");
    });

    it("should use flow_input for start-run inputs", () => {
      const dag = buildColdEmailDag();
      const startRun = dag.nodes.find((n) => n.id === "start-run");
      expect(startRun?.inputMapping).toEqual({
        "body.campaignId": "$ref:flow_input.campaignId",
        "body.clerkOrgId": "$ref:flow_input.clerkOrgId",
      });
    });
  });

  describe("deployWorkflows", () => {
    it("should call PUT /workflows/deploy with correct payload", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ workflows: [{ name: "cold-email-outreach", action: "created" }] }),
      });

      const { deployWorkflows } = await import("../../src/lib/workflows.js");
      await deployWorkflows();

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe("https://windmill.test.local/workflows/deploy");
      expect(opts.method).toBe("PUT");
      expect(opts.headers["x-api-key"]).toBe("test-windmill-key");

      const body = JSON.parse(opts.body);
      expect(body.appId).toBe("mcpfactory");
      expect(body.workflows).toHaveLength(1);
      expect(body.workflows[0].name).toBe("cold-email-outreach");
      expect(body.workflows[0].dag.nodes).toHaveLength(4);
      expect(body.workflows[0].dag.onError).toBe("end-run");
    });

    it("should not throw when windmill env vars are missing", async () => {
      const originalUrl = process.env.WINDMILL_SERVICE_URL;
      delete process.env.WINDMILL_SERVICE_URL;

      const { deployWorkflows } = await import("../../src/lib/workflows.js");
      await expect(deployWorkflows()).resolves.not.toThrow();
      expect(mockFetch).not.toHaveBeenCalled();

      process.env.WINDMILL_SERVICE_URL = originalUrl;
    });

    it("should not throw when deployment fails", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => "Internal server error",
      });

      const { deployWorkflows } = await import("../../src/lib/workflows.js");
      await expect(deployWorkflows()).resolves.not.toThrow();
    });
  });

  describe("executeCampaignWorkflow", () => {
    it("should call POST /workflows/by-name/{type}/execute with type, campaignId, and clerkOrgId", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "run-123", status: "queued" }),
      });

      const { executeCampaignWorkflow } = await import("../../src/lib/workflows.js");
      await executeCampaignWorkflow("cold-email-outreach", {
        campaignId: "campaign-1",
        clerkOrgId: "org_test",
      });

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe("https://windmill.test.local/workflows/by-name/cold-email-outreach/execute");
      expect(opts.method).toBe("POST");

      const body = JSON.parse(opts.body);
      expect(body.appId).toBe("mcpfactory");
      expect(body.orgId).toBe("org_test");
      expect(body.inputs).toEqual({
        campaignId: "campaign-1",
        clerkOrgId: "org_test",
      });
    });

    it("should use type parameter in workflow URL", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "run-456", status: "queued" }),
      });

      const { executeCampaignWorkflow } = await import("../../src/lib/workflows.js");
      await executeCampaignWorkflow("journalist-pitch", {
        campaignId: "campaign-2",
        clerkOrgId: "org_test",
      });

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe("https://windmill.test.local/workflows/by-name/journalist-pitch/execute");
    });

    it("should not throw when execution fails", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: async () => "Workflow not found",
      });

      const { executeCampaignWorkflow } = await import("../../src/lib/workflows.js");
      await expect(
        executeCampaignWorkflow("cold-email-outreach", {
          campaignId: "campaign-1",
          clerkOrgId: "org_test",
        })
      ).resolves.not.toThrow();
    });
  });
});
