import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * A brand is a globally-shared identity and an OFFER belongs to the (org, brand) pair, so "which
 * funnels does this brand sell through?" stops having one answer the day a customer creates their
 * second offer. brand-service refuses the brand-keyed read at that point rather than guessing.
 *
 * These tests pin the two halves of the fix: the question is asked at the OFFER grain (which
 * always has exactly one answer), and a refusal is never laundered into "declares nothing".
 */

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
  // Provisioning states an ancestor run on every read it makes — the seeds below already carry
  // one, so these exist to fail loudly if a path ever mints a second.
  createRun: vi.fn(async () => {
    throw new Error("createRun must not be called: the seed already states an ancestor run");
  }),
  updateRun: vi.fn(),
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
    // Raw-SQL seam. The funnel-less-ancestor adoption runs through it and is inert here: these
    // tests pin which QUESTIONS provisioning asks, not what the rule writes (that is measured
    // against a real database in tests/integration/stopped-ancestor-funnel-rerun.test.ts).
    execute: vi.fn().mockResolvedValue([]),
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
    offerId: "offer_id",
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
  fetchOfferSalesFunnels,
  fetchBrandSalesFunnels,
} from "../../src/lib/brand-sales-funnels-client.js";
import { planFunnelTurns, type ClaimedFunnelCampaign } from "../../src/lib/funnel-campaigns.js";
import { SALES_FUNNEL_KEYS } from "../../src/lib/sales-funnel-vocabulary.js";

const SALES = "sales-cold-email-outreach";
const OFFER_A = "11111111-1111-4111-8111-111111111111";
const OFFER_B = "22222222-2222-4222-8222-222222222222";

const IDENTITY = { orgId: "org-1", userId: "user-1", campaignId: "campaign-1" };

function claimed(overrides: Partial<ClaimedFunnelCampaign> = {}): ClaimedFunnelCampaign {
  return {
    id: "campaign-1",
    orgId: "org-1",
    createdByUserId: "user-1",
    parentRunId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    workflowSlug: "sales-email-cold-outreach",
    brandIds: ["brand-1"],
    featureSlug: SALES,
    funnelKey: null,
    dailyBudgetCents: null,
    offerId: null,
    ...overrides,
  };
}

function funnelsPayload(funnels: Array<{ funnelKey: string; active?: boolean }>) {
  return {
    funnels: funnels.map((f) => ({
      funnelKey: f.funnelKey,
      active: f.active ?? true,
      name: f.funnelKey,
      steps: [],
      rates: {},
      lifetimeRevenueUsd: null,
      destinationUrl: null,
      bookingUrl: null,
      updatedAt: "2026-08-19T00:00:00.000Z",
    })),
  };
}

/** billing still emits the pre-rename spellings — every ceiling below is stated its way. */
function mockFunnelBudgets(funnels: Array<{ funnelKey: string; dailyBudgetCents: string }>) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      brandId: "brand-1",
      dailyBudgetCents: String(funnels.reduce((s, f) => s + Number(f.dailyBudgetCents), 0)),
      funnels: funnels.map((f) => ({ ...f, updatedAt: null })),
    }),
  });
}

function mockDeclared(funnels: Array<{ funnelKey: string; active?: boolean }>) {
  mockFetch.mockResolvedValueOnce({ ok: true, json: async () => funnelsPayload(funnels) });
}

/** brand-service refusing to guess which offer (or org) the caller meant. */
function mockRefusal(status: number, code?: string) {
  mockFetch.mockResolvedValueOnce({
    ok: false,
    status,
    text: async () => (code ? JSON.stringify({ code }) : ""),
  });
}

function mockSpend(cents: string) {
  mockGetStatsBudget.mockResolvedValueOnce({
    windows: [{ label: "today", totalCostInUsdCents: cents, netTotalCostInUsdCents: cents }],
  });
}

