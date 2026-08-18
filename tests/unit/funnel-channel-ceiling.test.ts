import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  channelCeilingCents,
  fetchFunnelBudgets,
  fundedChannelPairs,
  type FunnelBudgetsRead,
} from "../../src/lib/funnel-budget-client.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const IDENTITY = { orgId: "org-1", userId: "user-1" };

function read(
  channels: Array<{ funnelKey: string; featureSlug: string; dailyBudgetCents: number }>,
): Extract<FunnelBudgetsRead, { ok: true }> {
  return {
    ok: true,
    brandDailyBudgetCents: 3000,
    funnels: [{ funnelKey: "sales_meetings_from_conversation", dailyBudgetCents: 3000 }],
    channels: channels as never,
  };
}

const SALES = "sales-cold-email-outreach";
const FEEDBACK = "sales-feedback-request-cold-email-outreach";

describe("the ceiling that binds one (funnel, acquisition channel) pair", () => {
  it("answers 'no finer grain' when billing states no pair for the funnel", () => {
    // An older billing deploy, or a brand that funds nothing per funnel. The caller falls through
    // to the funnel figure, i.e. today's behaviour — never to 'unfunded'.
    expect(channelCeilingCents(read([]), "sales_meetings_from_conversation", SALES)).toEqual({
      grain: "none",
    });
  });

  it("gives each channel of a split funnel its OWN ceiling", () => {
    const budgets = read([
      { funnelKey: "sales_meetings_from_conversation", featureSlug: SALES, dailyBudgetCents: 2000 },
      { funnelKey: "sales_meetings_from_conversation", featureSlug: FEEDBACK, dailyBudgetCents: 1000 },
    ]);
    expect(channelCeilingCents(budgets, "sales_meetings_from_conversation", SALES)).toEqual({
      grain: "pair",
      cents: 2000,
    });
    expect(channelCeilingCents(budgets, "sales_meetings_from_conversation", FEEDBACK)).toEqual({
      grain: "pair",
      cents: 1000,
    });
  });

  it("is UNFUNDED — never the funnel total — for a channel a split funnel does not fund", () => {
    const budgets = read([
      { funnelKey: "sales_meetings_from_conversation", featureSlug: SALES, dailyBudgetCents: 2000 },
      { funnelKey: "sales_meetings_from_conversation", featureSlug: "sales-crm-email-outreach", dailyBudgetCents: 1000 },
    ]);
    // Falling back would be one offer spending the money the other was funded for.
    expect(channelCeilingCents(budgets, "sales_meetings_from_conversation", FEEDBACK)).toEqual({
      grain: "pair",
      cents: null,
    });
  });

  it("binds whatever feature the campaign states when the funnel funds exactly ONE channel", () => {
    // billing's own rule for a write naming no channel, and what keeps every brand funding one
    // channel per funnel — including those whose single ceiling was attributed to the default
    // channel while their campaign runs another sales feature — behaving exactly as before.
    const budgets = read([
      { funnelKey: "sales_meetings_from_conversation", featureSlug: SALES, dailyBudgetCents: 2000 },
    ]);
    expect(channelCeilingCents(budgets, "sales_meetings_from_conversation", "sales-crm-email-outreach")).toEqual({
      grain: "pair",
      cents: 2000,
    });
  });

  it("counts a pair funded at zero as funded-at-zero, not as absent", () => {
    const budgets = read([
      { funnelKey: "sales_meetings_from_conversation", featureSlug: SALES, dailyBudgetCents: 0 },
      { funnelKey: "sales_meetings_from_conversation", featureSlug: FEEDBACK, dailyBudgetCents: 1000 },
    ]);
    expect(channelCeilingCents(budgets, "sales_meetings_from_conversation", SALES)).toEqual({
      grain: "pair",
      cents: 0,
    });
    expect(fundedChannelPairs(budgets).map((p) => p.featureSlug)).toEqual([FEEDBACK]);
  });
});

describe("reading the pair grain off billing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.BILLING_SERVICE_URL = "https://billing.test.local";
    process.env.BILLING_SERVICE_API_KEY = "billing-key";
  });

  function billingSays(body: unknown) {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => body });
  }

  it("reads an ABSENT channels field as no finer grain, not as nothing funded", async () => {
    billingSays({
      brandId: "brand-1",
      dailyBudgetCents: "3000",
      funnels: [{ funnelKey: "reply_meeting", dailyBudgetCents: "3000", updatedAt: null }],
    });
    const result = await fetchFunnelBudgets("brand-1", IDENTITY);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.channels).toEqual([]);
    expect(result.funnels).toHaveLength(1);
  });

  it("canonicalises the funnel of a pair, because billing still emits the pre-rename spelling", async () => {
    billingSays({
      brandId: "brand-1",
      dailyBudgetCents: "3000",
      funnels: [{ funnelKey: "reply_meeting", dailyBudgetCents: "3000", updatedAt: null }],
      channels: [
        { funnelKey: "reply_meeting", featureSlug: SALES, dailyBudgetCents: "2000", updatedAt: null },
        { funnelKey: "reply_meeting", featureSlug: FEEDBACK, dailyBudgetCents: "1000", updatedAt: null },
      ],
    });
    const result = await fetchFunnelBudgets("brand-1", IDENTITY);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.channels.map((c) => c.funnelKey)).toEqual([
      "sales_meetings_from_conversation",
      "sales_meetings_from_conversation",
    ]);
  });

  it("refuses the whole read on an unparseable pair ceiling", async () => {
    // A ceiling we cannot read must never be read as no ceiling — the same stance the per-funnel
    // figures take.
    billingSays({
      brandId: "brand-1",
      dailyBudgetCents: "3000",
      funnels: [],
      channels: [{ funnelKey: "reply_meeting", featureSlug: SALES, dailyBudgetCents: "not-a-number" }],
    });
    expect(await fetchFunnelBudgets("brand-1", IDENTITY)).toEqual({ ok: false });
  });
});
