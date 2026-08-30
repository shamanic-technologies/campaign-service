import { describe, it, expect, vi } from "vitest";
import {
  fetchFunnelBudgets,
  legCeilingCents,
  fundedLegRows,
  type FunnelBudgetsRead,
} from "../../src/lib/funnel-budget-client.js";
import { fundingFromBudgets } from "../../src/lib/campaign-funding.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const IDENTITY = { orgId: "org-1", userId: "user-1" };

const FUNNEL = "sales_meetings_from_conversation";
const SALES = "sales-cold-email-outreach";
const FEEDBACK = "feedback-request-cold-email-outreach";
const OFFER_A = "d5ecba00-783a-4939-b5bd-f85b9e6b7d9e";
const OFFER_B = "8f1e2c44-6a10-4d3b-9c77-1b2a3c4d5e6f";
// features-service MINTS these; they are carried verbatim and never parsed.
const BOOKING_LEG = "conversation_to_meeting_booked";
const ATTENDED_LEG = "meeting_booked_to_meeting_attended";

type LegRow = {
  funnelKey: string;
  featureSlug: string;
  offerId: string | null;
  legKey: string | null;
  dailyBudgetCents: number;
};

/**
 * A read shaped as billing serves it: every coarser grain is the SUM of the leg rows, which is
 * exactly what makes the offer figure the wrong ceiling for an offer worked for two legs.
 */
function readWith(legs: LegRow[]): Extract<FunnelBudgetsRead, { ok: true }> {
  const offers = new Map<string, { funnelKey: string; featureSlug: string; offerId: string | null; dailyBudgetCents: number }>();
  for (const l of legs) {
    const key = `${l.funnelKey}|${l.featureSlug}|${l.offerId ?? ""}`;
    const seen = offers.get(key);
    if (seen) seen.dailyBudgetCents += l.dailyBudgetCents;
    else offers.set(key, { funnelKey: l.funnelKey, featureSlug: l.featureSlug, offerId: l.offerId, dailyBudgetCents: l.dailyBudgetCents });
  }
  const offerRows = [...offers.values()];
  const total = legs.reduce((s, l) => s + l.dailyBudgetCents, 0);
  return {
    ok: true,
    brandDailyBudgetCents: total,
    funnels: [{ funnelKey: FUNNEL, dailyBudgetCents: total }],
    channels: offerRows.map((o) => ({ funnelKey: o.funnelKey, featureSlug: o.featureSlug, dailyBudgetCents: o.dailyBudgetCents })),
    offers: offerRows,
    legs,
  };
}

