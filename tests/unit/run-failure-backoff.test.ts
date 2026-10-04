import { describe, it, expect } from "vitest";
import {
  FAILING_ALERT_THRESHOLD,
  FAILURE_RETRY_BASE_MS,
  FAILURE_RETRY_CEILING_MS,
  FAILURES_AT_BASE_CADENCE,
  failureRetryDelayMs,
  formatInterval,
  isInFailureBackoff,
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
  const later = new Date(now.getTime() + 10 * 60_000);

  it("is true only past the base cadence AND while the next run is still in the future", () => {
    expect(isInFailureBackoff({ consecutiveRunFailures: FAILURES_AT_BASE_CADENCE + 1, nextRunAt: later }, now)).toBe(true);
    expect(isInFailureBackoff({ consecutiveRunFailures: FAILURES_AT_BASE_CADENCE, nextRunAt: later }, now)).toBe(false);
    expect(isInFailureBackoff({ consecutiveRunFailures: 20, nextRunAt: new Date(now.getTime() - 1) }, now)).toBe(false);
    expect(isInFailureBackoff({ consecutiveRunFailures: 20, nextRunAt: null }, now)).toBe(false);
    expect(isInFailureBackoff({ consecutiveRunFailures: 0, nextRunAt: later }, now)).toBe(false);
  });
});

describe("formatInterval", () => {
  it("reads as a person would say it", () => {
    expect(formatInterval(30 * 60_000)).toBe("30 min");
    expect(formatInterval(60_000)).toBe("1 min");
    expect(formatInterval(10_000)).toBe("10 s");
  });
});
