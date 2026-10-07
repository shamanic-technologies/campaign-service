import { describe, it, expect, beforeEach, vi } from "vitest";

// ── Pure rules ──────────────────────────────────────────────────────────────────────────────────
import {
  isGlobalBudgetExhausted,
  isReactiveLeg,
  potLeftCents,
  rankEntryTargets,
  selectByPathRoi,
  type GlobalCandidate,
} from "../../src/lib/global-sales-budget.js";

const ENTRY_REPLY = "start_to_conversation";
const ENTRY_VISIT = "start_to_website_visit";
const REPLY_TO_MEETING = "conversation_to_meeting_booked";
const SALES = "sales-cold-email-outreach";
const ADS = "google-ads";
const AI_MEETING = "ai-meeting-booking";

const LEGS = [
  { legKey: ENTRY_REPLY, fromStepKey: null, toStepKey: "conversation" },
  { legKey: ENTRY_VISIT, fromStepKey: null, toStepKey: "website_visit" },
  { legKey: REPLY_TO_MEETING, fromStepKey: "conversation", toStepKey: "meeting_booked" },
];

function cand(o: Partial<GlobalCandidate> & { campaignId: string }): GlobalCandidate {
  return { offerId: "offer-1", legKey: ENTRY_REPLY, featureSlug: SALES, spentCents: 0, ceilingCents: 1000, ...o };
}

describe("isReactiveLeg", () => {
  it("a leg OUT of a step is reactive; an entry leg is not", () => {
    expect(isReactiveLeg(REPLY_TO_MEETING, LEGS)).toBe(true);
    expect(isReactiveLeg(ENTRY_REPLY, LEGS)).toBe(false);
  });
  it("a leg the catalogue does not name, or no leg, reads PROACTIVE (capped — the conservative side)", () => {
    expect(isReactiveLeg("mystery_leg", LEGS)).toBe(false);
    expect(isReactiveLeg(null, LEGS)).toBe(false);
    expect(isReactiveLeg(REPLY_TO_MEETING, [])).toBe(false);
  });
});

describe("isGlobalBudgetExhausted", () => {
  it("holds at or over the budget, runs under it", () => {
    expect(isGlobalBudgetExhausted(999, 1000)).toBe(false);
    expect(isGlobalBudgetExhausted(1000, 1000)).toBe(true);
    expect(isGlobalBudgetExhausted(1200, 1000)).toBe(true);
  });
  it("a $0 global budget holds everything", () => {
    expect(isGlobalBudgetExhausted(0, 0)).toBe(true);
  });
});

describe("potLeftCents", () => {
  it("AC: a $10 pot with $4 of reactive spend leaves $6 for the entry legs", () => {
    expect(potLeftCents(400, 1000)).toBe(600);
  });
  it("never negative once in-flight spend overshoots", () => {
    expect(potLeftCents(1050, 1000)).toBe(0);
  });
});

describe("rankEntryTargets", () => {
  it("orders every offer's paths by ROI desc across the brand, null ROI last, drops channel-less entries", () => {
    const targets = rankEntryTargets(
      new Map([
        [
          "offer-1",
          [
            { rank: 1, pathKey: "p1", entryLegKey: ENTRY_REPLY, entryChannelSlug: SALES, roi: 3 },
            { rank: 2, pathKey: "p2", entryLegKey: ENTRY_VISIT, entryChannelSlug: null, roi: 2 },
            { rank: 3, pathKey: "p3", entryLegKey: ENTRY_VISIT, entryChannelSlug: ADS, roi: null },
          ],
        ],
        ["offer-2", [{ rank: 1, pathKey: "q1", entryLegKey: ENTRY_VISIT, entryChannelSlug: ADS, roi: 7 }]],
      ]),
    );
    expect(targets.map((t) => t.pathKey)).toEqual(["q1", "p1", "p3"]);
  });
});

