import { describe, it, expect } from "vitest";
import { answersOnDemand, sourceRunsOnItsOwn } from "../../src/lib/on-demand-mode.js";
import type { ChannelCatalogueRead } from "../../src/lib/channel-operator-client.js";

const SOURCE = "sourcing-apollo-cold-filters";
const LEG = "start_to_lead_found";

function catalogue(transitions: Array<{ featureSlug: string; legKey: string; triggerId: string }>, legs: Record<string, string[]>): ChannelCatalogueRead {
  return {
    ok: true,
    operatorBySlug: new Map(),
    legsBySlug: new Map(Object.entries(legs).map(([k, v]) => [k, new Set(v)])),
    legs: [],
    stepKeys: new Set(),
    triggerTransitions: transitions,
  };
}

const unit = { featureSlug: SOURCE, legKey: LEG, salesFunnelCampaignId: "sfc-1" };
const today = catalogue([{ featureSlug: SOURCE, legKey: LEG, triggerId: "on_demand" }], { [SOURCE]: [LEG] });
const flipped = catalogue([], { [SOURCE]: [LEG] });

describe("who dispatches a pipe (lib/on-demand-mode.ts)", () => {
  it("a source unit answers on demand while the catalogue says on_demand (today)", () => {
    expect(answersOnDemand(unit, today)).toBe(true);
    expect(sourceRunsOnItsOwn(unit, today)).toBe(false);
  });

  it("a source unit runs on its own once the catalogue reads its leg proactive", () => {
    expect(answersOnDemand(unit, flipped)).toBe(false);
    expect(sourceRunsOnItsOwn(unit, flipped)).toBe(true);
  });

  it("needs POSITIVE evidence: a source whose leg the catalogue does not publish answers on demand", () => {
    expect(answersOnDemand(unit, catalogue([], {}))).toBe(true);
  });

  it("an unreadable catalogue reads every source as on demand and every other campaign as not", () => {
    const down: ChannelCatalogueRead = { ok: false, detail: "HTTP 503" };
    expect(answersOnDemand(unit, down)).toBe(true);
    expect(answersOnDemand({ featureSlug: "sales-cold-email-outreach", legKey: "lead_found_to_conversation" }, down)).toBe(false);
  });

  it("a pre-funnel source (no sales funnel campaign) has no money of its own: on demand whatever the catalogue", () => {
    expect(answersOnDemand({ ...unit, salesFunnelCampaignId: null }, flipped)).toBe(true);
  });

  it("the same statement binds any channel: a non-source pipe reactive on on_demand is not dispatched", () => {
    const c = catalogue([{ featureSlug: "some-channel", legKey: "a_to_b", triggerId: "on_demand" }], { "some-channel": ["a_to_b"] });
    expect(answersOnDemand({ featureSlug: "some-channel", legKey: "a_to_b" }, c)).toBe(true);
    expect(answersOnDemand({ featureSlug: "some-channel", legKey: "b_to_c" }, c)).toBe(false);
  });
});
