import { describe, it, expect } from "vitest";
import { PERSON_EVENT_RETRY_SKIPS } from "../../src/lib/trigger-person.js";
import { STEP_TRIGGER_SKIPS } from "../../src/lib/step-trigger.js";

/**
 * FORM-ANSWER-NOBODY-DUE-1014: a form fill whose funnel caps read timed out (features-service redeploying)
 * was recorded skipped `sales_funnel_cap` and never fired again. A read billing could not answer is a
 * passing condition: the occurrence is retried. A cap REACHED is billing's verdict: recorded, not retried.
 */
describe("which skips put an occurrence carrying a person back on its short retry", () => {
  it("billing unable to answer for a funnel's caps retries the occurrence", () => {
    expect(PERSON_EVENT_RETRY_SKIPS.has(STEP_TRIGGER_SKIPS.SALES_FUNNEL_CAPS_UNAVAILABLE)).toBe(true);
  });

  it("a funnel cap reached is a verdict, never retried", () => {
    expect(PERSON_EVENT_RETRY_SKIPS.has(STEP_TRIGGER_SKIPS.SALES_FUNNEL_CAP)).toBe(false);
  });

  it("every retry skip is a skip the step trigger can name", () => {
    const named = new Set<string>(Object.values(STEP_TRIGGER_SKIPS));
    for (const reason of PERSON_EVENT_RETRY_SKIPS) expect(named.has(reason)).toBe(true);
  });
});
