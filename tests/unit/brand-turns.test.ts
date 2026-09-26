import { describe, it, expect, beforeEach, vi } from "vitest";

const {
  mockListRuns,
  mockGetStatsBudget,
  mockFindFirst,
  mockFindMany,
  mockInsertValues,
  mockUpdateSet,
  mockUpdateWhere,
  mockDeleteWhere,
  mockCreateRun,
  mockUpdateRun,
  mockTraceEvent,
} = vi.hoisted(() => ({
  mockTraceEvent: vi.fn(),
  mockListRuns: vi.fn(),
  mockGetStatsBudget: vi.fn(),
  mockCreateRun: vi.fn(),
  mockUpdateRun: vi.fn(),
  mockFindFirst: vi.fn(),
  mockFindMany: vi.fn(),
  mockInsertValues: vi.fn(),
  mockUpdateSet: vi.fn(),
  mockUpdateWhere: vi.fn(),
  mockDeleteWhere: vi.fn(),
}));

vi.mock("@distribute/runs-client", () => ({
  listRuns: mockListRuns,
  getStatsBudget: mockGetStatsBudget,
  createRun: mockCreateRun,
  updateRun: mockUpdateRun,
}));

vi.mock("../../src/lib/trace-event.js", () => ({ traceEvent: mockTraceEvent }));

vi.mock("../../src/db/index.js", () => ({
  db: {
    query: { campaigns: { findFirst: mockFindFirst, findMany: mockFindMany } },
    insert: vi.fn().mockReturnValue({ values: mockInsertValues }),
    update: vi.fn().mockReturnValue({
      set: (values: unknown) => {
        mockUpdateSet(values);
        return { where: mockUpdateWhere };
      },
    }),
    delete: vi.fn().mockReturnValue({ where: mockDeleteWhere }),
    // Raw-SQL seam (the offer adoption's pre-check), inert here.
    execute: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock("../../src/db/schema.js", () => ({
  campaigns: {
    id: "id",
    orgId: "org_id",
    featureSlug: "feature_slug",
    brandIds: "brand_ids",
    createdAt: "created_at",
    status: "status",
    goal: "goal",
  },
}));

vi.mock("drizzle-orm", () => ({
  and: vi.fn(),
  eq: vi.fn(),
  asc: vi.fn(),
  desc: vi.fn(),
  isNull: vi.fn(),
  inArray: vi.fn(),
  arrayContains: vi.fn(),
  sql: Object.assign(vi.fn(), { join: vi.fn() }),
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import {
  planBrandTurns,
  selectLowestFillRatio,
  serializationCohort,
  resetLegKeylessCeilingReports,
  TURN_DEFER_MS,
  FUNDING_RECHECK_MS,
  type ClaimedSalesCampaign,
} from "../../src/lib/brand-turns.js";

const SALES = "sales-cold-email-outreach";
const FEEDBACK = "feedback-request-cold-email-outreach";
const GOOGLE_ADS = "google-ads";
// Answers a lead who ALREADY replied: it books the meeting out of a stated sales interest rather
// than reaching a new person. Platform-operated, sales-family, and deliberately not outbound.
const AI_MEETING_BOOKING = "ai-meeting-booking";
const ANCESTOR_RUN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
// features-service MINTS these; the tests carry them verbatim exactly as the service does.
const ENTRY_LEG = "start_to_conversation";
const VISIT_LEG = "start_to_website_visit";
const OFFER = "offer-1";

// The brand's alive campaigns, as the sales-scoped liveness check reads them.
let aliveBrandCampaigns: Array<{ id: string; featureSlug: string | null }> = [];
function claimed(overrides: Partial<ClaimedSalesCampaign> = {}): ClaimedSalesCampaign {
  return {
    id: "campaign-1",
    orgId: "org-1",
    createdByUserId: "user-1",
    parentRunId: ANCESTOR_RUN_ID,
    workflowSlug: "sales-email-cold-outreach",
    brandIds: ["brand-1"],
    featureSlug: SALES,
    dailyBudgetCents: null,
    offerId: OFFER,
    legKey: ENTRY_LEG,
    ...overrides,
  };
}

type Entry = { offerId?: string | null; legKey: string | null; featureSlug?: string; dailyBudgetCents: string };
// billing's per-campaign ceilings for the brand. `brandDailyBudgetCents` defaults to their sum;
// pass it explicitly for a brand with ONE pot (entries: []).
function mockCampaignBudgets(entries: Entry[], brandDailyBudgetCents?: string | null) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      brandId: "brand-1",
      dailyBudgetCents:
        brandDailyBudgetCents === undefined
          ? String(entries.reduce((s, e) => s + Number(e.dailyBudgetCents), 0))
          : brandDailyBudgetCents,
      campaigns: entries.map((e) => ({ offerId: OFFER, featureSlug: SALES, ...e, updatedAt: null })),
    }),
  });
}

function mockSpend(cents: string) {
  mockGetStatsBudget.mockResolvedValueOnce({
    windows: [{ label: "today", totalCostInUsdCents: cents, netTotalCostInUsdCents: cents }],
  });
}

/** Run something and return everything it said on console.error, joined. */
function captureErrors(): () => string {
  const said: string[] = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    said.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(" "));
  });
  return () => said.join("\n");
}

