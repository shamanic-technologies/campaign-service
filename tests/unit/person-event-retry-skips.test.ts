import { describe, it, expect } from "vitest";
import { OWED_UNTIL_ROOM_SKIPS, PERSON_EVENT_RETRY_SKIPS } from "../../src/lib/trigger-person.js";
import { STEP_TRIGGER_SKIPS } from "../../src/lib/step-trigger.js";

/**
 * FORM-ANSWER-NOBODY-DUE-1014: a form fill whose funnel caps read timed out (features-service redeploying)
 * was recorded skipped `sales_funnel_cap` and never fired again. A read billing could not answer is a
 * passing condition: the occurrence is retried. NEVER-NO-FOLLOWUP-1014: a cap REACHED is owed too, until room returns.
 */
describe("which skips put an occurrence carrying a person back on its short retry", () => {
  it("billing unable to answer for a funnel's caps retries the occurrence", () => {
    expect(PERSON_EVENT_RETRY_SKIPS.has(STEP_TRIGGER_SKIPS.SALES_FUNNEL_CAPS_UNAVAILABLE)).toBe(true);
  });

  it("NEVER-NO-FOLLOWUP-1014: a cap reached / unfunded / pacing hold is owed until room returns, no deadline", () => {
    for (const reason of [
      STEP_TRIGGER_SKIPS.SALES_FUNNEL_CAP,
      STEP_TRIGGER_SKIPS.UNFUNDED,
      STEP_TRIGGER_SKIPS.RUN_IN_FLIGHT,
      STEP_TRIGGER_SKIPS.COHORT_RUN_IN_FLIGHT,
      STEP_TRIGGER_SKIPS.FAILURE_BACKOFF,
      STEP_TRIGGER_SKIPS.SALES_FUNNEL_CAPS_UNAVAILABLE,
    ]) {
      expect(OWED_UNTIL_ROOM_SKIPS.has(reason)).toBe(true);
      expect(PERSON_EVENT_RETRY_SKIPS.has(reason)).toBe(true);
    }
  });

  it("a person not known is retried only while young; a verdict about the person is final", () => {
    expect(PERSON_EVENT_RETRY_SKIPS.has(STEP_TRIGGER_SKIPS.PERSON_NOT_KNOWN)).toBe(true);
    expect(OWED_UNTIL_ROOM_SKIPS.has(STEP_TRIGGER_SKIPS.PERSON_NOT_KNOWN)).toBe(false);
    expect(PERSON_EVENT_RETRY_SKIPS.has(STEP_TRIGGER_SKIPS.PERSON_SUPPRESSED)).toBe(false);
    expect(PERSON_EVENT_RETRY_SKIPS.has(STEP_TRIGGER_SKIPS.NO_WORKFLOW)).toBe(false);
  });

  it("a campaign that is not a sales funnel unit has no money: final, never owed nor retried", () => {
    expect(OWED_UNTIL_ROOM_SKIPS.has(STEP_TRIGGER_SKIPS.NOT_A_SALES_FUNNEL_CAMPAIGN)).toBe(false);
    expect(PERSON_EVENT_RETRY_SKIPS.has(STEP_TRIGGER_SKIPS.NOT_A_SALES_FUNNEL_CAMPAIGN)).toBe(false);
  });

  it("every retry skip is a skip the step trigger can name", () => {
    const named = new Set<string>(Object.values(STEP_TRIGGER_SKIPS));
    for (const reason of PERSON_EVENT_RETRY_SKIPS) expect(named.has(reason)).toBe(true);
  });
});
