import { describe, it, expect, beforeEach, vi } from "vitest";

const { mockGetStatsBudget, mockFindMany, mockFetchBrandSalesBudget } = vi.hoisted(() => ({
  mockGetStatsBudget: vi.fn(),
  mockFindMany: vi.fn(),
  mockFetchBrandSalesBudget: vi.fn(),
}));

vi.mock("@distribute/runs-client", () => ({ getStatsBudget: (p: { featureSlug?: string }) => (p?.featureSlug?.startsWith("sourcing-") ? Promise.resolve({ windows: [] }) : mockGetStatsBudget(p)) }));
vi.mock("../../src/db/index.js", () => ({ db: { query: { campaigns: { findMany: mockFindMany } } } }));
vi.mock("../../src/db/schema.js", () => ({ campaigns: {} }));
vi.mock("drizzle-orm", () => ({ and: vi.fn(), eq: vi.fn(), arrayContains: vi.fn() }));
vi.mock("../../src/lib/brand-sales-budget-client.js", () => ({ fetchBrandSalesBudget: mockFetchBrandSalesBudget }));

import { globalSalesPotBlock, potRecheckAt, POT_RECHECK_MS } from "../../src/lib/global-sales-pot.js";

const SALES = "sales-cold-email-outreach";
const AI_MEETING = "ai-meeting-booking";
const NOW = new Date(2026, 9, 3, 12, 0, 0);

let spendById: Record<string, number | null> = {};

function rows(rs: Array<{ id: string; featureSlug: string; spent: number | null; status?: string; updatedAt?: Date }>) {
  spendById = {};
  for (const r of rs) spendById[r.id] = r.spent;
  mockFindMany.mockResolvedValue(
    rs.map((r) => ({ id: r.id, featureSlug: r.featureSlug, status: r.status ?? "ongoing", updatedAt: r.updatedAt ?? new Date() })),
  );
}

const input = { orgId: "org-1", brandId: "brand-1", featureSlug: SALES, identity: { orgId: "org-1" } };

beforeEach(() => {
  vi.clearAllMocks();
  mockGetStatsBudget.mockImplementation(async ({ campaignId }: { campaignId: string }) => {
    const cents = spendById[campaignId];
    if (cents === null) throw new Error("runs-service down");
    return { windows: [{ label: "today", totalCostInUsdCents: String(cents ?? 0), netTotalCostInUsdCents: String(cents ?? 0) }] };
  });
});

describe("globalSalesPotBlock", () => {
  it("a brand not in global mode is never stopped by the pot, and its spend is not read", async () => {
    mockFetchBrandSalesBudget.mockResolvedValue({ ok: true, mode: "campaigns" });
    expect(await globalSalesPotBlock(input, NOW)).toBeNull();
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it("AC: $10 pot, reactive $4 + entry $5.90 → still runs; reactive $4 + entry $6 → refused", async () => {
    mockFetchBrandSalesBudget.mockResolvedValue({ ok: true, mode: "global", dailyBudgetCents: 1000 });
    rows([
      { id: "booker", featureSlug: AI_MEETING, spent: 400 },
      { id: "email", featureSlug: SALES, spent: 590 },
    ]);
    expect(await globalSalesPotBlock(input, NOW)).toBeNull();

    rows([
      { id: "booker", featureSlug: AI_MEETING, spent: 400 },
      { id: "email", featureSlug: SALES, spent: 600 },
    ]);
    const block = await globalSalesPotBlock(input, NOW);
    expect(block).toMatchObject({ reason: "Global sales budget reached", nextRunAt: new Date(NOW.getTime() + POT_RECHECK_MS) });
  });

  it("each campaign's spend is read under its OWN channel", async () => {
    mockFetchBrandSalesBudget.mockResolvedValue({ ok: true, mode: "global", dailyBudgetCents: 1000 });
    rows([{ id: "booker", featureSlug: AI_MEETING, spent: 0 }]);
    await globalSalesPotBlock(input, NOW);
    expect(mockGetStatsBudget).toHaveBeenCalledWith(expect.objectContaining({ campaignId: "booker", featureSlug: AI_MEETING }));
  });

  it("counts a campaign stopped today, not one stopped before today, nor a non-sales one", async () => {
    mockFetchBrandSalesBudget.mockResolvedValue({ ok: true, mode: "global", dailyBudgetCents: 1000 });
    rows([
      { id: "stopped-today", featureSlug: SALES, spent: 1000, status: "stopped", updatedAt: new Date() },
      { id: "pr", featureSlug: "pr-expert-quote-opportunities", spent: 5000 },
    ]);
    expect((await globalSalesPotBlock(input, NOW))?.reason).toBe("Global sales budget reached");

    rows([
      { id: "stopped-long-ago", featureSlug: SALES, spent: 1000, status: "stopped", updatedAt: new Date(2020, 0, 1) },
      { id: "pr", featureSlug: "pr-expert-quote-opportunities", spent: 5000 },
    ]);
    expect(await globalSalesPotBlock(input, NOW)).toBeNull();
  });

  it("fail-closed: an unreadable spend or mode refuses", async () => {
    mockFetchBrandSalesBudget.mockResolvedValue({ ok: true, mode: "global", dailyBudgetCents: 1000 });
    rows([{ id: "email", featureSlug: SALES, spent: null }]);
    expect((await globalSalesPotBlock(input, NOW))?.reason).toBe("Global sales budget unavailable");

    mockFetchBrandSalesBudget.mockResolvedValue({ ok: false, detail: "HTTP 500" });
    expect((await globalSalesPotBlock(input, NOW))?.reason).toBe("Global sales budget unavailable");
  });

  it("a $0 pot refuses", async () => {
    mockFetchBrandSalesBudget.mockResolvedValue({ ok: true, mode: "global", dailyBudgetCents: 0 });
    rows([]);
    expect((await globalSalesPotBlock(input, NOW))?.reason).toBe("Global sales budget reached");
  });
});

describe("potRecheckAt", () => {
  it("ten minutes, or the rollover when it is nearer", () => {
    expect(potRecheckAt(NOW)).toEqual(new Date(NOW.getTime() + POT_RECHECK_MS));
    expect(potRecheckAt(new Date(2026, 9, 3, 23, 55, 0))).toEqual(new Date(2026, 9, 4, 0, 0, 0));
  });
});
