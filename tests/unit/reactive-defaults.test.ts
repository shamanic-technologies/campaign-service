import { describe, it, expect } from "vitest";
import { planReactiveDefaults, type CatalogueSalesPath, type CatalogueSalesPathLeg } from "../../src/lib/reactive-defaults.js";

const entry = (slug = "sales-cold-email-outreach"): CatalogueSalesPathLeg => ({
  legKey: "start_to_conversation", reactive: false, workedBy: "platform",
  channelSlug: slug, channelManaged: true
});
const meeting = (over: Partial<CatalogueSalesPathLeg> = {}): CatalogueSalesPathLeg => ({
  legKey: "conversation_to_meeting_booked", reactive: true, workedBy: "platform",
  channelSlug: "ai-meeting-booking", channelManaged: true, ...over,
});
const human = (legKey: string): CatalogueSalesPathLeg => ({
  legKey, reactive: true, workedBy: "human", channelSlug: "your-team-closing-calls", channelManaged: false
});
const path = (combinationKey: string, roi: number | null, legs: CatalogueSalesPathLeg[]): CatalogueSalesPath => ({ combinationKey, roi, legs });

describe("planReactiveDefaults — which reactive campaigns are on by default", () => {
  const withMeeting = path("A", 3, [entry(), meeting(), human("meeting_booked_to_meeting_attended")]);
  const noReactive = path("B", 0.5, [entry(), human("conversation_to_paid_client")]);
  const lowRoiMeeting = path("C", 0.8, [entry(), meeting()]);

  it("uses the paths the customer STATED, whatever their ROI", () => {
    const plan = planReactiveDefaults({ stated: true, combinationKeys: ["C"] }, [withMeeting, noReactive, lowRoiMeeting]);
    expect(plan.basis).toBe("stated");
    expect(plan.tickedCombinationKeys).toEqual(["C"]);
    expect(plan.pairs).toEqual([{ legKey: "conversation_to_meeting_booked", featureSlug: "ai-meeting-booking", combinationKeys: ["C"] }]);
  });

  it("never stated = the paths with ROI above 1", () => {
    const plan = planReactiveDefaults({ stated: false, combinationKeys: null }, [withMeeting, noReactive, lowRoiMeeting, path("N", null, [entry(), meeting()])]);
    expect(plan.basis).toBe("roi_above_1");
    expect(plan.tickedCombinationKeys).toEqual(["A"]);
    expect(plan.pairs.map((p) => p.featureSlug)).toEqual(["ai-meeting-booking"]);
  });

  it("stated EMPTY ticks nothing (different from never stated)", () => {
    expect(planReactiveDefaults({ stated: true, combinationKeys: [] }, [withMeeting]).pairs).toEqual([]);
  });

  it("never turns on an entry leg, a human leg, or a channel we do not run", () => {
    const plan = planReactiveDefaults({ stated: true, combinationKeys: ["X"] }, [
      path("X", 5, [entry(), meeting({ channelManaged: false }), human("meeting_attended_to_paid_client")]),
    ]);
    expect(plan.pairs).toEqual([]);
  });

  it("one pair per (leg, channel), naming every ticked path that uses it", () => {
    const plan = planReactiveDefaults({ stated: true, combinationKeys: ["A", "C"] }, [withMeeting, lowRoiMeeting]);
    expect(plan.pairs).toEqual([{ legKey: "conversation_to_meeting_booked", featureSlug: "ai-meeting-booking", combinationKeys: ["A", "C"] }]);
  });

  it("an offer whose ticked paths use no reactive platform leg switches nothing on", () => {
    expect(planReactiveDefaults({ stated: true, combinationKeys: ["B"] }, [noReactive]).pairs).toEqual([]);
  });
});
