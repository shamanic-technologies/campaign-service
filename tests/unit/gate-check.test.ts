import { describe, it, expect, beforeEach, vi } from "vitest";

const {
  mockListRuns,
  mockUpdateRun,
  mockGetRunsBatch,
  mockDbUpdate,
} = vi.hoisted(() => {
  const mockSet = vi.fn().mockReturnValue({
    where: vi.fn().mockResolvedValue(undefined),
  });
  return {
    mockListRuns: vi.fn(),
    mockUpdateRun: vi.fn(),
    mockGetRunsBatch: vi.fn(),
    mockDbUpdate: vi.fn().mockReturnValue({ set: mockSet }),
  };
});

vi.mock("@mcpfactory/runs-client", () => ({
  listRuns: mockListRuns,
  updateRun: mockUpdateRun,
  getRunsBatch: mockGetRunsBatch,
  getRun: vi.fn(),
}));

vi.mock("../../src/db/index.js", () => ({
  db: {
    update: mockDbUpdate,
  },
}));

vi.mock("../../src/db/schema.js", () => ({
  campaigns: { id: "id" },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(),
}));

// Mock fetch for lead stats
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { runGateChecks, type GateCheckInput } from "../../src/lib/gate-check.js";

function makeCampaign(overrides: Partial<GateCheckInput> = {}): GateCheckInput {
  return {
    campaignId: "campaign-1",
    clerkOrgId: "org-1",
    brandId: "brand-1",
    status: "ongoing",
    maxBudgetDailyUsd: "10.00",
    maxBudgetWeeklyUsd: null,
    maxBudgetMonthlyUsd: null,
    maxBudgetTotalUsd: null,
    maxLeads: null,
    ...overrides,
  };
}

