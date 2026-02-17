import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { buildColdEmailDag } from "../../src/lib/workflows.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("Workflow module", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("buildColdEmailDag", () => {
    it("should produce a valid DAG with nodes and edges", () => {
      const dag = buildColdEmailDag();

      expect(dag.nodes).toBeDefined();
      expect(dag.edges).toBeDefined();
      expect(dag.nodes.length).toBeGreaterThan(0);
      expect(dag.edges.length).toBeGreaterThan(0);
    });

    it("should have the correct top-level node sequence", () => {
      const dag = buildColdEmailDag();
      const nodeIds = dag.nodes.map((n) => n.id);

      expect(nodeIds).toContain("register-prompt");
      expect(nodeIds).toContain("extract-brand");
      expect(nodeIds).toContain("suggest-icp");
      expect(nodeIds).toContain("search-leads");
      expect(nodeIds).toContain("process-leads");
    });

    it("should have correct edge ordering", () => {
      const dag = buildColdEmailDag();

      expect(dag.edges).toEqual([
        { from: "register-prompt", to: "extract-brand" },
        { from: "extract-brand", to: "suggest-icp" },
        { from: "suggest-icp", to: "search-leads" },
        { from: "search-leads", to: "process-leads" },
      ]);
    });

    it("should have process-leads as for-each with sub-nodes", () => {
      const dag = buildColdEmailDag();
      const forEachNode = dag.nodes.find((n) => n.id === "process-leads");

      expect(forEachNode).toBeDefined();
      expect(forEachNode!.type).toBe("for-each");
      expect(forEachNode!.config.iterator).toBe("$ref:search-leads.output.people");

      const subDag = forEachNode!.config.dag as { nodes: { id: string }[]; edges: { from: string; to: string }[] };
      expect(subDag.nodes.map((n) => n.id)).toEqual(["enrich-lead", "generate-email", "send-email"]);
      expect(subDag.edges).toEqual([
        { from: "enrich-lead", to: "generate-email" },
        { from: "generate-email", to: "send-email" },
      ]);
    });

    it("should use http.call type for all service nodes", () => {
      const dag = buildColdEmailDag();

      for (const node of dag.nodes) {
        if (node.type !== "for-each") {
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
        if (node.config.service) {
          serviceMap[node.id] = node.config.service as string;
        }
      }

      expect(serviceMap["register-prompt"]).toBe("emailgeneration");
      expect(serviceMap["extract-brand"]).toBe("brand");
      expect(serviceMap["suggest-icp"]).toBe("brand");
      expect(serviceMap["search-leads"]).toBe("apollo");
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
      expect(body.workflows[0].dag.nodes).toBeDefined();
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

  describe("executeColdEmailOutreach", () => {
    it("should call POST /workflows/by-name/cold-email-outreach/execute", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "run-123", status: "queued" }),
      });

      const { executeColdEmailOutreach } = await import("../../src/lib/workflows.js");
      await executeColdEmailOutreach({
        brandId: "brand-1",
        brandUrl: "https://example.com",
        campaignId: "campaign-1",
        clerkOrgId: "org_test",
        clerkUserId: "user_test",
        targetAudience: "CEOs at SaaS startups",
        targetOutcome: "Book demos",
        valueForTarget: "Enterprise analytics",
      });

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe("https://windmill.test.local/workflows/by-name/cold-email-outreach/execute");
      expect(opts.method).toBe("POST");

      const body = JSON.parse(opts.body);
      expect(body.appId).toBe("mcpfactory");
      expect(body.orgId).toBe("org_test");
      expect(body.inputs.brandId).toBe("brand-1");
      expect(body.inputs.campaignId).toBe("campaign-1");
      expect(body.inputs.clerkOrgId).toBe("org_test");
      expect(body.inputs.targetAudience).toBe("CEOs at SaaS startups");
    });

    it("should handle null optional fields gracefully", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "run-456", status: "queued" }),
      });

      const { executeColdEmailOutreach } = await import("../../src/lib/workflows.js");
      await executeColdEmailOutreach({
        brandId: "brand-1",
        brandUrl: "https://example.com",
        campaignId: "campaign-1",
        clerkOrgId: "org_test",
        targetAudience: null,
        targetOutcome: null,
        valueForTarget: null,
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.inputs.targetAudience).toBe("");
      expect(body.inputs.targetOutcome).toBe("");
      expect(body.inputs.valueForTarget).toBe("");
    });

    it("should not throw when execution fails", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: async () => "Workflow not found",
      });

      const { executeColdEmailOutreach } = await import("../../src/lib/workflows.js");
      await expect(
        executeColdEmailOutreach({
          brandId: "brand-1",
          brandUrl: "https://example.com",
          campaignId: "campaign-1",
          clerkOrgId: "org_test",
        })
      ).resolves.not.toThrow();
    });
  });
});