/** Run something and return everything it said on console.warn, joined. */
function captureWarnings(): () => string {
  const said: string[] = [];
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    said.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(" "));
  });
  return () => said.join("\n");
}

describe("selectLowestFillRatio", () => {
  it("hands the turn to the campaign that has filled the least of its own ceiling", () => {
    const winner = selectLowestFillRatio([
      { campaignId: "a", legKey: ENTRY_LEG, spentCents: 800, ceilingCents: 1000 },
      { campaignId: "b", legKey: VISIT_LEG, spentCents: 900, ceilingCents: 5000 },
    ]);
    expect(winner).toBe("b");
  });

  it("is not a fixed order — a campaign that can absorb the whole day never starves the others", () => {
    const big = { campaignId: "big", legKey: ENTRY_LEG, spentCents: 0, ceilingCents: 100_000 };
    const small = { campaignId: "small", legKey: VISIT_LEG, spentCents: 0, ceilingCents: 100 };
    expect(selectLowestFillRatio([big, small])).toBe("big"); // tie at 0 → leg order
    expect(selectLowestFillRatio([{ ...big, spentCents: 10_000 }, small])).toBe("small");
  });

  it("a campaign at its ceiling yields to another funded one, with no special case", () => {
    const winner = selectLowestFillRatio([
      { campaignId: "full", legKey: ENTRY_LEG, spentCents: 1000, ceilingCents: 1000 },
      { campaignId: "open", legKey: VISIT_LEG, spentCents: 990, ceilingCents: 1000 },
    ]);
    expect(winner).toBe("open");
  });

  it("returns null when every funded campaign is at its ceiling", () => {
    expect(
      selectLowestFillRatio([
        { campaignId: "a", legKey: ENTRY_LEG, spentCents: 1000, ceilingCents: 1000 },
        { campaignId: "b", legKey: VISIT_LEG, spentCents: 2500, ceilingCents: 2000 },
      ]),
    ).toBeNull();
  });

  it("never runs a campaign funded at zero", () => {
    expect(
      selectLowestFillRatio([{ campaignId: "zero", legKey: VISIT_LEG, spentCents: 0, ceilingCents: 0 }]),
    ).toBeNull();
  });

  it("breaks ties deterministically on the leg, not insertion order", () => {
    const rows = [
      { campaignId: "v", legKey: VISIT_LEG, spentCents: 50, ceilingCents: 100 },
      { campaignId: "r", legKey: ENTRY_LEG, spentCents: 50, ceilingCents: 100 },
    ];
    expect(selectLowestFillRatio(rows)).toBe("r");
    expect(selectLowestFillRatio([...rows].reverse())).toBe("r");
  });
});

