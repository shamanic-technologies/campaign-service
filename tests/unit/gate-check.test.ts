import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const {
  mockListRuns,
  mockUpdateRun,
  mockGetStatsBudget,
  mockDbUpdate,
} = vi.hoisted(() => {
  const mockSet = vi.fn().mockReturnValue({
    where: vi.fn().mockResolvedValue(undefined),
  });
  return {
    mockListRuns: vi.fn(),
    mockUpdateRun: vi.fn(),
    mockGetStatsBudget: vi.fn(),
    mockDbUpdate: vi.fn().mockReturnValue({ set: mockSet }),
  };
});

vi.mock("@distribute/runs-client", () => ({
  listRuns: mockListRuns,
  updateRun: mockUpdateRun,
  getStatsBudget: mockGetStatsBudget,
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

import { runGateChecks, nextDayStart, nextWeekStart, nextMonthStart, type GateCheckInput } from "../../src/lib/gate-check.js";

function makeCampaign(overrides: Partial<GateCheckInput> = {}): GateCheckInput {
  return {
    campaignId: "campaign-1",
    orgId: "org-1",
    brandId: "brand-1",
    // Empty by default so the per-brand daily-budget loop is a no-op in tests that exercise
    // the OTHER gates. The brand-budget describe block sets brandIds explicitly.
    brandIds: [],
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
    brandId: null,
    campaignId: "campaign-1",
    serviceName: "campaign-service",
    taskName: "campaign-1",
    completedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function makeBudgetResponse(windows: Array<{ label: string; totalCostInUsdCents: string }>) {
  return {
    windows: windows.map(w => ({
      label: w.label,
      totalCostInUsdCents: w.totalCostInUsdCents,
      actualCostInUsdCents: w.totalCostInUsdCents,
      provisionedCostInUsdCents: "0",
    })),
  };
}

describe("Gate Check", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListRuns.mockResolvedValue({ runs: [] });
    mockGetStatsBudget.mockResolvedValue({ windows: [] });
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
    it("should mark runs running > 3 hours as failed", async () => {
      const staleRun = makeRun({
        id: "stale-run-1",
        status: "running",
        startedAt: new Date(Date.now() - (3 * 60 + 1) * 60 * 1000).toISOString(),
      });
      mockListRuns.mockResolvedValue({ runs: [staleRun] });

      await runGateChecks(makeCampaign());

      expect(mockUpdateRun).toHaveBeenCalledWith("stale-run-1", "failed", expect.objectContaining({ orgId: "org-1" }));
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
    it("should auto-stop if no budget is defined (fail-closed, terminal)", async () => {
      const result = await runGateChecks(makeCampaign({
        maxBudgetDailyUsd: null,
        maxBudgetWeeklyUsd: null,
        maxBudgetMonthlyUsd: null,
        maxBudgetTotalUsd: null,
      }));
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("No budget defined (fail-closed)");
      // A zero-budget campaign can never run → terminal auto-stop, not retryable,
      // so it is never re-claimed by the scheduler (no Windmill re-fire loop).
      expect(result.autoStopped).toBe(true);
      expect(mockDbUpdate).toHaveBeenCalled();
    });

    it("should block when daily budget is exceeded", async () => {
      mockGetStatsBudget.mockResolvedValue(
        makeBudgetResponse([{ label: "daily", totalCostInUsdCents: "1500" }])
      );

      const result = await runGateChecks(makeCampaign({
        maxBudgetDailyUsd: "10.00", // 1000 cents
      }));
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("daily budget exceeded");
    });

    it("should allow when budget is not exceeded", async () => {
      mockGetStatsBudget.mockResolvedValue(
        makeBudgetResponse([{ label: "daily", totalCostInUsdCents: "500" }])
      );

      const result = await runGateChecks(makeCampaign({
        maxBudgetDailyUsd: "10.00",
      }));
      expect(result.allowed).toBe(true);
    });

    it("should auto-stop campaign when total budget is exceeded", async () => {
      mockGetStatsBudget.mockResolvedValue(
        makeBudgetResponse([
          { label: "daily", totalCostInUsdCents: "500" },
          { label: "total", totalCostInUsdCents: "5500" },
        ])
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

    it("should call getStatsBudget with correct windows (no appId)", async () => {
      await runGateChecks(makeCampaign({
        maxBudgetDailyUsd: "10.00",
        maxBudgetWeeklyUsd: "50.00",
        maxBudgetTotalUsd: "100.00",
      }));

      expect(mockGetStatsBudget).toHaveBeenCalledWith(
        expect.objectContaining({
          orgId: "org-1",
          campaignId: "campaign-1",
          windows: expect.arrayContaining([
            expect.objectContaining({ label: "daily" }),
            expect.objectContaining({ label: "weekly" }),
            expect.objectContaining({ label: "total" }),
          ]),
        })
      );

      // Should NOT include appId
      const callArgs = mockGetStatsBudget.mock.calls[0][0];
      expect(callArgs).not.toHaveProperty("appId");
    });

    it("should only include windows for configured budgets", async () => {
      await runGateChecks(makeCampaign({
        maxBudgetDailyUsd: "10.00",
        maxBudgetWeeklyUsd: null,
        maxBudgetMonthlyUsd: null,
        maxBudgetTotalUsd: null,
      }));

      const call = mockGetStatsBudget.mock.calls[0][0];
      expect(call.windows).toHaveLength(1);
      expect(call.windows[0].label).toBe("daily");
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

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      });

      const result = await runGateChecks(makeCampaign({ maxLeads: 5 }));
      expect(result.allowed).toBe(true); // 2 completed < 5 maxLeads
    });

    it("should block on non-404 lead-service error (fail-closed)", async () => {
      mockListRuns.mockResolvedValue({ runs: [] });

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
      });

      const result = await runGateChecks(makeCampaign({ maxLeads: 10 }));
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("Lead stats unavailable (fail-closed)");
    });
  });

  describe("Credit affordability check", () => {
    const ORIG_URL = process.env.BILLING_SERVICE_URL;
    const ORIG_KEY = process.env.BILLING_SERVICE_API_KEY;

    beforeEach(() => {
      process.env.BILLING_SERVICE_URL = "https://billing.test.local";
      process.env.BILLING_SERVICE_API_KEY = "test-billing-key";
    });

    afterEach(() => {
      if (ORIG_URL === undefined) delete process.env.BILLING_SERVICE_URL;
      else process.env.BILLING_SERVICE_URL = ORIG_URL;
      if (ORIG_KEY === undefined) delete process.env.BILLING_SERVICE_API_KEY;
      else process.env.BILLING_SERVICE_API_KEY = ORIG_KEY;
    });

    it("should block with 30min backoff (NOT auto-stopped) when org cannot afford the run", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ affordable: false, balanceCents: "0", lastRequiredCents: "150", hasHistory: true }),
      });

      const before = Date.now();
      const result = await runGateChecks(makeCampaign());
      const after = Date.now();

      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("Insufficient credits");
      // Backed off ~30min, campaign stays ongoing → recharge auto-resumes (no manual restart).
      expect(result.nextRunAt).toBeInstanceOf(Date);
      expect(result.nextRunAt!.getTime()).toBeGreaterThanOrEqual(before + 30 * 60 * 1000);
      expect(result.nextRunAt!.getTime()).toBeLessThanOrEqual(after + 30 * 60 * 1000 + 1000);
      // Must NOT auto-stop — that would need a manual restart instead of self-healing.
      expect(result.autoStopped).toBeUndefined();
      expect(mockDbUpdate).not.toHaveBeenCalled();
    });

    it("should proceed when org can afford the run (affordable=true)", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ affordable: true, balanceCents: "5000", lastRequiredCents: "150", hasHistory: true }),
      });

      const result = await runGateChecks(makeCampaign());
      expect(result.allowed).toBe(true);
    });

    it("should fail-open SILENTLY (allow, no warn) when the billing call throws", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      mockFetch.mockRejectedValueOnce(new Error("ECONNRESET"));

      const result = await runGateChecks(makeCampaign());
      expect(result.allowed).toBe(true);
      // No log on the fail-open path — it fires per-tick per-campaign across the fleet.
      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it("should fail-open (allow) on a non-2xx billing response", async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

      const result = await runGateChecks(makeCampaign());
      expect(result.allowed).toBe(true);
    });

    it("should call the locked affordability contract with x-api-key + identity headers", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ affordable: true, balanceCents: "5000", lastRequiredCents: null, hasHistory: false }),
      });

      await runGateChecks(makeCampaign({ userId: "user-1", runId: "run-1" }));

      const [calledUrl, opts] = mockFetch.mock.calls[0];
      expect(calledUrl).toBe("https://billing.test.local/internal/campaigns/campaign-1/affordability");
      expect(opts.headers["x-api-key"]).toBe("test-billing-key");
      expect(opts.headers["x-org-id"]).toBe("org-1");
      expect(opts.headers["x-campaign-id"]).toBe("campaign-1");
    });
  });

  describe("Per-brand daily budget pacing", () => {
    const ORIG_URL = process.env.BILLING_SERVICE_URL;
    const ORIG_KEY = process.env.BILLING_SERVICE_API_KEY;

    beforeEach(() => {
      process.env.BILLING_SERVICE_URL = "https://billing.test.local";
      process.env.BILLING_SERVICE_API_KEY = "test-billing-key";
      // Default: campaign budget window passes (daily=0) and brand spend is 0 (today=0).
      // Per-test overrides drive the "today" window to exercise the cap.
      mockGetStatsBudget.mockResolvedValue(
        makeBudgetResponse([
          { label: "daily", totalCostInUsdCents: "0" },
          { label: "today", totalCostInUsdCents: "0" },
        ])
      );
    });

    afterEach(() => {
      if (ORIG_URL === undefined) delete process.env.BILLING_SERVICE_URL;
      else process.env.BILLING_SERVICE_URL = ORIG_URL;
      if (ORIG_KEY === undefined) delete process.env.BILLING_SERVICE_API_KEY;
      else process.env.BILLING_SERVICE_API_KEY = ORIG_KEY;
    });

    // Queue one billing daily-budget response (FIFO with other fetches in the same tick).
    function mockDailyBudget(dailyBudgetCents: string | null, brandId = "brand-1") {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ brandId, dailyBudgetCents, updatedAt: null }),
      });
    }

    it("blocks (paced, not stopped) when today's brand spend reaches the ceiling", async () => {
      mockDailyBudget("1000"); // ceiling 1000 cents
      mockGetStatsBudget.mockResolvedValue(
        makeBudgetResponse([
          { label: "daily", totalCostInUsdCents: "0" },
          { label: "today", totalCostInUsdCents: "1000" }, // spend == ceiling
        ])
      );

      const result = await runGateChecks(makeCampaign({ brandIds: ["brand-1"] }));
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("Brand daily budget reached");
      // D1: not parked till midnight, not terminal — internal.ts applies the 15min backoff,
      // so a raised ceiling re-enables on the next loop.
      expect(result.nextRunAt).toBeUndefined();
      expect(result.autoStopped).toBeUndefined();
    });

    it("allows when today's brand spend is below the ceiling", async () => {
      mockDailyBudget("1000");
      mockGetStatsBudget.mockResolvedValue(
        makeBudgetResponse([
          { label: "daily", totalCostInUsdCents: "0" },
          { label: "today", totalCostInUsdCents: "999" },
        ])
      );

      const result = await runGateChecks(makeCampaign({ brandIds: ["brand-1"] }));
      expect(result.allowed).toBe(true);
    });

    it("treats an unset budget (null) as unbounded — no cap", async () => {
      mockDailyBudget(null);
      mockGetStatsBudget.mockResolvedValue(
        makeBudgetResponse([
          { label: "daily", totalCostInUsdCents: "0" },
          { label: "today", totalCostInUsdCents: "999999" }, // huge spend, null ceiling → never blocks
        ])
      );

      const result = await runGateChecks(makeCampaign({ brandIds: ["brand-1"] }));
      expect(result.allowed).toBe(true);
    });

    it("re-enables on the next loop once the ceiling is raised", async () => {
      mockGetStatsBudget.mockResolvedValue(
        makeBudgetResponse([
          { label: "daily", totalCostInUsdCents: "0" },
          { label: "today", totalCostInUsdCents: "1000" }, // spend fixed at 1000
        ])
      );

      // loop 1: ceiling 1000, spend 1000 → blocked
      mockDailyBudget("1000");
      const blocked = await runGateChecks(makeCampaign({ brandIds: ["brand-1"] }));
      expect(blocked.allowed).toBe(false);

      // loop 2: ceiling raised to 5000, same spend → allowed
      mockDailyBudget("5000");
      const allowed = await runGateChecks(makeCampaign({ brandIds: ["brand-1"] }));
      expect(allowed.allowed).toBe(true);
    });

    it("fail-OPEN (allow) and SILENT when the billing read throws", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      mockFetch.mockRejectedValueOnce(new Error("ECONNRESET"));
      mockGetStatsBudget.mockResolvedValue(
        makeBudgetResponse([
          { label: "daily", totalCostInUsdCents: "0" },
          { label: "today", totalCostInUsdCents: "999999" },
        ])
      );

      const result = await runGateChecks(makeCampaign({ brandIds: ["brand-1"] }));
      expect(result.allowed).toBe(true); // unreadable ceiling → no cap, other gates pass
      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it("blocks the tick if ANY brand in a multi-brand campaign hits its ceiling", async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: true, json: async () => ({ brandId: "brand-1", dailyBudgetCents: "1000", updatedAt: null }) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ brandId: "brand-2", dailyBudgetCents: "1000", updatedAt: null }) });
      // getStatsBudget call order: campaign window, brand-1 spend, brand-2 spend
      mockGetStatsBudget
        .mockResolvedValueOnce(makeBudgetResponse([{ label: "daily", totalCostInUsdCents: "0" }]))
        .mockResolvedValueOnce(makeBudgetResponse([{ label: "today", totalCostInUsdCents: "0" }]))
        .mockResolvedValueOnce(makeBudgetResponse([{ label: "today", totalCostInUsdCents: "2000" }]));

      const result = await runGateChecks(makeCampaign({ brandIds: ["brand-1", "brand-2"] }));
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("Brand daily budget reached");
    });

    it("calls the locked daily-budget contract with x-api-key + x-brand-id", async () => {
      mockDailyBudget("999999");
      const result = await runGateChecks(makeCampaign({ brandIds: ["brand-1"], runId: "run-1" }));
      expect(result.allowed).toBe(true);

      const [calledUrl, opts] = mockFetch.mock.calls[0];
      expect(calledUrl).toBe("https://billing.test.local/internal/brands/brand-1/daily-budget");
      expect(opts.headers["x-api-key"]).toBe("test-billing-key");
      expect(opts.headers["x-org-id"]).toBe("org-1");
      expect(opts.headers["x-brand-id"]).toBe("brand-1");
    });
  });

  describe("nextRunAt on temporal budget exceeded", () => {
    it("should return nextRunAt when daily budget is exceeded", async () => {
      mockGetStatsBudget.mockResolvedValue(
        makeBudgetResponse([{ label: "daily", totalCostInUsdCents: "1500" }])
      );

      const result = await runGateChecks(makeCampaign({ maxBudgetDailyUsd: "10.00" }));
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("daily budget exceeded");
      expect(result.nextRunAt).toBeInstanceOf(Date);
      // Should be tomorrow at midnight
      const expected = nextDayStart();
      expect(result.nextRunAt!.getTime()).toBe(expected.getTime());
    });

    it("should return nextRunAt when weekly budget is exceeded", async () => {
      mockGetStatsBudget.mockResolvedValue(
        makeBudgetResponse([{ label: "weekly", totalCostInUsdCents: "6000" }])
      );

      const result = await runGateChecks(makeCampaign({
        maxBudgetDailyUsd: null,
        maxBudgetWeeklyUsd: "50.00",
      }));
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("weekly budget exceeded");
      expect(result.nextRunAt).toBeInstanceOf(Date);
      const expected = nextWeekStart();
      expect(result.nextRunAt!.getTime()).toBe(expected.getTime());
    });

    it("should return nextRunAt when monthly budget is exceeded", async () => {
      mockGetStatsBudget.mockResolvedValue(
        makeBudgetResponse([{ label: "monthly", totalCostInUsdCents: "11000" }])
      );

      const result = await runGateChecks(makeCampaign({
        maxBudgetDailyUsd: null,
        maxBudgetMonthlyUsd: "100.00",
      }));
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("monthly budget exceeded");
      expect(result.nextRunAt).toBeInstanceOf(Date);
      const expected = nextMonthStart();
      expect(result.nextRunAt!.getTime()).toBe(expected.getTime());
    });

    it("should NOT return nextRunAt when total budget is exceeded (auto-stop instead)", async () => {
      mockGetStatsBudget.mockResolvedValue(
        makeBudgetResponse([{ label: "total", totalCostInUsdCents: "5500" }])
      );

      const result = await runGateChecks(makeCampaign({
        maxBudgetDailyUsd: null,
        maxBudgetTotalUsd: "50.00",
      }));
      expect(result.allowed).toBe(false);
      expect(result.autoStopped).toBe(true);
      expect(result.nextRunAt).toBeUndefined();
    });

    it("should return earliest nextRunAt when daily exceeds before weekly", async () => {
      mockGetStatsBudget.mockResolvedValue(
        makeBudgetResponse([
          { label: "daily", totalCostInUsdCents: "1500" },
          { label: "weekly", totalCostInUsdCents: "1500" },
        ])
      );

      const result = await runGateChecks(makeCampaign({
        maxBudgetDailyUsd: "10.00",
        maxBudgetWeeklyUsd: "50.00",
      }));
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("daily budget exceeded");
      // Daily is checked first, so nextRunAt should be next day
      const expected = nextDayStart();
      expect(result.nextRunAt!.getTime()).toBe(expected.getTime());
    });
  });

  describe("nextDayStart / nextWeekStart / nextMonthStart helpers", () => {
    it("nextDayStart returns tomorrow at midnight", () => {
      const result = nextDayStart();
      expect(result.getHours()).toBe(0);
      expect(result.getMinutes()).toBe(0);
      expect(result.getSeconds()).toBe(0);
      expect(result.getTime()).toBeGreaterThan(Date.now());
    });

    it("nextWeekStart returns next Monday at midnight", () => {
      const result = nextWeekStart();
      expect(result.getDay()).toBe(1); // Monday
      expect(result.getHours()).toBe(0);
      expect(result.getTime()).toBeGreaterThan(Date.now());
    });

    it("nextMonthStart returns 1st of next month at midnight", () => {
      const result = nextMonthStart();
      expect(result.getDate()).toBe(1);
      expect(result.getHours()).toBe(0);
      expect(result.getTime()).toBeGreaterThan(Date.now());
    });
  });
});