let warnings: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  process.env.BRAND_SERVICE_URL = "https://brand.test";
  process.env.BRAND_SERVICE_API_KEY = "brand-key";
  process.env.BILLING_SERVICE_URL = "https://billing.test";
  process.env.BILLING_SERVICE_API_KEY = "billing-key";
  process.env.FEATURES_SERVICE_URL = "https://features.test";
  process.env.FEATURES_SERVICE_API_KEY = "features-key";
  process.env.WORKFLOW_SERVICE_URL = "https://workflow.test";
  process.env.WORKFLOW_SERVICE_API_KEY = "workflow-key";
  // The per-CHANNEL reads (which funnels a channel may sell, which workflow runs it) are answered
  // by URL, so the ordered `mockResolvedValueOnce` queue above keeps describing the
  // billing → brand/offer sequence and nothing else.
  mockFetch.mockImplementation(async (input: URL | string) => {
    const url = String(input);
    if (url.includes("/features/")) {
      return { ok: true, json: async () => ({ feature: { slug: url.split("/features/")[1], salesFunnels: [...SALES_FUNNEL_KEYS] } }) };
    }
    if (url.includes("/workflows")) {
      return {
        ok: true,
        json: async () => ({
          workflows: [{ workflowSlug: "seed-workflow", createdAt: "2026-08-18T00:00:00.000Z" }],
        }),
      };
    }
    if (url.includes("/public/channels")) {
      return { ok: true, json: async () => ({ channels: [], steps: [] }) };
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  });
  mockListRuns.mockResolvedValue({ runs: [] });
  mockFindMany.mockResolvedValue([{ id: "campaign-1", featureSlug: SALES }]);
  mockFindFirst.mockResolvedValue(undefined);
  mockInsertValues.mockResolvedValue(undefined);
  warnings = [];
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("sales-funnels reads keep the three outcomes apart", () => {
  it("reads ONE offer's funnels at the offer grain, naming the org", async () => {
    mockDeclared([{ funnelKey: "website_purchases" }]);

    const read = await fetchOfferSalesFunnels(OFFER_A, IDENTITY);

    expect(read).toEqual({ ok: true, funnels: [{ funnelKey: "website_purchases", active: true }] });
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(`https://brand.test/internal/offers/${OFFER_A}/sales-funnels`);
    expect(init.headers["x-org-id"]).toBe("org-1");
  });

  it("an EMPTY list is a truthful answer, not a failure", async () => {
    mockDeclared([]);
    await expect(fetchBrandSalesFunnels("brand-1", IDENTITY)).resolves.toEqual({
      ok: true,
      funnels: [],
    });
  });

  it("a 409 refusal is `ambiguous` — never an empty declaration", async () => {
    mockRefusal(409, "MULTIPLE_OFFERS");
    const read = await fetchBrandSalesFunnels("brand-1", IDENTITY);
    expect(read.ok).toBe(false);
    expect(read).toMatchObject({ reason: "ambiguous" });
  });

  it("a refusal dressed as a 400 is still `ambiguous`, matched on its code", async () => {
    mockRefusal(400, "OFFER_REQUIRED");
    expect(await fetchBrandSalesFunnels("brand-1", IDENTITY)).toMatchObject({ reason: "ambiguous" });
  });

  it("a transport failure is `unavailable`, and is NOT the same answer as a refusal", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ECONNRESET"));
    expect(await fetchOfferSalesFunnels(OFFER_A, IDENTITY)).toMatchObject({ reason: "unavailable" });

    mockRefusal(500);
    expect(await fetchBrandSalesFunnels("brand-1", IDENTITY)).toMatchObject({
      reason: "unavailable",
    });
  });

  it("an offer id that names nothing is `unknown_offer` — retrying never fixes it", async () => {
    mockRefusal(404);
    expect(await fetchOfferSalesFunnels(OFFER_A, IDENTITY)).toMatchObject({
      reason: "unknown_offer",
    });
  });

  it("an inactive funnel is never returned, whatever ceiling billing still holds", async () => {
    mockDeclared([{ funnelKey: "website_purchases", active: false }, { funnelKey: "form_magnet" }]);
    expect(await fetchOfferSalesFunnels(OFFER_A, IDENTITY)).toEqual({
      ok: true,
      funnels: [{ funnelKey: "form_magnet", active: true }],
    });
  });
});

