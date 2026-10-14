import { describe, it, expect, vi, beforeEach } from "vitest";

import { resolveStartablePair } from "../../src/lib/startable-pair.js";
import { proactiveCampaignsToStop } from "../../src/lib/single-proactive.js";
import { readSourcingMap } from "../../src/lib/sourcing-origins-client.js";
import {
  LIVE_SOURCE_ORIGIN_SLUGS,
  SOURCE_LEG_KEY,
  isLiveSourceOrigin,
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

beforeEach(() => vi.clearAllMocks());

describe("the LOCKED vocabulary", () => {
  it("holds features-service's keys verbatim", async () => {
    const { originsByChannel: SOURCING_ORIGINS_BY_CHANNEL, defaultOriginByChannel: DEFAULT_SOURCE_ORIGIN_BY_CHANNEL } = await readSourcingMap();
    expect(SOURCE_LEG_KEY).toBe("start_to_lead_found");
    expect([...LIVE_SOURCE_ORIGIN_SLUGS]).toEqual([
      "sourcing-apollo-cold-filters",
      "sourcing-apollo-buying-signals",
      "sourcing-linkedin-engagement-signals",
      "sourcing-crm-contacts",
      "lead-sourcing",
    ]);
    expect(sourceCampaignKey(APOLLO)).toBe("campaign:sourcing-apollo-cold-filters|start_to_lead_found");
    expect(DEFAULT_SOURCE_ORIGIN_BY_CHANNEL).toEqual({
      "sales-cold-email-outreach": APOLLO,
      "feedback-request-cold-email-outreach": APOLLO,
      "sales-crm-email-outreach": "sourcing-crm-contacts",
      "cold-whatsapp-outreach": "sourcing-crm-contacts",
    });
    // The brand's own CRM contacts feed WhatsApp (only) and the sales cold email (features-service parity, 2026-10-12).
    expect(SOURCING_ORIGINS_BY_CHANNEL["cold-whatsapp-outreach"]).toEqual(["sourcing-crm-contacts"]);
    expect(SOURCING_ORIGINS_BY_CHANNEL["sales-cold-email-outreach"]).toContain("sourcing-crm-contacts");
    // Every default is an origin its channel serves.
    for (const [channel, origin] of Object.entries(DEFAULT_SOURCE_ORIGIN_BY_CHANNEL)) {
      expect(SOURCING_ORIGINS_BY_CHANNEL[channel]).toContain(origin);
    }
    expect(isSourceCampaign({ featureSlug: "sourcing-apify-search" })).toBe(true);
    expect(isSourceCampaign({ featureSlug: COLD })).toBe(false);
  });

  it("LEAD SOURCING (owner 2026-10-11) is a source campaign that feeds the cold email channels, never CRM email, and widens no spend read", async () => {
    const { originsByChannel: SOURCING_ORIGINS_BY_CHANNEL, feedingByChannel: SOURCE_CAMPAIGNS_FEEDING_CHANNEL } = await readSourcingMap();
    expect(isSourceCampaign({ featureSlug: "lead-sourcing" })).toBe(true);
    expect(isLiveSourceOrigin("lead-sourcing")).toBe(true);
    expect(SOURCE_CAMPAIGNS_FEEDING_CHANNEL["sales-cold-email-outreach"]).toEqual([...SOURCING_ORIGINS_BY_CHANNEL["sales-cold-email-outreach"]!, "lead-sourcing"]);
    expect(SOURCE_CAMPAIGNS_FEEDING_CHANNEL["feedback-request-cold-email-outreach"]).toContain("lead-sourcing");
    expect(SOURCE_CAMPAIGNS_FEEDING_CHANNEL["sales-crm-email-outreach"]).toEqual(["sourcing-crm-contacts"]);
    for (const origins of Object.values(SOURCING_ORIGINS_BY_CHANNEL)) expect(origins).not.toContain("lead-sourcing");
  });
});

describe("turning a source ON (start-funded-pair resolution)", () => {
  const never = () => {
    throw new Error("a source start reads no catalogue");
  };
  const deps = { catalogue: never as never };

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