describe("serializationCohort", () => {
  it("puts the outbound cold-email channels in ONE cohort and everything else in its own", () => {
    expect(serializationCohort(SALES)).toBe("outbound_cold_email");
    expect(serializationCohort(FEEDBACK)).toBe("outbound_cold_email");
    expect(serializationCohort(GOOGLE_ADS)).toBe("google_ads");
    expect(serializationCohort(AI_MEETING_BOOKING)).toBe("ai_meeting_booking");
    expect(serializationCohort(AI_MEETING_BOOKING)).not.toBe(serializationCohort(SALES));
  });

  it("gives earned media its own cohort — it holds no leads and burns no mailbox", () => {
    expect(serializationCohort("pr-expert-quote-outreach")).toBe("expert_quote_outreach");
    expect(serializationCohort("pr-expert-quote-outreach")).not.toBe(serializationCohort(SALES));
  });
});

function resetMocks() {
  vi.clearAllMocks();
  // clearAllMocks does NOT drop queued `...Once` values, so an unconsumed one from a previous
  // test would answer the next test's first read. Reset the queue-driven mocks outright.
  mockFetch.mockReset();
  mockTraceEvent.mockReset();
  mockTraceEvent.mockResolvedValue(undefined);
  mockGetStatsBudget.mockReset();
  mockGetStatsBudget.mockResolvedValue({
    windows: [{ label: "today", totalCostInUsdCents: "0", netTotalCostInUsdCents: "0" }],
  });
  resetLegKeylessCeilingReports();
  process.env.BILLING_SERVICE_URL = "https://billing.test.local";
  process.env.BILLING_SERVICE_API_KEY = "billing-key";
  process.env.BRAND_SERVICE_URL = "https://brand.test.local";
  process.env.BRAND_SERVICE_API_KEY = "brand-key";
  mockFetch.mockImplementation(async (input: URL | string) => {
    throw new Error(`unexpected fetch in test: ${String(input)}`);
  });
  mockListRuns.mockResolvedValue({ runs: [] });
  mockFindFirst.mockResolvedValue({ id: "existing", name: "custom name", status: "ongoing" });
  aliveBrandCampaigns = [{ id: "campaign-1", featureSlug: SALES }];
  mockFindMany.mockImplementation(async () => aliveBrandCampaigns);
  mockInsertValues.mockResolvedValue(undefined);
  mockUpdateWhere.mockResolvedValue(undefined);
  mockDeleteWhere.mockResolvedValue(undefined);
}

