import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGetStatsBudget } = vi.hoisted(() => ({ mockGetStatsBudget: vi.fn() }));
vi.mock("@distribute/runs-client", () => ({ getStatsBudget: mockGetStatsBudget }));

import { resolveStartablePair } from "../../src/lib/startable-pair.js";
import { getChannelStatsBudget } from "../../src/lib/channel-spend.js";
import { proactiveCampaignsToStop } from "../../src/lib/single-proactive.js";
import {
  DEFAULT_SOURCE_ORIGIN_BY_CHANNEL,
  LIVE_SOURCE_ORIGIN_SLUGS,
  SOURCE_LEG_KEY,
  SOURCING_ORIGINS_BY_CHANNEL,
  isSourceCampaign,
  sourceCampaignKey,
} from "../../src/lib/source-campaigns.js";

/**
 * SOURCE CAMPAIGNS (owner 2026-10-07): an offer's lead sources are campaigns keyed
 * (offerId, featureSlug = <origin>, legKey = "start_to_lead_found"), features-service's LOCKED keys.
 */

const OFFER = "11111111-1111-1111-1111-111111111111";
const BRAND = "22222222-2222-2222-2222-222222222222";
const IDENTITY = { orgId: "org", userId: "user", runId: "33333333-3333-3333-3333-333333333333", brandId: BRAND };
const APOLLO = "sourcing-apollo-cold-filters";
const COLD = "sales-cold-email-outreach";
const TODAY = [{ label: "today", since: "2026-10-07T00:00:00.000Z" }];

function window(cents: string) {
  return {
    label: "today",
    totalCostInUsdCents: cents, actualCostInUsdCents: cents, provisionedCostInUsdCents: "0",
    netTotalCostInUsdCents: cents, netActualCostInUsdCents: cents, netProvisionedCostInUsdCents: "0",
  };
}

beforeEach(() => vi.clearAllMocks());

describe("the LOCKED vocabulary", () => {
  it("holds features-service's keys verbatim", () => {
    expect(SOURCE_LEG_KEY).toBe("start_to_lead_found");
    expect([...LIVE_SOURCE_ORIGIN_SLUGS]).toEqual([
      "sourcing-apollo-cold-filters",
      "sourcing-apollo-buying-signals",
      "sourcing-linkedin-engagement-signals",
      "sourcing-crm-contacts",
    ]);
    expect(sourceCampaignKey(APOLLO)).toBe("campaign:sourcing-apollo-cold-filters|start_to_lead_found");
    expect(DEFAULT_SOURCE_ORIGIN_BY_CHANNEL).toEqual({
      "sales-cold-email-outreach": APOLLO,
      "feedback-request-cold-email-outreach": APOLLO,
      "sales-crm-email-outreach": "sourcing-crm-contacts",
    });
    // Every default is an origin its channel serves.
    for (const [channel, origin] of Object.entries(DEFAULT_SOURCE_ORIGIN_BY_CHANNEL)) {
      expect(SOURCING_ORIGINS_BY_CHANNEL[channel]).toContain(origin);
    }
    expect(isSourceCampaign({ featureSlug: "sourcing-apify-search" })).toBe(true);
    expect(isSourceCampaign({ featureSlug: COLD })).toBe(false);
  });
});

describe("turning a source ON (start-funded-pair resolution)", () => {
  const never = () => {
    throw new Error("a source start reads no catalogue, billing or workflow");
  };
  const deps = { catalogue: never as never, budgets: never as never, workflow: never as never };

  it("is startable with no workflow and no ceiling read", async () => {
    const r = await resolveStartablePair({ brandId: BRAND, offerId: OFFER, featureSlug: APOLLO, legKey: SOURCE_LEG_KEY }, IDENTITY, deps);
    expect(r).toEqual({ ok: true, pair: { legKey: SOURCE_LEG_KEY, ceilingCents: null, workflowSlug: null } });
  });

  it("refuses a retired origin and any other leg, in a sentence", async () => {
    const retired = await resolveStartablePair({ brandId: BRAND, offerId: OFFER, featureSlug: "sourcing-apify-search", legKey: SOURCE_LEG_KEY }, IDENTITY, deps);
    expect(retired).toMatchObject({ ok: false, refusal: { status: 400, code: "unknown_channel" } });
    const leg = await resolveStartablePair({ brandId: BRAND, offerId: OFFER, featureSlug: APOLLO, legKey: "start_to_conversation" }, IDENTITY, deps);
    expect(leg).toMatchObject({ ok: false, refusal: { status: 400, code: "leg_not_performed" } });
    const noOffer = await resolveStartablePair({ brandId: BRAND, offerId: null, featureSlug: APOLLO, legKey: SOURCE_LEG_KEY }, IDENTITY, deps);
    expect(noOffer).toMatchObject({ ok: false, refusal: { code: "leg_required" } });
  });
});

