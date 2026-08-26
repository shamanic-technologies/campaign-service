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
  funnelCampaignName,
  FUNNEL_TURN_DEFER_MS,
  FUNDING_RECHECK_MS,
  type ClaimedFunnelCampaign,
} from "../../src/lib/funnel-campaigns.js";

const SALES = "sales-cold-email-outreach";
const FEEDBACK = "feedback-request-cold-email-outreach";
const GOOGLE_ADS = "google-ads";
const ANCESTOR_RUN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
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
    }),
  });
}

// brand-service has retired the goal set: a declared funnel carries its KEY and nothing that
// names a goal. This mock emits exactly that shape, so a re-introduced goal read would fail here.
function mockDeclaredFunnels(funnels: Array<{ funnelKey: string; active?: boolean }>) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      funnels: funnels.map(f => ({
        funnelKey: f.funnelKey,
        active: f.active ?? true,
        name: f.funnelKey,
        steps: [],
        rates: {},
        lifetimeRevenueUsd: null,
        destinationUrl: null,
        bookingUrl: null,
        updatedAt: "2026-08-02T00:00:00.000Z",
      })),
    }),
  });
}

/** Run something and return everything it said on console.warn, joined. */
async function captureWarnings(run: () => Promise<unknown>): Promise<string> {
  const said: string[] = [];
  const warn = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    said.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(" "));
  });
  try {
    await run();
  } finally {
    warn.mockRestore();
  }
  return said.join("\n");
}