describe("planBrandTurns", () => {
  beforeEach(resetMocks);

  it("leaves non-sales campaigns entirely alone", async () => {
    const deferred = await planBrandTurns([claimed({ featureSlug: "pr-media-pitch-v1" })]);
    expect(deferred.size).toBe(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("a brand with ONE funded pot and no per-campaign ceilings runs on it", async () => {
    mockCampaignBudgets([], "5000");
    mockSpend("0");
    const deferred = await planBrandTurns([claimed()]);
    expect(deferred.size).toBe(0);
  });

  it("HOLDS a brand that funds nothing — no campaign ceiling and no pot", async () => {
    mockCampaignBudgets([], null);
    const now = new Date("2026-08-16T10:00:00Z");
    const deferred = await planBrandTurns([claimed()], now);
    expect(deferred.get("campaign-1")?.getTime()).toBe(now.getTime() + FUNDING_RECHECK_MS);
  });

  it("HOLDS the brand when the ceilings cannot be read (fail-CLOSED)", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });
    const now = new Date("2026-08-16T10:00:00Z");
    const deferred = await planBrandTurns([claimed()], now);
    expect(deferred.get("campaign-1")?.getTime()).toBe(now.getTime() + FUNDING_RECHECK_MS);
  });

  it("CREATES NOTHING for a funded campaign ceiling that has no campaign", async () => {
    // Money is not a statement of intent: a campaign exists because the CUSTOMER said so.
    mockCampaignBudgets([
      { legKey: ENTRY_LEG, dailyBudgetCents: "2000" },
      { legKey: ENTRY_LEG, featureSlug: FEEDBACK, dailyBudgetCents: "1000" },
    ]);
    mockSpend("0");
    await planBrandTurns([claimed()]);
    expect(mockInsertValues).not.toHaveBeenCalled();
  });

  it("never RESUMES a campaign because its ceiling is funded", async () => {
    mockCampaignBudgets([{ legKey: ENTRY_LEG, dailyBudgetCents: "2000" }]);
    mockSpend("0");
    await planBrandTurns([claimed()]);
    for (const call of mockUpdateSet.mock.calls) {
      expect(call[0]).not.toHaveProperty("status");
      expect(call[0]).not.toHaveProperty("stopReason");
    }
  });

  it("makes ONE billing read — the per-campaign ceilings — and nothing else", async () => {
    mockCampaignBudgets([{ legKey: ENTRY_LEG, dailyBudgetCents: "2000" }]);
    mockSpend("0");
    await planBrandTurns([claimed()]);
    const urls = mockFetch.mock.calls.map((c) => String(c[0]));
    expect(urls).toHaveLength(1);
    expect(urls[0]).toBe("https://billing.test.local/internal/brands/brand-1/campaign-budgets");
  });

  it("names, as an ERROR, a funded ceiling that states no leg", async () => {
    mockCampaignBudgets([
      { legKey: ENTRY_LEG, dailyBudgetCents: "1500" },
      { legKey: null, featureSlug: FEEDBACK, dailyBudgetCents: "500" },
    ]);
    mockSpend("0");
    const said = captureErrors();
    await planBrandTurns([claimed()]);
    const text = said();
    expect(text).toContain("FUNDED CEILING STATES NO LEG");
    expect(text).toContain("brand-1");
    expect(text).toContain(FEEDBACK);
    expect(text).toContain("500 cents/day");
  });

  it("says nothing at all when every funded ceiling states its leg", async () => {
    mockCampaignBudgets([{ legKey: ENTRY_LEG, dailyBudgetCents: "2000" }]);
    mockSpend("0");
    const said = captureErrors();
    await planBrandTurns([claimed()]);
    expect(said()).toBe("");
  });

  it("does NOT hold the brand for a leg-less ceiling — the live campaign is not at fault", async () => {
    mockCampaignBudgets([
      { legKey: ENTRY_LEG, dailyBudgetCents: "1500" },
      { legKey: null, featureSlug: FEEDBACK, dailyBudgetCents: "500" },
    ]);
    mockSpend("0");
    const said = captureErrors();
    const deferred = await planBrandTurns([claimed()]);
    expect(said()).toContain("FUNDED CEILING STATES NO LEG");
    expect(deferred.size).toBe(0);
  });

  it("reports the same leg-less ceiling once per cadence, not once per tick", async () => {
    const budgets = () => mockCampaignBudgets([{ legKey: null, dailyBudgetCents: "500" }]);
    const now = new Date("2026-09-06T10:00:00Z");
    const said = captureErrors();
    budgets();
    mockSpend("0");
    await planBrandTurns([claimed()], now);
    budgets();
    mockSpend("0");
    await planBrandTurns([claimed()], new Date(now.getTime() + 60_000));
    expect(said().match(/FUNDED CEILING STATES NO LEG/g)).toHaveLength(1);
  });

  it("HOLDS a campaign whose (offer, leg, channel) carries no ceiling while the brand funds another", async () => {
    mockCampaignBudgets([
      { legKey: ENTRY_LEG, dailyBudgetCents: "2000" },
      { legKey: VISIT_LEG, dailyBudgetCents: "0" },
    ]);
    mockSpend("0");
    const now = new Date("2026-08-16T10:00:00Z");
    const deferred = await planBrandTurns(
      [claimed({ id: "c-reply" }), claimed({ id: "c-visit", legKey: VISIT_LEG })],
      now,
    );
    expect(deferred.get("c-visit")?.getTime()).toBe(now.getTime() + FUNDING_RECHECK_MS);
    expect(deferred.has("c-reply")).toBe(false);
  });

  it("fires exactly one campaign per cohort per tick — the emptiest relative to its ceiling", async () => {
    mockCampaignBudgets([
      { legKey: ENTRY_LEG, dailyBudgetCents: "1000" },
      { legKey: VISIT_LEG, dailyBudgetCents: "1000" },
    ]);
    mockSpend("900"); // c-reply is nearly full
    mockSpend("100"); // c-visit is nearly empty → takes the turn
    const now = new Date("2026-08-16T10:00:00Z");
    const deferred = await planBrandTurns(
      [claimed({ id: "c-reply" }), claimed({ id: "c-visit", legKey: VISIT_LEG })],
      now,
    );
    expect(deferred.get("c-reply")?.getTime()).toBe(now.getTime() + TURN_DEFER_MS);
    expect(deferred.has("c-visit")).toBe(false);
  });

  it("asks each campaign's spend under its OWN feature — the seed's slug would answer zero", async () => {
    mockCampaignBudgets([
      { legKey: ENTRY_LEG, featureSlug: SALES, dailyBudgetCents: "1000" },
      { legKey: VISIT_LEG, featureSlug: GOOGLE_ADS, dailyBudgetCents: "1000" },
    ]);
    mockSpend("0");
    mockSpend("0");
    aliveBrandCampaigns = [
      { id: "c-email", featureSlug: SALES },
      { id: "c-ads", featureSlug: GOOGLE_ADS },
    ];
    await planBrandTurns([
      claimed({ id: "c-email", featureSlug: SALES }),
      claimed({ id: "c-ads", featureSlug: GOOGLE_ADS, legKey: VISIT_LEG }),
    ]);
    const slugs = mockGetStatsBudget.mock.calls.map((c) => c[0].featureSlug);
    expect(slugs).toContain(SALES);
    expect(slugs).toContain(GOOGLE_ADS);
  });

  it("holds the whole cohort while one of its runs is in flight", async () => {
    mockCampaignBudgets([{ legKey: ENTRY_LEG, dailyBudgetCents: "2000" }]);
    mockSpend("0");
    mockListRuns.mockResolvedValue({ runs: [{ id: "run-1" }] });
    const now = new Date("2026-08-16T10:00:00Z");
    const deferred = await planBrandTurns([claimed()], now);
    expect(deferred.get("campaign-1")?.getTime()).toBe(now.getTime() + TURN_DEFER_MS);
  });

  it("a live cold-email run does NOT hold a funded Google Ads campaign", async () => {
    mockCampaignBudgets([{ legKey: VISIT_LEG, featureSlug: GOOGLE_ADS, dailyBudgetCents: "1000" }]);
    mockSpend("0");
    aliveBrandCampaigns = [{ id: "c-email", featureSlug: SALES }];
    mockListRuns.mockResolvedValue({ runs: [{ id: "run-1" }] });
    const deferred = await planBrandTurns([
      claimed({ id: "c-ads", featureSlug: GOOGLE_ADS, legKey: VISIT_LEG }),
    ]);
    expect(deferred.has("c-ads")).toBe(false);
  });

  it("re-checks a parked brand on the funding cadence, never only on the day rollover", async () => {
    mockCampaignBudgets([{ legKey: ENTRY_LEG, dailyBudgetCents: "1000" }]);
    mockSpend("1000"); // at its ceiling
    const now = new Date("2026-08-23T14:00:00Z");
    const deferred = await planBrandTurns([claimed()], now);
    expect(deferred.get("campaign-1")?.getTime()).toBe(now.getTime() + FUNDING_RECHECK_MS);
  });
});

