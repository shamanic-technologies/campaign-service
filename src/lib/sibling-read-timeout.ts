/**
 * How long a READ of a sibling service may take before campaign-service gives up on it
 * (FLEET-STALL-1107).
 *
 * Node's fetch has no deadline of its own (undici waits up to 300 s for headers). Prod
 * 2026-11-07 15:30-16:10 UTC: the shared Postgres was saturated (twice-daily backup + heavy
 * queries), billing answered its payment-outlook read with a 502 after ~2.3 min, and the
 * scheduler's payment-hold sweep, which runs FIRST in every tick and read every org one after the
 * other, held the tick for ~40 min: 62 campaigns overdue, campaign dispatch fell from ~70-140 to
 * ~0 per 15 min, for every client at once.
 *
 * Every caller already has a named answer for "could not be read" (fail-soft sweep, fail-open
 * credit check, fail-closed money read, ...). A deadline only makes that answer arrive in seconds
 * instead of minutes, so one slow sibling costs one read, never the whole tick.
 */
export const SIBLING_READ_TIMEOUT_MS = 15_000;

/** The signal every bounded sibling read passes to fetch. */
export function siblingReadSignal(ms: number = SIBLING_READ_TIMEOUT_MS): AbortSignal {
  return AbortSignal.timeout(ms);
}