describe("selectByPathRoi", () => {
  const targets = rankEntryTargets(
    new Map([
      [
        "offer-1",
        [
          { rank: 1, pathKey: "best", entryLegKey: ENTRY_VISIT, entryChannelSlug: ADS, roi: 5 },
          { rank: 2, pathKey: "next", entryLegKey: ENTRY_REPLY, entryChannelSlug: SALES, roi: 2 },
          { rank: 3, pathKey: "noroi", entryLegKey: ENTRY_REPLY, entryChannelSlug: "feedback-request-cold-email-outreach", roi: null },
        ],
      ],
    ]),
  );

  it("gives the budget to the best-ROI path's campaign, even when another is emptier", () => {
    const pick = selectByPathRoi(
      [
        cand({ campaignId: "email", legKey: ENTRY_REPLY, featureSlug: SALES, spentCents: 0 }),
        cand({ campaignId: "ads", legKey: ENTRY_VISIT, featureSlug: ADS, spentCents: 900 }),
      ],
      targets,
    );
    expect(pick).toEqual({ campaignId: "ads", pathKey: "best" });
  });

  it("spills to the next path when the best one's campaign is at its own ceiling", () => {
    const pick = selectByPathRoi(
      [
        cand({ campaignId: "email", legKey: ENTRY_REPLY, featureSlug: SALES }),
        cand({ campaignId: "ads", legKey: ENTRY_VISIT, featureSlug: ADS, spentCents: 1000 }),
      ],
      targets,
    );
    expect(pick).toEqual({ campaignId: "email", pathKey: "next" });
  });

  it("spills to the next path when no live campaign performs the best one", () => {
    expect(selectByPathRoi([cand({ campaignId: "email" })], targets)).toEqual({ campaignId: "email", pathKey: "next" });
  });

  it("a path with no ROI still gets money when nothing better can run", () => {
    const pick = selectByPathRoi(
      [cand({ campaignId: "fb", featureSlug: "feedback-request-cold-email-outreach" })],
      targets,
    );
    expect(pick).toEqual({ campaignId: "fb", pathKey: "noroi" });
  });

  it("a campaign no path names is the last resort, paced on the fill ratio", () => {
    const pick = selectByPathRoi(
      [
        cand({ campaignId: "x", offerId: "offer-9", spentCents: 500 }),
        cand({ campaignId: "y", offerId: "offer-9", spentCents: 100 }),
      ],
      targets,
    );
    expect(pick).toEqual({ campaignId: "y", pathKey: null });
  });

  it("with no targets at all it IS the fill-ratio pick (the sales-paths fallback)", () => {
    const pick = selectByPathRoi(
      [cand({ campaignId: "a", spentCents: 800 }), cand({ campaignId: "b", spentCents: 200 })],
      [],
    );
    expect(pick).toEqual({ campaignId: "b", pathKey: null });
  });

  it("returns null when every candidate is at its own ceiling", () => {
    expect(
      selectByPathRoi([cand({ campaignId: "a", spentCents: 1000 }), cand({ campaignId: "b", ceilingCents: 0 })], targets),
    ).toBeNull();
  });
});

// ── The planner in GLOBAL mode ──────────────────────────────────────────────────────────────────

const {
  mockGetStatsBudget,
  mockListRuns,
  mockFindMany,
  mockFetchCampaignBudgets,
  mockFetchBrandSalesBudget,
  mockFetchOfferSalesPaths,
  mockFetchChannelCatalogue,
  mockReportTurnHolds,
} = vi.hoisted(() => ({
  mockGetStatsBudget: vi.fn(),
  mockListRuns: vi.fn(),
  mockFindMany: vi.fn(),
  mockFetchCampaignBudgets: vi.fn(),
  mockFetchBrandSalesBudget: vi.fn(),
  mockFetchOfferSalesPaths: vi.fn(),
  mockFetchChannelCatalogue: vi.fn(),
  mockReportTurnHolds: vi.fn(),
}));

vi.mock("@distribute/runs-client", () => ({ getStatsBudget: (p: { featureSlug?: string }) => (p?.featureSlug?.startsWith("sourcing-") ? Promise.resolve({ windows: [] }) : mockGetStatsBudget(p)), listRuns: mockListRuns }));
vi.mock("../../src/db/index.js", () => ({ db: { query: { campaigns: { findMany: mockFindMany } } } }));
vi.mock("../../src/db/schema.js", () => ({ campaigns: {} }));
vi.mock("drizzle-orm", () => ({ and: vi.fn(), eq: vi.fn(), arrayContains: vi.fn() }));
vi.mock("../../src/lib/campaign-budget-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/campaign-budget-client.js")>()),
  fetchCampaignBudgets: mockFetchCampaignBudgets,
}));
vi.mock("../../src/lib/brand-sales-budget-client.js", () => ({ fetchBrandSalesBudget: mockFetchBrandSalesBudget }));
vi.mock("../../src/lib/offer-sales-paths-client.js", () => ({ fetchOfferSalesPaths: mockFetchOfferSalesPaths }));
vi.mock("../../src/lib/channel-operator-client.js", () => ({ fetchChannelCatalogue: mockFetchChannelCatalogue }));
vi.mock("../../src/lib/turn-hold-event.js", () => ({ reportTurnHolds: mockReportTurnHolds }));
vi.mock("../../src/lib/provisioning-identity.js", () => ({
  buildProvisioningIdentity: vi.fn().mockResolvedValue({ orgId: "org-1", userId: "user-1", runId: "run-1", campaignId: "c", brandId: "brand-1" }),
}));
vi.mock("../../src/lib/campaign-offer-adoption.js", () => ({ adoptOfferForPairSafely: vi.fn() }));