// A CAMPAIGN THAT IS DELIBERATELY NOT RUNNING MUST SAY SO — from `run_events` alone, a campaign
// correctly parked at its ceiling was indistinguishable from one that had silently died.
describe("planBrandTurns — the hold is stated on the run ledger", () => {
  beforeEach(() => {
    resetMocks();
    mockGetStatsBudget.mockReset();
  });

  /** The one hold event emitted for a campaign, or undefined. */
  function holdFor(campaignId: string) {
    const call = mockTraceEvent.mock.calls.find(
      (c) => (c[1] as { data?: { campaignId?: string } }).data?.campaignId === campaignId,
    );
    if (!call) return undefined;
    return {
      runId: call[0] as string,
      payload: call[1] as { event: string; level: string; detail: string; data: Record<string, unknown> },
      headers: call[2] as Record<string, string | undefined>,
    };
  }

  it("says WHY a campaign parked at its daily ceiling is not running", async () => {
    mockCampaignBudgets([{ legKey: ENTRY_LEG, dailyBudgetCents: "400" }]);
    mockSpend("428");
    const now = new Date("2026-09-17T05:33:27Z");
    const deferred = await planBrandTurns([claimed()], now);
    expect(deferred.get("campaign-1")?.getTime()).toBe(now.getTime() + FUNDING_RECHECK_MS);

    const hold = holdFor("campaign-1");
    expect(hold?.runId).toBe(ANCESTOR_RUN_ID);
    expect(hold?.payload.event).toBe("campaign-hold");
    expect(hold?.payload.level).toBe("info");
    expect(hold?.payload.data.reason).toBe("daily_ceiling_reached");
    expect(hold?.payload.data.spentCents).toBe(428);
    expect(hold?.payload.data.ceilingCents).toBe(400);
    expect(hold?.headers["x-campaign-id"]).toBe("campaign-1");
  });

  it("says WHY a campaign the customer funds nothing for is not running", async () => {
    mockCampaignBudgets([], null);
    const deferred = await planBrandTurns([claimed()], new Date("2026-09-17T05:33:27Z"));
    expect(deferred.size).toBe(1);
    const hold = holdFor("campaign-1");
    expect(hold?.payload.data.reason).toBe("unfunded");
    expect(hold?.payload.level).toBe("info");
  });

  it("says WHY a brand whose ceilings cannot be read is held, and WARNS — that one is a fault", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });
    await planBrandTurns([claimed()], new Date("2026-09-17T05:33:27Z"));
    const hold = holdFor("campaign-1");
    expect(hold?.payload.data.reason).toBe("budgets_unreadable");
    expect(hold?.payload.level).toBe("warn");
  });

  it("stays SILENT for a campaign that merely yielded its turn — the brand is visibly working", async () => {
    mockCampaignBudgets([
      { legKey: ENTRY_LEG, dailyBudgetCents: "1000" },
      { legKey: VISIT_LEG, dailyBudgetCents: "1000" },
    ]);
    mockSpend("900");
    mockSpend("100");
    const now = new Date("2026-09-17T05:33:27Z");
    const deferred = await planBrandTurns(
      [claimed({ id: "c-reply" }), claimed({ id: "c-visit", legKey: VISIT_LEG })],
      now,
    );
    expect(deferred.get("c-reply")?.getTime()).toBe(now.getTime() + TURN_DEFER_MS);
    expect(mockTraceEvent).not.toHaveBeenCalled();
  });

  it("stays SILENT while a run of the cohort is in flight", async () => {
    mockCampaignBudgets([{ legKey: ENTRY_LEG, dailyBudgetCents: "2000" }]);
    mockSpend("0");
    mockListRuns.mockResolvedValue({ runs: [{ id: "run-1" }] });
    await planBrandTurns([claimed()], new Date("2026-09-17T05:33:27Z"));
    expect(mockTraceEvent).not.toHaveBeenCalled();
  });

  it("never invents a run id for a campaign that has no ancestor run", async () => {
    mockCampaignBudgets([], null);
    const said = captureWarnings();
    await planBrandTurns([claimed({ parentRunId: null })], new Date("2026-09-17T05:33:27Z"));
    expect(mockTraceEvent).not.toHaveBeenCalled();
    expect(said()).toContain("no ancestor run");
  });

  it("a hold that cannot be reported never changes whether a campaign runs", async () => {
    mockCampaignBudgets([{ legKey: ENTRY_LEG, dailyBudgetCents: "400" }]);
    mockSpend("428");
    mockTraceEvent.mockRejectedValue(new Error("runs-service unreachable"));
    await expect(
      planBrandTurns([claimed()], new Date("2026-09-17T05:33:27Z")),
    ).resolves.toBeInstanceOf(Map);
  });
});
