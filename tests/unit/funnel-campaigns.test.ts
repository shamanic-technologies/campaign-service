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
} = vi.hoisted(() => ({
  mockListRuns: vi.fn(),
  mockGetStatsBudget: vi.fn(),
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

import {
  planFunnelTurns,
  selectLowestFillRatio,
  funnelCampaignName,
  FUNNEL_TURN_DEFER_MS,
  FUNDING_RECHECK_MS,
  type ClaimedFunnelCampaign,
} from "../../src/lib/funnel-campaigns.js";

const SALES = "sales-cold-email-outreach";

// The brand's alive campaigns, as the sales-scoped liveness check reads them.
let aliveBrandCampaigns: Array<{ id: string; featureSlug: string | null }> = [];
function claimed(overrides: Partial<ClaimedFunnelCampaign> = {}): ClaimedFunnelCampaign {
  return {
    id: "campaign-1",
    orgId: "org-1",
    createdByUserId: "user-1",
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
    mockSpend("1200"); // the funded funnel is over its ceiling
    mockSpend("0");    // the unfunded one has spent nothing, but has no ceiling to fill

    const now = new Date("2026-08-02T10:00:00Z");
    const deferred = await planFunnelTurns(
      [
        claimed({ id: "c-visit", funnelKey: "website_purchases" }),
        claimed({ id: "c-unfunded", funnelKey: "sales_meetings_from_conversation" }),
      ],
      now,
    );

    // The funded-but-full one waits for the day rollover; the unfunded one is not waiting its
    // TURN at all, it is waiting for money, so it re-checks on the funding cadence.
    expect(deferred.get("c-visit")!.getTime()).toBeGreaterThan(now.getTime() + FUNNEL_TURN_DEFER_MS);
    expect(deferred.get("c-unfunded")?.getTime()).toBe(now.getTime() + FUNDING_RECHECK_MS);
  });
});
