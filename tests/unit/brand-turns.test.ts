import { describe, it, expect, beforeEach, vi } from "vitest";

const {
  mockListRuns,
  mockFindFirst,
  mockFindMany,
  mockInsertValues,
  mockUpdateSet,
  mockUpdateWhere,
  mockDeleteWhere,
  mockCreateRun,
  mockUpdateRun,
  mockTraceEvent,
  mockUnitMoney,
} = vi.hoisted(() => ({
  mockTraceEvent: vi.fn(),
  mockUnitMoney: vi.fn(),
  mockListRuns: vi.fn(),
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
  createRun: mockCreateRun,
  updateRun: mockUpdateRun,
}));

vi.mock("../../src/lib/trace-event.js", () => ({ traceEvent: mockTraceEvent }));

// A unit's money is its funnel's caps. Defaults to the REAL read (so the billing URL is pinned);
// a test states a verdict with `fundedUnit` / `heldUnit` when the read itself is not the subject.
vi.mock("../../src/lib/sales-funnel-campaigns.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/sales-funnel-campaigns.js")>();
  mockUnitMoney.mockImplementation(actual.salesFunnelUnitMoney);
  return { ...actual, salesFunnelUnitMoney: mockUnitMoney };
});

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
  hasLiveRunForBrandCohort,
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
let aliveBrandCampaigns: Array<{ id: string; featureSlug: string | null; salesFunnelCampaignId?: string | null }> = [];
function claimed(overrides: Partial<ClaimedSalesCampaign> = {}): ClaimedSalesCampaign {
  return {
    id: "campaign-1",
    orgId: "org-1",
    createdByUserId: "user-1",
    parentRunId: ANCESTOR_RUN_ID,
    workflowSlug: "sales-email-cold-outreach",
    brandIds: ["brand-1"],
    featureSlug: SALES,
    offerId: OFFER,
    legKey: ENTRY_LEG,
    salesFunnelCampaignId: "fc-1",
    salesFunnelId: "funnel@1",
    ...overrides,
  };
}

/** The funnel funds this unit; it ranks on `spentCents / ceilingCents`. */
function fundedUnit(id: string, spentCents: number, ceilingCents: number) {
  mockUnitMoney.mockImplementation(async (ref: { id: string }, now: Date) =>
    ref.id === id ? { run: true, pace: { spentCents, ceilingCents } } : pending(ref, now),
  );
}

// Per-unit verdicts, set by `unitVerdicts` for a test with several units.
let verdicts = new Map<string, unknown>();
function pending(ref: { id: string }, now: Date) {
  const v = verdicts.get(ref.id);
  if (!v) throw new Error(`no money verdict stated for unit ${ref.id}`);
  return typeof v === "function" ? (v as (n: Date) => unknown)(now) : v;
}
function unitVerdicts(map: Record<string, unknown>) {
  verdicts = new Map(Object.entries(map));
  mockUnitMoney.mockImplementation(async (ref: { id: string }, now: Date) => pending(ref, now));
}
const runs = (spentCents: number, ceilingCents: number) => ({ run: true, pace: { spentCents, ceilingCents } });
const held = (kind: "unfunded" | "unreadable" | "cap_reached") => (now: Date) => ({
  run: false,
  kind,
  reason: kind,
  detail: `held: ${kind}`,
  nextRunAt: new Date(now.getTime() + FUNDING_RECHECK_MS),
});

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
  verdicts = new Map();
  process.env.BILLING_SERVICE_URL = "https://billing.test.local";
  process.env.BILLING_SERVICE_API_KEY = "billing-key";
  mockFetch.mockImplementation(async (input: URL | string) => {
    throw new Error(`unexpected fetch in test: ${String(input)}`);
  });
  mockListRuns.mockResolvedValue({ runs: [] });
  aliveBrandCampaigns = [{ id: "campaign-1", featureSlug: SALES, salesFunnelCampaignId: "fc-1" }];
  mockFindMany.mockImplementation(async () => aliveBrandCampaigns);
  mockInsertValues.mockResolvedValue(undefined);
  mockUpdateWhere.mockResolvedValue(undefined);
  mockDeleteWhere.mockResolvedValue(undefined);
}

