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
  arrayContains: vi.fn(),
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import {
  planFunnelTurns,
  selectLowestFillRatio,
  funnelCampaignName,
  FUNNEL_TURN_DEFER_MS,
  type ClaimedFunnelCampaign,
} from "../../src/lib/funnel-campaigns.js";

const SALES = "sales-cold-email-outreach";

function claimed(overrides: Partial<ClaimedFunnelCampaign> = {}): ClaimedFunnelCampaign {
  return {
    id: "campaign-1",
    orgId: "org-1",
    createdByUserId: "user-1",
    workflowSlug: "sales-email-cold-outreach",
    brandIds: ["brand-1"],
    featureSlug: SALES,
    funnelKey: null,
    ...overrides,
  };
}

// billing-service still names these funnels the PRE-RENAME way, so every test below feeds this
// mock the legacy spellings on purpose: the two producers disagree in production today, and the
// canonicalisation is what keeps a fully-funded funnel from reading as unfunded.
function mockFunnelBudgets(funnels: Array<{ funnelKey: string; dailyBudgetCents: string }>) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      brandId: "brand-1",
      dailyBudgetCents: String(funnels.reduce((s, f) => s + Number(f.dailyBudgetCents), 0)),
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

function mockBrandGoal(goal: string) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ brand: {}, currentGoal: goal, brandProfile: null }),
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
    // No funnel-less campaign to adopt unless a test says otherwise.
    mockFindMany.mockResolvedValue([]);
    mockInsertValues.mockResolvedValue(undefined);
    mockUpdateWhere.mockResolvedValue(undefined);
    mockDeleteWhere.mockResolvedValue(undefined);
  });

  it("leaves non-sales campaigns entirely alone", async () => {
    const deferred = await planFunnelTurns([claimed({ featureSlug: "pr-media-pitch-v1" })]);
    expect(deferred.size).toBe(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("a brand that never set per-funnel ceilings behaves exactly as today", async () => {
    mockFunnelBudgets([]);
    const deferred = await planFunnelTurns([claimed()]);
    expect(deferred.size).toBe(0);
  });

  it("falls through to today's behaviour when the ceilings cannot be read (fail-soft)", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });
    const deferred = await planFunnelTurns([claimed()]);
    expect(deferred.size).toBe(0);
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
    // same two funnels the pre-rename way. It also carries the goal that funnel corresponds to —
    // a legacy alias for consumers still reading one, and what keeps it out of goal arbitration.
    expect(inserted.find(v => v.funnelKey === "sales_meetings_from_conversation").goal).toBe("meetingBooked");
    expect(inserted.find(v => v.funnelKey === "website_purchases").goal).toBe("signup");
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

  it("holds the whole brand while a run is in flight — one run per brand", async () => {
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
    // The brand's liveness is what is checked, not one campaign's.
    expect(mockListRuns).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-1", brandId: "brand-1", status: "running" }),
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

  it("keeps the campaign already doing the funnel's work instead of standing up a second one", async () => {
    mockFunnelBudgets([{ funnelKey: "visit_form", dailyBudgetCents: "1000" }]);
    mockDeclaredFunnels([{ funnelKey: "form_magnet" }]);
    mockFindFirst.mockResolvedValue(undefined); // no campaign states this funnel yet
    mockFindMany.mockResolvedValue([
      // The months-old campaign, running on the brand's goal, carrying all the history.
      { id: "c-incumbent", name: "opsfolio.com — Signups", goal: null, status: "ongoing" },
    ]);
    mockBrandGoal("formSubmission");
    mockSpend("0");

    await planFunnelTurns([claimed({ id: "c-incumbent" })], new Date("2026-08-02T10:00:00Z"));

    // Adopted, not duplicated: same campaign id, now stating the funnel and its goal.
    expect(mockInsertValues).not.toHaveBeenCalled();
    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({ funnelKey: "form_magnet" }),
    );
  });

  it("adopts the OLDEST match — the one carrying the history", async () => {
    mockFunnelBudgets([{ funnelKey: "visit_form", dailyBudgetCents: "1000" }]);
    mockDeclaredFunnels([{ funnelKey: "form_magnet" }]);
    mockFindFirst.mockResolvedValue(undefined);
    mockFindMany.mockResolvedValue([
      { id: "c-oldest", name: "the one with the history", goal: null, status: "ongoing" },
      { id: "c-newer", name: "a later one", goal: null, status: "ongoing" },
    ]);
    mockBrandGoal("formSubmission");
    mockSpend("0");

    await planFunnelTurns([claimed({ id: "c-oldest" })], new Date("2026-08-02T10:00:00Z"));

    expect(mockUpdateWhere).toHaveBeenCalled();
    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({ funnelKey: "form_magnet" }),
    );
    // findMany is ordered by createdAt asc, so the first match is the oldest.
    expect(mockFindMany).toHaveBeenCalled();
  });

  it("never adopts a campaign whose goal names a different funnel", async () => {
    mockFunnelBudgets([{ funnelKey: "visit_form", dailyBudgetCents: "1000" }]);
    mockDeclaredFunnels([{ funnelKey: "form_magnet" }]);
    mockFindFirst.mockResolvedValue(undefined);
    mockFindMany.mockResolvedValue([
      { id: "c-meetings", name: "meetings", goal: "meetingBooked", status: "ongoing" },
    ]);
    mockBrandGoal("meetingBooked");
    mockSpend("0");

    await planFunnelTurns([claimed({ id: "c-meetings" })], new Date("2026-08-02T10:00:00Z"));

    expect(mockInsertValues).toHaveBeenCalledTimes(1);
    expect(mockInsertValues.mock.calls[0][0].funnelKey).toBe("form_magnet");
  });

  it("drops the empty stand-in it created for a funnel the incumbent was already working", async () => {
    mockFunnelBudgets([{ funnelKey: "visit_form", dailyBudgetCents: "1000" }]);
    mockDeclaredFunnels([{ funnelKey: "form_magnet" }]);
    mockFindFirst.mockResolvedValue({
      id: "c-standin",
      name: funnelCampaignName(SALES, "brand-1", "form_magnet"),
      status: "ongoing",
    });
    mockFindMany.mockResolvedValue([
      { id: "c-incumbent", name: "opsfolio.com — Signups", goal: null, status: "ongoing" },
    ]);
    mockBrandGoal("formSubmission");
    mockListRuns.mockResolvedValueOnce({ runs: [] }); // the stand-in never ran
    mockGetStatsBudget.mockResolvedValueOnce({
      windows: [{ label: "lifetime", totalCostInUsdCents: "0", netTotalCostInUsdCents: "0" }],
    });
    mockSpend("0");

    await planFunnelTurns([claimed({ id: "c-incumbent" })], new Date("2026-08-02T10:00:00Z"));

    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({ funnelKey: "form_magnet" }),
    );
    expect(mockDeleteWhere).toHaveBeenCalledTimes(1);
  });

  it("never drops a stand-in that has ever run", async () => {
    mockFunnelBudgets([{ funnelKey: "visit_form", dailyBudgetCents: "1000" }]);
    mockDeclaredFunnels([{ funnelKey: "form_magnet" }]);
    mockFindFirst.mockResolvedValue({
      id: "c-standin",
      name: funnelCampaignName(SALES, "brand-1", "form_magnet"),
      status: "ongoing",
    });
    mockFindMany.mockResolvedValue([
      { id: "c-incumbent", name: "opsfolio.com — Signups", goal: null, status: "ongoing" },
    ]);
    mockBrandGoal("formSubmission");
    mockListRuns.mockResolvedValueOnce({ runs: [{ id: "it-ran" }] });
    mockSpend("0");

    await planFunnelTurns([claimed({ id: "c-incumbent" })], new Date("2026-08-02T10:00:00Z"));

    expect(mockDeleteWhere).not.toHaveBeenCalled();
  });

  it("holds no campaign out of the running — one that states no funnel still takes turns", async () => {
    mockFunnelBudgets([{ funnelKey: "visit_signup", dailyBudgetCents: "1000" }]);
    mockDeclaredFunnels([{ funnelKey: "website_purchases" }]);
    mockFindFirst.mockResolvedValue({ id: "c-visit", name: "x", status: "ongoing" });
    mockFindMany.mockResolvedValue([]);
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
    mockFindMany.mockResolvedValue([]);
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
    mockFindMany.mockResolvedValue([]);
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

    // The funded-but-full one waits for the day rollover; the unfunded one re-checks in a minute
    // because its funding can change at any moment (and the gate is what refuses to spend).
    expect(deferred.get("c-visit")!.getTime()).toBeGreaterThan(now.getTime() + FUNNEL_TURN_DEFER_MS);
    expect(deferred.get("c-unfunded")?.getTime()).toBe(now.getTime() + FUNNEL_TURN_DEFER_MS);
  });
});
