import { describe, it, expect, beforeEach, vi } from "vitest";

const {
  mockGetStatsBudget,
  mockListRuns,
  mockFindMany,
  mockFetchCampaignBudgets,
  mockFetchBrandSalesBudget,
  mockFetchChannelCatalogue,
  mockReportTurnHolds,
} = vi.hoisted(() => ({
  mockGetStatsBudget: vi.fn(),
  mockListRuns: vi.fn(),
  mockFindMany: vi.fn(),
  mockFetchCampaignBudgets: vi.fn(),
  mockFetchBrandSalesBudget: vi.fn(),
  mockFetchChannelCatalogue: vi.fn(),
  mockReportTurnHolds: vi.fn(),
}));

vi.mock("@distribute/runs-client", () => ({ getStatsBudget: mockGetStatsBudget, listRuns: mockListRuns }));
vi.mock("../../src/db/index.js", () => ({ db: { query: { campaigns: { findMany: mockFindMany } } } }));
vi.mock("../../src/db/schema.js", () => ({ campaigns: {} }));
vi.mock("drizzle-orm", () => ({ and: vi.fn(), eq: vi.fn(), arrayContains: vi.fn() }));
vi.mock("../../src/lib/campaign-budget-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/campaign-budget-client.js")>()),
  fetchCampaignBudgets: mockFetchCampaignBudgets,
}));
vi.mock("../../src/lib/brand-sales-budget-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/brand-sales-budget-client.js")>()),
  fetchBrandSalesBudget: mockFetchBrandSalesBudget,
}));
vi.mock("../../src/lib/channel-operator-client.js", () => ({ fetchChannelCatalogue: mockFetchChannelCatalogue }));
vi.mock("../../src/lib/turn-hold-event.js", () => ({ reportTurnHolds: mockReportTurnHolds }));
vi.mock("../../src/lib/provisioning-identity.js", () => ({ buildProvisioningIdentity: vi.fn().mockResolvedValue(null) }));
vi.mock("../../src/lib/campaign-offer-adoption.js", () => ({ adoptOfferForPairSafely: vi.fn() }));

import {
  boundedCap,
  daysLeftInPeriod,
  itemPace,
  itemsOf,
  underCap,
  type SalesItem,
} from "../../src/lib/sales-items.js";
import { parseSalesItems } from "../../src/lib/brand-sales-budget-client.js";
import { itemVerdict, salesItemsGate, ITEM_RECHECK_MS } from "../../src/lib/sales-items-pace.js";
import { planBrandTurns, FUNDING_RECHECK_MS, type ClaimedSalesCampaign } from "../../src/lib/brand-turns.js";

const SALES = "sales-cold-email-outreach";
const AI_MEETING = "ai-meeting-booking";
const ENTRY = "start_to_conversation";
const REACTIVE = "conversation_to_meeting_booked";
const LEGS = [
  { legKey: ENTRY, fromStepKey: null, toStepKey: "conversation" },
  { legKey: REACTIVE, fromStepKey: "conversation", toStepKey: "meeting_booked" },
];

// Server-local clock, as every daily window here.
const NOW = new Date(2026, 9, 10, 12, 0, 0);
const PERIOD_START = new Date(2026, 9, 1);
const PERIOD_END = new Date(2026, 9, 31); // 21 days left on Oct 10, today included

function item(o: Partial<SalesItem> = {}): SalesItem {
  return {
    offerId: "offer-1",
    legKey: ENTRY,
    featureSlug: SALES,
    budgetCents: 1000,
    period: "day",
    periodStart: null,
    periodEnd: null,
    managed: true,
    ...o,
  };
}
const monthly = (o: Partial<SalesItem> = {}) =>
  item({ period: "month", periodStart: PERIOD_START, periodEnd: PERIOD_END, budgetCents: 9900, ...o });
const KEY = { offerId: "offer-1", legKey: ENTRY, featureSlug: SALES };

// ── Pure rules ──────────────────────────────────────────────────────────────────────────────────