import { planBrandTurns, TURN_DEFER_MS, FUNDING_RECHECK_MS, type ClaimedSalesCampaign } from "../../src/lib/brand-turns.js";

type Row = { id: string; featureSlug: string; legKey: string; offerId?: string; ceiling: number; spent: number };

let spendById: Record<string, number | null> = {};

function setup(rows: Row[], extraDbRows: Array<{ id: string; featureSlug: string; legKey: string; spent: number | null }> = []) {
  spendById = {};
  for (const r of rows) spendById[r.id] = r.spent;
  for (const r of extraDbRows) spendById[r.id] = r.spent;
  mockFetchCampaignBudgets.mockResolvedValue({
    ok: true,
    brandDailyBudgetCents: rows.reduce((s, r) => s + r.ceiling, 0),
    campaigns: rows.map((r) => ({ offerId: r.offerId ?? "offer-1", legKey: r.legKey, featureSlug: r.featureSlug, dailyBudgetCents: r.ceiling })),
  });
  mockFindMany.mockResolvedValue([
    ...rows.map((r) => ({ id: r.id, featureSlug: r.featureSlug, legKey: r.legKey, status: "ongoing", updatedAt: new Date() })),
    ...extraDbRows.map((r) => ({ id: r.id, featureSlug: r.featureSlug, legKey: r.legKey, status: "ongoing", updatedAt: new Date() })),
  ]);
  return rows.map(
    (r): ClaimedSalesCampaign => ({
      id: r.id,
      orgId: "org-1",
      createdByUserId: "user-1",
      parentRunId: "run-1",
      workflowSlug: "wf",
      brandIds: ["brand-1"],
      featureSlug: r.featureSlug,
      dailyBudgetCents: null,
      offerId: r.offerId ?? "offer-1",
      legKey: r.legKey,
    }),
  );
}

const NOW = new Date("2026-09-29T12:00:00Z");

