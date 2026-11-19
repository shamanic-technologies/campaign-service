import { describe, it, expect } from "vitest";
import { gateReasonToSkip, GATE_REFUSED_RETRY_MS } from "../../src/lib/trigger-deliveries.js";
import { OWED_UNTIL_ROOM_SKIPS } from "../../src/lib/trigger-person.js";
import { MONEY_HOLDS } from "../../src/lib/stuck-occurrences.js";
import { STEP_TRIGGER_SKIPS } from "../../src/lib/step-trigger.js";

/**
 * MON-STUCK-RETRY-1119: a prospect stuck on "Insufficient credits" retried 643 times in 39 h
 * because every gate refusal was re-queued as `run_in_flight` regardless of the actual reason.
 * Now `gateReasonToSkip` maps permanent funding refusals to `insufficient_credits`.
 */
describe("gate refusal → occurrence skip token mapping", () => {
  it("Insufficient credits maps to insufficient_credits, not run_in_flight", () => {
    expect(gateReasonToSkip("Insufficient credits")).toBe("insufficient_credits");
  });

  it("transient refusals (run in progress) keep run_in_flight", () => {
    expect(gateReasonToSkip("A run is already in progress")).toBe("run_in_flight");
  });

  it("unknown/generic gate reasons default to run_in_flight", () => {
    expect(gateReasonToSkip("refused")).toBe("run_in_flight");
    expect(gateReasonToSkip("Campaign is not ongoing")).toBe("run_in_flight");
  });

  it("insufficient_credits is owed until room returns (never dropped)", () => {
    expect(OWED_UNTIL_ROOM_SKIPS.has("insufficient_credits")).toBe(true);
  });

  it("insufficient_credits is a money hold (not red on the monitoring hub)", () => {
    expect(MONEY_HOLDS.has("insufficient_credits")).toBe(true);
  });

  it("insufficient_credits is a named step-trigger skip (structural invariant)", () => {
    const named = new Set<string>(Object.values(STEP_TRIGGER_SKIPS));
    expect(named.has("insufficient_credits")).toBe(true);
  });
});