describe("itemsOf — an item funds exactly its (offer, leg, channel), and only a channel we run", () => {
  it("matches exactly, never a sibling leg, channel or offer", () => {
    const items = [item(), item({ legKey: REACTIVE }), item({ featureSlug: AI_MEETING }), item({ offerId: "offer-2" })];
    expect(itemsOf(items, KEY)).toEqual([item()]);
  });

  it("an item on a channel we do not run (managed: false) funds nothing", () => {
    expect(itemsOf([item({ managed: false })], KEY)).toEqual([]);
  });

  it("a campaign stating no offer or no leg is funded by no item", () => {
    expect(itemsOf([item()], { ...KEY, offerId: null })).toEqual([]);
    expect(itemsOf([item()], { ...KEY, legKey: null })).toEqual([]);
  });
});

describe("itemPace", () => {
  const pace = (o: Partial<Parameters<typeof itemPace>[0]>) =>
    itemPace({ items: [item()], campaign: KEY, reactive: false, spentTodayCents: 0, now: NOW, ...o });

  it("daily item (prepaid / postpaid): today's cap IS the budget", () => {
    expect(pace({ spentTodayCents: 400 })).toMatchObject({ ok: true, spentCents: 400, capCents: 1000 });
  });

  it("no item = not funded (an expected state, not a fault)", () => {
    expect(pace({ items: [] })).toMatchObject({ ok: false, reason: "no_item" });
  });

  it("two items for one campaign is a fault, never summed by guess", () => {
    expect(pace({ items: [item(), item()] })).toMatchObject({ ok: false, reason: "ambiguous" });
  });

  it("monthly proactive item (subscriber) is paced over the days left: $99 with nothing spent, 21 days left → 471c today", () => {
    expect(daysLeftInPeriod(NOW, PERIOD_END)).toBe(21);
    const p = pace({ items: [monthly()], spentTodayCents: 0, spentInPeriodCents: 0 });
    expect(p.ok && p.capCents).toBeCloseTo(9900 / 21);
  });

  it("an under-spent month catches up, an over-spent one pays back", () => {
    const under = pace({ items: [monthly()], spentTodayCents: 0, spentInPeriodCents: 900 });
    expect(under.ok && under.capCents).toBeCloseTo(9000 / 21);
    const over = pace({ items: [monthly()], spentTodayCents: 0, spentInPeriodCents: 9000 });
    expect(over.ok && over.capCents).toBeCloseTo(900 / 21);
    const spent = pace({ items: [monthly()], spentTodayCents: 0, spentInPeriodCents: 9900 });
    expect(spent.ok && spent.capCents).toBe(0);
  });

  it("today's own spend is not counted twice: it is inside the period figure", () => {
    const p = pace({ items: [monthly()], spentTodayCents: 300, spentInPeriodCents: 1200 });
    expect(p).toMatchObject({ ok: true, spentCents: 300 });
    expect(p.ok && p.capCents).toBeCloseTo((9900 - 900) / 21);
  });

  it("monthly REACTIVE item is capped on the period only (it fires on leads, which are bursty)", () => {
    const p = pace({ items: [monthly({ legKey: REACTIVE })], campaign: { ...KEY, legKey: REACTIVE }, reactive: true, spentTodayCents: 0, spentInPeriodCents: 2000 });
    expect(p).toMatchObject({ ok: true, capCents: 7900 });
  });

  it("a period that began today does not count the previous period's spend from this morning", () => {
    const startedToday = monthly({ periodStart: new Date(2026, 9, 10, 9, 0, 0), periodEnd: new Date(2026, 10, 10, 9, 0, 0) });
    const p = pace({ items: [startedToday], spentTodayCents: 800, spentInPeriodCents: 100 });
    expect(p).toMatchObject({ ok: true, spentCents: 100 });
  });

  it("a monthly item whose period is not now is not judged (billing has not rolled it)", () => {
    const stale = monthly({ periodStart: new Date(2026, 8, 1), periodEnd: new Date(2026, 9, 1) });
    expect(pace({ items: [stale] })).toMatchObject({ ok: false, reason: "period_not_current" });
  });
});

describe("boundedCap / underCap", () => {
  it("an existing per-campaign ceiling stays an upper bound", () => {
    expect(boundedCap(1000, 600)).toBe(600);
    expect(boundedCap(400, 600)).toBe(400);
    expect(boundedCap(400, null)).toBe(400);
  });
  it("a zero cap never runs", () => {
    expect(underCap(0, 0)).toBe(false);
    expect(underCap(999, 1000)).toBe(true);
    expect(underCap(1000, 1000)).toBe(false);
  });
});

