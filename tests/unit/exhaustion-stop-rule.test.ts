import { describe, it, expect } from "vitest";
import { isExhaustionStopWarranted } from "../../src/lib/audience-exhaustion.js";

/**
 * The terminal "everyone has been contacted" verdict rests on POSITIVE evidence that outreach
 * actually ran out of people, never on an empty remainder — "nothing left to serve" is equally
 * true of a campaign that never had anything to serve.
 *
 * Prod 2026-08-20: campaign 4769db14, the first one the per-channel provisioner ever created,
 * stopped itself ten seconds after birth having served zero leads and holding zero exhaustion
 * marks. The stop is sticky against funding, so the customer's $10/day channel was parked
 * indefinitely on a verdict about work that never happened.
 */
describe("isExhaustionStopWarranted", () => {
  it("does NOT warrant a stop for a campaign that has never exhausted an audience — 0 of 0 is not 100%", () => {
    expect(
      isExhaustionStopWarranted({
        hasServeableAudience: false,
        hasEverExhaustedAnAudience: false,
      }),
    ).toBe(false);
  });

  it("warrants the stop when the campaign ran out of people it actually had", () => {
    expect(
      isExhaustionStopWarranted({
        hasServeableAudience: false,
        hasEverExhaustedAnAudience: true,
      }),
    ).toBe(true);
  });

  it("never warrants a stop while a serveable audience remains, evidence or not", () => {
    expect(
      isExhaustionStopWarranted({
        hasServeableAudience: true,
        hasEverExhaustedAnAudience: true,
      }),
    ).toBe(false);
    expect(
      isExhaustionStopWarranted({
        hasServeableAudience: true,
        hasEverExhaustedAnAudience: false,
      }),
    ).toBe(false);
  });
});
