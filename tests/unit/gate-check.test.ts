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
  getStatsBudget: (p: { featureSlug?: string }) => (p?.featureSlug?.startsWith("sourcing-") ? Promise.resolve({ windows: [] }) : mockGetStatsBudget(p)),
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

// A unit's money is its sales funnel's caps (lib/sales-funnel-campaigns.ts). Every test below runs
// a funded unit (run: true) unless it says otherwise; the caps describe restores the real read.
const { mockUnitMoney } = vi.hoisted(() => ({ mockUnitMoney: vi.fn() }));
vi.mock("../../src/lib/sales-funnel-campaigns.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/sales-funnel-campaigns.js")>();
  return { ...actual, salesFunnelUnitMoney: mockUnitMoney };
});

// Mock fetch for lead stats
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { runGateChecks, nextWeekStart, nextMonthStart, nextDayStart, NOT_A_SALES_FUNNEL_CAMPAIGN, type GateCheckInput } from "../../src/lib/gate-check.js";

// A feature paced by the CAMPAIGN budget windows (not the brand daily budget). Any slug that
// isn't sales-cold-email-outreach qualifies.
const NON_SALES_FEATURE = "pr-expert-quote-opportunities";

function makeCampaign(overrides: Partial<GateCheckInput> = {}): GateCheckInput {
  return {
    campaignId: "campaign-1",
    orgId: "org-1",
    brandId: "brand-1",
    featureSlug: "sales-cold-email-outreach",
    brandIds: [],
    status: "ongoing",
    maxBudgetDailyUsd: "10.00",
    maxBudgetWeeklyUsd: null,
    maxBudgetMonthlyUsd: null,
    maxBudgetTotalUsd: null,
    // A SALES FUNNEL unit by default: the only campaign the gate lets spend (owner 2026-10-14).
    offerId: "offer-1",
    legKey: "lead_found_to_conversation",
    salesFunnelCampaignId: "funnel-campaign-1",
    salesFunnelId: "f@x",
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

/**
 * The gate reads runs-service TWICE and each read states what it wants: the campaign's RUNNING
 * rows (stale cleanup + the one-run-at-a-time guard) and — only under a maxLeads cap — its
 * COMPLETED rows, bounded by that cap. Answer each call by the status it asked for, so a test
 * that stages completed runs cannot accidentally also stage them as live.
 */
function mockRuns(
  { running = [], completed = [] }: { running?: unknown[]; completed?: unknown[] } = {},
) {
  mockListRuns.mockImplementation(async (params: { status?: string; limit?: number }) => {
    if (params.status === "running") return { runs: running };
    if (params.status === "completed") {
      // runs-service honours the bound; a caller asking for N never receives more than N.
      return { runs: params.limit != null ? completed.slice(0, params.limit) : completed };
    }
    return { runs: [] };
  });
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
      // window too) on committed spend.
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
    mockRuns();
    mockGetStatsBudget.mockResolvedValue({ windows: [] });
    mockUpdateRun.mockResolvedValue({});
    mockUnitMoney.mockResolvedValue({ run: true, pace: { spentCents: 0, ceilingCents: 1000 } });
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

  describe("ONE money model: a campaign that is not a sales funnel unit is refused by name", () => {
    beforeEach(() => {
      process.env.BILLING_SERVICE_URL = "https://billing.test.local";
      process.env.BILLING_SERVICE_API_KEY = "k";
    });
    afterEach(() => {
      delete process.env.BILLING_SERVICE_URL;
      delete process.env.BILLING_SERVICE_API_KEY;
    });

    it("refuses NOT_A_SALES_FUNNEL_CAMPAIGN and reads no billing, no caps, no spend", async () => {
      const result = await runGateChecks(makeCampaign({
        salesFunnelCampaignId: null,
        salesFunnelId: null,
        brandIds: ["brand-1"],
        maxBudgetDailyUsd: "10.00",
      }));
      expect(result).toEqual({ allowed: false, reason: NOT_A_SALES_FUNNEL_CAMPAIGN });
      expect(NOT_A_SALES_FUNNEL_CAMPAIGN).toBe("Not a sales funnel campaign");
      expect(mockFetch).not.toHaveBeenCalled();
      expect(mockGetStatsBudget).not.toHaveBeenCalled();
      expect(mockUnitMoney).not.toHaveBeenCalled();
    });

    it("refuses a non-unit on a non-sales channel too (no channel escapes the funnel)", async () => {
      const result = await runGateChecks(makeCampaign({ salesFunnelCampaignId: undefined, featureSlug: NON_SALES_FEATURE }));
      expect(result).toEqual({ allowed: false, reason: NOT_A_SALES_FUNNEL_CAMPAIGN });
      expect(mockGetStatsBudget).not.toHaveBeenCalled();
    });

    it("still answers the running-run guard first", async () => {
      mockRuns({ running: [makeRun({ status: "running" })] });
      const result = await runGateChecks(makeCampaign({ salesFunnelCampaignId: null }));
      expect(result.reason).toBe("A run is already in progress");
    });

    it("allows a unit whose caps say run:true, asking the caps with the unit's identity", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ affordable: true }) });
      const result = await runGateChecks(makeCampaign({ brandIds: ["brand-1"] }));
      expect(result).toMatchObject({ allowed: true, creditCheck: "affordable" });
      expect(mockUnitMoney).toHaveBeenCalledWith(expect.objectContaining({
        id: "campaign-1",
        orgId: "org-1",
        brandId: "brand-1",
        offerId: "offer-1",
        legKey: "lead_found_to_conversation",
        salesFunnelCampaignId: "funnel-campaign-1",
        salesFunnelId: "f@x",
      }));
      // The only billing read is the credit pre-filter; no retired ceiling is asked.
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(String(mockFetch.mock.calls[0][0])).toContain("/affordability");
      expect(mockGetStatsBudget).not.toHaveBeenCalled();
    });

    it("refuses a unit with its caps' own verdict", async () => {
      const nextRunAt = new Date(Date.now() + 600_000);
      mockUnitMoney.mockResolvedValue({ run: false, kind: "cap_reached", reason: "Sales funnel max budget reached", detail: "d", nextRunAt });
      expect(await runGateChecks(makeCampaign())).toEqual({ allowed: false, reason: "Sales funnel max budget reached", reasonDetail: "d", nextRunAt });
    });
  });

  describe("a SALES FUNNEL unit is paid by its funnel's caps (billing), nothing else", () => {
    const unitInput = (featureSlug = "sales-cold-email-outreach") => makeCampaign({ featureSlug });
    const capsAnswer = (body: Record<string, unknown>) =>
      mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ pipes: null, maxVolume: null, ...body }) });
    const budget = (consumedCents: string | null, reached: boolean | null) => ({
      amountCents: "1000", period: "weekly", consumedCents, reached,
      consumedUnavailableReason: consumedCents === null ? "runs_unavailable" : null, consumedUnavailableDetail: null,
    });

    beforeEach(async () => {
      process.env.BILLING_SERVICE_URL = "https://billing.test.local";
      process.env.BILLING_SERVICE_API_KEY = "k";
      const actual = await vi.importActual<typeof import("../../src/lib/sales-funnel-campaigns.js")>("../../src/lib/sales-funnel-campaigns.js");
      actual.resetSalesFunnelCapsCache();
      mockUnitMoney.mockImplementation(actual.salesFunnelUnitMoney);
    });
    afterEach(() => {
      delete process.env.BILLING_SERVICE_URL;
      delete process.env.BILLING_SERVICE_API_KEY;
    });

    it("refuses when no max budget is stated, before any pre-funnel money path is read", async () => {
      capsAnswer({ stated: false, funded: false, fundedBy: null, maxBudget: null });
      const result = await runGateChecks(unitInput());
      expect(result).toMatchObject({ allowed: false, reason: "Sales funnel not funded" });
      expect(result.reasonDetail).toContain("funnel-campaign-1");
      expect(mockFetch.mock.calls[0][0]).toContain("/internal/brands/");
      expect(mockFetch.mock.calls[0][0]).toContain("/sales-funnels/f%40x/campaigns/funnel-campaign-1/caps");
    });

    it("refuses a proactive pipe once the max budget is reached (new first touches stop)", async () => {
      capsAnswer({ stated: true, funded: true, fundedBy: "max_budget", maxBudget: budget("1000", true) });
      expect(await runGateChecks(unitInput())).toMatchObject({ allowed: false, reason: "Sales funnel max budget reached" });
    });

    it("refuses a proactive pipe when the consumption cannot be measured (fail-closed, never 'not reached')", async () => {
      capsAnswer({ stated: true, funded: true, fundedBy: "max_budget", maxBudget: budget(null, null) });
      expect(await runGateChecks(unitInput())).toMatchObject({ allowed: false, reason: "Sales funnel budget unavailable" });
    });

    it("refuses a REACTIVE pipe too once the cap is reached (owner: always respect the user budget)", async () => {
      capsAnswer({
        stated: true, funded: true, fundedBy: "max_budget",
        maxBudget: budget("1000", true),
        pipes: [{ pipeId: "ai-meeting-booking|x", channelSlug: "ai-meeting-booking", legKey: "conversation_to_meeting_booked", mode: "reactive", campaignIds: [] }],
      });
      const input = { ...unitInput("ai-meeting-booking"), legKey: "conversation_to_meeting_booked" };
      expect(await runGateChecks(input)).toMatchObject({ allowed: false, reason: "Sales funnel max budget reached" });
    });

    it("runs a proactive pipe under its caps, reading none of the pre-funnel money", async () => {
      capsAnswer({ stated: true, funded: true, fundedBy: "both", maxBudget: budget("400", false), maxVolume: { count: 100, period: "monthly", unit: "first_contacts", consumed: 10, reached: false, consumedUnavailableReason: null } });
      expect((await runGateChecks(unitInput())).allowed).toBe(true);
      expect(mockGetStatsBudget).not.toHaveBeenCalled();
    });

    it("refuses when billing cannot be read", async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) });
      expect(await runGateChecks(unitInput())).toMatchObject({ allowed: false, reason: "Sales funnel caps unavailable" });
    });
  });

  describe("Stale run cleanup", () => {
    it("should mark runs running > 3 hours as failed", async () => {
      const staleRun = makeRun({
        id: "stale-run-1",
        status: "running",
        startedAt: new Date(Date.now() - (3 * 60 + 1) * 60 * 1000).toISOString(),
      });
      mockRuns({ running: [staleRun] });

      await runGateChecks(makeCampaign());

      expect(mockUpdateRun).toHaveBeenCalledWith("stale-run-1", "failed", expect.objectContaining({ orgId: "org-1" }));
    });

    it("should NOT mark recent running runs as stale", async () => {
      const recentRun = makeRun({
        id: "recent-run",
        status: "running",
        startedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      });
      mockRuns({ running: [recentRun] });

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
      mockRuns({ running: [runningRun] });

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

    it("sales feature ignores the campaign budget windows entirely (its funnel's caps govern)", async () => {
      // A sales-family unit is paced by its funnel's caps, NOT the campaign windows. Even with
      // every window configured and way over, the window path never runs → allowed, no window call.
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

    it("non-sales: BLOCKS but never stops the campaign when the total budget is exceeded", async () => {
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
      expect(result.reason).toBe("total budget exceeded");
      // A configured ceiling reached is a SYSTEM CONDITION and never changes a status: the
      // campaign stays exactly as the customer left it and the caller backs the run off.
      expect(result.nextRunAt).toBeUndefined();
      expect(mockDbUpdate).not.toHaveBeenCalled();
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

  describe("Bounded runs reads", () => {
    it("never asks runs-service for the campaign's whole history", async () => {
      await runGateChecks(makeCampaign({ maxLeads: 3 }));

      expect(mockListRuns).toHaveBeenCalled();
      for (const [params] of mockListRuns.mock.calls) {
        // Every read states the status it wants AND a bound. An unfiltered, unbounded read
        // replayed ~21k rows per gate check — i.e. per campaign per tick, fleet-wide.
        expect(params.status).toBeDefined();
        expect(params.limit).toBeGreaterThan(0);
      }
    });

    it("reads only the RUNNING rows for stale cleanup + the in-progress guard", async () => {
      await runGateChecks(makeCampaign());

      const statuses = mockListRuns.mock.calls.map(([p]: [{ status?: string }]) => p.status);
      expect(statuses).toEqual(["running"]);
      const [params] = mockListRuns.mock.calls[0];
      expect(params).toMatchObject({
        orgId: "org-1",
        serviceName: "campaign-service",
        taskName: "campaign-1",
        status: "running",
      });
    });

    it("does not read completed runs at all when the campaign has no maxLeads cap", async () => {
      await runGateChecks(makeCampaign({ maxLeads: null }));

      const statuses = mockListRuns.mock.calls.map(([p]: [{ status?: string }]) => p.status);
      expect(statuses).not.toContain("completed");
    });

    it("bounds the completed-run read by the cap it is compared against", async () => {
      await runGateChecks(makeCampaign({ maxLeads: 3 }));

      const completedCall = mockListRuns.mock.calls
        .map(([p]: [{ status?: string; limit?: number }]) => p)
        .find(p => p.status === "completed");
      expect(completedCall).toMatchObject({ status: "completed", limit: 3 });
    });
  });

  describe("Volume check", () => {
    it("should BLOCK — never stop — when maxLeads is reached", async () => {
      mockRuns({
        completed: [
          makeRun({ id: "r1", status: "completed" }),
          makeRun({ id: "r2", status: "completed" }),
          makeRun({ id: "r3", status: "completed" }),
        ],
      });

      // Mock lead stats
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ totalServed: 3 }),
      });

      const result = await runGateChecks(makeCampaign({ maxLeads: 3 }));
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("Max leads reached");
      // The lead cap blocks the RUN. Only the customer stops a campaign, so there is nothing to
      // un-stop when they raise the cap.
    });

    it("should allow when maxLeads is not reached", async () => {
      mockRuns({ completed: [makeRun({ id: "r1", status: "completed" })] });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ totalServed: 1 }),
      });

      const result = await runGateChecks(makeCampaign({ maxLeads: 10 }));
      expect(result.allowed).toBe(true);
    });

    it("should fallback to completed run count on 404 from lead-service", async () => {
      mockRuns({
        completed: [
          makeRun({ id: "r1", status: "completed" }),
          makeRun({ id: "r2", status: "completed" }),
        ],
      });

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      });

      const result = await runGateChecks(makeCampaign({ maxLeads: 5 }));
      expect(result.allowed).toBe(true); // 2 completed < 5 maxLeads
    });

    it("still reaches maxLeads for a campaign whose history dwarfs the bound", async () => {
      // 50 lifetime completed runs against a cap of 3. The gate only ever receives the first 3
      // (that is the whole point of the bound) — a count capped at the cap must still satisfy
      // `>= maxLeads`, or a long-running campaign would never stop.
      mockRuns({
        completed: Array.from({ length: 50 }, (_, i) =>
          makeRun({ id: `r${i}`, status: "completed" }),
        ),
      });

      // lead-service 404 → the completed-run count IS totalServed, no other source.
      mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });

      const result = await runGateChecks(makeCampaign({ maxLeads: 3 }));
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("Max leads reached");
      // The lead cap blocks the RUN. Only the customer stops a campaign, so there is nothing to
      // un-stop when they raise the cap.
    });

    it("still reaches maxLeads via the history when lead-service under-reports", async () => {
      mockRuns({
        completed: Array.from({ length: 50 }, (_, i) =>
          makeRun({ id: `r${i}`, status: "completed" }),
        ),
      });

      // lead-service answers below the cap; the run history is what carries the campaign over it.
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ totalServed: 1 }) });

      const result = await runGateChecks(makeCampaign({ maxLeads: 5 }));
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("Max leads reached");
      // The lead cap blocks the RUN. Only the customer stops a campaign, so there is nothing to
      // un-stop when they raise the cap.
    });

    it("should block on non-404 lead-service error (fail-closed)", async () => {
      mockRuns();

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

    it("should report an ALLOWED run as authorized by billing, not merely allowed", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ affordable: true, balanceCents: "5000" }),
      });

      const result = await runGateChecks(makeCampaign());
      expect(result.allowed).toBe(true);
      expect(result.creditCheck).toBe("affordable");
      expect(result.creditCheckDetail).toBeUndefined();
    });

    it("should report a BLOCKED run as unaffordable", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ affordable: false, balanceCents: "0" }),
      });

      const result = await runGateChecks(makeCampaign());
      expect(result.creditCheck).toBe("unaffordable");
    });

    it("should report the fail-open path as UNREADABLE, never as an authorization", async () => {
      // The whole point: an incident must be able to tell "billing said yes" from "billing
      // could not be asked". Both allow the run; only one of them is an authorization.
      mockFetch.mockRejectedValueOnce(new Error("ECONNRESET"));
      let result = await runGateChecks(makeCampaign());
      expect(result.allowed).toBe(true);
      expect(result.creditCheck).toBe("unreadable");
      expect(result.creditCheckDetail).toBe("ECONNRESET");

      mockFetch.mockResolvedValueOnce({ ok: false, status: 502 });
      result = await runGateChecks(makeCampaign());
      expect(result.allowed).toBe(true);
      expect(result.creditCheck).toBe("unreadable");
      expect(result.creditCheckDetail).toBe("billing responded 502");

      // A 200 that does not state `affordable` is not an answer either.
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ balanceCents: "5000" }) });
      result = await runGateChecks(makeCampaign());
      expect(result.allowed).toBe(true);
      expect(result.creditCheck).toBe("unreadable");

      delete process.env.BILLING_SERVICE_URL;
      result = await runGateChecks(makeCampaign());
      expect(result.allowed).toBe(true);
      expect(result.creditCheck).toBe("unreadable");
      expect(result.creditCheckDetail).toBe("billing not configured");
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


  describe("nextRunAt on temporal budget exceeded (unit on a non-sales channel)", () => {
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

    it("paces the TOTAL window on COMMITTED — blocks when committed is over", async () => {
      // Committed-pacing applies to the total window too (product-owner decision for full
      // dashboard coherence). It is no longer terminal, so an inflated hold near the lifetime cap
      // pauses the campaign until the holds settle rather than stopping it.
      mockGetStatsBudget.mockResolvedValue(
        makeBudgetResponse([{ label: "total", totalCostInUsdCents: "9000", actualCostInUsdCents: "4000" }])
      );

      const result = await runGateChecks(makeCampaign({
        featureSlug: NON_SALES_FEATURE,
        maxBudgetDailyUsd: null,
        maxBudgetTotalUsd: "50.00",
      }));
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("total budget exceeded");
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

    it("should NOT return nextRunAt when total budget is exceeded — it has no reset boundary", async () => {
      mockGetStatsBudget.mockResolvedValue(
        makeBudgetResponse([{ label: "total", totalCostInUsdCents: "5500" }])
      );

      const result = await runGateChecks(makeCampaign({
        featureSlug: NON_SALES_FEATURE,
        maxBudgetDailyUsd: null,
        maxBudgetTotalUsd: "50.00",
      }));
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("total budget exceeded");
      // No reset boundary of its own: the caller applies its own backoff and re-checks.
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