describe("parseSalesItems — billing's item list, refused whole when one item is unreadable", () => {
  const raw = { offerId: "offer-1", legKey: ENTRY, featureSlug: SALES, budgetCents: "990.00", period: "day", periodStart: null, periodEnd: null };
  it("reads a daily and a monthly item; managed absent = managed", () => {
    const parsed = parseSalesItems([
      raw,
      { ...raw, period: "month", periodStart: PERIOD_START.toISOString(), periodEnd: PERIOD_END.toISOString(), managed: false },
    ]);
    expect(parsed).toEqual([
      item({ budgetCents: 990 }),
      item({ budgetCents: 990, period: "month", periodStart: PERIOD_START, periodEnd: PERIOD_END, managed: false }),
    ]);
  });
  it("refuses an item naming no leg, a bad budget, an unknown period, a month with no period", () => {
    expect(typeof parseSalesItems([{ ...raw, legKey: null }])).toBe("string");
    expect(typeof parseSalesItems([{ ...raw, budgetCents: "abc" }])).toBe("string");
    expect(typeof parseSalesItems([{ ...raw, period: "week" }])).toBe("string");
    expect(typeof parseSalesItems([{ ...raw, period: "month" }])).toBe("string");
    expect(typeof parseSalesItems("nope")).toBe("string");
  });
});

// ── Reads ───────────────────────────────────────────────────────────────────────────────────────

let spend: Record<string, { today: number; period?: number } | null> = {};

