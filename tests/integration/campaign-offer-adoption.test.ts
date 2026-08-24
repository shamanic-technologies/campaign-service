import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { campaigns } from "../../src/db/schema.js";
import { cleanTestData, closeDb, insertTestCampaign, randomId } from "../helpers/test-db.js";
import {
  adoptOfferForPair,
  resetOfferAdoptionThrottle,
} from "../../src/lib/campaign-offer-adoption.js";
import type { ProvisioningIdentity } from "../../src/lib/provisioning-identity.js";

/**
 * The rule against a real database: a campaign that already exists with no offer becomes
 * attributed on this service's own cadence, and ONLY where its own (org, brand) pair resolves to
 * exactly one offer.
 *
 * The prod shape it is seeded from (2026-08-24): org 100ed4eb / brand fbe3ce77 holds ONE offer
 * 231bb036, created 28 minutes before campaign 16705a37 — which is ongoing, spending, and shows on
 * no offer page because the caller that created it never stated the offer.
 */
const ORG = randomId();
const OTHER_ORG = randomId();
const BRAND = randomId();
const OFFER = randomId();
const OTHER_ORG_OFFER = randomId();

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function identityFor(orgId: string): ProvisioningIdentity {
  return { orgId, userId: randomId(), runId: randomId(), brandId: BRAND };
}

/** brand-service answers per (org, brand) pair — the org is what selects the answer. */
function brandServiceHolds(offersByOrg: Record<string, string[]>) {
  mockFetch.mockImplementation(async (_url: string, init: { headers: Record<string, string> }) => {
    const offers = offersByOrg[init.headers["x-org-id"]] ?? [];
    return { ok: true, json: async () => ({ offers: offers.map((offerId) => ({ offerId })) }) };
  });
}

async function offerOf(id: string): Promise<string | null> {
  const [row] = await db.select().from(campaigns).where(eq(campaigns.id, id));
  return row?.offerId ?? null;
}