function mockSpend(cents: string) {
  mockGetStatsBudget.mockResolvedValueOnce({
    windows: [{ label: "today", totalCostInUsdCents: cents, netTotalCostInUsdCents: cents }],
  });
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

describe("planFunnelTurns", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.BILLING_SERVICE_URL = "https://billing.test.local";
    process.env.BILLING_SERVICE_API_KEY = "billing-key";
    process.env.BRAND_SERVICE_URL = "https://brand.test.local";
    process.env.BRAND_SERVICE_API_KEY = "brand-key";
    process.env.FEATURES_SERVICE_URL = "https://features.test.local";
    process.env.FEATURES_SERVICE_API_KEY = "features-key";
    process.env.WORKFLOW_SERVICE_URL = "https://workflow.test.local";
    process.env.WORKFLOW_SERVICE_API_KEY = "workflow-key";
    // The reads that are ASKED PER CHANNEL rather than per brand: which funnels a channel may be
    // sold through (features-service) and which workflow can run it (workflow-service). Answered by
    // URL rather than by queue position, so every ordered `mockResolvedValueOnce` below — which
    // takes precedence — keeps describing the billing/brand sequence it always did.
    mockFetch.mockImplementation(async (input: URL | string) => {
      const url = String(input);
      if (url.includes("/features/")) {
        return { ok: true, json: async () => ({ feature: { slug: new URL(url).pathname.split("/features/")[1], salesFunnels: [...SALES_FUNNEL_KEYS] } }) };
      }
      if (url.includes("/workflows")) {
        return {
          ok: true,
          json: async () => ({
            workflows: [{ workflowSlug: `${new URL(url).searchParams.get("featureSlug")}-seed`, createdAt: "2026-08-18T00:00:00.000Z" }],
          }),
        };
      }
      throw new Error(`unexpected fetch in test: ${url}`);
    });
    mockListRuns.mockResolvedValue({ runs: [] });
    mockFindFirst.mockResolvedValue({ id: "existing", name: "custom name", status: "ongoing" });
    // The only findMany left is the sales-scoped liveness check ({ id, featureSlug }). Default the
    // brand to ONE alive sales campaign so that read is genuinely exercised (with no live run)
    // rather than short-circuited.
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
    const deferred = await planFunnelTurns([claimed()]);
    expect(deferred.size).toBe(0);
  });

  it("HOLDS a brand that funds nothing — no funnel ceiling and no pot", async () => {
    mockFunnelBudgets([], null);
    const now = new Date("2026-08-16T10:00:00Z");
    const deferred = await planFunnelTurns([claimed()], now);
    expect(deferred.get("campaign-1")?.getTime()).toBe(now.getTime() + FUNDING_RECHECK_MS);
  });

  it("HOLDS a brand whose every funnel is funded at zero", async () => {
    mockFunnelBudgets([{ funnelKey: "reply_meeting", dailyBudgetCents: "0" }], "0");
    const now = new Date("2026-08-16T10:00:00Z");
    const deferred = await planFunnelTurns(
      [claimed({ funnelKey: "sales_meetings_from_conversation" })],
      now,
    );
    expect(deferred.get("campaign-1")?.getTime()).toBe(now.getTime() + FUNDING_RECHECK_MS);
  });

  it("funding ONE funnel releases that funnel's campaign with no other step", async () => {
    mockFunnelBudgets([{ funnelKey: "reply_meeting", dailyBudgetCents: "2000" }]);
    mockDeclaredFunnels([{ funnelKey: "sales_meetings_from_conversation" }]);
    mockFindFirst.mockResolvedValue({ id: "campaign-1", name: "x", status: "ongoing", stopReason: null });
    mockSpend("0");

    const deferred = await planFunnelTurns([claimed({ funnelKey: "sales_meetings_from_conversation" })]);
    expect(deferred.size).toBe(0);
  });

  it("HOLDS the brand when the ceilings cannot be read (fail-CLOSED)", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });
    const now = new Date("2026-08-16T10:00:00Z");
    const deferred = await planFunnelTurns([claimed()], now);
    // The gate refuses to spend on the same unreadable ceiling, so firing would only burn a run.
    expect(deferred.get("campaign-1")?.getTime()).toBe(now.getTime() + FUNDING_RECHECK_MS);
  });

  it("gives every funded funnel its own campaign", async () => {
    mockFunnelBudgets([
      { funnelKey: "visit_signup", dailyBudgetCents: "1000" },
      { funnelKey: "reply_meeting", dailyBudgetCents: "2000" },
    ]);
    mockDeclaredFunnels([
      { funnelKey: "website_purchases" },
      { funnelKey: "sales_meetings_from_conversation" },
    ]);
    mockFindFirst.mockResolvedValue(undefined); // neither funnel has a campaign yet

    await planFunnelTurns([claimed()]);

    expect(mockInsertValues).toHaveBeenCalledTimes(2);
    const inserted = mockInsertValues.mock.calls.map(c => c[0]);
    expect(inserted.map(v => v.funnelKey).sort()).toEqual(["sales_meetings_from_conversation", "website_purchases"]);
    // The campaign STATES its funnel in the canonical vocabulary even though billing named those
    // same two funnels the pre-rename way — and states NOTHING ELSE about what it sells: the goal
    // is not written any more, because it cannot tell the two meeting funnels apart.
    for (const values of inserted) expect(values.goal).toBeUndefined();
    expect(inserted[0].name).toBe(funnelCampaignName(SALES, "brand-1", inserted[0].funnelKey));
  });

  it("gives a funnel funded through TWO channels one campaign per channel", async () => {
    mockFunnelBudgets(
      [{ funnelKey: "reply_meeting", dailyBudgetCents: "3000" }],
      "3000",
      [
        { funnelKey: "reply_meeting", featureSlug: SALES, dailyBudgetCents: "2000" },
        { funnelKey: "reply_meeting", featureSlug: FEEDBACK, dailyBudgetCents: "1000" },
      ],
    );
    mockDeclaredFunnels([{ funnelKey: "sales_meetings_from_conversation" }]);
    mockFindFirst.mockResolvedValue(undefined);

    await planFunnelTurns([claimed({ funnelKey: "sales_meetings_from_conversation" })]);

    const inserted = mockInsertValues.mock.calls.map(c => c[0]);
    expect(inserted).toHaveLength(2);
    // One campaign per PAIR: each states the same funnel and its OWN channel, so neither can be
    // mistaken for the other and each is paced on the ceiling that binds it.
    expect(inserted.map(v => v.featureSlug).sort()).toEqual([SALES, FEEDBACK].sort());
    for (const values of inserted) {
      expect(values.funnelKey).toBe("sales_meetings_from_conversation");
      expect(values.name).toBe(funnelCampaignName(values.featureSlug, "brand-1", values.funnelKey));
    }
    // The second channel runs its OWN feature's workflow — never the seed campaign's, which
    // belongs to another offer and which workflow-service would refuse for this feature.
    const feedback = inserted.find(v => v.featureSlug === FEEDBACK)!;
    expect(feedback.workflowSlug).toBe(`${FEEDBACK}-seed`);
  });

  it("never provisions a pair the channel may not be sold through", async () => {
    mockFunnelBudgets(
      [{ funnelKey: "visit_signup", dailyBudgetCents: "1000" }],
      "1000",
      [{ funnelKey: "visit_signup", featureSlug: FEEDBACK, dailyBudgetCents: "1000" }],
    );
    mockDeclaredFunnels([{ funnelKey: "website_purchases" }]);
    mockFindFirst.mockResolvedValue(undefined);
    // features-service states the feedback request sells the CONVERSATION chain alone: it buys a
    // conversation and has no website step to sell.
    mockFetch.mockImplementationOnce(async () => ({
      ok: true,
      json: async () => ({ feature: { slug: FEEDBACK, salesFunnels: ["sales_meetings_from_conversation"] } }),
    }));

    await planFunnelTurns([claimed({ funnelKey: "website_purchases" })]);

    expect(mockInsertValues).not.toHaveBeenCalled();
  });

  it("states a FULL identity on both channel reads — the run id included, and it resolves", async () => {
    // The whole feature was dead in production on exactly this: the provisioning identity was
    // built from a campaign row, so it carried no run, and both services rejected it outright
    // (`400 Missing required headers: x-run-id` / `400 x-org-id, x-user-id, and x-run-id headers
    // are required`). Both rejections became "unknown" and the pair was skipped, silently.
    mockFunnelBudgets(
      [{ funnelKey: "reply_meeting", dailyBudgetCents: "2000" }],
      "2000",
      [{ funnelKey: "reply_meeting", featureSlug: FEEDBACK, dailyBudgetCents: "2000" }],
    );
    mockDeclaredFunnels([{ funnelKey: "sales_meetings_from_conversation" }]);
    mockFindFirst.mockResolvedValue(undefined);

    await planFunnelTurns([claimed({ funnelKey: "sales_meetings_from_conversation" })]);

    const reads = mockFetch.mock.calls.filter(
      (c) => String(c[0]).includes("/features/") || String(c[0]).includes("/workflows"),
    );
    expect(reads.length).toBeGreaterThanOrEqual(2);
    for (const [, init] of reads) {
      const headers = (init as { headers: Record<string, string> }).headers;
      expect(headers["x-org-id"]).toBe("org-1");
      expect(headers["x-user-id"]).toBe("user-1");
      // Well-formed enough for the downstream to accept, and a run runs-service can resolve —
      // never a minted uuid (see trigger-run.ts / no-legacy).
      expect(headers["x-run-id"]).toBe(ANCESTOR_RUN_ID);
      expect(headers["x-run-id"]).toMatch(UUID_RE);
    }
  });

  it("anchors a campaign that has no ancestor run BEFORE asking, and reuses that run", async () => {
    const minted = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    mockCreateRun.mockResolvedValue({ id: minted });
    mockFunnelBudgets(
      [{ funnelKey: "reply_meeting", dailyBudgetCents: "2000" }],
      "2000",
      [{ funnelKey: "reply_meeting", featureSlug: FEEDBACK, dailyBudgetCents: "2000" }],
    );
    mockDeclaredFunnels([{ funnelKey: "sales_meetings_from_conversation" }]);
    mockFindFirst.mockResolvedValue(undefined);

    await planFunnelTurns([
      claimed({ funnelKey: "sales_meetings_from_conversation", parentRunId: null }),
    ]);

    // Created once and PERSISTED on the campaign, so the next sweep takes the same branch as a
    // campaign born with one.
    expect(mockCreateRun).toHaveBeenCalledTimes(1);
    expect(mockUpdateSet).toHaveBeenCalledWith(expect.objectContaining({ parentRunId: minted }));
    const featureRead = mockFetch.mock.calls.find((c) => String(c[0]).includes("/features/"))!;
    expect((featureRead[1] as { headers: Record<string, string> }).headers["x-run-id"]).toBe(minted);
  });

  it("provisions nothing for a channel whose funnel statement cannot be read", async () => {
    mockFunnelBudgets(
      [{ funnelKey: "reply_meeting", dailyBudgetCents: "2000" }],
      "2000",
      [{ funnelKey: "reply_meeting", featureSlug: FEEDBACK, dailyBudgetCents: "2000" }],
    );
    mockDeclaredFunnels([{ funnelKey: "sales_meetings_from_conversation" }]);
    mockFindFirst.mockResolvedValue(undefined);
    mockFetch.mockImplementationOnce(async () => ({ ok: false, status: 500, json: async () => ({}) }));

    const said = await captureWarnings(() =>
      planFunnelTurns([claimed({ funnelKey: "sales_meetings_from_conversation" })]),
    );

    // A pair is never guessed at — the same stance an unreadable brand declaration takes.
    expect(mockInsertValues).not.toHaveBeenCalled();
    // ...and it is never passed over in SILENCE. The customer's money is on this pair and we
    // failed to evaluate it, which is a different thing from evaluating it and saying no.
    expect(said).toMatch(/could not READ features-service/);
    expect(said).toContain(FEEDBACK);
    expect(said).toContain("sales_meetings_from_conversation");
    expect(said).toContain("brand-1");
  });

  it("says which funded pair it passed over when workflow-service will not answer", async () => {
    mockFunnelBudgets(
      [{ funnelKey: "reply_meeting", dailyBudgetCents: "2000" }],
      "2000",
      [{ funnelKey: "reply_meeting", featureSlug: FEEDBACK, dailyBudgetCents: "2000" }],
    );
    mockDeclaredFunnels([{ funnelKey: "sales_meetings_from_conversation" }]);
    mockFindFirst.mockResolvedValue(undefined);
    mockFetch.mockImplementation(async (input: URL | string) => {
      const url = String(input);
      if (url.includes("/features/")) {
        return { ok: true, json: async () => ({ feature: { slug: new URL(url).pathname.split("/features/")[1], salesFunnels: [...SALES_FUNNEL_KEYS] } }) };
      }
      // A REJECTION, not an empty catalogue. Collapsing the two is how a read that was refused on
      // every sweep looked exactly like a channel with no dynasty.
      return { ok: false, status: 400, text: async () => "x-run-id header required" };
    });

    const said = await captureWarnings(() =>
      planFunnelTurns([claimed({ funnelKey: "sales_meetings_from_conversation" })]),
    );

    expect(mockInsertValues).not.toHaveBeenCalled();
    expect(said).toMatch(/could not READ workflow-service/);
    expect(said).toContain(FEEDBACK);
    expect(said).toContain("sales_meetings_from_conversation");
    expect(said).toContain("400");
  });

  it("provisions nothing for a channel with no active workflow to run it", async () => {
    mockFunnelBudgets(
      [{ funnelKey: "reply_meeting", dailyBudgetCents: "2000" }],
      "2000",
      [{ funnelKey: "reply_meeting", featureSlug: FEEDBACK, dailyBudgetCents: "2000" }],
    );
    mockDeclaredFunnels([{ funnelKey: "sales_meetings_from_conversation" }]);
    mockFindFirst.mockResolvedValue(undefined);
    mockFetch.mockImplementation(async (input: URL | string) => {
      const url = String(input);
      if (url.includes("/features/")) {
        return { ok: true, json: async () => ({ feature: { slug: new URL(url).pathname.split("/features/")[1], salesFunnels: [...SALES_FUNNEL_KEYS] } }) };
      }
      return { ok: true, json: async () => ({ workflows: [] }) };
    });

    await planFunnelTurns([claimed({ funnelKey: "sales_meetings_from_conversation" })]);

    // A campaign with no DAG to run would sit ongoing and produce nothing forever.
    expect(mockInsertValues).not.toHaveBeenCalled();
  });

  it("paces each channel on its OWN ceiling, so one cannot consume the other's money", async () => {
    // Both campaigns work the same funnel; the sales pitch has already spent its whole $20 while
    // the feedback request has spent nothing of its $10. Ranked on the FUNNEL total ($30) the
    // spent-out one would still look 66% empty and keep taking turns.
    mockFunnelBudgets(
      [{ funnelKey: "reply_meeting", dailyBudgetCents: "3000" }],
      "3000",
      [
        { funnelKey: "reply_meeting", featureSlug: SALES, dailyBudgetCents: "2000" },
        { funnelKey: "reply_meeting", featureSlug: FEEDBACK, dailyBudgetCents: "1000" },
      ],
    );
    mockDeclaredFunnels([{ funnelKey: "sales_meetings_from_conversation" }]);
    mockFindFirst.mockResolvedValue({ id: "existing", name: "x", status: "ongoing", stopReason: null });
    mockSpend("2000"); // the sales pitch, at its own ceiling
    mockSpend("0");    // the feedback request, untouched

    aliveBrandCampaigns = [
      { id: "c-sales", featureSlug: SALES },
      { id: "c-feedback", featureSlug: FEEDBACK },
    ];
    const now = new Date("2026-08-18T10:00:00Z");
    const deferred = await planFunnelTurns(
      [
        claimed({ id: "c-sales", funnelKey: "sales_meetings_from_conversation", featureSlug: SALES }),
        claimed({ id: "c-feedback", funnelKey: "sales_meetings_from_conversation", featureSlug: FEEDBACK }),
      ],
      now,
    );

    // The full channel yields; the empty one takes the turn.
    expect(deferred.has("c-feedback")).toBe(false);
    expect(deferred.get("c-sales")).toBeDefined();
  });

  it("HOLDS a campaign whose funnel is funded through OTHER channels only", async () => {
    mockFunnelBudgets(
      [{ funnelKey: "reply_meeting", dailyBudgetCents: "3000" }],
      "3000",
      [
        { funnelKey: "reply_meeting", featureSlug: SALES, dailyBudgetCents: "2000" },
        { funnelKey: "reply_meeting", featureSlug: "sales-crm-email-outreach", dailyBudgetCents: "1000" },
      ],
    );
    mockDeclaredFunnels([{ funnelKey: "sales_meetings_from_conversation" }]);
    mockFindFirst.mockResolvedValue({ id: "existing", name: "x", status: "ongoing", stopReason: null });
    mockSpend("0");
    mockSpend("0");

    aliveBrandCampaigns = [{ id: "c-sales", featureSlug: SALES }];
    const now = new Date("2026-08-18T10:00:00Z");
    const deferred = await planFunnelTurns(
      [
        claimed({ id: "c-sales", funnelKey: "sales_meetings_from_conversation", featureSlug: SALES }),
        claimed({ id: "c-crm", funnelKey: "sales_meetings_from_conversation", featureSlug: "sales-crm-email-outreach" }),
        claimed({ id: "c-feedback", funnelKey: "sales_meetings_from_conversation", featureSlug: FEEDBACK }),
      ],
      now,
    );

    // The funnel is SPLIT across two channels and neither is the feedback request's: falling back
    // to the funnel total would be spending the other two offers' money. It waits for money, not
    // for a turn, so it is re-checked on the funding cadence.
    expect(deferred.get("c-feedback")?.getTime()).toBe(now.getTime() + FUNDING_RECHECK_MS);
    // The two funded channels are in the running as usual — one takes the turn, the other waits it.
    expect(deferred.get("c-sales")?.getTime() ?? now.getTime() + FUNNEL_TURN_DEFER_MS)
      .toBe(now.getTime() + FUNNEL_TURN_DEFER_MS);
  });

  it("a funnel funded through exactly ONE channel binds whatever feature the campaign states", async () => {
    // billing's migration attributed some brands' single ceiling to the DEFAULT channel while their
    // campaign runs another sales feature. Holding those would be a regression on a brand that has
    // funded one channel per funnel all along, which is every brand today.
    mockFunnelBudgets(
      [{ funnelKey: "reply_meeting", dailyBudgetCents: "2000" }],
      "2000",
      [{ funnelKey: "reply_meeting", featureSlug: SALES, dailyBudgetCents: "2000" }],
    );
    mockDeclaredFunnels([{ funnelKey: "sales_meetings_from_conversation" }]);
    mockFindFirst.mockResolvedValue({ id: "existing", name: "x", status: "ongoing", stopReason: null });
    mockSpend("0");

    aliveBrandCampaigns = [{ id: "c-crm", featureSlug: "sales-crm-email-outreach" }];
    const deferred = await planFunnelTurns([
      claimed({
        id: "c-crm",
        funnelKey: "sales_meetings_from_conversation",
        featureSlug: "sales-crm-email-outreach",
      }),
    ]);

    expect(deferred.size).toBe(0);
  });

  it("never provisions a funnel billing funds but brand-service does not declare active", async () => {
    mockFunnelBudgets([
      { funnelKey: "visit_signup", dailyBudgetCents: "1000" },
      { funnelKey: "visit_form", dailyBudgetCents: "500" },
    ]);
    mockDeclaredFunnels([
      { funnelKey: "website_purchases" },
      { funnelKey: "form_magnet", active: false },
    ]);
    mockFindFirst.mockResolvedValue(undefined);

    await planFunnelTurns([claimed()]);

    expect(mockInsertValues).toHaveBeenCalledTimes(1);
    expect(mockInsertValues.mock.calls[0][0].funnelKey).toBe("website_purchases");
  });

  it("ranks a campaign row still on a pre-rename key on its funnel's real ceiling", async () => {
    // The row has not met migration 0043 yet — or a replica is mid-deploy. It must still find its
    // own ceiling: reading it as unfunded would give it a zero ceiling, drop it out of the running
    // and starve the funnel it was provisioned for, silently.
    mockFunnelBudgets([
      { funnelKey: "visit_signup", dailyBudgetCents: "1000" },
      { funnelKey: "reply_meeting", dailyBudgetCents: "1000" },
    ]);
    mockDeclaredFunnels([
      { funnelKey: "website_purchases" },
      { funnelKey: "sales_meetings_from_conversation" },
    ]);
    mockSpend("900"); // c-canonical is 90% full
    mockSpend("100"); // c-preRename is 10% full — it must be allowed to win on that

    const now = new Date("2026-08-02T10:00:00Z");
    const deferred = await planFunnelTurns(
      [
        claimed({ id: "c-canonical", funnelKey: "website_purchases" }),
        claimed({ id: "c-preRename", funnelKey: "reply_meeting" }),
      ],
      now,
    );

    expect(deferred.has("c-preRename")).toBe(false); // takes the turn on its own ceiling
    expect(deferred.get("c-canonical")?.getTime()).toBe(now.getTime() + FUNNEL_TURN_DEFER_MS);
  });

  it("holds the whole brand while a SALES run is in flight — one run per brand", async () => {
    aliveBrandCampaigns = [
      { id: "c-visit", featureSlug: SALES },
      { id: "c-reply", featureSlug: SALES },
    ];
    mockFunnelBudgets([
      { funnelKey: "visit_signup", dailyBudgetCents: "1000" },
      { funnelKey: "reply_meeting", dailyBudgetCents: "2000" },
    ]);
    mockDeclaredFunnels([
      { funnelKey: "website_purchases" },
      { funnelKey: "sales_meetings_from_conversation" },
    ]);
    mockListRuns.mockResolvedValue({ runs: [{ id: "live" }] });

    const now = new Date("2026-08-02T10:00:00Z");
    const deferred = await planFunnelTurns(
      [
        claimed({ id: "c-visit", funnelKey: "website_purchases" }),
        claimed({ id: "c-reply", funnelKey: "sales_meetings_from_conversation" }),
      ],
      now,
    );

    expect(deferred.get("c-visit")?.getTime()).toBe(now.getTime() + FUNNEL_TURN_DEFER_MS);
    expect(deferred.get("c-reply")?.getTime()).toBe(now.getTime() + FUNNEL_TURN_DEFER_MS);
    // Asked of the brand's SALES campaigns, one at a time — never brand-wide, which would also
    // count the brand's PR / AI-visibility / hiring / VC runs and hold sales forever.
    expect(mockListRuns).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-1", campaignId: "c-visit", status: "running" }),
    );
    expect(mockListRuns).not.toHaveBeenCalledWith(
      expect.objectContaining({ brandId: "brand-1" }),
    );
  });

  it("a brand's PR run never holds its sales outreach — the liveness check skips other features", async () => {
    // Prod, brand f4d73dab (2026-08-02): PR outreach ticks continuously, so a brand-wide liveness
    // read always saw a live run and every sales campaign was deferred 60s, every tick, forever.
    aliveBrandCampaigns = [
      { id: "c-pr", featureSlug: "pr-expert-quote-outreach" },
      { id: "c-visit", featureSlug: SALES },
    ];
    mockListRuns.mockImplementation(async ({ campaignId }: { campaignId?: string }) =>
      campaignId === "c-pr" ? { runs: [{ id: "live-pr" }] } : { runs: [] },
    );
    mockFunnelBudgets([{ funnelKey: "visit_signup", dailyBudgetCents: "1000" }]);
    mockDeclaredFunnels([{ funnelKey: "website_purchases" }]);
    mockSpend("0");

    const now = new Date("2026-08-02T10:00:00Z");
    const deferred = await planFunnelTurns(
      [claimed({ id: "c-visit", funnelKey: "website_purchases" })],
      now,
    );

    expect(deferred.has("c-visit")).toBe(false); // takes its turn — the PR run is not its business
    expect(mockListRuns).not.toHaveBeenCalledWith(
      expect.objectContaining({ campaignId: "c-pr" }),
    );
  });

  it("fires exactly one funnel per tick — the emptiest relative to its ceiling", async () => {
    mockFunnelBudgets([
      { funnelKey: "visit_signup", dailyBudgetCents: "1000" },
      { funnelKey: "reply_meeting", dailyBudgetCents: "1000" },
    ]);
    mockDeclaredFunnels([
      { funnelKey: "website_purchases" },
      { funnelKey: "sales_meetings_from_conversation" },
    ]);
    mockSpend("900"); // c-visit is 90% full
    mockSpend("100"); // c-reply is 10% full

    const now = new Date("2026-08-02T10:00:00Z");
    const deferred = await planFunnelTurns(
      [
        claimed({ id: "c-visit", funnelKey: "website_purchases" }),
        claimed({ id: "c-reply", funnelKey: "sales_meetings_from_conversation" }),
      ],
      now,
    );

    expect(deferred.has("c-reply")).toBe(false); // takes the turn
    expect(deferred.get("c-visit")?.getTime()).toBe(now.getTime() + FUNNEL_TURN_DEFER_MS);
  });

  it("parks every funnel until the ceilings reset when all are full", async () => {
    mockFunnelBudgets([
      { funnelKey: "visit_signup", dailyBudgetCents: "1000" },
      { funnelKey: "reply_meeting", dailyBudgetCents: "1000" },
    ]);
    mockDeclaredFunnels([
      { funnelKey: "website_purchases" },
      { funnelKey: "sales_meetings_from_conversation" },
    ]);
    mockSpend("1000");
    mockSpend("1200");

    const now = new Date("2026-08-02T10:00:00Z");
    const deferred = await planFunnelTurns(
      [
        claimed({ id: "c-visit", funnelKey: "website_purchases" }),
        claimed({ id: "c-reply", funnelKey: "sales_meetings_from_conversation" }),
      ],
      now,
    );

    expect(deferred.size).toBe(2);
    for (const at of deferred.values()) expect(at.getTime()).toBeGreaterThan(now.getTime());
  });

  it("provisions for a funded funnel even when a campaign of the brand states none", async () => {
    // The rule this replaces held a brand's provisioning back while ANY campaign of it could not
    // be attributed to a funnel — so a customer funded a funnel and never got a campaign for it
    // (prod, 2026-08-12: 2 of 18 live campaigns). Nothing can be unattributable now: every sales
    // campaign states its funnel from birth, so a funded funnel always gets its campaign.
    mockFunnelBudgets([{ funnelKey: "reply_meeting", dailyBudgetCents: "3000" }]);
    mockDeclaredFunnels([{ funnelKey: "sales_meetings_from_conversation" }]);
    mockFindFirst.mockResolvedValue(undefined); // the funnel has no campaign yet
    mockSpend("0");

    await planFunnelTurns([claimed({ id: "c-no-funnel", funnelKey: null })], new Date("2026-08-12T10:00:00Z"));

    expect(mockInsertValues).toHaveBeenCalledTimes(1);
    expect(mockInsertValues.mock.calls[0][0].funnelKey).toBe("sales_meetings_from_conversation");
    // Nothing is deleted and no campaign is re-labelled: provisioning adds, it never rewrites.
    expect(mockDeleteWhere).not.toHaveBeenCalled();
    expect(mockUpdateSet).not.toHaveBeenCalled();
  });

  it("holds no campaign out of the running — one that states no funnel still takes turns", async () => {
    mockFunnelBudgets([{ funnelKey: "visit_signup", dailyBudgetCents: "1000" }]);
    mockDeclaredFunnels([{ funnelKey: "website_purchases" }]);
    mockFindFirst.mockResolvedValue({ id: "c-visit", name: "x", status: "ongoing" });
    mockSpend("900"); // c-legacy: 90% of the brand total
    mockSpend("100"); // c-visit: 10% of its own ceiling

    const now = new Date("2026-08-02T10:00:00Z");
    const deferred = await planFunnelTurns(
      [
        claimed({ id: "c-legacy", funnelKey: null }),
        claimed({ id: "c-visit", funnelKey: "website_purchases" }),
      ],
      now,
    );

    // The emptiest relative to its OWN ceiling takes the turn; the other waits ONE minute and is
    // re-ranked from scratch next tick. Nothing is parked because another campaign exists.
    expect(deferred.has("c-visit")).toBe(false);
    expect(deferred.get("c-legacy")?.getTime()).toBe(now.getTime() + FUNNEL_TURN_DEFER_MS);
  });

  it("a campaign that states no funnel can win the turn", async () => {
    mockFunnelBudgets([{ funnelKey: "visit_signup", dailyBudgetCents: "1000" }]);
    mockDeclaredFunnels([{ funnelKey: "website_purchases" }]);
    mockFindFirst.mockResolvedValue({ id: "c-visit", name: "x", status: "ongoing" });
    mockSpend("0");   // c-legacy: nothing spent
    mockSpend("900"); // c-visit: 90% full

    const now = new Date("2026-08-02T10:00:00Z");
    const deferred = await planFunnelTurns(
      [
        claimed({ id: "c-legacy", funnelKey: null }),
        claimed({ id: "c-visit", funnelKey: "website_purchases" }),
      ],
      now,
    );

    expect(deferred.has("c-legacy")).toBe(false);
    expect(deferred.get("c-visit")?.getTime()).toBe(now.getTime() + FUNNEL_TURN_DEFER_MS);
  });

  it("re-checks a campaign on an unfunded funnel every tick, never parks it for the day", async () => {
    mockFunnelBudgets([{ funnelKey: "visit_signup", dailyBudgetCents: "1000" }]);
    mockDeclaredFunnels([{ funnelKey: "website_purchases" }]);
    mockFindFirst.mockResolvedValue({ id: "c-visit", name: "x", status: "ongoing" });
    // Only the FUNDED campaign is ever asked what it spent — the unfunded one is out of the
    // running before the question arises, so a second queued answer here would be a stale mock
    // spilling into the next test.
    mockSpend("1200"); // the funded funnel is over its ceiling

    const now = new Date("2026-08-02T10:00:00Z");
    const deferred = await planFunnelTurns(
      [
        claimed({ id: "c-visit", funnelKey: "website_purchases" }),
        claimed({ id: "c-unfunded", funnelKey: "sales_meetings_from_conversation" }),
      ],
      now,
    );

    // The funded-but-full one waits on the funding cadence, not on its turn; the unfunded one is
    // not waiting its TURN at all either, it is waiting for money — same cadence, same reason.
    expect(deferred.get("c-visit")!.getTime()).toBeGreaterThan(now.getTime() + FUNNEL_TURN_DEFER_MS);
    expect(deferred.get("c-unfunded")?.getTime()).toBe(now.getTime() + FUNDING_RECHECK_MS);
  });

  it("re-checks a brand whose every funded pair is at its ceiling on the funding cadence, not at the day rollover", async () => {
    mockFunnelBudgets([
      { funnelKey: "reply_meeting", dailyBudgetCents: "4000" },
      { funnelKey: "visit_signup", dailyBudgetCents: "1000" },
    ]);
    mockDeclaredFunnels([
      { funnelKey: "sales_meetings_from_conversation" },
      { funnelKey: "website_purchases" },
    ]);
    mockFindFirst.mockResolvedValue({ id: "existing", name: "x", status: "ongoing" });
    mockSpend("4000"); // c-reply: exactly at its ceiling
    mockSpend("1200"); // c-visit: over its ceiling

    const now = new Date("2026-08-23T16:24:00Z");
    const deferred = await planFunnelTurns(
      [
        claimed({ id: "c-reply", funnelKey: "sales_meetings_from_conversation" }),
        claimed({ id: "c-visit", funnelKey: "website_purchases" }),
      ],
      now,
    );

    // Nothing runs — but the money that re-opens them can arrive at any hour, so the wake-up is
    // bounded by the funding cadence. Parking on the day rollover is what left a raised ceiling
    // unspent until midnight UTC.
    expect(deferred.get("c-reply")?.getTime()).toBe(now.getTime() + FUNDING_RECHECK_MS);
    expect(deferred.get("c-visit")?.getTime()).toBe(now.getTime() + FUNDING_RECHECK_MS);
  });

  it("never defers past the day rollover when the rollover is nearer than the funding cadence", async () => {
    mockFunnelBudgets([{ funnelKey: "reply_meeting", dailyBudgetCents: "4000" }]);
    mockDeclaredFunnels([{ funnelKey: "sales_meetings_from_conversation" }]);
    mockFindFirst.mockResolvedValue({ id: "existing", name: "x", status: "ongoing" });
    mockSpend("4000");

    // Three minutes to midnight (local, which is what the day-rollover helper works in).
    const now = new Date();
    now.setHours(23, 57, 0, 0);
    const deferred = await planFunnelTurns(
      [claimed({ id: "c-reply", funnelKey: "sales_meetings_from_conversation" })],
      now,
    );

    const rollover = new Date(now.getTime());
    rollover.setDate(rollover.getDate() + 1);
    rollover.setHours(0, 0, 0, 0);
    expect(deferred.get("c-reply")?.getTime()).toBe(rollover.getTime());
  });

  it("leaves the non-exhausted paths alone: the winner fires and the loser waits its turn", async () => {
    mockFunnelBudgets([
      { funnelKey: "reply_meeting", dailyBudgetCents: "4000" },
      { funnelKey: "visit_signup", dailyBudgetCents: "1000" },
    ]);
    mockDeclaredFunnels([
      { funnelKey: "sales_meetings_from_conversation" },
      { funnelKey: "website_purchases" },
    ]);
    mockFindFirst.mockResolvedValue({ id: "existing", name: "x", status: "ongoing" });
    mockSpend("2000"); // c-reply: 50% full
    mockSpend("900");  // c-visit: 90% full

    const now = new Date("2026-08-23T16:24:00Z");
    const deferred = await planFunnelTurns(
      [
        claimed({ id: "c-reply", funnelKey: "sales_meetings_from_conversation" }),
        claimed({ id: "c-visit", funnelKey: "website_purchases" }),
      ],
      now,
    );

    expect(deferred.has("c-reply")).toBe(false);
    expect(deferred.get("c-visit")?.getTime()).toBe(now.getTime() + FUNNEL_TURN_DEFER_MS);
  });
  // ── Google Ads: the first PAID-REACH channel ──────────────────────────────────────────────────
  // A channel is a feature slug, so nothing here is special-cased: the funded pair is provisioned,
  // scheduled and paced by the same rules. What IS different is what it shares with a cold-email
  // campaign — no leads, no mailboxes — so neither holds the other back.

  it("gives a funded (funnel, google-ads) pair its own campaign, on that channel's own workflow", async () => {
    mockFunnelBudgets(
      [{ funnelKey: "visit_signup", dailyBudgetCents: "1000" }],
      "1000",
      [{ funnelKey: "visit_signup", featureSlug: GOOGLE_ADS, dailyBudgetCents: "1000" }],
    );
    mockDeclaredFunnels([{ funnelKey: "website_purchases" }]);
    mockFindFirst.mockResolvedValue(undefined); // the pair has no campaign yet

    await planFunnelTurns([claimed({ funnelKey: "sales_meetings_from_conversation" })]);

    expect(mockInsertValues).toHaveBeenCalledTimes(1);
    const inserted = mockInsertValues.mock.calls[0][0];
    expect(inserted.featureSlug).toBe(GOOGLE_ADS);
    expect(inserted.funnelKey).toBe("website_purchases");
    // The identity is (org, brand, funnel, CHANNEL) — a paid-reach campaign holds its own, so a
    // brand may work one funnel through an ad and a cold email at the same time.
    expect(inserted.acquisitionChannel).toBe("google_ads");
    // A workflow belongs to a FEATURE: the seed's cold-email slug would run the wrong DAG.
    expect(inserted.workflowSlug).toBe("google-ads-seed");
    expect(inserted.status).toBe("ongoing");
    // No per-campaign ceiling is ever written for this family: the money is billing's, read live.
    expect(inserted.dailyBudgetCents).toBeUndefined();
  });

  it("provisions NO Google Ads campaign for a funnel that channel cannot sell", async () => {
    // An ad buys a click. The conversation chain starts with a reply it has no way to sell, and
    // features-service states that per channel rather than leaving it to be inferred here.
    mockFetch.mockImplementation(async (input: URL | string) => {
      const url = String(input);
      if (url.includes("/features/")) {
        const slug = new URL(url).pathname.split("/features/")[1];
        return {
          ok: true,
          json: async () => ({
            feature: {
              slug,
              salesFunnels: slug === GOOGLE_ADS
                ? ["website_purchases", "sales_meetings_from_website", "form_magnet"]
                : [...SALES_FUNNEL_KEYS],
            },
          }),
        };
      }
      if (url.includes("/workflows")) {
        return {
          ok: true,
          json: async () => ({
            workflows: [{ workflowSlug: `${new URL(url).searchParams.get("featureSlug")}-seed`, createdAt: "2026-08-18T00:00:00.000Z" }],
          }),
        };
      }
      throw new Error(`unexpected fetch in test: ${url}`);
    });
    mockFunnelBudgets(
      [{ funnelKey: "reply_meeting", dailyBudgetCents: "1000" }],
      "1000",
      [{ funnelKey: "reply_meeting", featureSlug: GOOGLE_ADS, dailyBudgetCents: "1000" }],
    );
    mockDeclaredFunnels([{ funnelKey: "sales_meetings_from_conversation" }]);
    mockFindFirst.mockResolvedValue(undefined);

    await planFunnelTurns([claimed({ funnelKey: "sales_meetings_from_conversation" })]);

    expect(mockInsertValues).not.toHaveBeenCalled();
  });

  it("a live cold-email run does NOT hold a funded Google Ads campaign, and neither holds the other", async () => {
    // Serialization exists because two outbound runs would contact the same people from the same
    // mailboxes. An ad shares neither, so counting a cold-email run against it would hold a funded
    // channel every tick for a reason that is not true of it — and say so in no log at all.
    mockFunnelBudgets(
      [
        { funnelKey: "reply_meeting", dailyBudgetCents: "2000" },
        { funnelKey: "visit_signup", dailyBudgetCents: "1000" },
      ],
      "3000",
      [
        { funnelKey: "reply_meeting", featureSlug: SALES, dailyBudgetCents: "2000" },
        { funnelKey: "visit_signup", featureSlug: GOOGLE_ADS, dailyBudgetCents: "1000" },
      ],
    );
    mockDeclaredFunnels([
      { funnelKey: "sales_meetings_from_conversation" },
      { funnelKey: "website_purchases" },
    ]);
    mockFindFirst.mockResolvedValue({ id: "existing", name: "x", status: "ongoing", stopReason: null });
    mockSpend("0"); // c-sales
    mockSpend("0"); // c-ads

    aliveBrandCampaigns = [
      { id: "c-sales", featureSlug: SALES },
      { id: "c-ads", featureSlug: GOOGLE_ADS },
    ];
    mockListRuns.mockImplementation(async ({ campaignId }: { campaignId?: string }) =>
      campaignId === "c-sales" ? { runs: [{ id: "live-cold-email" }] } : { runs: [] },
    );

    const now = new Date("2026-08-26T10:00:00Z");
    const deferred = await planFunnelTurns(
      [
        claimed({ id: "c-sales", funnelKey: "sales_meetings_from_conversation", featureSlug: SALES }),
        claimed({ id: "c-ads", funnelKey: "website_purchases", featureSlug: GOOGLE_ADS }),
      ],
      now,
    );

    expect(deferred.has("c-ads")).toBe(false); // takes its turn while cold email is mid-run
    expect(deferred.get("c-sales")?.getTime()).toBe(now.getTime() + FUNNEL_TURN_DEFER_MS);
  });

  it("asks each campaign's spend under its OWN feature — the seed's slug would answer zero", async () => {
    // The spend read filters on featureSlug. Asking for the ad campaign's spend under the seed's
    // cold-email slug answers ZERO, so a campaign at its ceiling would read as perfectly empty and
    // take every turn — overspending its own ceiling with nothing in any log.
    mockFunnelBudgets(
      [
        { funnelKey: "reply_meeting", dailyBudgetCents: "2000" },
        { funnelKey: "visit_signup", dailyBudgetCents: "1000" },
      ],
      "3000",
      [
        { funnelKey: "reply_meeting", featureSlug: SALES, dailyBudgetCents: "2000" },
        { funnelKey: "visit_signup", featureSlug: GOOGLE_ADS, dailyBudgetCents: "1000" },
      ],
    );
    mockDeclaredFunnels([
      { funnelKey: "sales_meetings_from_conversation" },
      { funnelKey: "website_purchases" },
    ]);
    mockFindFirst.mockResolvedValue({ id: "existing", name: "x", status: "ongoing", stopReason: null });
    mockSpend("0");
    mockSpend("0");

    aliveBrandCampaigns = [
      { id: "c-sales", featureSlug: SALES },
      { id: "c-ads", featureSlug: GOOGLE_ADS },
    ];
    await planFunnelTurns(
      [
        claimed({ id: "c-sales", funnelKey: "sales_meetings_from_conversation", featureSlug: SALES }),
        claimed({ id: "c-ads", funnelKey: "website_purchases", featureSlug: GOOGLE_ADS }),
      ],
      new Date("2026-08-26T10:00:00Z"),
    );

    expect(mockGetStatsBudget).toHaveBeenCalledWith(
      expect.objectContaining({ campaignId: "c-ads", featureSlug: GOOGLE_ADS }),
    );
    expect(mockGetStatsBudget).toHaveBeenCalledWith(
      expect.objectContaining({ campaignId: "c-sales", featureSlug: SALES }),
    );
  });

  it("two funded Google Ads funnels of one brand still take turns — one live run per ad account", async () => {
    mockFunnelBudgets(
      [
        { funnelKey: "visit_signup", dailyBudgetCents: "1000" },
        { funnelKey: "visit_form", dailyBudgetCents: "1000" },
      ],
      "2000",
      [
        { funnelKey: "visit_signup", featureSlug: GOOGLE_ADS, dailyBudgetCents: "1000" },
        { funnelKey: "visit_form", featureSlug: GOOGLE_ADS, dailyBudgetCents: "1000" },
      ],
    );
    mockDeclaredFunnels([{ funnelKey: "website_purchases" }, { funnelKey: "form_magnet" }]);
    mockFindFirst.mockResolvedValue({ id: "existing", name: "x", status: "ongoing", stopReason: null });
    mockSpend("900"); // c-purchases: 90% full
    mockSpend("100"); // c-form: 10% full

    aliveBrandCampaigns = [
      { id: "c-purchases", featureSlug: GOOGLE_ADS },
      { id: "c-form", featureSlug: GOOGLE_ADS },
    ];
    const now = new Date("2026-08-26T10:00:00Z");
    const deferred = await planFunnelTurns(
      [
        claimed({ id: "c-purchases", funnelKey: "website_purchases", featureSlug: GOOGLE_ADS }),
        claimed({ id: "c-form", funnelKey: "form_magnet", featureSlug: GOOGLE_ADS }),
      ],
      now,
    );

    expect(deferred.has("c-form")).toBe(false); // the emptiest relative to its own ceiling
    expect(deferred.get("c-purchases")?.getTime()).toBe(now.getTime() + FUNNEL_TURN_DEFER_MS);
  });
});
