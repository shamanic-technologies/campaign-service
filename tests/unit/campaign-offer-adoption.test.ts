import { describe, it, expect, beforeEach, vi } from "vitest";

const { mockExecute } = vi.hoisted(() => ({ mockExecute: vi.fn() }));

vi.mock("../../src/db/index.js", () => ({ db: { execute: mockExecute } }));

vi.mock("drizzle-orm", () => ({
  // The raw-`sql` seam. These tests pin WHICH question is asked of brand-service and WHETHER a
  // write is attempted; what the SQL writes is measured against a real database in
  // tests/integration/campaign-offer-adoption.test.ts.
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
    strings: [...strings],
    values,
    text: strings.join("?"),
  }),
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import {
  adoptOfferForPair,
  adoptOfferForPairSafely,
  resetOfferAdoptionThrottle,
  OFFER_ADOPTION_RECHECK_MS,
} from "../../src/lib/campaign-offer-adoption.js";
import type { ProvisioningIdentity } from "../../src/lib/provisioning-identity.js";

const ORG = "100ed4eb-f10e-42bf-aa58-054014392141";
const BRAND = "fbe3ce77-8890-48a7-9e19-7f67fecdac05";
const CAMPAIGN = "16705a37-f95e-420c-b6a1-c91b436631b0";
const OFFER = "231bb036-1fa4-4e0d-82a9-600b4f744e32";

const identity: ProvisioningIdentity = {
  orgId: ORG,
  userId: "user-1",
  runId: "3f6d2f2e-0a5a-4e1e-9a4f-1a2b3c4d5e6f",
  brandId: BRAND,
};

/** The pre-check answer, then the UPDATE's RETURNING. */
function db(offerless: Array<{ id: string; status: string }>, written: string[] = []) {
  mockExecute.mockReset();
  mockExecute.mockResolvedValueOnce(offerless);
  mockExecute.mockResolvedValueOnce(written.map((id) => ({ id })));
}

function brandServiceAnswers(offerIds: string[]) {
  mockFetch.mockResolvedValue({
    ok: true,
    json: async () => ({ offers: offerIds.map((offerId) => ({ offerId })) }),
  });
}

describe("campaign offer adoption — a live campaign attributed to no offer appears on no offer page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetOfferAdoptionThrottle();
    process.env.BRAND_SERVICE_URL = "https://brand.test";
    process.env.BRAND_SERVICE_API_KEY = "brand-key";
  });

  it("writes the pair's single offer onto the campaign that states none", async () => {
    db([{ id: CAMPAIGN, status: "ongoing" }], [CAMPAIGN]);
    brandServiceAnswers([OFFER]);

    const written = await adoptOfferForPair({ orgId: ORG, brandId: BRAND }, identity);

    expect(written).toBe(1);
    // The offer id reaches the UPDATE.
    expect(mockExecute.mock.calls[1][0].values).toContain(OFFER);
  });

  it("NAMES THE ORG on the brand-service read — an offer belongs to the (org, brand) pair", async () => {
    // A brand row is a shared global identity many orgs claim, each with its own offers. Reading
    // the brand's offers without naming the org would attribute this org's campaign to ANOTHER
    // org's offer, inside the very per-offer grouping the column exists to make correct.
    db([{ id: CAMPAIGN, status: "ongoing" }], [CAMPAIGN]);
    brandServiceAnswers([OFFER]);

    await adoptOfferForPair({ orgId: ORG, brandId: BRAND }, identity);

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(`https://brand.test/internal/brands/${BRAND}/offers`);
    expect(init.headers["x-org-id"]).toBe(ORG);
  });

  it("scopes the write to the campaign's own org", async () => {
    db([{ id: CAMPAIGN, status: "ongoing" }], [CAMPAIGN]);
    brandServiceAnswers([OFFER]);

    await adoptOfferForPair({ orgId: ORG, brandId: BRAND }, identity);

    for (const call of mockExecute.mock.calls) {
      expect(call[0].text).toContain('"org_id" =');
      expect(call[0].values).toContain(ORG);
    }
  });

  it("writes NOTHING when the pair holds several offers, and says so", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    db([{ id: CAMPAIGN, status: "ongoing" }]);
    brandServiceAnswers([OFFER, "a-second-offer"]);

    const written = await adoptOfferForPair({ orgId: ORG, brandId: BRAND }, identity);

    expect(written).toBe(0);
    expect(mockExecute).toHaveBeenCalledTimes(1); // the pre-check only — no UPDATE
    expect(warn.mock.calls.flat().join(" ")).toContain("2");
  });

  it("writes NOTHING when the pair holds no offer, and says so", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    db([{ id: CAMPAIGN, status: "ongoing" }]);
    brandServiceAnswers([]);

    const written = await adoptOfferForPair({ orgId: ORG, brandId: BRAND }, identity);

    expect(written).toBe(0);
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
  });

  it("writes NOTHING when brand-service will not answer, and says so", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    db([{ id: CAMPAIGN, status: "ongoing" }]);
    mockFetch.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });

    const written = await adoptOfferForPair({ orgId: ORG, brandId: BRAND }, identity);

    expect(written).toBe(0);
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
  });

  it("asks NOTHING when every campaign of the pair already states an offer", async () => {
    db([]);

    const written = await adoptOfferForPair({ orgId: ORG, brandId: BRAND }, identity);

    expect(written).toBe(0);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockExecute).toHaveBeenCalledTimes(1); // the pre-check, nothing more
  });

  it("stays SILENT for a pair whose unattributed rows are all stopped", async () => {
    // The pre-offers population: 145 stopped rows, most belonging to orgs brand-service does not
    // know at all. Saying so every ten minutes forever buries the live case this exists for.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    db([{ id: "old-1", status: "stopped" }]);
    brandServiceAnswers([]);

    await adoptOfferForPair({ orgId: ORG, brandId: BRAND }, identity);

    expect(warn).not.toHaveBeenCalled();
  });

  it("still ADOPTS a stopped row when its own pair genuinely resolves", async () => {
    db([{ id: "old-1", status: "stopped" }], ["old-1"]);
    brandServiceAnswers([OFFER]);

    expect(await adoptOfferForPair({ orgId: ORG, brandId: BRAND }, identity)).toBe(1);
  });

  it("asks one pair at most once per recheck interval", async () => {
    const t0 = new Date("2026-08-24T10:00:00Z");
    db([{ id: CAMPAIGN, status: "ongoing" }]);
    brandServiceAnswers([]);
    await adoptOfferForPair({ orgId: ORG, brandId: BRAND }, identity, t0);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    db([{ id: CAMPAIGN, status: "ongoing" }]);
    await adoptOfferForPair({ orgId: ORG, brandId: BRAND }, identity, new Date(t0.getTime() + 60_000));
    expect(mockFetch).toHaveBeenCalledTimes(1); // throttled

    db([{ id: CAMPAIGN, status: "ongoing" }]);
    await adoptOfferForPair(
      { orgId: ORG, brandId: BRAND },
      identity,
      new Date(t0.getTime() + OFFER_ADOPTION_RECHECK_MS + 1),
    );
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("is fail-SOFT — a failure never holds up the provisioning that called it", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mockExecute.mockReset();
    mockExecute.mockRejectedValueOnce(new Error("db down"));

    await expect(adoptOfferForPairSafely({ orgId: ORG, brandId: BRAND }, identity)).resolves.toBe(0);
  });
});
