import { describe, it, expect } from "vitest";
import {
  TRIGGER_DELIVERY_MAX,
  TRIGGER_DELIVERY_NOTHING_YET_MAX,
  deliveryMax,
  redeliveryDelayMs,
} from "../../src/lib/trigger-deliveries.js";

const MIN = 60_000;
/** When each run of one occurrence starts (minutes after the first), every run ending the same way. */
function runTimes(nothingToDo: boolean): number[] {
  const times = [0];
  for (let failed = 1; failed < deliveryMax(nothingToDo); failed++) times.push(times[failed - 1] + redeliveryDelayMs(failed, nothingToDo) / MIN);
  return times;
}

describe("redelivery of an occurrence whose runs found nothing to do YET (HELLO-LATE-1126)", () => {
  it("Elias, 2026-11-25: number given 15:10, account 15:23:34 (13.5 min later): the next run is within 2 min of it", () => {
    const times = runTimes(true);
    for (const landed of [0.5, 3, 7.2, 13.5, 17]) {
      const next = times.find((t) => t >= landed)!;
      expect(next - landed).toBeLessThanOrEqual(2);
    }
    // Before: the failure backoff put the next run 30 min after the 15:22 one (15:52-15:53).
    const failed = runTimes(false);
    expect(failed.find((t) => t >= 13.5)! - 13.5).toBeGreaterThan(25);
  });

  it("keeps the same ~4 h window, never more runs than that", () => {
    const times = runTimes(true);
    expect(times.length).toBe(TRIGGER_DELIVERY_NOTHING_YET_MAX);
    expect(times.at(-1)).toBeGreaterThanOrEqual(3.5 * 60);
    expect(times.at(-1)).toBeLessThanOrEqual(4.5 * 60);
  });

  it("a failed run keeps the failure backoff and its count, byte for byte", () => {
    expect(deliveryMax(false)).toBe(TRIGGER_DELIVERY_MAX);
    expect([1, 2, 3, 4, 5].map((n) => redeliveryDelayMs(n) / MIN)).toEqual([2, 10, 30, 60, 120]);
    expect([1, 2, 3, 4, 5].map((n) => redeliveryDelayMs(n, false) / MIN)).toEqual([2, 10, 30, 60, 120]);
  });
});
