import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { buildColdEmailDag, COLD_EMAIL_PROMPT, COLD_EMAIL_VARIABLES, getConfirmedWorkflowName } from "../../src/lib/workflows.js";

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
    it("should produce a valid DAG with 9 nodes and 7 edges", () => {
      const dag = buildColdEmailDag();
      expect(dag.nodes).toBeDefined();
      expect(dag.edges).toBeDefined();
      expect(dag.nodes.length).toBe(9);
      expect(dag.edges.length).toBe(7);
    });

    it("should have the correct node IDs", () => {
      const dag = buildColdEmailDag();
      const nodeIds = dag.nodes.map((n) => n.id);
      expect(nodeIds).toEqual([
        "gate-check",
        "start-run",
        "fetch-lead",
        "check-lead",
        "brand-profile",
        "email-generate",
        "email-send",
        "end-run",
        "end-run-error",
      ]);
    });

    it("should have correct edges with conditional branching after check-lead", () => {
      const dag = buildColdEmailDag();
      expect(dag.edges).toEqual([
        { from: "gate-check", to: "start-run" },
        { from: "start-run", to: "fetch-lead" },
        { from: "fetch-lead", to: "check-lead" },
        { from: "check-lead", to: "brand-profile", condition: "results.fetch_lead.found == true" },
        { from: "brand-profile", to: "email-generate" },
        { from: "email-generate", to: "email-send" },
        { from: "check-lead", to: "end-run" },
      ]);
    });

    it("should have check-lead as a condition node (not http.call)", () => {
      const dag = buildColdEmailDag();
      const checkLead = dag.nodes.find((n) => n.id === "check-lead");
      expect(checkLead?.type).toBe("condition");
    });

    it("should use http.call type for all non-condition nodes", () => {
      const dag = buildColdEmailDag();
      for (const node of dag.nodes) {
        if (node.id === "check-lead") {
          expect(node.type).toBe("condition");
        } else {
          expect(node.type).toBe("http.call");
          expect(node.config.service).toBeDefined();
          expect(node.config.method).toBeDefined();
          expect(node.config.path).toBeDefined();
        }
      }
    });

    it("should reference correct services", () => {
      const dag = buildColdEmailDag();
      const serviceMap: Record<string, string> = {};
      for (const node of dag.nodes) {
        if (node.config?.service) {
          serviceMap[node.id] = node.config.service as string;
        }
      }
      expect(serviceMap["gate-check"]).toBe("campaign");
      expect(serviceMap["start-run"]).toBe("campaign");
      expect(serviceMap["brand-profile"]).toBe("brand");
      expect(serviceMap["fetch-lead"]).toBe("lead");
      expect(serviceMap["email-generate"]).toBe("content-generation");
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

    it("should NOT have validateResponse on fetch-lead (handled by check-lead condition)", () => {
      const dag = buildColdEmailDag();
      const fetchLead = dag.nodes.find((n) => n.id === "fetch-lead");
      expect(fetchLead?.config.validateResponse).toBeUndefined();
    });

    it("should have conditional edge from check-lead to brand-profile (found=true branch)", () => {
      const dag = buildColdEmailDag();
      const conditionalEdge = dag.edges.find((e) => e.from === "check-lead" && e.to === "brand-profile");
      expect(conditionalEdge?.condition).toBe("results.fetch_lead.found == true");
    });

    it("should have unconditional edge from check-lead to end-run (always runs)", () => {
      const dag = buildColdEmailDag();
      const endRunEdge = dag.edges.find((e) => e.from === "check-lead" && e.to === "end-run");
      expect(endRunEdge).toBeDefined();
      expect(endRunEdge?.condition).toBeUndefined();
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

    it("should pass leadFound flag to end-run via inputMapping", () => {
      const dag = buildColdEmailDag();
      const endRun = dag.nodes.find((n) => n.id === "end-run");
      expect(endRun?.inputMapping?.["body.leadFound"]).toBe("$ref:fetch-lead.output.found");
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

    it("should configure brand-profile node with dynamic keyType from start-run", () => {
      const dag = buildColdEmailDag();
      const brandProfile = dag.nodes.find((n) => n.id === "brand-profile");
      expect(brandProfile?.config.body).toBeUndefined();
      expect(brandProfile?.inputMapping).toEqual({
        "body.appId": "$ref:start-run.output.appId",
        "body.clerkOrgId": "$ref:start-run.output.clerkOrgId",
        "body.url": "$ref:start-run.output.brandUrl",
        "body.clerkUserId": "$ref:start-run.output.clerkUserId",
        "body.parentRunId": "$ref:start-run.output.runId",
        "body.keyType": "$ref:start-run.output.keySource",
        "body.workflowName": "$ref:start-run.output.workflowName",
        "body.urgency": "$ref:start-run.output.urgency",
        "body.scarcity": "$ref:start-run.output.scarcity",
        "body.riskReversal": "$ref:start-run.output.riskReversal",
        "body.socialProof": "$ref:start-run.output.socialProof",
      });
    });

    it("should configure fetch-lead node with dynamic keySource from start-run", () => {
      const dag = buildColdEmailDag();
      const fetchLead = dag.nodes.find((n) => n.id === "fetch-lead");
      expect(fetchLead?.config.body).toBeUndefined();
      expect(fetchLead?.inputMapping?.["body.keySource"]).toBe("$ref:start-run.output.keySource");
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
      expect(mapping["body.workflowName"]).toBe("$ref:start-run.output.workflowName");
    });

    it("should map lead data from fetch-lead and brand data from brand-profile to email-generate", () => {
      const dag = buildColdEmailDag();
      const emailGen = dag.nodes.find((n) => n.id === "email-generate");
      const mapping = emailGen?.inputMapping || {};

      // Top-level body fields (GenerateRequest schema fields)
      expect(mapping["body.appId"]).toBe("$ref:start-run.output.appId");
      expect(mapping["body.runId"]).toBe("$ref:start-run.output.runId");
      expect(mapping["body.brandId"]).toBe("$ref:start-run.output.brandId");
      expect(mapping["body.campaignId"]).toBe("$ref:start-run.output.campaignId");
      expect(mapping["body.keyMode"]).toBe("$ref:start-run.output.keySource");
      expect(mapping["body.workflowName"]).toBe("$ref:start-run.output.workflowName");
      expect(mapping["body.apolloEnrichmentId"]).toBe("$ref:fetch-lead.output.lead.externalId");

      // Template variables MUST be nested under body.variables (content-generation expects z.record)
      // Lead fields from fetch-lead (flat camelCase per Apollo spec)
      expect(mapping["body.variables.leadFirstName"]).toBe("$ref:fetch-lead.output.lead.data.firstName");
      expect(mapping["body.variables.leadLastName"]).toBe("$ref:fetch-lead.output.lead.data.lastName");
      expect(mapping["body.variables.leadEmail"]).toBe("$ref:fetch-lead.output.lead.data.email");
      expect(mapping["body.variables.leadCompanyName"]).toBe("$ref:fetch-lead.output.lead.data.organizationName");

      // Brand fields from brand-profile (core) — nested under variables
      expect(mapping["body.variables.clientCompanyName"]).toBe("$ref:start-run.output.brandDomain");
      expect(mapping["body.variables.clientBrandUrl"]).toBe("$ref:start-run.output.brandUrl");
      expect(mapping["body.variables.clientCompanyOverview"]).toBe("$ref:brand-profile.output.profile.companyOverview");
      expect(mapping["body.variables.clientValueProposition"]).toBe("$ref:brand-profile.output.profile.valueProposition");

      // Brand fields from brand-profile (credibility)
      expect(mapping["body.variables.clientLeadership"]).toBe("$ref:brand-profile.output.profile.leadership");
      expect(mapping["body.variables.clientFunding"]).toBe("$ref:brand-profile.output.profile.funding");
      expect(mapping["body.variables.clientAwardsAndRecognition"]).toBe("$ref:brand-profile.output.profile.awardsAndRecognition");
      expect(mapping["body.variables.clientRevenueMilestones"]).toBe("$ref:brand-profile.output.profile.revenueMilestones");

      // Brand fields from brand-profile (sales persuasion intelligence)
      expect(mapping["body.variables.clientUrgency"]).toBe("$ref:brand-profile.output.profile.urgency");
      expect(mapping["body.variables.clientScarcity"]).toBe("$ref:brand-profile.output.profile.scarcity");
      expect(mapping["body.variables.clientRiskReversal"]).toBe("$ref:brand-profile.output.profile.riskReversal");
      expect(mapping["body.variables.clientPriceAnchoring"]).toBe("$ref:brand-profile.output.profile.priceAnchoring");
      expect(mapping["body.variables.clientValueStacking"]).toBe("$ref:brand-profile.output.profile.valueStacking");

      // Campaign fields from start-run — nested under variables
      expect(mapping["body.variables.targetOutcome"]).toBe("$ref:start-run.output.targetOutcome");
      expect(mapping["body.variables.valueForTarget"]).toBe("$ref:start-run.output.valueForTarget");
    });

    it("should nest ALL COLD_EMAIL_VARIABLES under body.variables in email-generate (not top-level body)", () => {
      const dag = buildColdEmailDag();
      const emailGen = dag.nodes.find((n) => n.id === "email-generate");
      const mapping = emailGen?.inputMapping || {};

      // Every template variable must be under body.variables.*, not body.*
      for (const variable of COLD_EMAIL_VARIABLES) {
        const variablesKey = `body.variables.${variable}`;
        const topLevelKey = `body.${variable}`;
        expect(mapping[variablesKey], `Expected body.variables.${variable} to be defined`).toBeDefined();
        expect(mapping[topLevelKey], `body.${variable} should NOT exist (must be under body.variables)`).toBeUndefined();
      }
    });

    it("should map lead data from fetch-lead to email-send", () => {
      const dag = buildColdEmailDag();
      const emailSend = dag.nodes.find((n) => n.id === "email-send");
      const mapping = emailSend?.inputMapping || {};

      expect(mapping["body.to"]).toBe("$ref:fetch-lead.output.lead.data.email");
      expect(mapping["body.recipientFirstName"]).toBe("$ref:fetch-lead.output.lead.data.firstName");
      expect(mapping["body.recipientLastName"]).toBe("$ref:fetch-lead.output.lead.data.lastName");
      expect(mapping["body.recipientCompany"]).toBe("$ref:fetch-lead.output.lead.data.organizationName");
      expect(mapping["body.subject"]).toBe("$ref:email-generate.output.subject");
      expect(mapping["body.sequence"]).toBe("$ref:email-generate.output.sequence");
      expect(mapping["body.workflowName"]).toBe("$ref:start-run.output.workflowName");
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

      // end-run also includes leadFound from fetch-lead
      expect(endRun?.inputMapping).toEqual({
        "body.campaignId": "$ref:flow_input.campaignId",
        "body.clerkOrgId": "$ref:flow_input.clerkOrgId",
        "body.leadFound": "$ref:fetch-lead.output.found",
      });
      // end-run-error only has flow_input (real errors, no leadFound context)
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
      expect(url).toBe("https://workflow.test.local/workflows/deploy");
      expect(opts.method).toBe("PUT");
      expect(opts.headers["x-api-key"]).toBe("test-workflow-key");

      const body = JSON.parse(opts.body);
      expect(body.appId).toBe("mcpfactory");
      expect(body.workflows).toHaveLength(1);
      expect(body.workflows[0].name).toBe("cold-email-outreach");
      expect(body.workflows[0].dag.nodes).toHaveLength(9);
      expect(body.workflows[0].dag.onError).toBe("end-run-error");
    });

    it("should not throw when workflow-service env vars are missing", async () => {
      const originalUrl = process.env.WORKFLOW_SERVICE_URL;
      delete process.env.WORKFLOW_SERVICE_URL;

      const { deployWorkflows } = await import("../../src/lib/workflows.js");
      await expect(deployWorkflows()).resolves.not.toThrow();
      expect(mockFetch).not.toHaveBeenCalled();

      process.env.WORKFLOW_SERVICE_URL = originalUrl;
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

  describe("getConfirmedWorkflowName", () => {
    it("should throw when workflow name has not been confirmed by deploy", () => {
      expect(() => getConfirmedWorkflowName("unknown-workflow")).toThrow(
        'Workflow name "unknown-workflow" not confirmed by workflow-service'
      );
    });

    it("should return confirmed name after successful deploy", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ workflows: [{ name: "cold-email-outreach", action: "created" }] }),
      });

      const { deployWorkflows } = await import("../../src/lib/workflows.js");
      await deployWorkflows();

      expect(getConfirmedWorkflowName("cold-email-outreach")).toBe("cold-email-outreach");
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
        appId: "mcpfactory",
      });

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe("https://workflow.test.local/workflows/by-name/cold-email-outreach/execute");
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
        appId: "mcpfactory",
      });

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe("https://workflow.test.local/workflows/by-name/journalist-pitch/execute");
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
          appId: "mcpfactory",
        })
      ).resolves.not.toThrow();
    });
  });
});
