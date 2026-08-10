import { describe, it, expect } from "vitest";
import { STOP_REASONS, isResumableStopReason } from "../../src/lib/stop-reason.js";

describe("stop reasons", () => {
  it("names one reason per place a campaign is stopped", () => {
    expect(STOP_REASONS).toEqual({
      AUDIENCE_EXHAUSTED: "audience_exhausted",
      MAX_LEADS_REACHED: "max_leads_reached",
      MANUAL: "manual",
      ORG_TEARDOWN: "org_teardown",
    });
  });

  it("resumes ONLY a campaign that ran out of people to contact", () => {
    expect(isResumableStopReason(STOP_REASONS.AUDIENCE_EXHAUSTED)).toBe(true);

    // Stopping a campaign on purpose has to stay stopped, and a campaign that hit a limit it
    // cannot grow out of never comes back on its own either.
    expect(isResumableStopReason(STOP_REASONS.MANUAL)).toBe(false);
    expect(isResumableStopReason(STOP_REASONS.MAX_LEADS_REACHED)).toBe(false);
    expect(isResumableStopReason(STOP_REASONS.ORG_TEARDOWN)).toBe(false);
  });

  it("never resumes a stop whose reason nobody recorded", () => {
    // Every row stopped before the reason column existed. Guessing one would resurrect the
    // campaigns a person switched off on purpose.
    expect(isResumableStopReason(null)).toBe(false);
    expect(isResumableStopReason(undefined)).toBe(false);
    expect(isResumableStopReason("")).toBe(false);
    expect(isResumableStopReason("something-a-future-code-path-invented")).toBe(false);
  });
});