describe("one proactive campaign per offer never touches a source", () => {
  it("a source turned ON displaces nothing and takes no lock", async () => {
    const tx = { execute: vi.fn(), select: vi.fn() };
    const stopped = await proactiveCampaignsToStop(
      tx as never,
      { id: "s1", orgId: "org", offerId: OFFER, legKey: SOURCE_LEG_KEY, featureSlug: APOLLO },
      { catalogue: () => { throw new Error("no catalogue read"); } },
    );
    expect(stopped).toEqual([]);
    expect(tx.execute).not.toHaveBeenCalled();
    expect(tx.select).not.toHaveBeenCalled();
  });

  it("the outreach campaign turned ON never stops a live source, even if the catalogue published its leg as an entry leg", async () => {
    const liveSource = { id: "s1", featureSlug: APOLLO, legKey: SOURCE_LEG_KEY, status: "ongoing" };
    const where = vi.fn(async () => [liveSource]);
    const tx = { execute: vi.fn(), select: () => ({ from: () => ({ where }) }) };
    const catalogue = vi.fn();
    const stopped = await proactiveCampaignsToStop(
      tx as never,
      { id: "c1", orgId: "org", offerId: OFFER, legKey: "start_to_conversation", featureSlug: COLD },
      { catalogue },
    );
    expect(stopped).toEqual([]);
    // Only sources were live: the catalogue is not even asked.
    expect(catalogue).not.toHaveBeenCalled();
  });
});

describe("the outreach campaign's spend still counts the sourcing filed under its offer's sources", () => {
  const spend: Record<string, string> = {};
  beforeEach(() => {
    for (const k of Object.keys(spend)) delete spend[k];
    mockGetStatsBudget.mockImplementation(async ({ campaignId, featureSlug }: { campaignId?: string; featureSlug?: string }) => {
      const cents = spend[`${campaignId}|${featureSlug}`];
      return { windows: cents === undefined ? [] : [window(cents)] };
    });
  });
  const feeding = async () => [{ id: "src-apollo", featureSlug: APOLLO, status: "ongoing" }];

  it("reads the same total before and after lead-service files the sourcing under the source campaign", async () => {
    spend[`jub|${COLD}`] = "300.0000000000";
    spend[`jub|${APOLLO}`] = "250.0000000000";
    const before = await getChannelStatsBudget({ orgId: "org", campaignId: "jub", featureSlug: COLD, windows: TODAY }, { feeding });

    delete spend[`jub|${APOLLO}`];
    spend[`src-apollo|${APOLLO}`] = "250.0000000000";
    const after = await getChannelStatsBudget({ orgId: "org", campaignId: "jub", featureSlug: COLD, windows: TODAY }, { feeding });

    expect(before.windows[0].netTotalCostInUsdCents).toBe("550.0000000000");
    expect(after.windows[0].netTotalCostInUsdCents).toBe("550.0000000000");
    const asked = mockGetStatsBudget.mock.calls.map((c) => `${c[0].campaignId}|${c[0].featureSlug}`);
    expect(asked).toContain(`src-apollo|${APOLLO}`);
  });

  it("a brand-scoped read, or a channel that sources nothing, asks no source", async () => {
    const spy = vi.fn(feeding);
    await getChannelStatsBudget({ orgId: "org", brandId: BRAND, featureSlug: COLD, windows: TODAY }, { feeding: spy });
    await getChannelStatsBudget({ orgId: "org", campaignId: "c", featureSlug: "ai-meeting-booking", windows: TODAY }, { feeding: spy });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("billing's split read measures the campaign family: outreach + the sources feeding it", () => {
  it("names every feeding source campaign in campaignIds", async () => {
    process.env.BILLING_SERVICE_URL = "https://billing.test.local";
    process.env.BILLING_SERVICE_API_KEY = "k";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      split: true, outreachDailyBudgetCents: "100", sourcingCeilingCents: "50",
      today: { sourcingSpentCents: "1", outreachSpentCents: "2" },
    }), { status: 200 }));
    const { fetchCampaignSplitToday } = await import("../../src/lib/campaign-budget-split.js");
    const r = await fetchCampaignSplitToday(BRAND, {
      campaignId: "jub", offerId: OFFER, legKey: "start_to_conversation", featureSlug: COLD, sourceCampaignIds: ["src-a", "src-b"],
    }, { orgId: "org" });
    expect(r.ok).toBe(true);
    const url = new URL(String(fetchSpy.mock.calls[0][0]));
    expect(url.searchParams.get("campaignIds")).toBe("jub,src-a,src-b");
    fetchSpy.mockRestore();
  });
});