describe("planBrandTurns", () => {
  let actualMoney: typeof import("../../src/lib/sales-funnel-campaigns.js").salesFunnelUnitMoney;
  beforeEach(async () => {
    resetMocks();
    actualMoney = (await vi.importActual<typeof import("../../src/lib/sales-funnel-campaigns.js")>("../../src/lib/sales-funnel-campaigns.js")).salesFunnelUnitMoney;
    mockUnitMoney.mockImplementation(actualMoney);
  });

  it("leaves non-sales campaigns that are not units entirely alone", async () => {
    const deferred = await planBrandTurns([claimed({ featureSlug: "pr-media-pitch-v1", salesFunnelCampaignId: null, salesFunnelId: null })]);
    expect(deferred.size).toBe(0);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockUnitMoney).not.toHaveBeenCalled();
    expect(mockTraceEvent).not.toHaveBeenCalled();
  });

  it("HOLDS a sales-family campaign that is not a sales funnel unit, by name, with no billing read", async () => {
    const now = new Date("2026-10-14T10:00:00Z");
    const deferred = await planBrandTurns([claimed({ salesFunnelCampaignId: null, salesFunnelId: null })], now);
    expect(deferred.get("campaign-1")?.getTime()).toBe(now.getTime() + FUNDING_RECHECK_MS);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockUnitMoney).not.toHaveBeenCalled();
    expect(mockListRuns).not.toHaveBeenCalled();
    const call = mockTraceEvent.mock.calls[0];
    expect(call?.[0]).toBe(ANCESTOR_RUN_ID);
    expect((call?.[1] as { data: { reason: string } }).data.reason).toBe("not_a_sales_funnel_campaign");
  });

  it("HOLDS a SALES FUNNEL unit on its funnel's money", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ stated: false, funded: false, fundedBy: null, maxBudget: null, maxVolume: null, pipes: null }) });
    const now = new Date("2026-10-10T10:00:00Z");
    const deferred = await planBrandTurns(
      [claimed({ id: "unit-1", offerId: OFFER, salesFunnelCampaignId: "funnel-campaign-1", salesFunnelId: "f@x" })],
      now,
    );
    expect(deferred.get("unit-1")?.getTime()).toBe(now.getTime() + 10 * 60_000);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(String(mockFetch.mock.calls[0][0])).toContain("/sales-funnels/f%40x/campaigns/funnel-campaign-1/caps");
  });

  it("plans a sales funnel unit OUTSIDE the sales family on its funnel's caps (#608)", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ stated: false, funded: false, fundedBy: null, maxBudget: null, maxVolume: null, pipes: null }) });
    const now = new Date("2026-10-10T10:00:00Z");
    const deferred = await planBrandTurns(
      [claimed({ id: "li-unit", featureSlug: "organic-linkedin-publishing", offerId: OFFER, salesFunnelCampaignId: "fc-li", salesFunnelId: "f@li" })],
      now,
    );
    expect(deferred.get("li-unit")?.getTime()).toBe(now.getTime() + 10 * 60_000);
  });

  it("gives a FUNDED sales funnel unit its cohort's turn on its funnel's consumed / max budget", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        stated: true, funded: true, fundedBy: "max_budget",
        maxBudget: { amountCents: "1000", period: "weekly", consumedCents: "100", reached: false, consumedUnavailableReason: null },
        maxVolume: null,
        pipes: null,
      }),
    });
    mockFindMany.mockResolvedValue([]);
    const deferred = await planBrandTurns([
      claimed({ id: "unit-2", offerId: OFFER, salesFunnelCampaignId: "funnel-campaign-2", salesFunnelId: "f@y" }),
    ]);
    expect(deferred.has("unit-2")).toBe(false);
  });

  it("HOLDS a unit whose money read throws (fail-CLOSED)", async () => {
    mockUnitMoney.mockRejectedValue(new Error("boom"));
    const now = new Date("2026-08-16T10:00:00Z");
    const deferred = await planBrandTurns([claimed()], now);
    expect(deferred.get("campaign-1")?.getTime()).toBe(now.getTime() + FUNDING_RECHECK_MS);
  });

  it("never RESUMES or CREATES anything because a funnel is funded", async () => {
    fundedUnit("campaign-1", 0, 2000);
    await planBrandTurns([claimed()]);
    expect(mockInsertValues).not.toHaveBeenCalled();
    for (const call of mockUpdateSet.mock.calls) {
      expect(call[0]).not.toHaveProperty("status");
      expect(call[0]).not.toHaveProperty("stopReason");
    }
  });

  it("fires exactly one unit per cohort per tick — the emptiest relative to its max budget", async () => {
    unitVerdicts({ "c-reply": runs(900, 1000), "c-visit": runs(100, 1000) });
    const now = new Date("2026-08-16T10:00:00Z");
    const deferred = await planBrandTurns(
      [claimed({ id: "c-reply" }), claimed({ id: "c-visit", legKey: VISIT_LEG })],
      now,
    );
    expect(deferred.get("c-reply")?.getTime()).toBe(now.getTime() + TURN_DEFER_MS);
    expect(deferred.has("c-visit")).toBe(false);
  });

  it("units of different cohorts each take their own turn", async () => {
    unitVerdicts({ "c-email": runs(900, 1000), "c-ads": runs(100, 1000) });
    aliveBrandCampaigns = [];
    const deferred = await planBrandTurns([
      claimed({ id: "c-email", featureSlug: SALES }),
      claimed({ id: "c-ads", featureSlug: GOOGLE_ADS, legKey: VISIT_LEG }),
    ]);
    expect(deferred.size).toBe(0);
  });

  it("holds the whole cohort while one of its runs is in flight", async () => {
    fundedUnit("campaign-1", 0, 2000);
    mockListRuns.mockResolvedValue({ runs: [{ id: "run-1" }] });
    const now = new Date("2026-08-16T10:00:00Z");
    const deferred = await planBrandTurns([claimed()], now);
    expect(deferred.get("campaign-1")?.getTime()).toBe(now.getTime() + TURN_DEFER_MS);
  });

  it("a live cold-email run does NOT hold a funded Google Ads unit", async () => {
    fundedUnit("c-ads", 0, 1000);
    aliveBrandCampaigns = [{ id: "c-email", featureSlug: SALES, salesFunnelCampaignId: "fc-1" }];
    mockListRuns.mockResolvedValue({ runs: [{ id: "run-1" }] });
    const deferred = await planBrandTurns([
      claimed({ id: "c-ads", featureSlug: GOOGLE_ADS, legKey: VISIT_LEG }),
    ]);
    expect(deferred.has("c-ads")).toBe(false);
  });

  it("re-checks a unit at its max budget on the funding cadence, never only on the day rollover", async () => {
    fundedUnit("campaign-1", 1000, 1000);
    const now = new Date("2026-08-23T14:00:00Z");
    const deferred = await planBrandTurns([claimed()], now);
    expect(deferred.get("campaign-1")?.getTime()).toBe(now.getTime() + FUNDING_RECHECK_MS);
  });
});

