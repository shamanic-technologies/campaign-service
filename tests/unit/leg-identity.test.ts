import { describe, it, expect } from "vitest";
import {
  catalogueLegOf,
  legIsReactive,
  combinationIdentity,
  legIdentity,
  legKeySpellings,
  publishedSpelling,
  sameLeg,
  storedLegKey,
  withOtherOutboundSpellings,
} from "../../src/lib/leg-identity.js";
import { ceilingEntriesOf, type CampaignBudgetEntry } from "../../src/lib/campaign-budget-client.js";
import { itemsOf, type SalesItem } from "../../src/lib/sales-items.js";
import { selectByPathRoi } from "../../src/lib/global-sales-budget.js";
import { planReactiveDefaults } from "../../src/lib/reactive-defaults.js";

const COLD = "sales-cold-email-outreach";
const CALL = "cold-call-outreach";
const ADS = "google-ads";
const OLD_REPLY = "start_to_conversation";
const NEW_REPLY = "lead_found_to_conversation";
const OLD_VISIT = "start_to_website_visit";
const NEW_VISIT = "lead_found_to_website_visit";

describe("leg identity across the outbound rename (wave 1)", () => {
  it("treats the legacy and the new spelling of an OUTBOUND leg as one leg", () => {
    for (const slug of [COLD, CALL, "feedback-request-cold-email-outreach", "cold-linkedin-outreach"]) {
      expect(sameLeg(slug, OLD_REPLY, NEW_REPLY)).toBe(true);
      expect(sameLeg(slug, NEW_VISIT, OLD_VISIT)).toBe(true);
      expect(sameLeg(slug, OLD_REPLY, NEW_VISIT)).toBe(false);
      expect(legIdentity(slug, NEW_REPLY)).toBe(legIdentity(slug, OLD_REPLY));
    }
  });

  it("never renames a NON-outbound channel's start_to_* leg", () => {
    expect(sameLeg(ADS, OLD_VISIT, NEW_VISIT)).toBe(false);
    expect(legKeySpellings(ADS, OLD_VISIT)).toEqual([OLD_VISIT]);
    expect(storedLegKey(ADS, NEW_VISIT)).toBe(NEW_VISIT);
    expect(storedLegKey(ADS, OLD_VISIT)).toBe(OLD_VISIT);
  });

  it("leaves every other leg (and sourcing's start_to_lead_found) untouched", () => {
    expect(legKeySpellings(COLD, "conversation_to_meeting_booked")).toEqual(["conversation_to_meeting_booked"]);
    expect(storedLegKey("sourcing-apollo-cold-filters", "start_to_lead_found")).toBe("start_to_lead_found");
    expect(sameLeg(COLD, null, null)).toBe(true);
    expect(sameLeg(COLD, OLD_REPLY, null)).toBe(false);
  });

  it("STORES the legacy spelling in wave 1, whichever the caller sent", () => {
    expect(storedLegKey(COLD, NEW_REPLY)).toBe(OLD_REPLY);
    expect(storedLegKey(COLD, OLD_REPLY)).toBe(OLD_REPLY);
    expect(storedLegKey(CALL, NEW_VISIT)).toBe(OLD_VISIT);
    expect(storedLegKey(COLD, null)).toBeNull();
  });

  it("lists both spellings for a DB filter (key itself first) and a channel-less superset", () => {
    expect(legKeySpellings(COLD, NEW_REPLY)).toEqual([NEW_REPLY, OLD_REPLY]);
    expect(legKeySpellings(COLD, OLD_VISIT)).toEqual([OLD_VISIT, NEW_VISIT]);
    expect(withOtherOutboundSpellings([OLD_REPLY, "x_to_y"]).sort()).toEqual([NEW_REPLY, OLD_REPLY, "x_to_y"].sort());
  });

  it("resolves the channel's OWN published spelling, exact first", () => {
    expect(publishedSpelling(COLD, [NEW_REPLY, NEW_VISIT], OLD_REPLY)).toBe(NEW_REPLY);
    expect(publishedSpelling(COLD, [OLD_REPLY, NEW_REPLY], NEW_REPLY)).toBe(NEW_REPLY);
    expect(publishedSpelling(ADS, [NEW_VISIT], OLD_VISIT)).toBeNull();
  });

  it("matches a sales-path combination key across spellings, part by part under its own channel", () => {
    const old = `${OLD_REPLY}@${COLD}+conversation_to_meeting_booked@ai-meeting-booking`;
    const renamed = `${NEW_REPLY}@${COLD}+conversation_to_meeting_booked@ai-meeting-booking`;
    expect(combinationIdentity(renamed)).toBe(combinationIdentity(old));
    expect(combinationIdentity(`${NEW_VISIT}@${ADS}`)).not.toBe(combinationIdentity(`${OLD_VISIT}@${ADS}`));
  });
});

