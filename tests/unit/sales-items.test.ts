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

vi.mock("@distribute/runs-client", () => ({ getStatsBudget: (p: { featureSlug?: string }) => (p?.featureSlug?.startsWith("sourcing-") ? Promise.resolve({ windows: [] }) : mockGetStatsBudget(p)), listRuns: mockListRuns }));
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
    role: null,
    managed: true,
    ...o,
  };
}
const monthly = (o: Partial<SalesItem> = {}) =>
  item({ period: "month", periodStart: PERIOD_START, periodEnd: PERIOD_END, budgetCents: 9900, ...o });
const KEY = { offerId: "offer-1", legKey: ENTRY, featureSlug: SALES };

// ── Pure rules ──────────────────────────────────────────────────────────────────────────────────

describe("itemsOf — an item names exactly its (offer, leg, channel)", () => {
  it("matches exactly, never a sibling leg, channel or offer", () => {
    const items = [item(), item({ legKey: REACTIVE }), item({ featureSlug: AI_MEETING }), item({ offerId: "offer-2" })];
    expect(itemsOf(items, KEY)).toEqual([item()]);
  });

  it("offer ids match case-insensitively (billing stores them lowercased)", () => {
    expect(itemsOf([item({ offerId: "abcdef" })], { ...KEY, offerId: "ABCDEF" })).toHaveLength(1);
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

  it("an item on a channel we do not run (managed: false) funds nothing: unfunded, not a fault", () => {
    expect(pace({ items: [item({ managed: false })] })).toMatchObject({ ok: false, reason: "unmanaged" });
  });

  it("managed: null (billing could not say) holds the campaign as a fault", () => {
    expect(pace({ items: [item({ managed: null })] })).toMatchObject({ ok: false, reason: "managed_unknown" });
  });

  it("billing's stated role wins over our catalogue read; null falls back to it", () => {
    const spentToday = { spentTodayCents: 600, spentInPeriodCents: 2000 };
    expect(pace({ items: [monthly({ role: "reactive" })], reactive: false, ...spentToday })).toMatchObject({ ok: true, reactive: true });
    expect(pace({ items: [monthly({ role: "proactive" })], reactive: true, ...spentToday })).toMatchObject({ ok: true, reactive: false });
    expect(pace({ items: [monthly()], reactive: true, ...spentToday })).toMatchObject({ ok: true, reactive: true });
  });

  it("two items for one campaign is a fault, never summed by guess", () => {
    expect(pace({ items: [item(), item()] })).toMatchObject({ ok: false, reason: "ambiguous" });
  });

  it("monthly PROACTIVE item is a max on the period, never paced: $99 with nothing spent → the whole $99 is spendable today", () => {
    const p = pace({ items: [monthly()], spentTodayCents: 0, spentInPeriodCents: 0 });
    expect(p).toMatchObject({ ok: true, reactive: false, spentCents: 0, capCents: 9900 });
  });

  it("monthly item: the period's spend is compared to the whole budget; today's spend rides along", () => {
    const p = pace({ items: [monthly()], spentTodayCents: 3000, spentInPeriodCents: 5000 });
    expect(p).toMatchObject({ ok: true, spentCents: 5000, capCents: 9900, spentTodayCents: 3000 });
    const spent = pace({ items: [monthly()], spentTodayCents: 0, spentInPeriodCents: 9900 });
    expect(spent.ok && underCap(spent.spentCents, spent.capCents)).toBe(false);
  });

  it("monthly REACTIVE item is the same max on the period", () => {
    const p = pace({ items: [monthly({ legKey: REACTIVE })], campaign: { ...KEY, legKey: REACTIVE }, reactive: true, spentTodayCents: 0, spentInPeriodCents: 2000 });
    expect(p).toMatchObject({ ok: true, reactive: true, spentCents: 2000, capCents: 9900 });
  });

  it("a period that began today counts only the spend since it began", () => {
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
  // billing v0.81.48's served row (SpendableCampaignItem): no pathKeys, role and managed nullable.
  const raw = { offerId: "offer-1", legKey: ENTRY, featureSlug: SALES, role: "proactive", budgetCents: "990.0000000000", period: "day", periodStart: null, periodEnd: null, managed: true };
  it("reads billing's served rows: daily and monthly, role and managed carried, null kept null", () => {
    const parsed = parseSalesItems([
      raw,
      { ...raw, role: "reactive", period: "month", periodStart: PERIOD_START.toISOString(), periodEnd: PERIOD_END.toISOString(), managed: false },
      { ...raw, role: null, managed: null },
    ]);
    expect(parsed).toEqual([
      item({ budgetCents: 990, role: "proactive" }),
      item({ budgetCents: 990, role: "reactive", period: "month", periodStart: PERIOD_START, periodEnd: PERIOD_END, managed: false }),
      item({ budgetCents: 990, role: null, managed: null }),
    ]);
  });
  it("a managed: null item holds only its own campaign, never the whole read", () => {
    expect(Array.isArray(parseSalesItems([raw, { ...raw, legKey: REACTIVE, managed: null }]))).toBe(true);
  });
  it("refuses an item naming no leg, a bad budget, an unknown period, a month with no period", () => {
    expect(typeof parseSalesItems([{ ...raw, legKey: null }])).toBe("string");
    expect(typeof parseSalesItems([{ ...raw, budgetCents: "abc" }])).toBe("string");
    expect(typeof parseSalesItems([{ ...raw, period: "week" }])).toBe("string");
    expect(typeof parseSalesItems([{ ...raw, period: "month" }])).toBe("string");
    expect(typeof parseSalesItems([{ ...raw, role: "sideways" }])).toBe("string");
    expect(typeof parseSalesItems([{ ...raw, managed: "yes" }])).toBe("string");
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
    expect(await verdict()).toEqual({ run: true, spentCents: 999, capCents: 1000, reactive: false });
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

describe("itemVerdict — monthly item (any payment mode): spend as fast as the work allows until the month's budget is used", () => {
  // Legistai shape: $90/month on the entry leg; billing's campaign-grain ceiling for that row is $90 / 30 = $3/day.
  const ceilingAt300 = {
    ok: true,
    brandDailyBudgetCents: 300,
    campaigns: [{ offerId: "offer-1", legKey: ENTRY, featureSlug: SALES, dailyBudgetCents: 300 }],
  };
  const m90 = (o: Partial<SalesItem> = {}) => monthly({ budgetCents: 9000, ...o });

  it("proactive, $0 spent this month: allowed past $3 today (billing's monthly/30 ceiling is not read)", async () => {
    mockFetchCampaignBudgets.mockResolvedValue(ceilingAt300);
    spend["c-1"] = { today: 2500, period: 2500 };
    expect(await verdict({ items: [m90()] })).toEqual({ run: true, spentCents: 2500, capCents: 9000, reactive: false });
    expect(mockFetchCampaignBudgets).not.toHaveBeenCalled();
  });

  it("proactive: the month's budget used → reached until the period resets", async () => {
    spend["c-1"] = { today: 4000, period: 9000 };
    const v = await verdict({ items: [m90()] });
    expect(v).toMatchObject({ run: false, kind: "reached", spentCents: 9000, capCents: 9000 });
    expect(v.run === false && v.detail).toContain("spent for the period");
  });

  it("reactive: same max on the period, never paced", async () => {
    mockFetchCampaignBudgets.mockResolvedValue(ceilingAt300);
    const reactiveCampaign = { ...CAMPAIGN, legKey: REACTIVE, featureSlug: AI_MEETING };
    const items = [m90({ legKey: REACTIVE, featureSlug: AI_MEETING, budgetCents: 900, role: "reactive" })];
    spend["c-1"] = { today: 800, period: 800 };
    expect(await verdict({ campaign: reactiveCampaign, items, reactive: true })).toEqual({ run: true, spentCents: 800, capCents: 900, reactive: true });
    spend["c-1"] = { today: 100, period: 900 };
    expect(await verdict({ campaign: reactiveCampaign, items, reactive: true })).toMatchObject({ run: false, kind: "reached" });
  });

  it("a person's own daily budget on the campaign still binds, against today's spend", async () => {
    spend["c-1"] = { today: 500, period: 500 };
    expect(await verdict({ items: [m90()], campaign: { ...CAMPAIGN, dailyBudgetCents: 500 } })).toMatchObject({ run: false, kind: "reached", capCents: 500 });
    expect(await verdict({ items: [m90()], campaign: { ...CAMPAIGN, dailyBudgetCents: 501 } })).toMatchObject({ run: true, capCents: 9000 });
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

  it("a monthly item is capped on the period, not paced (reactive leg read from the catalogue)", async () => {
    mockFetchBrandSalesBudget.mockResolvedValue({ ok: true, mode: "items", items: [monthly({ legKey: REACTIVE, featureSlug: AI_MEETING })] });
    // 2000 of 9900 spent this period, 600 of it today: a paced cap would refuse, the period cap does not.
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

  it("a campaign no item budgets is held as unfunded, and the global pot is never read", async () => {
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

  it("an item billing cannot classify (managed: null) holds that campaign only, as unreadable", async () => {
    mockFetchBrandSalesBudget.mockResolvedValue({
      ok: true,
      mode: "items",
      items: [item({ managed: null }), item({ legKey: REACTIVE, featureSlug: AI_MEETING })],
    });
    const deferred = await planBrandTurns(
      [claimed("email"), claimed("booker", { legKey: REACTIVE, featureSlug: AI_MEETING })],
      NOW,
    );
    expect(deferred.has("booker")).toBe(false);
    expect(holdsOf().map((h) => [h.campaign.id, h.reason])).toEqual([["email", "budgets_unreadable"]]);
  });

  it("billing's stated reactive role puts the leg first in its cohort, whatever the catalogue says", async () => {
    mockFetchBrandSalesBudget.mockResolvedValue({
      ok: true,
      mode: "items",
      // Both entry-leg per the catalogue; billing states the second reactive.
      items: [item(), item({ offerId: "offer-2", role: "reactive" })],
    });
    spend = { a: { today: 0 }, b: { today: 900 } };
    const deferred = await planBrandTurns([claimed("a"), claimed("b", { offerId: "offer-2" })], NOW);
    expect(deferred.has("b")).toBe(false);
    expect(deferred.has("a")).toBe(true);
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

// ── A brand billing does not serve items for (no subscriber monthly row) ──────────────────────────

describe("planBrandTurns — a brand NOT in items mode behaves exactly as before", () => {
  it("campaigns mode: no item verdict, no item hold, the campaign ceiling paces it as always", async () => {
    mockFetchBrandSalesBudget.mockResolvedValue({ ok: true, mode: "campaigns" });
    mockFetchCampaignBudgets.mockResolvedValue({
      ok: true,
      brandDailyBudgetCents: 5000,
      campaigns: [{ offerId: "offer-1", legKey: ENTRY, featureSlug: SALES, dailyBudgetCents: 1000 }],
    });
    spend = { email: { today: 10 } };
    const deferred = await planBrandTurns([claimed("email")], NOW);
    expect(deferred.has("email")).toBe(false);
    expect(holdsOf().filter((h) => h.reason === "item_budget_reached")).toEqual([]);
    // No monthly period window is ever asked outside items mode.
    for (const [arg] of mockGetStatsBudget.mock.calls) {
      expect((arg as { windows: Array<{ label: string }> }).windows.map((w) => w.label)).not.toContain("period");
    }
  });

  it("salesItemsGate leaves a campaigns-mode brand to today's path", async () => {
    mockFetchBrandSalesBudget.mockResolvedValue({ ok: true, mode: "campaigns" });
    expect(await salesItemsGate({ ...CAMPAIGN, brandIds: ["brand-1"] }, { orgId: "org-1" }, NOW)).toEqual({
      applies: false,
      salesBudget: { ok: true, mode: "campaigns" },
    });
    expect(mockGetStatsBudget).not.toHaveBeenCalled();
  });
});
