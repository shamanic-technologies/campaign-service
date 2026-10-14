import { describe, it, expect, vi } from "vitest";
import { resolveStartablePair } from "../../src/lib/startable-pair.js";
import type { ChannelCatalogueRead } from "../../src/lib/channel-operator-client.js";

/**
 * CAN THE CUSTOMER START THE CAMPAIGN FOR AN (OFFER, LEG, CHANNEL) THEY FUND?
 *
 * The things that must never happen here: a leg invented, a refusal a person cannot read, and (ONE
 * money model, owner 2026-10-14) an outreach campaign born outside a sales funnel campaign, with no money.
 */

const CHANNEL = "sales-cold-email-outreach";
const ENTRY_LEG = "start_to_conversation";
const SECOND_LEG = "conversation_to_meeting_booked";
const OFFER = "11111111-1111-1111-1111-111111111111";
const BRAND = "22222222-2222-2222-2222-222222222222";

const IDENTITY = {
  orgId: "org_test",
  userId: "user_test",
  runId: "33333333-3333-3333-3333-333333333333",
  brandId: BRAND,
};

function catalogue(overrides: Partial<{
  operator: "platform" | "customer";
  channelLegs: string[];
}> = {}): ChannelCatalogueRead {
  const channelLegs = overrides.channelLegs ?? [ENTRY_LEG, SECOND_LEG];
  return {
    ok: true,
    operatorBySlug: new Map([[CHANNEL, overrides.operator ?? "platform"]]),
    legsBySlug: new Map([[CHANNEL, new Set(channelLegs)]]),
    legs: channelLegs.map((legKey) => ({ legKey, fromStepKey: null, toStepKey: null })),
    stepKeys: new Set<string>(),
  };
}

function deps(over: { catalogue?: ChannelCatalogueRead } = {}) {
  return { catalogue: async () => over.catalogue ?? catalogue() };
}

function start(input: Partial<Parameters<typeof resolveStartablePair>[0]> = {}, over: { catalogue?: ChannelCatalogueRead } = {}) {
  return resolveStartablePair(
    { brandId: BRAND, offerId: OFFER, legKey: ENTRY_LEG, featureSlug: CHANNEL, ...input },
    IDENTITY,
    deps(over),
  );
}

describe("resolveStartablePair", () => {
  it("refuses an outreach channel with a valid scope: it runs inside a sales funnel campaign (409 sales_funnel_required)", async () => {
    const read = await start();
    expect(read.ok).toBe(false);
    if (!read.ok) {
      expect(read.refusal).toMatchObject({ status: 409, code: "sales_funnel_required" });
      expect(read.refusal.message).toMatch(/sales funnel/);
    }
  });

  it("refuses a customer-operated or service-performed channel the same way: no outreach start outside a funnel", async () => {
    const custom = await start({}, { catalogue: catalogue({ operator: "customer" }) });
    expect(custom.ok || custom.refusal.code).toBe("sales_funnel_required");

    const AIC = "ai-instant-call";
    const LEG = "conversation_to_booking_call";
    const aic = await resolveStartablePair(
      { brandId: BRAND, offerId: OFFER, legKey: LEG, featureSlug: AIC },
      IDENTITY,
      {
        catalogue: async () => ({
          ok: true,
          operatorBySlug: new Map([[AIC, "platform" as const]]),
          legsBySlug: new Map([[AIC, new Set([LEG])]]),
          legs: [{ legKey: LEG, fromStepKey: "conversation", toStepKey: "booking_call" }],
          stepKeys: new Set<string>(),
        }),
      },
    );
    expect(aic.ok || aic.refusal).toMatchObject({ status: 409, code: "sales_funnel_required" });
  });

  it("a live lead SOURCE origin still starts on its lead-found leg, with no ceiling, no workflow and no catalogue read", async () => {
    const readCatalogue = vi.fn();
    const read = await resolveStartablePair(
      { brandId: BRAND, offerId: OFFER, legKey: "start_to_lead_found", featureSlug: "sourcing-apollo-cold-filters" },
      IDENTITY,
      { catalogue: readCatalogue },
    );
    expect(read).toEqual({ ok: true, pair: { legKey: "start_to_lead_found", ceilingCents: null, workflowSlug: null } });
    expect(readCatalogue).not.toHaveBeenCalled();
  });

  it("refuses a start that states no leg or no offer, in words a person can read", async () => {
    for (const input of [{ legKey: null }, { offerId: null }]) {
      const read = await start(input);
      expect(read.ok).toBe(false);
      if (!read.ok) {
        expect(read.refusal).toMatchObject({ status: 400, code: "leg_required" });
        expect(read.refusal.message).not.toMatch(/funnel/i);
      }
    }
  });

  it("refuses a channel outside the sales family — its money is not paced here", async () => {
    const read = await start({ featureSlug: "pr-cold-email-outreach" });
    expect(read.ok || read.refusal.code).toBe("channel_not_paced_here");
  });

  it("refuses a channel the catalogue does not publish", async () => {
    const read = await start({ featureSlug: "google-ads" });
    expect(read.ok || read.refusal.code).toBe("unknown_channel");
  });

  it("refuses a leg the channel does not perform rather than stamping it", async () => {
    const read = await start({}, { catalogue: catalogue({ channelLegs: [SECOND_LEG] }) });
    expect(read.ok || read.refusal.code).toBe("leg_not_performed");
  });

  it("an unreadable catalogue is a 502, never a refusal about the channel", async () => {
    const read = await start({}, { catalogue: { ok: false, detail: "HTTP 503" } });
    expect(read.ok || read.refusal).toMatchObject({ status: 502, code: "catalogue_unavailable" });
  });
});