describe("catalogue reads accept either spelling", () => {
  // features-service after its own rename: the outbound channel publishes the NEW spelling, starting
  // at lead_found, and still states the transition is NOT reactive (the offer's proactive campaign).
  const renamed = {
    legs: [
      { legKey: NEW_REPLY, fromStepKey: "lead_found", toStepKey: "conversation" },
      { legKey: OLD_VISIT, fromStepKey: null, toStepKey: "website_visit" },
      { legKey: "conversation_to_meeting_booked", fromStepKey: "conversation", toStepKey: "meeting_booked" },
    ],
    legsBySlug: new Map([
      [COLD, new Set([NEW_REPLY])],
      [ADS, new Set([OLD_VISIT])],
      ["ai-meeting-booking", new Set(["conversation_to_meeting_booked"])],
    ]),
    reactiveBySlug: new Map([
      [COLD, new Map([[NEW_REPLY, false]])],
      [ADS, new Map([[OLD_VISIT, false]])],
      ["ai-meeting-booking", new Map([["conversation_to_meeting_booked", true]])],
    ]),
  };

  it("finds a legacy-stored campaign's leg in a catalogue that publishes the new spelling", () => {
    expect(catalogueLegOf(renamed, COLD, OLD_REPLY)?.legKey).toBe(NEW_REPLY);
    expect(catalogueLegOf(renamed, ADS, OLD_VISIT)?.legKey).toBe(OLD_VISIT);
  });

  it("reads proactive/reactive from the (channel, leg) transition, not from 'starts from nothing'", () => {
    expect(legIsReactive(renamed, COLD, OLD_REPLY)).toBe(false);
    expect(legIsReactive(renamed, COLD, NEW_REPLY)).toBe(false);
    expect(legIsReactive(renamed, "ai-meeting-booking", "conversation_to_meeting_booked")).toBe(true);
    expect(legIsReactive(renamed, COLD, "nope_to_nothing")).toBeNull();
  });

  it("falls back to the leg's fromStep when the channel states no transition flag (today's reading)", () => {
    const legacy = { legs: [{ legKey: OLD_REPLY, fromStepKey: null, toStepKey: "conversation" }] };
    expect(legIsReactive(legacy, COLD, OLD_REPLY)).toBe(false);
    expect(legIsReactive(legacy, COLD, NEW_REPLY)).toBe(false);
  });
});

describe("money matches either spelling", () => {
  const entry = (legKey: string | null, featureSlug = COLD): CampaignBudgetEntry => ({
    offerId: "o1", legKey, featureSlug, dailyBudgetCents: 500, sourcingCeilingCents: null,
  } as CampaignBudgetEntry);

  it("a billing ceiling under the new spelling funds a legacy-stored campaign, and the reverse", () => {
    const newRead = { ok: true as const, brandDailyBudgetCents: 500, campaigns: [entry(NEW_REPLY)] };
    expect(ceilingEntriesOf(newRead, { featureSlug: COLD, offerId: "o1", legKey: OLD_REPLY })).toHaveLength(1);
    const oldRead = { ok: true as const, brandDailyBudgetCents: 500, campaigns: [entry(OLD_REPLY)] };
    expect(ceilingEntriesOf(oldRead, { featureSlug: COLD, offerId: "o1", legKey: NEW_REPLY })).toHaveLength(1);
  });

  it("a new-spelling entry is not 'another leg' that disqualifies a leg-less one", () => {
    const read = { ok: true as const, brandDailyBudgetCents: 900, campaigns: [entry(NEW_REPLY), entry(null)] };
    expect(ceilingEntriesOf(read, { featureSlug: COLD, offerId: "o1", legKey: OLD_REPLY })).toHaveLength(2);
  });

  it("a non-outbound channel's ceiling is matched verbatim only", () => {
    const read = { ok: true as const, brandDailyBudgetCents: 500, campaigns: [entry(NEW_VISIT, ADS)] };
    expect(ceilingEntriesOf(read, { featureSlug: ADS, offerId: "o1", legKey: OLD_VISIT })).toHaveLength(0);
  });

  it("an items-mode item under the new spelling is the legacy campaign's item", () => {
    const item = { offerId: "O1", legKey: NEW_VISIT, featureSlug: COLD } as SalesItem;
    expect(itemsOf([item], { offerId: "o1", legKey: OLD_VISIT, featureSlug: COLD })).toHaveLength(1);
    expect(itemsOf([{ ...item, featureSlug: ADS }], { offerId: "o1", legKey: OLD_VISIT, featureSlug: ADS })).toHaveLength(0);
  });

  it("global mode's best-ROI path under the new spelling picks the legacy campaign", () => {
    const pick = selectByPathRoi(
      [{ campaignId: "c1", offerId: "o1", legKey: OLD_REPLY, featureSlug: COLD, spentCents: 0, ceilingCents: 100 }],
      [{ offerId: "o1", legKey: NEW_REPLY, featureSlug: COLD, pathKey: "p1" }],
    );
    expect(pick).toEqual({ campaignId: "c1", pathKey: "p1" });
  });

  it("a ticked path stated by brand-service in the old spelling matches features' new one", () => {
    const plan = planReactiveDefaults(
      { stated: true, combinationKeys: [`${OLD_REPLY}@${COLD}+conversation_to_meeting_booked@ai-meeting-booking`] } as any,
      [{
        combinationKey: `${NEW_REPLY}@${COLD}+conversation_to_meeting_booked@ai-meeting-booking`,
        roi: null,
        legs: [
          { legKey: NEW_REPLY, reactive: false, workedBy: "platform", channelSlug: COLD, channelManaged: true },
          { legKey: "conversation_to_meeting_booked", reactive: true, workedBy: "platform", channelSlug: "ai-meeting-booking", channelManaged: true },
        ],
      }],
    );
    expect(plan.pairs.map((p) => p.featureSlug)).toEqual(["ai-meeting-booking"]);
  });
});