describe("hasLiveRunForBrandCohort", () => {
  beforeEach(resetMocks);

  it("asks campaign by campaign, only the brand's sales campaigns and units of THIS cohort", async () => {
    aliveBrandCampaigns = [
      { id: "c-email", featureSlug: SALES, salesFunnelCampaignId: null },
      { id: "c-pr", featureSlug: "pr-media-pitch-v1", salesFunnelCampaignId: null },
      { id: "c-ads", featureSlug: GOOGLE_ADS, salesFunnelCampaignId: "fc-ads" },
      { id: "c-feedback-unit", featureSlug: FEEDBACK, salesFunnelCampaignId: "fc-2" },
    ];
    const live = await hasLiveRunForBrandCohort("org-1", "brand-1", "outbound_cold_email", new Date("2026-10-14T10:00:00Z"));
    expect(live).toBe(false);
    const asked = mockListRuns.mock.calls.map((c) => c[0].campaignId);
    expect(asked).toEqual(["c-email", "c-feedback-unit"]);
    for (const c of mockListRuns.mock.calls) {
      expect(c[0].status).toBe("running");
      expect(c[0].limit).toBe(1);
    }
  });

  it("answers true as soon as one campaign of the cohort has a live run", async () => {
    aliveBrandCampaigns = [{ id: "c-ads", featureSlug: GOOGLE_ADS, salesFunnelCampaignId: "fc-ads" }];
    mockListRuns.mockResolvedValue({ runs: [{ id: "run-1" }] });
    expect(await hasLiveRunForBrandCohort("org-1", "brand-1", "google_ads", new Date())).toBe(true);
  });
});

