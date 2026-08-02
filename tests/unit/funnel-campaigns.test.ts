import { describe, it, expect, beforeEach, vi } from "vitest";

const {
  mockListRuns,
  mockGetStatsBudget,
  mockFindFirst,
  mockInsertValues,
  mockUpdateWhere,
} = vi.hoisted(() => ({
  mockListRuns: vi.fn(),
  mockGetStatsBudget: vi.fn(),
  mockFindFirst: vi.fn(),
  mockInsertValues: vi.fn(),
  mockUpdateWhere: vi.fn(),
}));

vi.mock("@distribute/runs-client", () => ({
  listRuns: mockListRuns,
  getStatsBudget: mockGetStatsBudget,
}));

vi.mock("../../src/db/index.js", () => ({
  db: {
    query: { campaigns: { findFirst: mockFindFirst } },
    insert: vi.fn().mockReturnValue({ values: mockInsertValues }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({ where: mockUpdateWhere }),
    }),
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
  },
}));

vi.mock("drizzle-orm", () => ({
  and: vi.fn(),
  eq: vi.fn(),
  desc: vi.fn(),
  arrayContains: vi.fn(),
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import {
  planFunnelTurns,
  selectLowestFillRatio,
  funnelCampaignName,
  FUNNEL_TURN_DEFER_MS,
  SUPERSEDED_DEFER_MS,
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

function mockDeclaredFunnels(funnels: Array<{ funnelKey: string; goal: string; active?: boolean }>) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      declared: funnels.length > 0,
      funnels: funnels.map(f => ({ ...f, active: f.active ?? true, currentGoal: f.goal })),
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
      { campaignId: "a", funnelKey: "reply_meeting", spentCents: 800, ceilingCents: 1000 },
      { campaignId: "b", funnelKey: "visit_signup", spentCents: 900, ceilingCents: 5000 },
    ]);
    expect(winner).toBe("b");
  });

  it("is not a fixed order — a funnel that can absorb the whole day never starves the others", () => {
    // First in the list, huge ceiling, nothing spent: under a fixed order it would take every
    // turn. It takes this one, and once it has filled 10% the smaller funnel wins the next.
    const big = { campaignId: "big", funnelKey: "reply_meeting", spentCents: 0, ceilingCents: 100_000 };
    const small = { campaignId: "small", funnelKey: "visit_signup", spentCents: 0, ceilingCents: 100 };
    expect(selectLowestFillRatio([big, small])).toBe("big"); // tie at 0 → funnelKey order
    expect(selectLowestFillRatio([{ ...big, spentCents: 10_000 }, small])).toBe("small");
  });

  it("a funnel at its ceiling yields to another funded one, with no special case", () => {
    const winner = selectLowestFillRatio([
      { campaignId: "full", funnelKey: "reply_meeting", spentCents: 1000, ceilingCents: 1000 },
      { campaignId: "open", funnelKey: "visit_signup", spentCents: 990, ceilingCents: 1000 },
    ]);
    expect(winner).toBe("open");
  });

  it("returns null when every funded funnel is at its ceiling", () => {
    expect(
      selectLowestFillRatio([
        { campaignId: "a", funnelKey: "reply_meeting", spentCents: 1000, ceilingCents: 1000 },
        { campaignId: "b", funnelKey: "visit_signup", spentCents: 2500, ceilingCents: 2000 },
      ]),
    ).toBeNull();
  });

  it("never runs a funnel funded at zero", () => {
    expect(
      selectLowestFillRatio([
        { campaignId: "zero", funnelKey: "visit_signup", spentCents: 0, ceilingCents: 0 },
      ]),
    ).toBeNull();
  });

  it("breaks ties deterministically on funnelKey, not insertion order", () => {
    const rows = [
      { campaignId: "v", funnelKey: "visit_signup", spentCents: 50, ceilingCents: 100 },
      { campaignId: "r", funnelKey: "reply_meeting", spentCents: 50, ceilingCents: 100 },
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
    mockFindFirst.mockResolvedValue({ id: "existing", status: "ongoing" });
    mockInsertValues.mockResolvedValue(undefined);
    mockUpdateWhere.mockResolvedValue(undefined);
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
      { funnelKey: "visit_signup", goal: "signup" },
      { funnelKey: "reply_meeting", goal: "meetingBooked" },
    ]);
    mockFindFirst.mockResolvedValue(undefined); // neither funnel has a campaign yet

    await planFunnelTurns([claimed()]);

    expect(mockInsertValues).toHaveBeenCalledTimes(2);
    const inserted = mockInsertValues.mock.calls.map(c => c[0]);
    expect(inserted.map(v => v.funnelKey).sort()).toEqual(["reply_meeting", "visit_signup"]);
    // The campaign carries the funnel's OWN goal, forwarded verbatim — that is what keeps it
    // out of goal arbitration.
    expect(inserted.find(v => v.funnelKey === "reply_meeting").goal).toBe("meetingBooked");
    expect(inserted.find(v => v.funnelKey === "visit_signup").goal).toBe("signup");
    expect(inserted[0].name).toBe(funnelCampaignName(SALES, "brand-1", inserted[0].funnelKey));
  });

  it("never provisions a funnel billing funds but brand-service does not declare active", async () => {
    mockFunnelBudgets([
      { funnelKey: "visit_signup", dailyBudgetCents: "1000" },
      { funnelKey: "visit_form", dailyBudgetCents: "500" },
    ]);
    mockDeclaredFunnels([
      { funnelKey: "visit_signup", goal: "signup" },
      { funnelKey: "visit_form", goal: "formSubmission", active: false },
    ]);
    mockFindFirst.mockResolvedValue(undefined);

    await planFunnelTurns([claimed()]);

    expect(mockInsertValues).toHaveBeenCalledTimes(1);
    expect(mockInsertValues.mock.calls[0][0].funnelKey).toBe("visit_signup");
  });

  it("holds the whole brand while a run is in flight — one run per brand", async () => {
    mockFunnelBudgets([
      { funnelKey: "visit_signup", dailyBudgetCents: "1000" },
      { funnelKey: "reply_meeting", dailyBudgetCents: "2000" },
    ]);
    mockDeclaredFunnels([
      { funnelKey: "visit_signup", goal: "signup" },
      { funnelKey: "reply_meeting", goal: "meetingBooked" },
    ]);
    mockListRuns.mockResolvedValue({ runs: [{ id: "live" }] });

    const now = new Date("2026-08-02T10:00:00Z");
    const deferred = await planFunnelTurns(
      [
        claimed({ id: "c-visit", funnelKey: "visit_signup" }),
        claimed({ id: "c-reply", funnelKey: "reply_meeting" }),
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
      { funnelKey: "visit_signup", goal: "signup" },
      { funnelKey: "reply_meeting", goal: "meetingBooked" },
    ]);
    mockSpend("900"); // c-visit is 90% full
    mockSpend("100"); // c-reply is 10% full

    const now = new Date("2026-08-02T10:00:00Z");
    const deferred = await planFunnelTurns(
      [
        claimed({ id: "c-visit", funnelKey: "visit_signup" }),
        claimed({ id: "c-reply", funnelKey: "reply_meeting" }),
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
      { funnelKey: "visit_signup", goal: "signup" },
      { funnelKey: "reply_meeting", goal: "meetingBooked" },
    ]);
    mockSpend("1000");
    mockSpend("1200");

    const now = new Date("2026-08-02T10:00:00Z");
    const deferred = await planFunnelTurns(
      [
        claimed({ id: "c-visit", funnelKey: "visit_signup" }),
        claimed({ id: "c-reply", funnelKey: "reply_meeting" }),
      ],
      now,
    );

    expect(deferred.size).toBe(2);
    for (const at of deferred.values()) expect(at.getTime()).toBeGreaterThan(now.getTime());
  });

  it("supersedes the pre-funnel campaign once funnels are funded", async () => {
    mockFunnelBudgets([{ funnelKey: "visit_signup", dailyBudgetCents: "1000" }]);
    mockDeclaredFunnels([{ funnelKey: "visit_signup", goal: "signup" }]);
    mockSpend("0");

    const now = new Date("2026-08-02T10:00:00Z");
    const deferred = await planFunnelTurns(
      [
        claimed({ id: "c-legacy", funnelKey: null }),
        claimed({ id: "c-visit", funnelKey: "visit_signup" }),
      ],
      now,
    );

    // The legacy campaign paces on the brand-level SUM — letting it run would spend every
    // funnel's allowance at once.
    expect(deferred.get("c-legacy")?.getTime()).toBe(now.getTime() + SUPERSEDED_DEFER_MS);
    expect(deferred.has("c-visit")).toBe(false);
  });
});