describe("legCeilingCents", () => {
  it("binds a campaign to its OWN leg's money, never the offer SUM the sibling leg is in", () => {
    const read = readWith([
      { funnelKey: FUNNEL, featureSlug: SALES, offerId: OFFER_A, legKey: BOOKING_LEG, dailyBudgetCents: 2000 },
      { funnelKey: FUNNEL, featureSlug: SALES, offerId: OFFER_A, legKey: ATTENDED_LEG, dailyBudgetCents: 1000 },
    ]);
    // The offer figure is 3000 — the SUM. Pacing either campaign on it hands each the other's money.
    expect(read.offers[0]!.dailyBudgetCents).toBe(3000);
    expect(legCeilingCents(read, FUNNEL, SALES, OFFER_A, BOOKING_LEG)).toEqual({ grain: "leg", cents: 2000 });
    expect(legCeilingCents(read, FUNNEL, SALES, OFFER_A, ATTENDED_LEG)).toEqual({ grain: "leg", cents: 1000 });
  });

  it("says UNFUNDED for a leg the brand's money is not scoped to — never a fallback", () => {
    const read = readWith([
      { funnelKey: FUNNEL, featureSlug: SALES, offerId: OFFER_A, legKey: BOOKING_LEG, dailyBudgetCents: 2000 },
    ]);
    expect(legCeilingCents(read, FUNNEL, SALES, OFFER_A, ATTENDED_LEG)).toEqual({ grain: "leg", cents: null });
  });

  it("has nothing to say about a campaign that states NO leg", () => {
    const read = readWith([
      { funnelKey: FUNNEL, featureSlug: SALES, offerId: OFFER_A, legKey: BOOKING_LEG, dailyBudgetCents: 2000 },
    ]);
    expect(legCeilingCents(read, FUNNEL, SALES, OFFER_A, null)).toEqual({ grain: "none" });
  });

  it("has nothing to say about a brand whose ceilings name no leg at all", () => {
    const read = readWith([
      { funnelKey: FUNNEL, featureSlug: SALES, offerId: OFFER_A, legKey: null, dailyBudgetCents: 2000 },
    ]);
    expect(legCeilingCents(read, FUNNEL, SALES, OFFER_A, BOOKING_LEG)).toEqual({ grain: "none" });
  });

  it("has nothing to say when billing serves no leg grain at all (an older deploy)", () => {
    const read = { ...readWith([]), legs: [] };
    expect(legCeilingCents(read, FUNNEL, SALES, OFFER_A, BOOKING_LEG)).toEqual({ grain: "none" });
  });

  it("binds whatever feature the campaign states when the funnel is worked through ONE channel", () => {
    const read = readWith([
      { funnelKey: FUNNEL, featureSlug: SALES, offerId: OFFER_A, legKey: BOOKING_LEG, dailyBudgetCents: 2000 },
    ]);
    expect(legCeilingCents(read, FUNNEL, FEEDBACK, OFFER_A, BOOKING_LEG)).toEqual({ grain: "leg", cents: 2000 });
  });

  it("refuses the neighbour's money when the funnel IS split across channels", () => {
    const read = readWith([
      { funnelKey: FUNNEL, featureSlug: SALES, offerId: OFFER_A, legKey: BOOKING_LEG, dailyBudgetCents: 2000 },
      { funnelKey: FUNNEL, featureSlug: FEEDBACK, offerId: OFFER_A, legKey: BOOKING_LEG, dailyBudgetCents: 500 },
    ]);
    expect(legCeilingCents(read, FUNNEL, "google-ads", OFFER_A, BOOKING_LEG)).toEqual({ grain: "leg", cents: null });
  });

  it("keeps billing's offer rule: another offer's leg money is not this offer's", () => {
    const read = readWith([
      { funnelKey: FUNNEL, featureSlug: SALES, offerId: OFFER_A, legKey: BOOKING_LEG, dailyBudgetCents: 2000 },
      { funnelKey: FUNNEL, featureSlug: SALES, offerId: OFFER_B, legKey: BOOKING_LEG, dailyBudgetCents: 500 },
    ]);
    expect(legCeilingCents(read, FUNNEL, SALES, OFFER_A, BOOKING_LEG)).toEqual({ grain: "leg", cents: 2000 });
    expect(legCeilingCents(read, FUNNEL, SALES, OFFER_B, BOOKING_LEG)).toEqual({ grain: "leg", cents: 500 });
  });

  it("falls through unchanged when the brand's money is scoped to offers and the campaign states none", () => {
    const read = readWith([
      { funnelKey: FUNNEL, featureSlug: SALES, offerId: OFFER_A, legKey: BOOKING_LEG, dailyBudgetCents: 2000 },
    ]);
    expect(legCeilingCents(read, FUNNEL, SALES, null, BOOKING_LEG)).toEqual({ grain: "none" });
  });
});