// A CAMPAIGN THAT IS DELIBERATELY NOT RUNNING MUST SAY SO — from `run_events` alone, a campaign
// correctly parked at its ceiling was indistinguishable from one that had silently died.
describe("planBrandTurns — the hold is stated on the run ledger", () => {
  beforeEach(resetMocks);

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

  it("says WHY a unit parked at its funnel's max budget is not running", async () => {
    fundedUnit("campaign-1", 428, 400);
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

  it("says WHY a unit its funnel funds nothing for is not running", async () => {
    unitVerdicts({ "campaign-1": held("unfunded") });
    const deferred = await planBrandTurns([claimed()], new Date("2026-09-17T05:33:27Z"));
    expect(deferred.size).toBe(1);
    const hold = holdFor("campaign-1");
    expect(hold?.payload.data.reason).toBe("unfunded");
    expect(hold?.payload.level).toBe("info");
  });

  it("says WHY a unit whose caps cannot be read is held, and WARNS — that one is a fault", async () => {
    unitVerdicts({ "campaign-1": held("unreadable") });
    await planBrandTurns([claimed()], new Date("2026-09-17T05:33:27Z"));
    const hold = holdFor("campaign-1");
    expect(hold?.payload.data.reason).toBe("budgets_unreadable");
    expect(hold?.payload.level).toBe("warn");
  });

  it("says a reached cap is a ceiling hold", async () => {
    unitVerdicts({ "campaign-1": held("cap_reached") });
    await planBrandTurns([claimed()], new Date("2026-09-17T05:33:27Z"));
    expect(holdFor("campaign-1")?.payload.data.reason).toBe("daily_ceiling_reached");
  });

  it("stays SILENT for a unit that merely yielded its turn — the brand is visibly working", async () => {
    unitVerdicts({ "c-reply": runs(900, 1000), "c-visit": runs(100, 1000) });
    const now = new Date("2026-09-17T05:33:27Z");
    const deferred = await planBrandTurns(
      [claimed({ id: "c-reply" }), claimed({ id: "c-visit", legKey: VISIT_LEG })],
      now,
    );
    expect(deferred.get("c-reply")?.getTime()).toBe(now.getTime() + TURN_DEFER_MS);
    expect(mockTraceEvent).not.toHaveBeenCalled();
  });

  it("stays SILENT while a run of the cohort is in flight", async () => {
    fundedUnit("campaign-1", 0, 2000);
    mockListRuns.mockResolvedValue({ runs: [{ id: "run-1" }] });
    await planBrandTurns([claimed()], new Date("2026-09-17T05:33:27Z"));
    expect(mockTraceEvent).not.toHaveBeenCalled();
  });

  it("never invents a run id for a campaign that has no ancestor run", async () => {
    unitVerdicts({ "campaign-1": held("unfunded") });
    const said = captureWarnings();
    await planBrandTurns([claimed({ parentRunId: null })], new Date("2026-09-17T05:33:27Z"));
    expect(mockTraceEvent).not.toHaveBeenCalled();
    expect(said()).toContain("no ancestor run");
  });

  it("a hold that cannot be reported never changes whether a campaign runs", async () => {
    fundedUnit("campaign-1", 428, 400);
    mockTraceEvent.mockRejectedValue(new Error("runs-service unreachable"));
    await expect(
      planBrandTurns([claimed()], new Date("2026-09-17T05:33:27Z")),
    ).resolves.toBeInstanceOf(Map);
  });
});
