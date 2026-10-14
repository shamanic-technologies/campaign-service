import { describe, it, expect } from "vitest";
import { delayMsOf, parseDelayParams, personDelayLateMs, DELAY_PLAN_LATE_MS } from "../../src/lib/delay-trigger-detector.js";

describe("delay trigger params (FACT-NOT-FOLLOWED-1014)", () => {
  it("keeps {afterStep, days} byte-identical", () => {
    expect(parseDelayParams({ afterStep: "lead_found", days: 3 })).toEqual({ afterStep: "lead_found", days: 3 });
  });

  it("reads minutes and the step the person must still not have reached", () => {
    const p = parseDelayParams({ afterStep: "signup", minutes: 30, unlessStep: "paid_client" });
    expect(p).toEqual({ afterStep: "signup", minutes: 30, unlessStep: "paid_client" });
    expect(delayMsOf(p!)).toBe(30 * 60_000);
  });

  it("refuses both or neither of days/minutes, a minute delay under 5, a non-integer, an unlessStep equal to afterStep", () => {
    expect(parseDelayParams({ afterStep: "signup", days: 1, minutes: 30 })).toBeNull();
    expect(parseDelayParams({ afterStep: "signup" })).toBeNull();
    expect(parseDelayParams({ afterStep: "signup", minutes: 4 })).toBeNull();
    expect(parseDelayParams({ afterStep: "signup", minutes: 30.5 })).toBeNull();
    expect(parseDelayParams({ afterStep: "signup", minutes: 30, unlessStep: "signup" })).toBeNull();
    expect(parseDelayParams({ afterStep: "signup", minutes: 30, unlessStep: "" })).toBeNull();
    expect(parseDelayParams({ afterStep: "signup", days: 0 })).toBeNull();
  });

  it("an anchor is never planned later than the delay itself (a connector backfill writes to nobody)", () => {
    expect(personDelayLateMs({ afterStep: "signup", minutes: 30, unlessStep: "paid_client" })).toBe(30 * 60_000);
    expect(personDelayLateMs({ afterStep: "signup", days: 5, unlessStep: "paid_client" })).toBe(DELAY_PLAN_LATE_MS);
  });
});

describe("lead-service step-reached answer", () => {
  it("since mode needs a date; email mode keeps an undated reach (the person still reached the step)", async () => {
    const { parseStepReachers } = await import("../../src/lib/step-reach-client.js");
    const undated = { step: "paid_client", people: [{ email: "A@x.io", name: null, phone: null, reachedAt: null }] };
    expect(() => parseStepReachers(undated)).toThrow(/malformed/);
    expect(parseStepReachers(undated, true).map((p) => p.email)).toEqual(["a@x.io"]);
    expect(() => parseStepReachers({ step: "signup" })).toThrow(/no people/);
  });
});
