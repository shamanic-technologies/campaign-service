import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  campaignCeilingCents,
  ceilingEntriesOf,
  fetchCampaignBudgets,
  legKeylessFundedCeilings,
  type CampaignBudgetEntry,
  type CampaignBudgetsRead,
} from "../../src/lib/campaign-budget-client.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const SALES = "sales-cold-email-outreach";
const BOOKING = "ai-meeting-booking";

function read(campaigns: CampaignBudgetEntry[], brand: number | null = 500): Extract<CampaignBudgetsRead, { ok: true }> {
  return { ok: true, brandDailyBudgetCents: brand, campaigns };
}
const e = (over: Partial<CampaignBudgetEntry>): CampaignBudgetEntry => ({
  offerId: "offer-1", legKey: "start_to_conversation", featureSlug: SALES, dailyBudgetCents: 100, ...over,
});

describe("fetchCampaignBudgets", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    process.env.BILLING_SERVICE_URL = "https://billing.test.local/";
    process.env.BILLING_SERVICE_API_KEY = "key";
  });

  it("reads billing's campaign-budgets contract, org-scoped, and parses cents", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        brandId: "b",
        dailyBudgetCents: "500.0000000000",
        campaigns: [{ offerId: "o", legKey: null, featureSlug: BOOKING, dailyBudgetCents: "100.0000000000", updatedAt: "x" }],
      }),
    });
    const r = await fetchCampaignBudgets("brand-1", { orgId: "org-1" });
    expect(r).toEqual({
      ok: true,
      brandDailyBudgetCents: 500,
      campaigns: [{ offerId: "o", legKey: null, featureSlug: BOOKING, dailyBudgetCents: 100 }],
    });
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("https://billing.test.local/internal/brands/brand-1/campaign-budgets");
    expect(init.headers["x-org-id"]).toBe("org-1");
  });

  it("refuses the whole read on an unparseable ceiling, a missing array, or a non-2xx", async () => {
    for (const answer of [
      { ok: true, json: async () => ({ dailyBudgetCents: "1", campaigns: [{ featureSlug: SALES, dailyBudgetCents: "abc" }] }) },
      { ok: true, json: async () => ({ dailyBudgetCents: "1" }) },
      { ok: false, status: 500, json: async () => ({}) },
    ]) {
      mockFetch.mockResolvedValueOnce(answer);
      expect(await fetchCampaignBudgets("brand-1", { orgId: "org-1" })).toEqual({ ok: false });
    }
  });
});

describe("ceilingEntriesOf — billing's campaignCeilingRows, mirrored", () => {
  it("an exact (offer, leg, channel) entry is the campaign's", () => {
    const r = read([e({}), e({ legKey: "start_to_website_visit" })]);
    expect(ceilingEntriesOf(r, { featureSlug: SALES, offerId: "offer-1", legKey: "start_to_conversation" })).toHaveLength(1);
  });

  it("a leg-less entry counts only while its channel names no OTHER leg", () => {
    const legless = e({ legKey: null, featureSlug: BOOKING });
    const booking = { featureSlug: BOOKING, offerId: "offer-1", legKey: "conversation_to_meeting_booked" };
    expect(ceilingEntriesOf(read([legless, e({ legKey: "x_to_y" })]), booking)).toEqual([legless]);
    expect(ceilingEntriesOf(read([legless, e({ legKey: "x_to_y", featureSlug: BOOKING })]), booking)).toEqual([]);
  });

  it("an offer-less entry counts only while the brand names no OTHER offer", () => {
    const offerless = e({ offerId: null });
    const key = { featureSlug: SALES, offerId: "offer-1", legKey: "start_to_conversation" };
    expect(ceilingEntriesOf(read([offerless]), key)).toEqual([offerless]);
    expect(ceilingEntriesOf(read([offerless, e({ offerId: "offer-2", featureSlug: BOOKING })]), key)).toEqual([]);
  });

  it("a campaign not stating all of (offer, leg, channel) names no ceiling", () => {
    expect(ceilingEntriesOf(read([e({ legKey: null })]), { featureSlug: SALES, offerId: "offer-1", legKey: null })).toEqual([]);
  });
});

describe("campaignCeilingCents", () => {
  it("a brand with no per-campaign entries paces on its pot", () => {
    expect(campaignCeilingCents(read([], 700), {})).toEqual({ grain: "brand", cents: 700 });
  });

  it("sums the campaign's entries, and answers null — never the brand total — when none are its own", () => {
    const key = { featureSlug: SALES, offerId: "offer-1", legKey: "start_to_conversation" };
    expect(campaignCeilingCents(read([e({}), e({ dailyBudgetCents: 50 })]), key)).toEqual({ grain: "campaign", cents: 150 });
    expect(campaignCeilingCents(read([e({ legKey: "other" })]), key)).toEqual({ grain: "campaign", cents: null });
  });
});

describe("legKeylessFundedCeilings", () => {
  it("names only FUNDED entries that state no leg", () => {
    const funded = e({ legKey: null });
    expect(legKeylessFundedCeilings(read([funded, e({ legKey: null, dailyBudgetCents: 0 }), e({})]))).toEqual([funded]);
  });
});