beforeEach(() => {
  vi.clearAllMocks();
  spend = {};
  mockListRuns.mockResolvedValue({ runs: [] });
  mockFindMany.mockResolvedValue([]);
  mockGetStatsBudget.mockImplementation(async ({ campaignId }: { campaignId: string }) => {
    const s = spend[campaignId];
    if (s === null) throw new Error("runs-service down");
    const today = String(s?.today ?? 0);
    const period = String(s?.period ?? s?.today ?? 0);
    return {
      windows: [
        { label: "today", totalCostInUsdCents: today, netTotalCostInUsdCents: today },
        { label: "period", totalCostInUsdCents: period, netTotalCostInUsdCents: period },
      ],
    };
  });
  // Billing serves no per-campaign ceiling for the brand: only the items bind.
  mockFetchCampaignBudgets.mockResolvedValue({ ok: true, brandDailyBudgetCents: 5000, campaigns: [] });
  mockFetchChannelCatalogue.mockResolvedValue({ ok: true, legs: LEGS, operatorBySlug: new Map(), legsBySlug: new Map(), stepKeys: new Set() });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

const CAMPAIGN = { id: "c-1", orgId: "org-1", offerId: "offer-1", legKey: ENTRY, featureSlug: SALES, dailyBudgetCents: null };
const verdict = (o: Partial<Parameters<typeof itemVerdict>[0]> = {}) =>
  itemVerdict({ campaign: CAMPAIGN, brandId: "brand-1", items: [item()], reactive: false, identity: { orgId: "org-1" }, now: NOW, ...o });

describe("itemVerdict", () => {
  it("no item: unfunded, and no spend is read", async () => {
    expect(await verdict({ items: [] })).toMatchObject({ run: false, kind: "unfunded" });
    expect(mockGetStatsBudget).not.toHaveBeenCalled();
  });

  it("under the daily item: runs; at it: reached, re-checked within ten minutes", async () => {
    spend["c-1"] = { today: 999 };
    expect(await verdict()).toEqual({ run: true, spentCents: 999, capCents: 1000 });
    spend["c-1"] = { today: 1000 };
    expect(await verdict()).toMatchObject({ run: false, kind: "reached", nextRunAt: new Date(NOW.getTime() + ITEM_RECHECK_MS) });
  });

  it("the brand pot is NOT an upper bound (items replace it); the campaign's own daily budget IS", async () => {
    mockFetchCampaignBudgets.mockResolvedValue({ ok: true, brandDailyBudgetCents: 100, campaigns: [] });
    spend["c-1"] = { today: 500 };
    expect(await verdict()).toMatchObject({ run: true, capCents: 1000 });
    expect(await verdict({ campaign: { ...CAMPAIGN, dailyBudgetCents: 400 } })).toMatchObject({ run: false, kind: "reached", capCents: 400 });
  });

  it("a billing ceiling at the campaign grain stays an upper bound", async () => {
    mockFetchCampaignBudgets.mockResolvedValue({
      ok: true,
      brandDailyBudgetCents: 300,
      campaigns: [{ offerId: "offer-1", legKey: ENTRY, featureSlug: SALES, dailyBudgetCents: 300 }],
    });
    spend["c-1"] = { today: 300 };
    expect(await verdict()).toMatchObject({ run: false, kind: "reached", capCents: 300 });
  });

  it("an unreadable spend or ceiling holds THIS campaign (fail-closed)", async () => {
    spend["c-1"] = null;
    expect(await verdict()).toMatchObject({ run: false, kind: "unreadable" });
    spend["c-1"] = { today: 0 };
    mockFetchCampaignBudgets.mockResolvedValue({ ok: false });
    expect(await verdict()).toMatchObject({ run: false, kind: "unreadable" });
  });

  it("a monthly item reads the period window from billing's period start", async () => {
    spend["c-1"] = { today: 0, period: 0 };
    await verdict({ items: [monthly()] });
    expect(mockGetStatsBudget).toHaveBeenCalledWith(
      expect.objectContaining({
        campaignId: "c-1",
        featureSlug: SALES,
        windows: expect.arrayContaining([{ label: "period", since: PERIOD_START.toISOString() }]),
      }),
    );
  });
});

describe("salesItemsGate (gate-check's items branch)", () => {
  const gateCampaign = { ...CAMPAIGN, brandIds: ["brand-1"] };

  it("a brand not in items mode is untouched, and its mode read is handed back (never read twice)", async () => {
    mockFetchBrandSalesBudget.mockResolvedValue({ ok: true, mode: "global", dailyBudgetCents: 1000 });
    expect(await salesItemsGate(gateCampaign, { orgId: "org-1" }, NOW)).toEqual({
      applies: false,
      salesBudget: { ok: true, mode: "global", dailyBudgetCents: 1000 },
    });
    expect(mockGetStatsBudget).not.toHaveBeenCalled();
  });

  it("a co-branded campaign is never in items mode and its mode is not read here", async () => {
    expect(await salesItemsGate({ ...gateCampaign, brandIds: ["b1", "b2"] }, { orgId: "org-1" }, NOW)).toEqual({ applies: false, salesBudget: null });
    expect(mockFetchBrandSalesBudget).not.toHaveBeenCalled();
  });

  it("items mode: spent item → 'Item budget reached'; no item → 'Campaign not funded'; under → passes", async () => {
    mockFetchBrandSalesBudget.mockResolvedValue({ ok: true, mode: "items", items: [item()] });
    spend["c-1"] = { today: 1000 };
    expect(await salesItemsGate(gateCampaign, { orgId: "org-1" }, NOW)).toMatchObject({ applies: true, block: { reason: "Item budget reached" } });
    spend["c-1"] = { today: 10 };
    expect(await salesItemsGate(gateCampaign, { orgId: "org-1" }, NOW)).toEqual({ applies: true, block: null });
    mockFetchBrandSalesBudget.mockResolvedValue({ ok: true, mode: "items", items: [item({ legKey: REACTIVE })] });
    expect(await salesItemsGate(gateCampaign, { orgId: "org-1" }, NOW)).toMatchObject({ applies: true, block: { reason: "Campaign not funded" } });
  });

  it("the leg's reactive flag comes from the catalogue: a reactive monthly item is capped on the period, not paced", async () => {
    mockFetchBrandSalesBudget.mockResolvedValue({ ok: true, mode: "items", items: [monthly({ legKey: REACTIVE, featureSlug: AI_MEETING })] });
    // 2000 of 9900 spent this period, 600 of it today: a paced cap (7900/21 = 376) would refuse, the period cap does not.
    spend["c-1"] = { today: 600, period: 2000 };
    const reactiveCampaign = { ...gateCampaign, legKey: REACTIVE, featureSlug: AI_MEETING };
    expect(await salesItemsGate(reactiveCampaign, { orgId: "org-1" }, NOW)).toEqual({ applies: true, block: null });
  });
});

// ── Turn planner ────────────────────────────────────────────────────────────────────────────────

function claimed(id: string, o: Partial<ClaimedSalesCampaign> = {}): ClaimedSalesCampaign {
  return {
    id,
    orgId: "org-1",
    createdByUserId: "user-1",
    parentRunId: "run-1",
    workflowSlug: "wf",
    brandIds: ["brand-1"],
    featureSlug: SALES,
    dailyBudgetCents: null,
    offerId: "offer-1",
    legKey: ENTRY,
    ...o,
  };
}
const holdsOf = () => mockReportTurnHolds.mock.calls.flatMap((c) => c[0]) as Array<{ campaign: { id: string }; reason: string }>;

describe("planBrandTurns — ITEMS mode", () => {
  it("a held item never stops another item: the spent one parks, the other runs", async () => {
    mockFetchBrandSalesBudget.mockResolvedValue({
      ok: true,
      mode: "items",
      items: [item(), item({ legKey: REACTIVE, featureSlug: AI_MEETING, budgetCents: 500 })],
    });
    spend = { email: { today: 1000 }, booker: { today: 100 } };
    const deferred = await planBrandTurns(
      [claimed("email"), claimed("booker", { legKey: REACTIVE, featureSlug: AI_MEETING })],
      NOW,
    );
    expect(deferred.has("booker")).toBe(false);
    expect(deferred.get("email")).toEqual(new Date(NOW.getTime() + ITEM_RECHECK_MS));
    expect(holdsOf().map((h) => [h.campaign.id, h.reason])).toEqual([["email", "item_budget_reached"]]);
  });

  it("a campaign no active path budgets is held as unfunded, and the global pot is never read", async () => {
    mockFetchBrandSalesBudget.mockResolvedValue({ ok: true, mode: "items", items: [item()] });
    spend = { email: { today: 0 }, other: { today: 0 } };
    const deferred = await planBrandTurns([claimed("email"), claimed("other", { offerId: "offer-2" })], NOW);
    expect(deferred.has("email")).toBe(false);
    expect(deferred.get("other")).toEqual(new Date(NOW.getTime() + FUNDING_RECHECK_MS));
    expect(holdsOf().map((h) => [h.campaign.id, h.reason])).toEqual([["other", "unfunded"]]);
    // Only the funded campaign's own spend is read: items mode has no brand-wide pot to add up.
    expect(mockGetStatsBudget.mock.calls.map((c) => c[0].campaignId)).toEqual(["email"]);
  });

  it("an item on a channel we do not run funds nothing", async () => {
    mockFetchBrandSalesBudget.mockResolvedValue({ ok: true, mode: "items", items: [item({ managed: false })] });
    const deferred = await planBrandTurns([claimed("email")], NOW);
    expect(deferred.get("email")).toEqual(new Date(NOW.getTime() + FUNDING_RECHECK_MS));
    expect(mockGetStatsBudget).not.toHaveBeenCalled();
  });

  it("an unreadable spend holds that campaign only", async () => {
    mockFetchBrandSalesBudget.mockResolvedValue({
      ok: true,
      mode: "items",
      items: [item(), item({ legKey: REACTIVE, featureSlug: AI_MEETING })],
    });
    spend = { email: null, booker: { today: 0 } };
    const deferred = await planBrandTurns(
      [claimed("email"), claimed("booker", { legKey: REACTIVE, featureSlug: AI_MEETING })],
      NOW,
    );
    expect(deferred.has("booker")).toBe(false);
    expect(holdsOf().map((h) => [h.campaign.id, h.reason])).toEqual([["email", "budgets_unreadable"]]);
  });

  it("in one cohort, the reactive leg takes the turn first (bottom of the funnel first)", async () => {
    mockFetchBrandSalesBudget.mockResolvedValue({
      ok: true,
      mode: "items",
      items: [item(), item({ legKey: REACTIVE })],
    });
    spend = { entry: { today: 0 }, reactive: { today: 900 } };
    const deferred = await planBrandTurns([claimed("entry"), claimed("reactive", { legKey: REACTIVE })], NOW);
    expect(deferred.has("reactive")).toBe(false);
    expect(deferred.has("entry")).toBe(true);
  });
});
