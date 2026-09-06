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
} = vi.hoisted(() => ({
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
    // Raw-SQL seam. The funnel-less-ancestor adoption runs through it and is inert here: these
    // tests pin which QUESTIONS provisioning asks, not what the rule writes (that is measured
    // against a real database in tests/integration/stopped-ancestor-funnel-rerun.test.ts).
    execute: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock("../../src/db/schema.js", () => ({
  campaigns: {
    id: "id",
    orgId: "org_id",
    featureSlug: "feature_slug",
    funnelKey: "funnel_key",
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

import { SALES_FUNNEL_KEYS } from "../../src/lib/sales-funnel-vocabulary.js";
import {
  planFunnelTurns,
  selectLowestFillRatio,
  serializationCohort,
  resetLegKeylessCeilingReports,
  FUNNEL_TURN_DEFER_MS,
  FUNDING_RECHECK_MS,
  type ClaimedFunnelCampaign,
} from "../../src/lib/funnel-campaigns.js";

const SALES = "sales-cold-email-outreach";
const FEEDBACK = "feedback-request-cold-email-outreach";
const GOOGLE_ADS = "google-ads";
// Answers a lead who ALREADY replied: it books the meeting out of a stated sales interest rather
// than reaching a new person. Platform-operated, funnel-funded, and deliberately not outbound.
const AI_MEETING_BOOKING = "ai-meeting-booking";
// A channel the CUSTOMER's own team operates: they work the replies and book the meeting
// themselves. features-service publishes who operates each channel; nothing here holds a list.
const IN_HOUSE_BOOKING = "in-house-meeting-booking";
const ANCESTOR_RUN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
// features-service MINTS these; the tests carry them verbatim exactly as the service does. They
// are deliberately three DIFFERENT legs of the SAME funnel: what a customer buys is one leg, and
// two legs of one funnel through one channel are two campaigns.
const ENTRY_LEG = "start_to_conversation";
const BOOKING_LEG = "conversation_to_meeting_booked";
const ATTENDED_LEG = "meeting_booked_to_meeting_attended";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The brand's alive campaigns, as the sales-scoped liveness check reads them.
let aliveBrandCampaigns: Array<{ id: string; featureSlug: string | null }> = [];
function claimed(overrides: Partial<ClaimedFunnelCampaign> = {}): ClaimedFunnelCampaign {
  return {
    id: "campaign-1",
    orgId: "org-1",
    createdByUserId: "user-1",
    // The campaign's ancestor run — what every provisioning read states as its `x-run-id`.
    parentRunId: ANCESTOR_RUN_ID,
    workflowSlug: "sales-email-cold-outreach",
    brandIds: ["brand-1"],
    featureSlug: SALES,
    funnelKey: null,
    dailyBudgetCents: null,
    legKey: null,
    ...overrides,
  };
}

// billing-service still names these funnels the PRE-RENAME way, so every test below feeds this
// mock the legacy spellings on purpose: the two producers disagree in production today, and the
// canonicalisation is what keeps a fully-funded funnel from reading as unfunded.
function mockFunnelBudgets(
  funnels: Array<{ funnelKey: string; dailyBudgetCents: string }>,
  // What billing answers as the brand-level pot. Defaults to the sum, which is what it derives
  // when the brand funds per funnel; pass it explicitly for a brand with ONE pot (funnels: []).
  brandDailyBudgetCents?: string | null,
  // The finer, ADDITIVE grain: one entry per (funnel, acquisition-channel feature). Omitted = a
  // billing deploy that does not serve it, which every test below relies on to prove the
  // per-funnel behaviour is untouched.
  channels?: Array<{ funnelKey: string; featureSlug: string; dailyBudgetCents: string }>,
  // The FINEST grain billing stores: one row per (funnel, channel, offer, LEG) — the unit a
  // campaign is bought at. Omitted = a billing deploy that does not serve it, which is what every
  // test above relies on to prove the pair/funnel behaviour is untouched.
  legs?: Array<{
    funnelKey: string;
    featureSlug: string;
    offerId?: string | null;
    legKey: string | null;
    dailyBudgetCents: string;
  }>,
  // The OFFER grain, between `channels` and `legs`: one row per (funnel, channel, offer). Omitted
  // = a billing deploy that does not serve it.
  offers?: Array<{
    funnelKey: string;
    featureSlug: string;
    offerId?: string | null;
    dailyBudgetCents: string;
  }>,
) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      brandId: "brand-1",
      dailyBudgetCents:
        brandDailyBudgetCents === undefined
          ? String(funnels.reduce((s, f) => s + Number(f.dailyBudgetCents), 0))
          : brandDailyBudgetCents,
      funnels: funnels.map(f => ({ ...f, updatedAt: null })),
      ...(channels ? { channels: channels.map(c => ({ ...c, updatedAt: null })) } : {}),
      ...(offers
        ? { offers: offers.map(o => ({ offerId: null, ...o, updatedAt: null })) }
        : {}),
      ...(legs
        ? { legs: legs.map(l => ({ offerId: null, ...l, updatedAt: null })) }
        : {}),
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

describe("selectLowestFillRatio", () => {
  it("hands the turn to the funnel that has filled the least of its own ceiling", () => {
    // The bigger absolute spend is the EMPTIER funnel relative to what it can absorb.
    const winner = selectLowestFillRatio([
      { campaignId: "a", funnelKey: "sales_meetings_from_conversation", spentCents: 800, ceilingCents: 1000 },
      { campaignId: "b", funnelKey: "website_purchases", spentCents: 900, ceilingCents: 5000 },
    ]);
    expect(winner).toBe("b");
  });

  it("is not a fixed order — a funnel that can absorb the whole day never starves the others", () => {
    // First in the list, huge ceiling, nothing spent: under a fixed order it would take every
    // turn. It takes this one, and once it has filled 10% the smaller funnel wins the next.
    const big = { campaignId: "big", funnelKey: "sales_meetings_from_conversation", spentCents: 0, ceilingCents: 100_000 };
    const small = { campaignId: "small", funnelKey: "website_purchases", spentCents: 0, ceilingCents: 100 };
    expect(selectLowestFillRatio([big, small])).toBe("big"); // tie at 0 → funnelKey order
    expect(selectLowestFillRatio([{ ...big, spentCents: 10_000 }, small])).toBe("small");
  });

  it("a funnel at its ceiling yields to another funded one, with no special case", () => {
    const winner = selectLowestFillRatio([
      { campaignId: "full", funnelKey: "sales_meetings_from_conversation", spentCents: 1000, ceilingCents: 1000 },
      { campaignId: "open", funnelKey: "website_purchases", spentCents: 990, ceilingCents: 1000 },
    ]);
    expect(winner).toBe("open");
  });

  it("returns null when every funded funnel is at its ceiling", () => {
    expect(
      selectLowestFillRatio([
        { campaignId: "a", funnelKey: "sales_meetings_from_conversation", spentCents: 1000, ceilingCents: 1000 },
        { campaignId: "b", funnelKey: "website_purchases", spentCents: 2500, ceilingCents: 2000 },
      ]),
    ).toBeNull();
  });

  it("never runs a funnel funded at zero", () => {
    expect(
      selectLowestFillRatio([
        { campaignId: "zero", funnelKey: "website_purchases", spentCents: 0, ceilingCents: 0 },
      ]),
    ).toBeNull();
  });

  it("breaks ties deterministically on funnelKey, not insertion order", () => {
    const rows = [
      { campaignId: "v", funnelKey: "website_purchases", spentCents: 50, ceilingCents: 100 },
      { campaignId: "r", funnelKey: "sales_meetings_from_conversation", spentCents: 50, ceilingCents: 100 },
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
});

describe("planFunnelTurns", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks does NOT drop queued `...Once` values, so an unconsumed one from a previous
    // test would answer the next test's first read. Reset the two queue-driven mocks outright.
    mockFetch.mockReset();
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
  });

  it("leaves non-sales campaigns entirely alone", async () => {
    const deferred = await planFunnelTurns([claimed({ featureSlug: "pr-media-pitch-v1" })]);
    expect(deferred.size).toBe(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("a brand with ONE funded pot and no per-funnel ceilings runs exactly as it always did", async () => {
    mockFunnelBudgets([], "5000");
    mockSpend("0");
    const deferred = await planFunnelTurns([claimed()]);
    expect(deferred.size).toBe(0);
  });

  it("HOLDS a brand that funds nothing — no funnel ceiling and no pot", async () => {
    mockFunnelBudgets([], null);
    const now = new Date("2026-08-16T10:00:00Z");
    const deferred = await planFunnelTurns([claimed()], now);
    expect(deferred.get("campaign-1")?.getTime()).toBe(now.getTime() + FUNDING_RECHECK_MS);
  });

  it("HOLDS the brand when the ceilings cannot be read (fail-CLOSED)", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });
    const now = new Date("2026-08-16T10:00:00Z");
    const deferred = await planFunnelTurns([claimed()], now);
    expect(deferred.get("campaign-1")?.getTime()).toBe(now.getTime() + FUNDING_RECHECK_MS);
  });

  // ————————————————————————————————————————————————————————————————————————
  // MONEY NEVER STARTS ANYTHING
  // ————————————————————————————————————————————————————————————————————————

  it("CREATES NOTHING for a funded pair that has no campaign", async () => {
    // The whole shape of the 2026-09-06 incident: a funded ceiling stood a campaign up on its
    // own. A campaign exists because the CUSTOMER said so; money is not a statement of intent.
    mockFunnelBudgets(
      [{ funnelKey: "reply_meeting", dailyBudgetCents: "3000" }],
      "3000",
      undefined,
      [
        { funnelKey: "reply_meeting", featureSlug: SALES, legKey: ENTRY_LEG, dailyBudgetCents: "2000" },
        { funnelKey: "reply_meeting", featureSlug: FEEDBACK, legKey: ENTRY_LEG, dailyBudgetCents: "1000" },
      ],
    );
    mockSpend("0");
    // The brand runs ONE campaign; the second funded pair has none and must stay that way.
    await planFunnelTurns([claimed({ funnelKey: "sales_meetings_from_conversation", legKey: ENTRY_LEG })]);
    expect(mockInsertValues).not.toHaveBeenCalled();
  });

  it("never RESUMES a campaign because its ceiling is funded", async () => {
    // A campaign the customer stopped stays stopped. Nothing about money may set a status, so the
    // planner writes no status at all.
    mockFunnelBudgets([{ funnelKey: "reply_meeting", dailyBudgetCents: "2000" }], "2000");
    mockSpend("0");
    await planFunnelTurns([claimed({ funnelKey: "sales_meetings_from_conversation" })]);
    for (const call of mockUpdateSet.mock.calls) {
      expect(call[0]).not.toHaveProperty("status");
      expect(call[0]).not.toHaveProperty("stopReason");
    }
  });

  it("asks NOBODY whether a brand still sells a funnel — one billing read and nothing else", async () => {
    // Those reads existed only to decide whether a funded ceiling should get a campaign.
    mockFunnelBudgets([{ funnelKey: "reply_meeting", dailyBudgetCents: "2000" }], "2000");
    mockSpend("0");
    await planFunnelTurns([claimed({ funnelKey: "sales_meetings_from_conversation" })]);
    const urls = mockFetch.mock.calls.map((c) => String(c[0]));
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("/funnel-budgets");
  });

  // ————————————————————————————————————————————————————————————————————————
  // A FUNDED CEILING THAT NAMES NO LEG IS AN ERROR
  // ————————————————————————————————————————————————————————————————————————

  it("names, as an ERROR, a funded ceiling that states no leg", async () => {
    mockFunnelBudgets(
      [{ funnelKey: "reply_meeting", dailyBudgetCents: "2000" }],
      "2000",
      undefined,
      [
        { funnelKey: "reply_meeting", featureSlug: SALES, legKey: ENTRY_LEG, dailyBudgetCents: "1500" },
        { funnelKey: "reply_meeting", featureSlug: SALES, legKey: null, dailyBudgetCents: "500" },
      ],
    );
    mockSpend("0");
    const said = captureErrors();
    await planFunnelTurns([claimed({ funnelKey: "sales_meetings_from_conversation", legKey: ENTRY_LEG })]);
    const text = said();
    expect(text).toContain("FUNDED CEILING STATES NO LEG");
    expect(text).toContain("brand-1");
    expect(text).toContain("sales_meetings_from_conversation");
    expect(text).toContain(SALES);
    expect(text).toContain("500 cents/day");
  });

  it("says nothing at all when every funded ceiling states its leg", async () => {
    mockFunnelBudgets(
      [{ funnelKey: "reply_meeting", dailyBudgetCents: "2000" }],
      "2000",
      undefined,
      [{ funnelKey: "reply_meeting", featureSlug: SALES, legKey: ENTRY_LEG, dailyBudgetCents: "2000" }],
    );
    mockSpend("0");
    const said = captureErrors();
    await planFunnelTurns([claimed({ funnelKey: "sales_meetings_from_conversation", legKey: ENTRY_LEG })]);
    expect(said()).toBe("");
  });

  it("does NOT hold the brand for a leg-less ceiling — the live campaign is not at fault", async () => {
    mockFunnelBudgets(
      [{ funnelKey: "reply_meeting", dailyBudgetCents: "2000" }],
      "2000",
      undefined,
      [
        { funnelKey: "reply_meeting", featureSlug: SALES, legKey: ENTRY_LEG, dailyBudgetCents: "1500" },
        { funnelKey: "reply_meeting", featureSlug: FEEDBACK, legKey: null, dailyBudgetCents: "500" },
      ],
    );
    mockSpend("0");
    const said = captureErrors();
    const deferred = await planFunnelTurns([
      claimed({ funnelKey: "sales_meetings_from_conversation", legKey: ENTRY_LEG }),
    ]);
    expect(said()).toContain("FUNDED CEILING STATES NO LEG");
    expect(deferred.size).toBe(0);
  });

  it("reports the same leg-less ceiling once per cadence, not once per tick", async () => {
    const budgets = () =>
      mockFunnelBudgets(
        [{ funnelKey: "reply_meeting", dailyBudgetCents: "500" }],
        "500",
        undefined,
        [{ funnelKey: "reply_meeting", featureSlug: SALES, legKey: null, dailyBudgetCents: "500" }],
      );
    const now = new Date("2026-09-06T10:00:00Z");
    const said = captureErrors();
    budgets();
    mockSpend("0");
    await planFunnelTurns([claimed({ funnelKey: "sales_meetings_from_conversation" })], now);
    budgets();
    mockSpend("0");
    await planFunnelTurns(
      [claimed({ funnelKey: "sales_meetings_from_conversation" })],
      new Date(now.getTime() + 60_000),
    );
    expect(said().match(/FUNDED CEILING STATES NO LEG/g)).toHaveLength(1);
  });

  // ————————————————————————————————————————————————————————————————————————
  // TURN-TAKING AND PACING — unchanged
  // ————————————————————————————————————————————————————————————————————————

  it("HOLDS a campaign whose funnel carries no ceiling while the brand funds another", async () => {
    mockFunnelBudgets([
      { funnelKey: "reply_meeting", dailyBudgetCents: "2000" },
      { funnelKey: "visit_meeting", dailyBudgetCents: "0" },
    ]);
    mockSpend("0");
    const now = new Date("2026-08-16T10:00:00Z");
    const deferred = await planFunnelTurns(
      [
        claimed({ id: "c-reply", funnelKey: "sales_meetings_from_conversation" }),
        claimed({ id: "c-visit", funnelKey: "sales_meetings_from_website" }),
      ],
      now,
    );
    expect(deferred.get("c-visit")?.getTime()).toBe(now.getTime() + FUNDING_RECHECK_MS);
    expect(deferred.has("c-reply")).toBe(false);
  });

  it("fires exactly one campaign per cohort per tick — the emptiest relative to its ceiling", async () => {
    mockFunnelBudgets([
      { funnelKey: "reply_meeting", dailyBudgetCents: "1000" },
      { funnelKey: "visit_meeting", dailyBudgetCents: "1000" },
    ]);
    mockSpend("900"); // c-reply is nearly full
    mockSpend("100"); // c-visit is nearly empty → takes the turn
    const now = new Date("2026-08-16T10:00:00Z");
    const deferred = await planFunnelTurns(
      [
        claimed({ id: "c-reply", funnelKey: "sales_meetings_from_conversation" }),
        claimed({ id: "c-visit", funnelKey: "sales_meetings_from_website" }),
      ],
      now,
    );
    expect(deferred.get("c-reply")?.getTime()).toBe(now.getTime() + FUNNEL_TURN_DEFER_MS);
    expect(deferred.has("c-visit")).toBe(false);
  });

  it("asks each campaign's spend under its OWN feature — the seed's slug would answer zero", async () => {
    mockFunnelBudgets(
      [{ funnelKey: "reply_meeting", dailyBudgetCents: "2000" }],
      "2000",
      [
        { funnelKey: "reply_meeting", featureSlug: SALES, dailyBudgetCents: "1000" },
        { funnelKey: "reply_meeting", featureSlug: GOOGLE_ADS, dailyBudgetCents: "1000" },
      ],
    );
    mockSpend("0");
    mockSpend("0");
    aliveBrandCampaigns = [
      { id: "c-email", featureSlug: SALES },
      { id: "c-ads", featureSlug: GOOGLE_ADS },
    ];
    await planFunnelTurns([
      claimed({ id: "c-email", funnelKey: "sales_meetings_from_conversation", featureSlug: SALES }),
      claimed({ id: "c-ads", funnelKey: "sales_meetings_from_conversation", featureSlug: GOOGLE_ADS }),
    ]);
    const slugs = mockGetStatsBudget.mock.calls.map((c) => c[0].featureSlug);
    expect(slugs).toContain(SALES);
    expect(slugs).toContain(GOOGLE_ADS);
  });

  it("holds the whole cohort while one of its runs is in flight", async () => {
    mockFunnelBudgets([{ funnelKey: "reply_meeting", dailyBudgetCents: "2000" }]);
    mockSpend("0");
    mockListRuns.mockResolvedValue({ runs: [{ id: "run-1" }] });
    const now = new Date("2026-08-16T10:00:00Z");
    const deferred = await planFunnelTurns(
      [claimed({ funnelKey: "sales_meetings_from_conversation" })],
      now,
    );
    expect(deferred.get("campaign-1")?.getTime()).toBe(now.getTime() + FUNNEL_TURN_DEFER_MS);
  });

  it("a live cold-email run does NOT hold a funded Google Ads campaign", async () => {
    mockFunnelBudgets(
      [{ funnelKey: "reply_meeting", dailyBudgetCents: "2000" }],
      "2000",
      [
        { funnelKey: "reply_meeting", featureSlug: SALES, dailyBudgetCents: "1000" },
        { funnelKey: "reply_meeting", featureSlug: GOOGLE_ADS, dailyBudgetCents: "1000" },
      ],
    );
    mockSpend("0");
    aliveBrandCampaigns = [{ id: "c-email", featureSlug: SALES }];
    mockListRuns.mockResolvedValue({ runs: [{ id: "run-1" }] });
    const deferred = await planFunnelTurns([
      claimed({ id: "c-ads", funnelKey: "sales_meetings_from_conversation", featureSlug: GOOGLE_ADS }),
    ]);
    expect(deferred.has("c-ads")).toBe(false);
  });

  it("re-checks a parked brand on the funding cadence, never only on the day rollover", async () => {
    mockFunnelBudgets([{ funnelKey: "reply_meeting", dailyBudgetCents: "1000" }]);
    mockSpend("1000"); // at its ceiling
    const now = new Date("2026-08-23T14:00:00Z");
    const deferred = await planFunnelTurns(
      [claimed({ funnelKey: "sales_meetings_from_conversation" })],
      now,
    );
    expect(deferred.get("campaign-1")?.getTime()).toBe(now.getTime() + FUNDING_RECHECK_MS);
  });

  it("ranks a campaign row still on a pre-rename key on its funnel's real ceiling", async () => {
    mockFunnelBudgets([{ funnelKey: "reply_meeting", dailyBudgetCents: "2000" }]);
    mockSpend("0");
    const deferred = await planFunnelTurns([claimed({ funnelKey: "reply_meeting" })]);
    expect(deferred.size).toBe(0);
  });
});