describe("provisioning asks at the grain that has one answer", () => {
  it("a campaign stating NO offer keeps the brand-keyed read, exactly as before offers existed", async () => {
    mockFunnelBudgets([{ funnelKey: "visit_signup", dailyBudgetCents: "1000" }]);
    mockDeclared([{ funnelKey: "website_purchases" }]);
    mockSpend("0");

    await planFunnelTurns([claimed({ offerId: null })]);

    const urls = mockFetch.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("/internal/brands/brand-1/sales-funnels"))).toBe(true);
    expect(urls.some((u) => u.includes("/internal/offers/"))).toBe(false);
  });

  it("a brand selling SEVERAL offers is still arbitrated — each campaign on its own offer's funnels", async () => {
    // Two campaigns of one brand, each selling a different offer. The brand-keyed read would be
    // refused here; the offer-keyed reads each have exactly one answer.
    mockFunnelBudgets([
      { funnelKey: "visit_signup", dailyBudgetCents: "1000" },
      { funnelKey: "reply_meeting", dailyBudgetCents: "1000" },
    ]);
    mockDeclared([{ funnelKey: "website_purchases" }]); // offer A
    mockDeclared([{ funnelKey: "sales_meetings_from_conversation" }]); // offer B
    mockSpend("900"); // A is 90% full
    mockSpend("100"); // B is 10% full

    const now = new Date("2026-08-19T10:00:00Z");
    const deferred = await planFunnelTurns(
      [
        claimed({ id: "c-a", funnelKey: "website_purchases", offerId: OFFER_A }),
        claimed({ id: "c-b", funnelKey: "sales_meetings_from_conversation", offerId: OFFER_B }),
      ],
      now,
    );

    const urls = mockFetch.mock.calls.map((c) => String(c[0]));
    expect(urls).toContain(`https://brand.test/internal/offers/${OFFER_A}/sales-funnels`);
    expect(urls).toContain(`https://brand.test/internal/offers/${OFFER_B}/sales-funnels`);
    // No campaign of the group states no offer, so the ambiguous brand-keyed read is never made.
    expect(urls.some((u) => u.includes("/internal/brands/brand-1/sales-funnels"))).toBe(false);
    // Both funnels are declared, so both stay in the running and the emptiest takes the turn.
    expect(deferred.has("c-b")).toBe(false);
    expect(deferred.has("c-a")).toBe(true);
    expect(warnings).toEqual([]);
  });

  it("a campaign provisioned from an offer's declaration CARRIES that offer", async () => {
    mockFunnelBudgets([
      { funnelKey: "visit_signup", dailyBudgetCents: "1000" },
      { funnelKey: "reply_meeting", dailyBudgetCents: "1000" },
    ]);
    mockDeclared([
      { funnelKey: "website_purchases" },
      { funnelKey: "sales_meetings_from_conversation" },
    ]);
    mockSpend("0");

    await planFunnelTurns([
      claimed({ id: "c-a", funnelKey: "website_purchases", offerId: OFFER_A }),
    ]);

    const inserted = mockInsertValues.mock.calls.map((c) => c[0]);
    const meeting = inserted.find((v) => v.funnelKey === "sales_meetings_from_conversation");
    expect(meeting).toBeDefined();
    expect(meeting.offerId).toBe(OFFER_A);
  });

  it("a REFUSAL provisions nothing and says so — it is not read as 'declares nothing'", async () => {
    mockFunnelBudgets([{ funnelKey: "visit_signup", dailyBudgetCents: "1000" }]);
    mockRefusal(409, "MULTIPLE_OFFERS"); // the brand-keyed read on a multi-offer brand
    mockSpend("0");

    await planFunnelTurns([claimed({ offerId: null })]);

    expect(mockInsertValues).not.toHaveBeenCalled();
    expect(warnings.join("\n")).toMatch(/REFUSAL, not an empty declaration/);
  });

  it("a transport failure is logged as a transport failure, not as a refusal", async () => {
    mockFunnelBudgets([{ funnelKey: "visit_signup", dailyBudgetCents: "1000" }]);
    mockFetch.mockRejectedValueOnce(new Error("ECONNRESET"));
    mockSpend("0");

    await planFunnelTurns([claimed({ offerId: null })]);

    expect(mockInsertValues).not.toHaveBeenCalled();
    expect(warnings.join("\n")).toMatch(/unavailable/);
    expect(warnings.join("\n")).not.toMatch(/REFUSAL/);
  });

  it("a funnel SEVERAL offers of one brand declare is not provisioned for either — none outranks another", async () => {
    mockFunnelBudgets([{ funnelKey: "visit_signup", dailyBudgetCents: "1000" }]);
    mockDeclared([{ funnelKey: "website_purchases" }]); // offer A
    mockDeclared([{ funnelKey: "website_purchases" }]); // offer B sells the same chain
    mockSpend("0");
    mockSpend("0");

    await planFunnelTurns([
      claimed({ id: "c-a", funnelKey: "website_purchases", offerId: OFFER_A }),
      claimed({ id: "c-b", funnelKey: "website_purchases", offerId: OFFER_B }),
    ]);

    expect(mockInsertValues).not.toHaveBeenCalled();
    expect(warnings.join("\n")).toMatch(/several offers of this brand declare it/);
  });

  it("an offer's statement wins over the brand-keyed one when a group holds both", async () => {
    // One campaign states an offer, another (older) states none — so both reads happen, and the
    // funnel the offer named is filed under that offer rather than under nobody.
    mockFunnelBudgets([
      { funnelKey: "visit_signup", dailyBudgetCents: "1000" },
      { funnelKey: "reply_meeting", dailyBudgetCents: "1000" },
    ]);
    mockDeclared([{ funnelKey: "website_purchases" }]); // offer A
    mockDeclared([
      { funnelKey: "website_purchases" },
      { funnelKey: "sales_meetings_from_conversation" },
    ]); // brand-keyed
    mockSpend("0");
    mockSpend("0");

    await planFunnelTurns([
      claimed({ id: "c-a", funnelKey: "website_purchases", offerId: OFFER_A }),
      claimed({ id: "c-old", funnelKey: "sales_meetings_from_conversation", offerId: null }),
    ]);

    const urls = mockFetch.mock.calls.map((c) => String(c[0]));
    expect(urls).toContain(`https://brand.test/internal/offers/${OFFER_A}/sales-funnels`);
    expect(urls.some((u) => u.includes("/internal/brands/brand-1/sales-funnels"))).toBe(true);
    expect(warnings).toEqual([]);
  });
});