describe("fundingFromBudgets — the leg notch", () => {
  it("paces a leg campaign on its own leg's ceiling", () => {
    const read = readWith([
      { funnelKey: FUNNEL, featureSlug: SALES, offerId: OFFER_A, legKey: BOOKING_LEG, dailyBudgetCents: 2000 },
      { funnelKey: FUNNEL, featureSlug: SALES, offerId: OFFER_A, legKey: ATTENDED_LEG, dailyBudgetCents: 1000 },
    ]);
    expect(
      fundingFromBudgets(
        { funnelKey: FUNNEL, featureSlug: SALES, offerId: OFFER_A, legKey: ATTENDED_LEG },
        read,
      ),
    ).toEqual({ funded: true, ceilingCents: 1000 });
  });

  it("holds a campaign whose leg the customer funds nothing for", () => {
    const read = readWith([
      { funnelKey: FUNNEL, featureSlug: SALES, offerId: OFFER_A, legKey: BOOKING_LEG, dailyBudgetCents: 2000 },
    ]);
    const verdict = fundingFromBudgets(
      { funnelKey: FUNNEL, featureSlug: SALES, offerId: OFFER_A, legKey: ATTENDED_LEG },
      read,
    );
    expect(verdict.funded).toBe(false);
  });

  it("leaves a leg-less campaign on the offer figure, byte for byte", () => {
    const read = readWith([
      { funnelKey: FUNNEL, featureSlug: SALES, offerId: OFFER_A, legKey: BOOKING_LEG, dailyBudgetCents: 2000 },
      { funnelKey: FUNNEL, featureSlug: SALES, offerId: OFFER_A, legKey: ATTENDED_LEG, dailyBudgetCents: 1000 },
    ]);
    expect(
      fundingFromBudgets({ funnelKey: FUNNEL, featureSlug: SALES, offerId: OFFER_A }, read),
    ).toEqual({ funded: true, ceilingCents: 3000 });
  });
});

describe("fetchFunnelBudgets — the leg grain on the wire", () => {
  function respond(body: unknown) {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => body });
  }

  it("carries the leg rows, canonicalising the funnel and keeping a null leg as a VALUE", async () => {
    process.env.BILLING_SERVICE_URL = "https://billing.test.local";
    process.env.BILLING_SERVICE_API_KEY = "k";
    respond({
      brandId: "brand-1",
      dailyBudgetCents: "3000",
      funnels: [{ funnelKey: "reply_meeting", dailyBudgetCents: "3000" }],
      legs: [
        { funnelKey: "reply_meeting", featureSlug: SALES, offerId: OFFER_A, legKey: BOOKING_LEG, dailyBudgetCents: "2000" },
        { funnelKey: "reply_meeting", featureSlug: SALES, offerId: null, legKey: null, dailyBudgetCents: "1000" },
      ],
    });

    const read = await fetchFunnelBudgets("brand-1", IDENTITY);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.legs).toEqual([
      { funnelKey: FUNNEL, featureSlug: SALES, offerId: OFFER_A, legKey: BOOKING_LEG, dailyBudgetCents: 2000 },
      { funnelKey: FUNNEL, featureSlug: SALES, offerId: null, legKey: null, dailyBudgetCents: 1000 },
    ]);
    // A ceiling of zero is a deliberate "do not work this", at every grain.
    expect(fundedLegRows(read)).toHaveLength(2);
  });

  it("reads an ABSENT legs field as no finer grain, never as nothing funded", async () => {
    process.env.BILLING_SERVICE_URL = "https://billing.test.local";
    process.env.BILLING_SERVICE_API_KEY = "k";
    respond({
      brandId: "brand-1",
      dailyBudgetCents: "3000",
      funnels: [{ funnelKey: "reply_meeting", dailyBudgetCents: "3000" }],
    });

    const read = await fetchFunnelBudgets("brand-1", IDENTITY);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.legs).toEqual([]);
    expect(read.funnels[0]!.dailyBudgetCents).toBe(3000);
  });

  it("refuses the whole read on an unparseable leg ceiling — never reads it as no ceiling", async () => {
    process.env.BILLING_SERVICE_URL = "https://billing.test.local";
    process.env.BILLING_SERVICE_API_KEY = "k";
    respond({
      brandId: "brand-1",
      dailyBudgetCents: "3000",
      funnels: [{ funnelKey: "reply_meeting", dailyBudgetCents: "3000" }],
      legs: [{ funnelKey: "reply_meeting", featureSlug: SALES, offerId: null, legKey: BOOKING_LEG, dailyBudgetCents: "not-a-number" }],
    });

    expect((await fetchFunnelBudgets("brand-1", IDENTITY)).ok).toBe(false);
  });
});
