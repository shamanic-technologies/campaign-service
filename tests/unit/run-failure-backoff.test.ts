import { describe, it, expect } from "vitest";
import {
  FAILING_ALERT_THRESHOLD,
  FAILURE_RETRY_BASE_MS,
  FAILURE_RETRY_CEILING_MS,
  FAILURES_AT_BASE_CADENCE,
  failureRetryDelayMs,
  formatInterval,
  isInFailureBackoff,
  failureBackoffEndsAt,
  FRESH_START_STREAK_FIELDS,
  runHealthOf,
} from "../../src/lib/run-failure-backoff.js";

describe("failureRetryDelayMs — the retry interval widens with the streak, up to a ceiling", () => {
  it("keeps the old 60s cadence for a transient blip (the first few failures)", () => {
    for (let n = 1; n <= FAILURES_AT_BASE_CADENCE; n++) {
      expect(failureRetryDelayMs(n)).toBe(FAILURE_RETRY_BASE_MS);
    }
  });

  it("doubles after that: 2, 4, 8, 16 min, then holds at the 30 min ceiling", () => {
    const minutes = [4, 5, 6, 7, 8, 9, 50, 10_000].map((n) => failureRetryDelayMs(n) / 60_000);
    expect(minutes).toEqual([2, 4, 8, 16, 30, 30, 30, 30]);
    expect(failureRetryDelayMs(1_000_000)).toBe(FAILURE_RETRY_CEILING_MS);
  });

  it("never shrinks as the streak grows", () => {
    let prev = 0;
    for (let n = 1; n <= 40; n++) {
      const d = failureRetryDelayMs(n);
      expect(d).toBeGreaterThanOrEqual(prev);
      prev = d;
    }
  });

  it("a campaign failing all day costs ~48 attempts instead of 1,440", () => {
    let t = 0;
    let attempts = 0;
    while (t < 24 * 60 * 60_000) {
      attempts++;
      t += failureRetryDelayMs(attempts);
    }
    expect(attempts).toBeLessThan(60);
  });

  it("the alert threshold is reached ~33 min into an uninterrupted streak", () => {
    let t = 0;
    for (let n = 1; n < FAILING_ALERT_THRESHOLD; n++) t += failureRetryDelayMs(n);
    expect(t / 60_000).toBe(33);
  });
});

describe("runHealthOf — the readable state", () => {
  const base = { consecutiveRunFailures: 0, failingSince: null, lastRunFailureAt: null, failureAlertedAt: null };

  it("healthy with no streak", () => {
    expect(runHealthOf(base)).toEqual({
      state: "healthy",
      consecutiveFailures: 0,
      failingSince: null,
      lastFailureAt: null,
      retryIntervalMs: null,
      alertedAt: null,
    });
  });

  it("retrying below the threshold, failing at it", () => {
    const since = new Date("2026-10-04T00:35:40Z");
    const r = runHealthOf({ ...base, consecutiveRunFailures: FAILING_ALERT_THRESHOLD - 1, failingSince: since, lastRunFailureAt: since });
    expect(r.state).toBe("retrying");
    expect(r.failingSince).toBe(since.toISOString());
    const f = runHealthOf({ ...base, consecutiveRunFailures: FAILING_ALERT_THRESHOLD, failingSince: since, lastRunFailureAt: since, failureAlertedAt: since });
    expect(f.state).toBe("failing");
    expect(f.retryIntervalMs).toBe(FAILURE_RETRY_CEILING_MS);
    expect(f.alertedAt).toBe(since.toISOString());
  });
});

describe("isInFailureBackoff — an event must not bypass a widened interval", () => {
  const now = new Date("2026-10-04T12:00:00Z");
  const ago = (ms: number) => new Date(now.getTime() - ms);

  it("holds only while the interval the LAST FAILURE earned runs, beyond the base cadence", () => {
    // 4 failures = 2 min interval.
    expect(isInFailureBackoff({ consecutiveRunFailures: FAILURES_AT_BASE_CADENCE + 1, lastRunFailureAt: ago(60_000) }, now)).toBe(true);
    expect(isInFailureBackoff({ consecutiveRunFailures: FAILURES_AT_BASE_CADENCE + 1, lastRunFailureAt: ago(3 * 60_000) }, now)).toBe(false);
    expect(isInFailureBackoff({ consecutiveRunFailures: FAILURES_AT_BASE_CADENCE, lastRunFailureAt: ago(1_000) }, now)).toBe(false);
    expect(isInFailureBackoff({ consecutiveRunFailures: 20, lastRunFailureAt: ago(29 * 60_000) }, now)).toBe(true);
    expect(isInFailureBackoff({ consecutiveRunFailures: 20, lastRunFailureAt: ago(31 * 60_000) }, now)).toBe(false);
    expect(isInFailureBackoff({ consecutiveRunFailures: 20, lastRunFailureAt: null }, now)).toBe(false);
    expect(isInFailureBackoff({ consecutiveRunFailures: 0, lastRunFailureAt: ago(1_000) }, now)).toBe(false);
  });

  it("ends even when a parked unit's next_run_at keeps moving ahead (REACTIVE-BACKOFF-DEADLOCK-1025)", () => {
    // Prod 2026-10-25: 4 failures, last at 18:02 the day before, next_run_at pushed 10 min ahead by
    // every park. The backoff is long over; the event must dispatch the retry run.
    const row = {
      consecutiveRunFailures: 4,
      lastRunFailureAt: new Date("2026-10-24T18:02:18Z"),
      nextRunAt: new Date("2026-10-25T08:27:59Z"),
    };
    expect(isInFailureBackoff(row, new Date("2026-10-25T08:21:14Z"))).toBe(false);
    expect(failureBackoffEndsAt(row)!.toISOString()).toBe("2026-10-24T18:04:18.000Z");
  });

  it("a fresh start clears the streak, keeps the alert latch", () => {
    expect(FRESH_START_STREAK_FIELDS).toEqual({ consecutiveRunFailures: 0, failingSince: null, lastRunFailureAt: null });
    expect(Object.keys(FRESH_START_STREAK_FIELDS)).not.toContain("failureAlertedAt");
  });
});

describe("formatInterval", () => {
  it("reads as a person would say it", () => {
    expect(formatInterval(30 * 60_000)).toBe("30 min");
    expect(formatInterval(60_000)).toBe("1 min");
    expect(formatInterval(10_000)).toBe("10 s");
  });
});