describe("campaign offer adoption (integration)", () => {
  beforeEach(async () => {
    await cleanTestData();
    resetOfferAdoptionThrottle();
    mockFetch.mockReset();
    process.env.BRAND_SERVICE_URL = "https://brand.test";
    process.env.BRAND_SERVICE_API_KEY = "brand-key";
  });

  afterAll(async () => {
    await closeDb();
  });

  it("attributes the live campaign of a pair holding exactly one offer", async () => {
    const live = await insertTestCampaign(ORG, {
      status: "ongoing",
      brandId: BRAND,
      brandIds: [BRAND],
      acquisitionChannel: "cold_email",
      funnelKey: "sales_meetings_from_conversation",
      featureSlug: "sales-cold-email-outreach",
    });
    brandServiceHolds({ [ORG]: [OFFER] });

    expect(await adoptOfferForPair({ orgId: ORG, brandId: BRAND }, identityFor(ORG))).toBe(1);
    expect(await offerOf(live.id)).toBe(OFFER);
  });

  it("NEVER attributes a campaign to another org's offer on the same brand row", async () => {
    // A brand row is a shared global identity: it carries one offer per claiming org. Reading the
    // brand's offers without naming the org is the cross-org write this scoping closes.
    const mine = await insertTestCampaign(ORG, { status: "ongoing", brandId: BRAND, brandIds: [BRAND] });
    const theirs = await insertTestCampaign(OTHER_ORG, { status: "ongoing", brandId: BRAND, brandIds: [BRAND] });
    brandServiceHolds({ [ORG]: [OFFER], [OTHER_ORG]: [OTHER_ORG_OFFER] });

    await adoptOfferForPair({ orgId: ORG, brandId: BRAND }, identityFor(ORG));

    expect(await offerOf(mine.id)).toBe(OFFER);
    expect(await offerOf(theirs.id)).toBeNull();
  });

  it("leaves every campaign alone when the pair holds several offers", async () => {
    const live = await insertTestCampaign(ORG, { status: "ongoing", brandId: BRAND, brandIds: [BRAND] });
    brandServiceHolds({ [ORG]: [OFFER, randomId()] });

    expect(await adoptOfferForPair({ orgId: ORG, brandId: BRAND }, identityFor(ORG))).toBe(0);
    expect(await offerOf(live.id)).toBeNull();
  });

  it("leaves every campaign alone when the pair holds no offer", async () => {
    const live = await insertTestCampaign(ORG, { status: "ongoing", brandId: BRAND, brandIds: [BRAND] });
    brandServiceHolds({ [ORG]: [] });

    expect(await adoptOfferForPair({ orgId: ORG, brandId: BRAND }, identityFor(ORG))).toBe(0);
    expect(await offerOf(live.id)).toBeNull();
  });

  it("never overwrites an offer a campaign already states", async () => {
    const stated = await insertTestCampaign(ORG, {
      status: "ongoing",
      brandId: BRAND,
      brandIds: [BRAND],
      offerId: OTHER_ORG_OFFER,
    });
    const bare = await insertTestCampaign(ORG, { status: "ongoing", brandId: BRAND, brandIds: [BRAND] });
    brandServiceHolds({ [ORG]: [OFFER] });

    expect(await adoptOfferForPair({ orgId: ORG, brandId: BRAND }, identityFor(ORG))).toBe(1);
    expect(await offerOf(stated.id)).toBe(OTHER_ORG_OFFER);
    expect(await offerOf(bare.id)).toBe(OFFER);
  });

  it("adopts a stopped ancestor of the same pair, and only through the pair's own answer", async () => {
    const stopped = await insertTestCampaign(ORG, {
      status: "stopped",
      brandId: BRAND,
      brandIds: [BRAND],
      stopReason: "audience_exhausted",
    });
    brandServiceHolds({ [ORG]: [OFFER] });

    await adoptOfferForPair({ orgId: ORG, brandId: BRAND }, identityFor(ORG));

    const [row] = await db.select().from(campaigns).where(eq(campaigns.id, stopped.id));
    expect(row.offerId).toBe(OFFER);
    // Nothing else moves: the offer decides no money question and no lifecycle one.
    expect(row.status).toBe("stopped");
    expect(row.stopReason).toBe("audience_exhausted");
  });

  it("resolves the historical row that carries only the brand ARRAY, never a multi-brand one", async () => {
    const single = await insertTestCampaign(ORG, {
      status: "ongoing",
      brandId: null,
      brandIds: [BRAND],
    });
    const several = await insertTestCampaign(ORG, {
      status: "ongoing",
      brandId: null,
      brandIds: [BRAND, randomId()],
    });
    brandServiceHolds({ [ORG]: [OFFER] });

    await adoptOfferForPair({ orgId: ORG, brandId: BRAND }, identityFor(ORG));

    expect(await offerOf(single.id)).toBe(OFFER);
    // A campaign naming several brands is the permanent honest NULL — it is never guessed at.
    expect(await offerOf(several.id)).toBeNull();
  });

  it("is idempotent — a second pass reads nothing and writes nothing", async () => {
    const live = await insertTestCampaign(ORG, { status: "ongoing", brandId: BRAND, brandIds: [BRAND] });
    brandServiceHolds({ [ORG]: [OFFER] });

    const now = new Date();
    expect(await adoptOfferForPair({ orgId: ORG, brandId: BRAND }, identityFor(ORG), now)).toBe(1);
    const reads = mockFetch.mock.calls.length;

    // Past the throttle: the pre-check finds nothing left to attribute, so brand-service is not
    // even asked.
    const later = new Date(now.getTime() + 60 * 60_000);
    expect(await adoptOfferForPair({ orgId: ORG, brandId: BRAND }, identityFor(ORG), later)).toBe(0);
    expect(mockFetch.mock.calls.length).toBe(reads);
    expect(await offerOf(live.id)).toBe(OFFER);
  });
});