function makeRun(overrides: Partial<{ id: string; status: string; startedAt: string }> = {}) {
  return {
    id: overrides.id || crypto.randomUUID(),
    status: overrides.status || "completed",
    startedAt: overrides.startedAt || new Date().toISOString(),
    parentRunId: null,
    organizationId: "org-1",
    userId: null,
    appId: "mcpfactory",
    brandId: null,
    campaignId: "campaign-1",
    serviceName: "campaign-service",
    taskName: "campaign-1",
    completedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe("Gate Check", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListRuns.mockResolvedValue({ runs: [] });
    mockGetRunsBatch.mockResolvedValue(new Map());
    mockUpdateRun.mockResolvedValue({});
  });

  it("should block if campaign is not ongoing", async () => {
    const result = await runGateChecks(makeCampaign({ status: "stopped" }));
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("Campaign is not ongoing");
  });

  it("should allow when campaign is ongoing and gates pass", async () => {
    const result = await runGateChecks(makeCampaign());
    expect(result.allowed).toBe(true);
  });

  describe("Stale run cleanup", () => {
    it("should mark runs running > 30 min as failed", async () => {
      const staleRun = makeRun({
        id: "stale-run-1",
        status: "running",
        startedAt: new Date(Date.now() - 31 * 60 * 1000).toISOString(),
      });
      mockListRuns.mockResolvedValue({ runs: [staleRun] });

      await runGateChecks(makeCampaign());

      expect(mockUpdateRun).toHaveBeenCalledWith("stale-run-1", "failed");
    });

    it("should NOT mark recent running runs as stale", async () => {
      const recentRun = makeRun({
        id: "recent-run",
        status: "running",
        startedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      });
      mockListRuns.mockResolvedValue({ runs: [recentRun] });

      const result = await runGateChecks(makeCampaign());

      expect(mockUpdateRun).not.toHaveBeenCalled();
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("A run is already in progress");
    });
  });

  describe("Running run check", () => {
    it("should block if a run is already in progress", async () => {
      const runningRun = makeRun({
        status: "running",
        startedAt: new Date(Date.now() - 1000).toISOString(),
      });
      mockListRuns.mockResolvedValue({ runs: [runningRun] });

      const result = await runGateChecks(makeCampaign());
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("A run is already in progress");
    });
  });

  describe("Budget check", () => {
    it("should block if no budget is defined (fail-closed)", async () => {
      const result = await runGateChecks(makeCampaign({
        maxBudgetDailyUsd: null,
        maxBudgetWeeklyUsd: null,
        maxBudgetMonthlyUsd: null,
        maxBudgetTotalUsd: null,
      }));
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("No budget defined (fail-closed)");
    });

    it("should block when daily budget is exceeded", async () => {
      const run = makeRun({ id: "run-1", status: "completed" });
      mockListRuns.mockResolvedValue({ runs: [run] });
      mockGetRunsBatch.mockResolvedValue(
        new Map([["run-1", { totalCostInUsdCents: "1500" }]])
      );

      const result = await runGateChecks(makeCampaign({
        maxBudgetDailyUsd: "10.00", // 1000 cents
      }));
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("daily budget exceeded");
    });

    it("should allow when budget is not exceeded", async () => {
      const run = makeRun({ id: "run-1", status: "completed" });
      mockListRuns.mockResolvedValue({ runs: [run] });
      mockGetRunsBatch.mockResolvedValue(
        new Map([["run-1", { totalCostInUsdCents: "500" }]])
      );

      const result = await runGateChecks(makeCampaign({
        maxBudgetDailyUsd: "10.00",
      }));
      expect(result.allowed).toBe(true);
    });

    it("should auto-stop campaign when total budget is exceeded", async () => {
      const run = makeRun({ id: "run-1", status: "completed" });
      mockListRuns.mockResolvedValue({ runs: [run] });
      mockGetRunsBatch.mockResolvedValue(
        new Map([["run-1", { totalCostInUsdCents: "5500" }]])
      );

      const result = await runGateChecks(makeCampaign({
        maxBudgetDailyUsd: "100.00",
        maxBudgetTotalUsd: "50.00",
      }));
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("Total budget exceeded");
      expect(result.autoStopped).toBe(true);
      expect(mockDbUpdate).toHaveBeenCalled();
    });
  });

  describe("Volume check", () => {
    it("should auto-stop when maxLeads is reached", async () => {
      const runs = [
        makeRun({ id: "r1", status: "completed" }),
        makeRun({ id: "r2", status: "completed" }),
        makeRun({ id: "r3", status: "completed" }),
      ];
      mockListRuns.mockResolvedValue({ runs });
      mockGetRunsBatch.mockResolvedValue(new Map());

      // Mock lead stats
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ totalServed: 3 }),
      });

      const result = await runGateChecks(makeCampaign({ maxLeads: 3 }));
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("Max leads reached");
      expect(result.autoStopped).toBe(true);
    });

    it("should allow when maxLeads is not reached", async () => {
      const runs = [makeRun({ id: "r1", status: "completed" })];
      mockListRuns.mockResolvedValue({ runs });
      mockGetRunsBatch.mockResolvedValue(new Map());

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ totalServed: 1 }),
      });

      const result = await runGateChecks(makeCampaign({ maxLeads: 10 }));
      expect(result.allowed).toBe(true);
    });

    it("should fallback to completed run count on 404 from lead-service", async () => {
      const runs = [
        makeRun({ id: "r1", status: "completed" }),
        makeRun({ id: "r2", status: "completed" }),
      ];
      mockListRuns.mockResolvedValue({ runs });
      mockGetRunsBatch.mockResolvedValue(new Map());

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      });

      const result = await runGateChecks(makeCampaign({ maxLeads: 5 }));
      expect(result.allowed).toBe(true); // 2 completed < 5 maxLeads
    });

    it("should block on non-404 lead-service error (fail-closed)", async () => {
      mockListRuns.mockResolvedValue({ runs: [] });
      mockGetRunsBatch.mockResolvedValue(new Map());

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
      });

      const result = await runGateChecks(makeCampaign({ maxLeads: 10 }));
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("Lead stats unavailable (fail-closed)");
    });
  });

  describe("Consecutive failures check", () => {
    it("should auto-stop after 3 consecutive failures", async () => {
      const runs = [
        makeRun({ id: "r1", status: "failed", startedAt: new Date(Date.now() - 1000).toISOString() }),
        makeRun({ id: "r2", status: "failed", startedAt: new Date(Date.now() - 2000).toISOString() }),
        makeRun({ id: "r3", status: "failed", startedAt: new Date(Date.now() - 3000).toISOString() }),
      ];
      mockListRuns.mockResolvedValue({ runs });
      mockGetRunsBatch.mockResolvedValue(new Map());

      const result = await runGateChecks(makeCampaign());
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("3 consecutive failures");
      expect(result.autoStopped).toBe(true);
    });

    it("should allow when failures are not consecutive", async () => {
      const runs = [
        makeRun({ id: "r1", status: "failed", startedAt: new Date(Date.now() - 1000).toISOString() }),
        makeRun({ id: "r2", status: "completed", startedAt: new Date(Date.now() - 2000).toISOString() }),
        makeRun({ id: "r3", status: "failed", startedAt: new Date(Date.now() - 3000).toISOString() }),
      ];
      mockListRuns.mockResolvedValue({ runs });
      mockGetRunsBatch.mockResolvedValue(new Map());

      const result = await runGateChecks(makeCampaign());
      expect(result.allowed).toBe(true);
    });

    it("should allow when fewer than 3 consecutive failures", async () => {
      const runs = [
        makeRun({ id: "r1", status: "failed", startedAt: new Date(Date.now() - 1000).toISOString() }),
        makeRun({ id: "r2", status: "failed", startedAt: new Date(Date.now() - 2000).toISOString() }),
      ];
      mockListRuns.mockResolvedValue({ runs });
      mockGetRunsBatch.mockResolvedValue(new Map());

      const result = await runGateChecks(makeCampaign());
      expect(result.allowed).toBe(true);
    });
  });
});
