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
    it("should produce a valid DAG with 8 nodes and 7 edges", () => {
      const dag = buildColdEmailDag();
      expect(dag.nodes).toBeDefined();
      expect(dag.edges).toBeDefined();
      expect(dag.nodes.length).toBe(8);
      expect(dag.edges.length).toBe(7);
    });

    it("should have the correct node IDs", () => {
      const dag = buildColdEmailDag();
      const nodeIds = dag.nodes.map((n) => n.id);
      expect(nodeIds).toEqual([
        "gate-check",
        "start-run",
        "brand-profile",
        "fetch-lead",
        "email-generate",
        "email-send",
        "end-run",
        "end-run-error",
      ]);
    });

    it("should have correct edges with gate-check first and parallel fan-out after start-run", () => {
      const dag = buildColdEmailDag();
      expect(dag.edges).toEqual([
        { from: "gate-check", to: "start-run" },
        { from: "start-run", to: "brand-profile" },
        { from: "start-run", to: "fetch-lead" },
        { from: "brand-profile", to: "email-generate" },
        { from: "fetch-lead", to: "email-generate" },
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
      expect(serviceMap["gate-check"]).toBe("campaign");
      expect(serviceMap["start-run"]).toBe("campaign");
      expect(serviceMap["brand-profile"]).toBe("brand");
      expect(serviceMap["fetch-lead"]).toBe("lead");
      expect(serviceMap["email-generate"]).toBe("emailgeneration");
      expect(serviceMap["email-send"]).toBe("email-gateway");
      expect(serviceMap["end-run"]).toBe("campaign");
      expect(serviceMap["end-run-error"]).toBe("campaign");
    });

    it("should set retries: 0 at top-level on non-retryable nodes", () => {
      const dag = buildColdEmailDag();
      const noRetryNodes = ["gate-check", "fetch-lead", "email-generate", "email-send"];
      for (const nodeId of noRetryNodes) {
        const node = dag.nodes.find((n) => n.id === nodeId);
        // retries must be top-level on the node, NOT inside config
        expect(node?.retries).toBe(0);
        expect(node?.config.retries).toBeUndefined();
      }
    });

    it("should NOT set retries: 0 on start-run (idempotent)", () => {
      const dag = buildColdEmailDag();
      const startRun = dag.nodes.find((n) => n.id === "start-run");
      expect(startRun?.retries).toBeUndefined();
    });

    it("should have validateResponse on gate-check to catch allowed: false", () => {
      const dag = buildColdEmailDag();
      const gateCheck = dag.nodes.find((n) => n.id === "gate-check");
      expect(gateCheck?.config.validateResponse).toEqual({
        field: "allowed",
        equals: true,
      });
    });

    it("should have validateResponse on email-send to catch success: false", () => {
      const dag = buildColdEmailDag();
      const emailSend = dag.nodes.find((n) => n.id === "email-send");
      expect(emailSend?.config.validateResponse).toEqual({
        field: "success",
        equals: true,
      });
    });

    it("should have validateResponse on fetch-lead to catch found: false", () => {
      const dag = buildColdEmailDag();
      const fetchLead = dag.nodes.find((n) => n.id === "fetch-lead");
      expect(fetchLead?.config.validateResponse).toEqual({
        field: "found",
        equals: true,
      });
    });

    it("should have onError handler pointing to end-run-error (not end-run)", () => {
      const dag = buildColdEmailDag();
      expect(dag.onError).toBe("end-run-error");
    });

    it("should set success: true in end-run body and success: false in end-run-error body", () => {
      const dag = buildColdEmailDag();
      const endRun = dag.nodes.find((n) => n.id === "end-run");
      const endRunError = dag.nodes.find((n) => n.id === "end-run-error");
      expect(endRun?.config.body).toEqual({ success: true });
      expect(endRunError?.config.body).toEqual({ success: false });
    });

    it("should use /gate-check path (no /internal prefix)", () => {
      const dag = buildColdEmailDag();
      const gateCheck = dag.nodes.find((n) => n.id === "gate-check");
      expect(gateCheck?.config.path).toBe("/gate-check");
    });

    it("should use /start-run and /end-run paths (no /internal prefix)", () => {
      const dag = buildColdEmailDag();
      const startRun = dag.nodes.find((n) => n.id === "start-run");
      const endRun = dag.nodes.find((n) => n.id === "end-run");
      const endRunError = dag.nodes.find((n) => n.id === "end-run-error");
      expect(startRun?.config.path).toBe("/start-run");
      expect(endRun?.config.path).toBe("/end-run");
      expect(endRunError?.config.path).toBe("/end-run");
    });

    it("should configure gate-check node with flow_input mapping", () => {
      const dag = buildColdEmailDag();
      const gateCheck = dag.nodes.find((n) => n.id === "gate-check");
      expect(gateCheck?.inputMapping).toEqual({
        "body.campaignId": "$ref:flow_input.campaignId",
        "body.clerkOrgId": "$ref:flow_input.clerkOrgId",
      });
    });

    it("should configure brand-profile node with keyType and correct inputMapping", () => {
      const dag = buildColdEmailDag();
      const brandProfile = dag.nodes.find((n) => n.id === "brand-profile");
      expect(brandProfile?.config.body).toEqual({ keyType: "byok" });
      expect(brandProfile?.inputMapping).toEqual({
        "body.appId": "$ref:start-run.output.appId",
        "body.clerkOrgId": "$ref:start-run.output.clerkOrgId",
        "body.url": "$ref:start-run.output.brandUrl",
        "body.clerkUserId": "$ref:start-run.output.clerkUserId",
        "body.parentRunId": "$ref:start-run.output.runId",
      });
    });

    it("should configure fetch-lead node with custom headers and searchParams", () => {
      const dag = buildColdEmailDag();
      const fetchLead = dag.nodes.find((n) => n.id === "fetch-lead");
      const mapping = fetchLead?.inputMapping || {};
      expect(mapping["headers.x-app-id"]).toBe("$ref:start-run.output.appId");
      expect(mapping["headers.x-org-id"]).toBe("$ref:start-run.output.clerkOrgId");
      expect(mapping["body.campaignId"]).toBe("$ref:start-run.output.campaignId");
      expect(mapping["body.brandId"]).toBe("$ref:start-run.output.brandId");
      expect(mapping["body.parentRunId"]).toBe("$ref:start-run.output.runId");
      expect(mapping["body.searchParams"]).toBe("$ref:start-run.output.searchParams");
    });

    it("should map lead data from fetch-lead and brand data from brand-profile to email-generate", () => {
      const dag = buildColdEmailDag();
      const emailGen = dag.nodes.find((n) => n.id === "email-generate");
      const mapping = emailGen?.inputMapping || {};

      // Lead fields come from fetch-lead
      expect(mapping["body.leadFirstName"]).toBe("$ref:fetch-lead.output.lead.data.first_name");
      expect(mapping["body.leadLastName"]).toBe("$ref:fetch-lead.output.lead.data.last_name");
      expect(mapping["body.leadEmail"]).toBe("$ref:fetch-lead.output.lead.data.email");
      expect(mapping["body.leadCompanyName"]).toBe("$ref:fetch-lead.output.lead.data.organization_name");
      expect(mapping["body.apolloEnrichmentId"]).toBe("$ref:fetch-lead.output.lead.externalId");

      // Brand fields come from brand-profile
      expect(mapping["body.clientCompanyName"]).toBe("$ref:start-run.output.brandDomain");
      expect(mapping["body.clientBrandUrl"]).toBe("$ref:start-run.output.brandUrl");
      expect(mapping["body.clientCompanyOverview"]).toBe("$ref:brand-profile.output.profile.companyOverview");
      expect(mapping["body.clientValueProposition"]).toBe("$ref:brand-profile.output.profile.valueProposition");

      // Campaign fields from start-run
      expect(mapping["body.targetOutcome"]).toBe("$ref:start-run.output.targetOutcome");
      expect(mapping["body.valueForTarget"]).toBe("$ref:start-run.output.valueForTarget");
    });

    it("should map lead data from fetch-lead to email-send", () => {
      const dag = buildColdEmailDag();
      const emailSend = dag.nodes.find((n) => n.id === "email-send");
      const mapping = emailSend?.inputMapping || {};

      expect(mapping["body.to"]).toBe("$ref:fetch-lead.output.lead.data.email");
      expect(mapping["body.recipientFirstName"]).toBe("$ref:fetch-lead.output.lead.data.first_name");
      expect(mapping["body.recipientLastName"]).toBe("$ref:fetch-lead.output.lead.data.last_name");
      expect(mapping["body.recipientCompany"]).toBe("$ref:fetch-lead.output.lead.data.organization_name");
      expect(mapping["body.subject"]).toBe("$ref:email-generate.output.subject");
      expect(mapping["body.htmlBody"]).toBe("$ref:email-generate.output.bodyHtml");
    });

    it("should use flow_input for gate-check and start-run inputs", () => {
      const dag = buildColdEmailDag();
      const gateCheck = dag.nodes.find((n) => n.id === "gate-check");
      const startRun = dag.nodes.find((n) => n.id === "start-run");
      expect(gateCheck?.inputMapping).toEqual({
        "body.campaignId": "$ref:flow_input.campaignId",
        "body.clerkOrgId": "$ref:flow_input.clerkOrgId",
      });
      expect(startRun?.inputMapping).toEqual({
        "body.campaignId": "$ref:flow_input.campaignId",
        "body.clerkOrgId": "$ref:flow_input.clerkOrgId",
      });
    });

    it("should use flow_input for end-run and end-run-error (not start-run.output)", () => {
      const dag = buildColdEmailDag();
      const endRun = dag.nodes.find((n) => n.id === "end-run");
      const endRunError = dag.nodes.find((n) => n.id === "end-run-error");

      // Both should use flow_input, NOT $ref:start-run.output
      expect(endRun?.inputMapping).toEqual({
        "body.campaignId": "$ref:flow_input.campaignId",
        "body.clerkOrgId": "$ref:flow_input.clerkOrgId",
      });
      expect(endRunError?.inputMapping).toEqual({
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
      expect(body.workflows[0].dag.nodes).toHaveLength(8);
      expect(body.workflows[0].dag.onError).toBe("end-run-error");
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
