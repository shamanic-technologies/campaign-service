import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const {
  mockListRuns,
  mockUpdateRun,
  mockGetStatsBudget,
  mockDbUpdate,
  mockAnyBrandPaused,
} = vi.hoisted(() => {
  const mockSet = vi.fn().mockReturnValue({
    where: vi.fn().mockResolvedValue(undefined),
  });
  return {
    mockListRuns: vi.fn(),
    mockUpdateRun: vi.fn(),
    mockGetStatsBudget: vi.fn(),
    mockDbUpdate: vi.fn().mockReturnValue({ set: mockSet }),
    mockAnyBrandPaused: vi.fn(),
  };
});

vi.mock("../../src/lib/brand-pause.js", () => ({
  anyBrandPaused: mockAnyBrandPaused,
}));

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

import { runGateChecks, nextWeekStart, nextMonthStart, nextDayStart, type GateCheckInput } from "../../src/lib/gate-check.js";

// A feature paced by the CAMPAIGN budget windows (not the brand daily budget). Any slug that
// isn't sales-cold-email-outreach qualifies.
const NON_SALES_FEATURE = "pr-expert-quote-opportunities";

function makeCampaign(overrides: Partial<GateCheckInput> = {}): GateCheckInput {
  return {
    campaignId: "campaign-1",
    orgId: "org-1",
    brandId: "brand-1",
    featureSlug: "sales-cold-email-outreach",
    // Empty by default so the per-brand daily-budget loop is a no-op in tests that exercise
    // the OTHER gates. The brand-budget describe block sets brandIds explicitly.
    brandIds: [],
    status: "ongoing",
    maxBudgetDailyUsd: "10.00",
    maxBudgetWeeklyUsd: null,
    maxBudgetMonthlyUsd: null,
    maxBudgetTotalUsd: null,
    // Null by default → the sales gate falls back to the brand daily budget, so the existing
    // brand-budget describe block exercises unchanged. The campaign-own-budget block sets it.
    dailyBudgetCents: null,
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

function makeBudgetResponse(
  windows: Array<{
    label: string;
    totalCostInUsdCents: string;
    actualCostInUsdCents?: string;
    // NET committed (post-usage-discount) twin. When set, the gate paces on THIS instead of
    // gross — a discounted org must run until its NET spend hits the budget. Omit to model an
    // older runs-service (no net twin) → the gate falls back to gross.
    netTotalCostInUsdCents?: string;
  }>,
) {
  return {
    windows: windows.map(w => {
      // Default: actual == total (provisioned 0). Pass actualCostInUsdCents explicitly to
      // model an in-flight worst-case provisioned hold (total > actual). ALL budget caps now
      // pace on COMMITTED total — the per-brand daily cap AND every campaign window (daily,
      // weekly, monthly, total) — so a high total with low actual DOES block (and the total
      // window DOES auto-stop) on committed spend.
      const actual = w.actualCostInUsdCents ?? w.totalCostInUsdCents;
      const provisioned = (parseFloat(w.totalCostInUsdCents) - parseFloat(actual)).toString();
      return {
        label: w.label,
        totalCostInUsdCents: w.totalCostInUsdCents,
        actualCostInUsdCents: actual,
        provisionedCostInUsdCents: provisioned,
        ...(w.netTotalCostInUsdCents !== undefined
          ? { netTotalCostInUsdCents: w.netTotalCostInUsdCents }
          : {}),
      };
    }),
  };
}

describe("Gate Check", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListRuns.mockResolvedValue({ runs: [] });
    mockGetStatsBudget.mockResolvedValue({ windows: [] });
    mockUpdateRun.mockResolvedValue({});
    mockAnyBrandPaused.mockResolvedValue(false);
  });

  describe("Brand pause", () => {
    it("should HOLD (block, non-terminal) when a target brand is paused", async () => {
      mockAnyBrandPaused.mockResolvedValue(true);
      const result = await runGateChecks(makeCampaign({ brandIds: ["brand-1"] }));
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("Brand paused");
      // HOLD, not terminal: never auto-stops the campaign.
      expect(result.autoStopped).toBeUndefined();
      // Short-circuits before the runs fetch — a paused brand never hits runs-service.
      expect(mockListRuns).not.toHaveBeenCalled();
    });

    it("should HOLD a multi-brand campaign if ANY one brand is paused", async () => {
      mockAnyBrandPaused.mockResolvedValue(true);
      const result = await runGateChecks(makeCampaign({ brandIds: ["b1", "b2", "b3"] }));
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("Brand paused");
    });

    it("should NOT block when no target brand is paused", async () => {
      mockAnyBrandPaused.mockResolvedValue(false);
      const result = await runGateChecks(makeCampaign({ brandIds: ["b1", "b2"], featureSlug: NON_SALES_FEATURE }));
      expect(result.allowed).toBe(true);
    });

    it("should NOT hold a NON-sales campaign even when its brand is paused (pause is sales-only)", async () => {
      mockAnyBrandPaused.mockResolvedValue(true); // brand IS paused…
      const result = await runGateChecks(makeCampaign({ brandIds: ["brand-1"], featureSlug: NON_SALES_FEATURE }));
      // …but the pause holds only sales-cold-email-outreach, so a pr-expert run passes the gate.
      expect(result.reason).not.toBe("Brand paused");
      // The pause branch must short-circuit for non-sales — never even query the pause table.
      expect(mockAnyBrandPaused).not.toHaveBeenCalled();
    });
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
    it("should allow campaigns with no campaign-level budget", async () => {
      const result = await runGateChecks(makeCampaign({
        maxBudgetDailyUsd: null,
        maxBudgetWeeklyUsd: null,
        maxBudgetMonthlyUsd: null,
        maxBudgetTotalUsd: null,
      }));
      expect(result.allowed).toBe(true);
      expect(mockDbUpdate).not.toHaveBeenCalled();
      expect(mockGetStatsBudget).not.toHaveBeenCalled();
    });

    it("sales feature ignores the campaign budget windows entirely (brand budget governs)", async () => {
      // Sales is paced by the brand daily budget, NOT the campaign caps. Even with every
      // campaign window configured and way over, the campaign-window path never runs (and with
      // brandIds empty the brand loop is a no-op) → allowed, no runs-service window call.
      mockGetStatsBudget.mockResolvedValue(
        makeBudgetResponse([{ label: "total", totalCostInUsdCents: "999999" }])
      );

      const result = await runGateChecks(makeCampaign({
        featureSlug: "sales-cold-email-outreach",
        maxBudgetDailyUsd: "10.00",
        maxBudgetTotalUsd: "50.00",
      }));
      expect(result.allowed).toBe(true);
      expect(mockGetStatsBudget).not.toHaveBeenCalled();
    });

    it("non-sales: blocks on the campaign DAILY window when today's spend hits the cap", async () => {
      mockGetStatsBudget.mockResolvedValue(
        makeBudgetResponse([{ label: "daily", totalCostInUsdCents: "1000" }]) // == 10.00 cap
      );

      const result = await runGateChecks(makeCampaign({
        featureSlug: NON_SALES_FEATURE,
        maxBudgetDailyUsd: "10.00", // 1000 cents
      }));
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("daily budget exceeded");
      // Paced, not terminal: parks until the next day rollover (resets today's spend).
      expect(result.autoStopped).toBeUndefined();
      expect(result.nextRunAt!.getTime()).toBe(nextDayStart().getTime());
    });

    it("non-sales: allows when today's spend is below the campaign daily cap", async () => {
      mockGetStatsBudget.mockResolvedValue(
        makeBudgetResponse([{ label: "daily", totalCostInUsdCents: "999" }])
      );

      const result = await runGateChecks(makeCampaign({
        featureSlug: NON_SALES_FEATURE,
        maxBudgetDailyUsd: "10.00",
      }));
      expect(result.allowed).toBe(true);
    });

    it("non-sales: paces the campaign DAILY window on NET, not gross (discounted org not stopped early)", async () => {
      // 50%-discounted org: gross committed == the cap, but NET (what the org pays) is half.
      // Must be ALLOWED — pacing on gross would halt the campaign at half its real budget.
      mockGetStatsBudget.mockResolvedValue(
        makeBudgetResponse([
          { label: "daily", totalCostInUsdCents: "1000", netTotalCostInUsdCents: "500" },
        ])
      );

      const result = await runGateChecks(makeCampaign({
        featureSlug: NON_SALES_FEATURE,
        maxBudgetDailyUsd: "10.00", // 1000 cents — gross hits it, net (500) does not
      }));
      expect(result.allowed).toBe(true);
    });

    it("non-sales: blocks the campaign DAILY window when NET committed hits the cap", async () => {
      mockGetStatsBudget.mockResolvedValue(
        makeBudgetResponse([
          { label: "daily", totalCostInUsdCents: "2000", netTotalCostInUsdCents: "1000" },
        ])
      );

      const result = await runGateChecks(makeCampaign({
        featureSlug: NON_SALES_FEATURE,
        maxBudgetDailyUsd: "10.00", // net 1000 == cap → blocks
      }));
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("daily budget exceeded");
    });

    it("non-sales: is NEVER gated by the brand daily budget", async () => {
      // Brand ceiling set far below the brand's spend — must NOT block a non-sales campaign.
      process.env.BILLING_SERVICE_URL = "https://billing.test.local";
      process.env.BILLING_SERVICE_API_KEY = "test-billing-key";
      try {
        // No campaign windows configured → campaign-window path is a no-op too.
        const result = await runGateChecks(makeCampaign({
          featureSlug: NON_SALES_FEATURE,
          brandIds: ["brand-1"],
          maxBudgetDailyUsd: null,
          maxBudgetWeeklyUsd: null,
          maxBudgetMonthlyUsd: null,
          maxBudgetTotalUsd: null,
        }));
        expect(result.allowed).toBe(true);
        // Brand daily-budget read must NOT have fired for a non-sales feature.
        expect(mockFetch).not.toHaveBeenCalledWith(
          expect.stringContaining("/daily-budget"),
          expect.anything(),
        );
      } finally {
        delete process.env.BILLING_SERVICE_URL;
        delete process.env.BILLING_SERVICE_API_KEY;
      }
    });

    it("non-sales: auto-stops the campaign when the total budget is exceeded", async () => {
      mockGetStatsBudget.mockResolvedValue(
        makeBudgetResponse([
          { label: "daily", totalCostInUsdCents: "500" },
          { label: "total", totalCostInUsdCents: "5500" },
        ])
      );

      const result = await runGateChecks(makeCampaign({
        featureSlug: NON_SALES_FEATURE,
        maxBudgetDailyUsd: "100.00",
        maxBudgetTotalUsd: "50.00",
      }));
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("Total budget exceeded");
      expect(result.autoStopped).toBe(true);
      expect(result.nextRunAt).toBeUndefined();
      expect(mockDbUpdate).toHaveBeenCalled();
    });

    it("non-sales: calls getStatsBudget with all configured windows (daily incl., no appId)", async () => {
      await runGateChecks(makeCampaign({
        featureSlug: NON_SALES_FEATURE,
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

    it("non-sales: only includes windows for configured budgets", async () => {
      await runGateChecks(makeCampaign({
        featureSlug: NON_SALES_FEATURE,
        maxBudgetDailyUsd: "10.00",
        maxBudgetWeeklyUsd: "50.00",
        maxBudgetMonthlyUsd: null,
        maxBudgetTotalUsd: null,
      }));

      const call = mockGetStatsBudget.mock.calls[0][0];
      expect(call.windows).toHaveLength(2);
      expect(call.windows.map((w: { label: string }) => w.label).sort()).toEqual(["daily", "weekly"]);
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
      // Default: brand spend is 0 (today=0).
      // Per-test overrides drive the "today" window to exercise the cap.
      mockGetStatsBudget.mockResolvedValue(
        makeBudgetResponse([
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

    it("blocks (paced, not stopped) when today's feature spend for the brand reaches the ceiling", async () => {
      mockDailyBudget("1000"); // ceiling 1000 cents
      mockGetStatsBudget.mockResolvedValue(
        makeBudgetResponse([
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
          { label: "today", totalCostInUsdCents: "999" },
        ])
      );

      const result = await runGateChecks(makeCampaign({ brandIds: ["brand-1"] }));
      expect(result.allowed).toBe(true);
    });

    it("paces the brand daily budget on NET, not gross — a 50%-discounted brand runs to its FULL net budget", async () => {
      // The core bug: a $10 (1000c) brand daily budget with a 50% usage discount. Gross committed
      // hits 1000 (the cap) while the brand has only PAID 500 net. Pacing on gross halted the
      // campaign at half its real budget; pacing on net must ALLOW it to keep running.
      mockDailyBudget("1000"); // ceiling 1000 cents = what the org PAYS
      mockGetStatsBudget.mockResolvedValue(
        makeBudgetResponse([
          { label: "today", totalCostInUsdCents: "1000", netTotalCostInUsdCents: "500" },
        ])
      );

      const result = await runGateChecks(makeCampaign({ brandIds: ["brand-1"] }));
      expect(result.allowed).toBe(true);
    });

    it("blocks the brand daily budget when NET committed reaches the ceiling", async () => {
      mockDailyBudget("1000");
      mockGetStatsBudget.mockResolvedValue(
        makeBudgetResponse([
          // gross 2000 but the ceiling is judged on net 1000 == cap → blocks at the real budget.
          { label: "today", totalCostInUsdCents: "2000", netTotalCostInUsdCents: "1000" },
        ])
      );

      const result = await runGateChecks(makeCampaign({ brandIds: ["brand-1"] }));
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("Brand daily budget reached");
    });

    it("falls back to gross pacing when runs-service omits the net twin (older build)", async () => {
      // No netTotalCostInUsdCents on the window → gate uses gross, preserving pre-net behavior
      // (safe direction: over-counts → stops earlier, never overspends).
      mockDailyBudget("1000");
      mockGetStatsBudget.mockResolvedValue(
        makeBudgetResponse([
          { label: "today", totalCostInUsdCents: "1000" }, // gross only, == ceiling
        ])
      );

      const result = await runGateChecks(makeCampaign({ brandIds: ["brand-1"] }));
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("Brand daily budget reached");
    });

    it("blocks when COMMITTED (actual + provisioned) is over the ceiling even though actual alone is under", async () => {
      // Committed-pacing decision (supersedes #223 for this brand daily cap): the cap now
      // counts reserved follow-up-send holds toward the daily budget, matching the dashboard's
      // committed "Budget spent today". Actual alone (999 < 1000) is under the ceiling, but
      // committed total 5999 (provisioned 5000) is over — so the gate MUST block. This is the
      // deliberate reversal of the old #223 regression test (which asserted this case allows).
      mockDailyBudget("1000"); // ceiling 1000 cents
      mockGetStatsBudget.mockResolvedValue(
        makeBudgetResponse([
          // actual 999 (< 1000) but committed total 5999 (provisioned 5000) — must BLOCK.
          { label: "today", totalCostInUsdCents: "5999", actualCostInUsdCents: "999" },
        ])
      );

      const result = await runGateChecks(makeCampaign({ brandIds: ["brand-1"] }));
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("Brand daily budget reached");
    });

    it("treats an unset budget (null) as unbounded — no cap", async () => {
      mockDailyBudget(null);
      mockGetStatsBudget.mockResolvedValue(
        makeBudgetResponse([
          { label: "today", totalCostInUsdCents: "999999" }, // huge spend, null ceiling → never blocks
        ])
      );

      const result = await runGateChecks(makeCampaign({ brandIds: ["brand-1"] }));
      expect(result.allowed).toBe(true);
    });

    it("re-enables on the next loop once the ceiling is raised", async () => {
      mockGetStatsBudget.mockResolvedValue(
        makeBudgetResponse([
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

    it("blocks when the billing read throws (fail-closed spend control)", async () => {
      mockFetch.mockRejectedValueOnce(new Error("ECONNRESET"));
      mockGetStatsBudget.mockResolvedValue(
        makeBudgetResponse([
          { label: "today", totalCostInUsdCents: "999999" },
        ])
      );

      const result = await runGateChecks(makeCampaign({ brandIds: ["brand-1"] }));
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("Brand daily budget unavailable");
    });

    it("blocks when the billing read returns non-2xx (fail-closed spend control)", async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

      const result = await runGateChecks(makeCampaign({ brandIds: ["brand-1"] }));
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("Brand daily budget unavailable");
    });

    it("blocks when the billing read returns malformed dailyBudgetCents", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ brandId: "brand-1", dailyBudgetCents: "not-a-number", updatedAt: null }),
      });

      const result = await runGateChecks(makeCampaign({ brandIds: ["brand-1"] }));
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("Brand daily budget unavailable");
    });

    it("blocks the tick if ANY brand in a multi-brand campaign hits its ceiling", async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: true, json: async () => ({ brandId: "brand-1", dailyBudgetCents: "1000", updatedAt: null }) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ brandId: "brand-2", dailyBudgetCents: "1000", updatedAt: null }) });
      // getStatsBudget call order: brand-1 spend, brand-2 spend
      mockGetStatsBudget
        .mockResolvedValueOnce(makeBudgetResponse([{ label: "today", totalCostInUsdCents: "0" }]))
        .mockResolvedValueOnce(makeBudgetResponse([{ label: "today", totalCostInUsdCents: "2000" }]));

      const result = await runGateChecks(makeCampaign({ brandIds: ["brand-1", "brand-2"] }));
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("Brand daily budget reached");
    });

    it("compares the daily cap against same-feature brand-day spend only", async () => {
      mockDailyBudget("1000");
      mockGetStatsBudget.mockResolvedValue(
        makeBudgetResponse([{ label: "today", totalCostInUsdCents: "750" }])
      );

      const result = await runGateChecks(makeCampaign({
        campaignId: "campaign-active",
        brandIds: ["brand-1"],
        maxBudgetDailyUsd: "999999.00",
        featureSlug: "sales-cold-email-outreach",
      }));

      expect(result.allowed).toBe(true);
      expect(mockGetStatsBudget).toHaveBeenCalledWith({
        orgId: "org-1",
        brandId: "brand-1",
        featureSlug: "sales-cold-email-outreach",
        windows: [expect.objectContaining({ label: "today" })],
      });
      const brandSpendCall = mockGetStatsBudget.mock.calls[0][0];
      expect(brandSpendCall).not.toHaveProperty("campaignId");
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
      expect(mockGetStatsBudget.mock.calls[0][0]).not.toHaveProperty("campaignId");
    });
  });

  describe("Per-campaign daily budget pacing (sales feature, own budget)", () => {
    // No billing env — the campaign-own path never calls billing; it paces on the campaign's
    // OWN committed spend today (getStatsBudget, campaignId + featureSlug keyed) vs its own cap.
    it("blocks when the campaign's OWN committed spend reaches its OWN daily budget", async () => {
      mockGetStatsBudget.mockResolvedValue(
        makeBudgetResponse([{ label: "today", totalCostInUsdCents: "1000" }]) // spend == cap
      );

      const result = await runGateChecks(makeCampaign({
        brandIds: ["brand-1"],
        dailyBudgetCents: 1000,
      }));
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("Campaign daily budget reached");
      // Paced, not terminal — internal.ts applies the 15min backoff.
      expect(result.nextRunAt).toBeUndefined();
      expect(result.autoStopped).toBeUndefined();
    });

    it("allows when the campaign's OWN spend is below its OWN budget", async () => {
      mockGetStatsBudget.mockResolvedValue(
        makeBudgetResponse([{ label: "today", totalCostInUsdCents: "999" }])
      );

      const result = await runGateChecks(makeCampaign({
        brandIds: ["brand-1"],
        dailyBudgetCents: 1000,
      }));
      expect(result.allowed).toBe(true);
    });

    it("keys the spend query on campaignId (its OWN spend), NEVER the brand — and never reads billing", async () => {
      mockGetStatsBudget.mockResolvedValue(
        makeBudgetResponse([{ label: "today", totalCostInUsdCents: "0" }])
      );

      const result = await runGateChecks(makeCampaign({
        campaignId: "campaign-A",
        brandIds: ["brand-1"],
        dailyBudgetCents: 5000,
      }));
      expect(result.allowed).toBe(true);
      expect(mockGetStatsBudget).toHaveBeenCalledWith({
        orgId: "org-1",
        campaignId: "campaign-A",
        featureSlug: "sales-cold-email-outreach",
        windows: [expect.objectContaining({ label: "today" })],
      });
      const spendCall = mockGetStatsBudget.mock.calls[0][0];
      expect(spendCall).not.toHaveProperty("brandId");
      // Own-budget path must NOT hit the brand daily-budget billing endpoint.
      expect(mockFetch).not.toHaveBeenCalledWith(
        expect.stringContaining("/daily-budget"),
        expect.anything(),
      );
    });

    it("paces on NET committed, not gross — a 50%-discounted campaign runs to its FULL net budget", async () => {
      mockGetStatsBudget.mockResolvedValue(
        makeBudgetResponse([
          { label: "today", totalCostInUsdCents: "1000", netTotalCostInUsdCents: "500" },
        ])
      );

      const result = await runGateChecks(makeCampaign({
        brandIds: ["brand-1"],
        dailyBudgetCents: 1000,
      }));
      expect(result.allowed).toBe(true);
    });

    it("blocks on COMMITTED (actual + provisioned) over the cap even when actual alone is under", async () => {
      mockGetStatsBudget.mockResolvedValue(
        makeBudgetResponse([
          { label: "today", totalCostInUsdCents: "5999", actualCostInUsdCents: "999" },
        ])
      );

      const result = await runGateChecks(makeCampaign({
        brandIds: ["brand-1"],
        dailyBudgetCents: 1000,
      }));
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("Campaign daily budget reached");
    });

    it("one campaign hitting its cap does NOT depend on another — pacing is campaign-scoped", async () => {
      // Campaign A over its cap → blocked; campaign B (own budget, under) → allowed. Distinct
      // campaignIds mean distinct spend queries, so A's cap never gates B.
      mockGetStatsBudget
        .mockResolvedValueOnce(makeBudgetResponse([{ label: "today", totalCostInUsdCents: "1000" }]))
        .mockResolvedValueOnce(makeBudgetResponse([{ label: "today", totalCostInUsdCents: "10" }]));

      const a = await runGateChecks(makeCampaign({ campaignId: "campaign-A", brandIds: ["brand-1"], dailyBudgetCents: 1000 }));
      expect(a.allowed).toBe(false);
      expect(a.reason).toBe("Campaign daily budget reached");

      const b = await runGateChecks(makeCampaign({ campaignId: "campaign-B", brandIds: ["brand-1"], dailyBudgetCents: 1000 }));
      expect(b.allowed).toBe(true);
    });
  });

  describe("nextRunAt on temporal budget exceeded (non-sales feature)", () => {
    it("paces the weekly (non-terminal) budget on COMMITTED, not actual", async () => {
      // Committed-pacing: actual 4000 (< $50 = 5000) but committed total 6000 (provisioned
      // 2000) is over the cap — the non-terminal weekly window MUST block (matches the
      // dashboard's committed spend). Reverses the prior actual-pacing regression assertion.
      mockGetStatsBudget.mockResolvedValue(
        makeBudgetResponse([{ label: "weekly", totalCostInUsdCents: "6000", actualCostInUsdCents: "4000" }])
      );

      const result = await runGateChecks(makeCampaign({
        featureSlug: NON_SALES_FEATURE,
        maxBudgetDailyUsd: null,
        maxBudgetWeeklyUsd: "50.00",
      }));
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("weekly budget exceeded");
    });

    it("paces the TOTAL (terminal autoStop) window on COMMITTED — auto-stops when committed is over", async () => {
      // Committed-pacing now applies to the total window too (product-owner decision for full
      // dashboard coherence): actual 4000 (< $50 = 5000) but committed total 9000 (provisioned
      // 5000) is over the cap → terminal autoStop fires on committed. (Accepted tradeoff: a
      // temporary committed spike near the lifetime cap can stop a campaign before holds settle;
      // recoverable by re-activating.)
      mockGetStatsBudget.mockResolvedValue(
        makeBudgetResponse([{ label: "total", totalCostInUsdCents: "9000", actualCostInUsdCents: "4000" }])
      );

      const result = await runGateChecks(makeCampaign({
        featureSlug: NON_SALES_FEATURE,
        maxBudgetDailyUsd: null,
        maxBudgetTotalUsd: "50.00",
      }));
      expect(result.allowed).toBe(false);
      expect(result.autoStopped).toBe(true);
      expect(result.nextRunAt).toBeUndefined();
    });

    it("should return nextRunAt when weekly budget is exceeded", async () => {
      mockGetStatsBudget.mockResolvedValue(
        makeBudgetResponse([{ label: "weekly", totalCostInUsdCents: "6000" }])
      );

      const result = await runGateChecks(makeCampaign({
        featureSlug: NON_SALES_FEATURE,
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
        featureSlug: NON_SALES_FEATURE,
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
        featureSlug: NON_SALES_FEATURE,
        maxBudgetDailyUsd: null,
        maxBudgetTotalUsd: "50.00",
      }));
      expect(result.allowed).toBe(false);
      expect(result.autoStopped).toBe(true);
      expect(result.nextRunAt).toBeUndefined();
    });

    it("daily window takes precedence: blocks on daily (with day-rollover nextRunAt) before weekly", async () => {
      // daily over (1500 >= 1000) AND weekly over (6000 >= 5000): daily is enforced first.
      mockGetStatsBudget.mockResolvedValue(
        makeBudgetResponse([
          { label: "daily", totalCostInUsdCents: "1500" },
          { label: "weekly", totalCostInUsdCents: "6000" },
        ])
      );

      const result = await runGateChecks(makeCampaign({
        featureSlug: NON_SALES_FEATURE,
        maxBudgetDailyUsd: "10.00",
        maxBudgetWeeklyUsd: "50.00",
      }));
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("daily budget exceeded");
      expect(result.nextRunAt!.getTime()).toBe(nextDayStart().getTime());
    });
  });

  describe("nextWeekStart / nextMonthStart helpers", () => {
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