beforeEach(() => {
  vi.clearAllMocks();
  mockListRuns.mockResolvedValue({ runs: [] });
  mockGetStatsBudget.mockImplementation(async ({ campaignId }: { campaignId: string }) => {
    const cents = spendById[campaignId];
    if (cents === null) throw new Error("runs-service down");
    return { windows: [{ label: "today", totalCostInUsdCents: String(cents ?? 0), netTotalCostInUsdCents: String(cents ?? 0) }] };
  });
  mockFetchChannelCatalogue.mockResolvedValue({ ok: true, legs: LEGS, operatorBySlug: new Map(), legsBySlug: new Map(), stepKeys: new Set() });
  mockFetchOfferSalesPaths.mockResolvedValue({
    ok: true,
    status: "ok",
    paths: [
      { rank: 1, pathKey: "via-ads", entryLegKey: ENTRY_VISIT, entryChannelSlug: ADS, roi: 6 },
      { rank: 2, pathKey: "via-email", entryLegKey: ENTRY_REPLY, entryChannelSlug: SALES, roi: 2 },
    ],
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

function holdsOf(): Array<{ campaign: { id: string }; reason: string }> {
  return mockReportTurnHolds.mock.calls.flatMap((c) => c[0]);
}

describe("planBrandTurns — GLOBAL sales-budget mode", () => {
  it("campaigns mode never reads the catalogue or the sales paths", async () => {
    mockFetchBrandSalesBudget.mockResolvedValue({ ok: true, mode: "campaigns" });
    const claimed = setup([{ id: "email", featureSlug: SALES, legKey: ENTRY_REPLY, ceiling: 1000, spent: 0 }]);
    const deferred = await planBrandTurns(claimed, NOW);
    expect(deferred.size).toBe(0);
    expect(mockFetchChannelCatalogue).not.toHaveBeenCalled();
    expect(mockFetchOfferSalesPaths).not.toHaveBeenCalled();
  });

  it("gives the turn to the best-ROI path's campaign, not the emptiest one", async () => {
    mockFetchBrandSalesBudget.mockResolvedValue({ ok: true, mode: "global", dailyBudgetCents: 5000 });
    const claimed = setup([
      { id: "email", featureSlug: SALES, legKey: ENTRY_REPLY, ceiling: 1000, spent: 0 },
      { id: "ads", featureSlug: ADS, legKey: ENTRY_VISIT, ceiling: 1000, spent: 900 },
    ]);
    const deferred = await planBrandTurns(claimed, NOW);
    expect(deferred.has("ads")).toBe(false);
    expect(deferred.get("email")).toEqual(new Date(NOW.getTime() + TURN_DEFER_MS));
  });

  it("spills to the next path when the best one's campaign is at its own ceiling", async () => {
    mockFetchBrandSalesBudget.mockResolvedValue({ ok: true, mode: "global", dailyBudgetCents: 5000 });
    const claimed = setup([
      { id: "email", featureSlug: SALES, legKey: ENTRY_REPLY, ceiling: 1000, spent: 0 },
      { id: "ads", featureSlug: ADS, legKey: ENTRY_VISIT, ceiling: 1000, spent: 1000 },
    ]);
    const deferred = await planBrandTurns(claimed, NOW);
    expect(deferred.has("email")).toBe(false);
    expect(deferred.has("ads")).toBe(true);
  });

  it("holds every proactive campaign once brand-wide spend reaches the global budget — counting the one NOT claimed", async () => {
    mockFetchBrandSalesBudget.mockResolvedValue({ ok: true, mode: "global", dailyBudgetCents: 1000 });
    const claimed = setup(
      [{ id: "email", featureSlug: SALES, legKey: ENTRY_REPLY, ceiling: 5000, spent: 400 }],
      [{ id: "running-ads", featureSlug: ADS, legKey: ENTRY_VISIT, spent: 600 }],
    );
    const deferred = await planBrandTurns(claimed, NOW);
    expect(deferred.get("email")).toEqual(new Date(NOW.getTime() + FUNDING_RECHECK_MS));
    expect(holdsOf().map((h) => [h.campaign.id, h.reason])).toEqual([["email", "global_sales_budget_reached"]]);
  });

  it("a $0 global budget holds every proactive campaign", async () => {
    mockFetchBrandSalesBudget.mockResolvedValue({ ok: true, mode: "global", dailyBudgetCents: 0 });
    const claimed = setup([{ id: "email", featureSlug: SALES, legKey: ENTRY_REPLY, ceiling: 1000, spent: 0 }]);
    const deferred = await planBrandTurns(claimed, NOW);
    expect(deferred.has("email")).toBe(true);
    expect(holdsOf()[0].reason).toBe("global_sales_budget_reached");
  });

  // ── ONE pot, bottom of the funnel first (owner, 2026-10-03) ──────────────────────────────────

  it("AC: budget $10, reactive spent $4 → entry legs get at most the $6 left", async () => {
    mockFetchBrandSalesBudget.mockResolvedValue({ ok: true, mode: "global", dailyBudgetCents: 1000 });
    // Entry has spent $5.90: $9.90 of $10 is out of the pot, so it may still run.
    let claimed = setup([
      { id: "email", featureSlug: SALES, legKey: ENTRY_REPLY, ceiling: 1000, spent: 590 },
      { id: "booker", featureSlug: AI_MEETING, legKey: REPLY_TO_MEETING, ceiling: 1000, spent: 400 },
    ]);
    let deferred = await planBrandTurns(claimed, NOW);
    expect(deferred.has("email")).toBe(false);

    // Entry has spent its $6: the pot is spent, entry stops although its own ceiling has room.
    vi.clearAllMocks();
    mockFetchBrandSalesBudget.mockResolvedValue({ ok: true, mode: "global", dailyBudgetCents: 1000 });
    claimed = setup([
      { id: "email", featureSlug: SALES, legKey: ENTRY_REPLY, ceiling: 1000, spent: 600 },
      { id: "booker", featureSlug: AI_MEETING, legKey: REPLY_TO_MEETING, ceiling: 1000, spent: 400 },
    ]);
    deferred = await planBrandTurns(claimed, NOW);
    expect(deferred.get("email")).toEqual(new Date(NOW.getTime() + FUNDING_RECHECK_MS));
    expect(holdsOf().find((h) => h.campaign.id === "email")?.reason).toBe("global_sales_budget_reached");
  });

  it("a reactive leg's spend comes out of the pot: it alone can spend it and hold the entry legs", async () => {
    mockFetchBrandSalesBudget.mockResolvedValue({ ok: true, mode: "global", dailyBudgetCents: 1000 });
    const claimed = setup(
      [{ id: "email", featureSlug: SALES, legKey: ENTRY_REPLY, ceiling: 5000, spent: 0 }],
      // The reply handler, in flight (not claimed), already spent the whole pot.
      [{ id: "booker", featureSlug: AI_MEETING, legKey: REPLY_TO_MEETING, spent: 1000 }],
    );
    const deferred = await planBrandTurns(claimed, NOW);
    expect(deferred.has("email")).toBe(true);
    expect(holdsOf().map((h) => h.reason)).toEqual(["global_sales_budget_reached"]);
  });

  it("reactive legs keep working leads while the pot has money", async () => {
    mockFetchBrandSalesBudget.mockResolvedValue({ ok: true, mode: "global", dailyBudgetCents: 1000 });
    const claimed = setup([
      { id: "email", featureSlug: SALES, legKey: ENTRY_REPLY, ceiling: 1000, spent: 300 },
      { id: "booker", featureSlug: AI_MEETING, legKey: REPLY_TO_MEETING, ceiling: 1000, spent: 600 },
    ]);
    const deferred = await planBrandTurns(claimed, NOW);
    expect(deferred.has("booker")).toBe(false);
    expect(deferred.has("email")).toBe(false);
  });

  it("pot spent → the reactive leg is HELD (not stopped) and works the waiting lead the next day", async () => {
    mockFetchBrandSalesBudget.mockResolvedValue({ ok: true, mode: "global", dailyBudgetCents: 1000 });
    let claimed = setup([
      { id: "email", featureSlug: SALES, legKey: ENTRY_REPLY, ceiling: 1000, spent: 700 },
      { id: "booker", featureSlug: AI_MEETING, legKey: REPLY_TO_MEETING, ceiling: 1000, spent: 300 },
    ]);
    // 23:55 local: the rollover is nearer than the 10-minute re-check, so it is the re-check.
    const lateNight = new Date(2026, 8, 29, 23, 55, 0);
    let deferred = await planBrandTurns(claimed, lateNight);
    const tomorrow = new Date(2026, 8, 30, 0, 0, 0);
    expect(deferred.get("booker")).toEqual(tomorrow);
    expect(deferred.get("email")).toEqual(tomorrow);
    const bookerHold = holdsOf().find((h) => h.campaign.id === "booker") as { reason: string; detail: string } | undefined;
    expect(bookerHold?.reason).toBe("global_sales_budget_reached");
    expect(bookerHold?.detail).toMatch(/not dropped/);

    // The next day: nothing spent yet, the same reactive campaign runs (its waiting lead is worked).
    vi.clearAllMocks();
    mockFetchBrandSalesBudget.mockResolvedValue({ ok: true, mode: "global", dailyBudgetCents: 1000 });
    claimed = setup([
      { id: "email", featureSlug: SALES, legKey: ENTRY_REPLY, ceiling: 1000, spent: 0 },
      { id: "booker", featureSlug: AI_MEETING, legKey: REPLY_TO_MEETING, ceiling: 1000, spent: 0 },
    ]);
    deferred = await planBrandTurns(claimed, new Date(2026, 8, 30, 0, 1, 0));
    expect(deferred.has("booker")).toBe(false);
  });

  it("a $0 pot holds every sales campaign, reactive included", async () => {
    mockFetchBrandSalesBudget.mockResolvedValue({ ok: true, mode: "global", dailyBudgetCents: 0 });
    const claimed = setup([
      { id: "email", featureSlug: SALES, legKey: ENTRY_REPLY, ceiling: 1000, spent: 0 },
      { id: "booker", featureSlug: AI_MEETING, legKey: REPLY_TO_MEETING, ceiling: 1000, spent: 0 },
    ]);
    const deferred = await planBrandTurns(claimed, NOW);
    expect(deferred.has("booker")).toBe(true);
    expect(deferred.has("email")).toBe(true);
  });

  it("bottom first: in a shared cohort the reactive leg takes the turn ahead of the entry leg", async () => {
    mockFetchBrandSalesBudget.mockResolvedValue({ ok: true, mode: "global", dailyBudgetCents: 5000 });
    const claimed = setup([
      // Emptier entry leg — the campaigns-mode ranking would pick it.
      { id: "email", featureSlug: SALES, legKey: ENTRY_REPLY, ceiling: 1000, spent: 0 },
      { id: "replies", featureSlug: SALES, legKey: REPLY_TO_MEETING, ceiling: 1000, spent: 800 },
    ]);
    const deferred = await planBrandTurns(claimed, NOW);
    expect(deferred.has("replies")).toBe(false);
    expect(deferred.get("email")).toEqual(new Date(NOW.getTime() + TURN_DEFER_MS));
  });

  it("bottom first yields when the reactive leg is at its own ceiling", async () => {
    mockFetchBrandSalesBudget.mockResolvedValue({ ok: true, mode: "global", dailyBudgetCents: 5000 });
    const claimed = setup([
      { id: "email", featureSlug: SALES, legKey: ENTRY_REPLY, ceiling: 1000, spent: 0 },
      { id: "replies", featureSlug: SALES, legKey: REPLY_TO_MEETING, ceiling: 1000, spent: 1000 },
    ]);
    const deferred = await planBrandTurns(claimed, NOW);
    expect(deferred.has("email")).toBe(false);
    expect(deferred.has("replies")).toBe(true);
  });

  it("sales-paths failure falls back to fill-ratio pacing, still inside the global cap, and says so", async () => {
    mockFetchBrandSalesBudget.mockResolvedValue({ ok: true, mode: "global", dailyBudgetCents: 5000 });
    mockFetchOfferSalesPaths.mockResolvedValue({ ok: false, detail: "HTTP 502" });
    const claimed = setup([
      { id: "email", featureSlug: SALES, legKey: ENTRY_REPLY, ceiling: 1000, spent: 0 },
      { id: "ads", featureSlug: ADS, legKey: ENTRY_VISIT, ceiling: 1000, spent: 900 },
    ]);
    const deferred = await planBrandTurns(claimed, NOW);
    expect(deferred.has("email")).toBe(false); // emptiest wins, as in campaigns mode
    expect(deferred.has("ads")).toBe(true);
    expect(vi.mocked(console.error).mock.calls.flat().join(" ")).toMatch(/falling back to fill-ratio/);
  });

  it("a sales-paths status other than ok falls back the same way", async () => {
    mockFetchBrandSalesBudget.mockResolvedValue({ ok: true, mode: "global", dailyBudgetCents: 5000 });
    mockFetchOfferSalesPaths.mockResolvedValue({ ok: true, status: "no_complete_path", paths: [] });
    const claimed = setup([
      { id: "email", featureSlug: SALES, legKey: ENTRY_REPLY, ceiling: 1000, spent: 0 },
      { id: "ads", featureSlug: ADS, legKey: ENTRY_VISIT, ceiling: 1000, spent: 900 },
    ]);
    const deferred = await planBrandTurns(claimed, NOW);
    expect(deferred.has("email")).toBe(false);
  });

  it("an unreadable brand spend holds every sales campaign (fail-closed): the pot cannot be judged", async () => {
    mockFetchBrandSalesBudget.mockResolvedValue({ ok: true, mode: "global", dailyBudgetCents: 5000 });
    const claimed = setup(
      [
        { id: "email", featureSlug: SALES, legKey: ENTRY_REPLY, ceiling: 1000, spent: 0 },
        { id: "booker", featureSlug: AI_MEETING, legKey: REPLY_TO_MEETING, ceiling: 1000, spent: 0 },
      ],
      [{ id: "other", featureSlug: ADS, legKey: ENTRY_VISIT, spent: null }],
    );
    const deferred = await planBrandTurns(claimed, NOW);
    expect(deferred.has("email")).toBe(true);
    expect(deferred.has("booker")).toBe(true);
    expect(holdsOf().map((h) => h.reason)).toEqual(["budgets_unreadable", "budgets_unreadable"]);
  });

  it("an unreadable sales-budget MODE holds the whole brand (fail-closed, like an unreadable ceiling)", async () => {
    mockFetchBrandSalesBudget.mockResolvedValue({ ok: false, detail: "HTTP 500" });
    const claimed = setup([{ id: "email", featureSlug: SALES, legKey: ENTRY_REPLY, ceiling: 1000, spent: 0 }]);
    const deferred = await planBrandTurns(claimed, NOW);
    expect(deferred.get("email")).toEqual(new Date(NOW.getTime() + FUNDING_RECHECK_MS));
    expect(holdsOf()[0].reason).toBe("budgets_unreadable");
  });
});
