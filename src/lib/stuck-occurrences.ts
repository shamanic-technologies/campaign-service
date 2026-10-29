import { inArray, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { campaigns } from "../db/schema.js";
import { waitsOnlyOnChannel } from "./channel-down-replay.js";

/**
 * A PROSPECT WAITING ON A BLOCKED OCCURRENCE TURNS THE MONITORING HUB RED (REACTIVE-THROUGHPUT-1028).
 *
 * History: HOTFIX ANCESTOR-1015 (a Meta Ads form waited 14 h behind a failure backoff, nobody told) made every
 * stuck occurrence a staff EMAIL (`trigger_occurrence_stuck`). On 2026-10-28 it sent 48 of them, all about people
 * simply queued behind a newsletter burst. Owner rule (2026-10-22): « no email in my inbox please »; a monitoring
 * alert is red on dashboard v2 Monitoring. So nothing is sent any more: this READ is the alert, the way
 * crm-service serves its trigger reports (crm-service #214).
 *
 * STUCK = an occurrence carrying a PERSON or an ITEM (somebody waits for its answer), not done, waiting longer
 * than `STUCK_OCCURRENCE_AFTER_MS` (since its fact, or its recording when recorded later: `waitingSince`), tried
 * at least `STUCK_OCCURRENCE_MIN_ATTEMPTS` times, and genuinely BLOCKED. NOT stuck:
 *   - held only by the CUSTOMER's money (`MONEY_HOLDS`): their choice, owed until room returns;
 *   - waiting for the brand's channel to come back (lib/channel-down-replay.ts): replayed by itself;
 *   - waiting its turn in a MOVING queue: every hold is a run in flight, and the campaign holding it dispatched or
 *     finished a run inside `MOVING_QUEUE_WINDOW_MS` (lib/person-runs.ts drains it as runs end), for less than
 *     `QUEUED_TOO_LONG_MS`. A queue that moves but leaves a person waiting longer IS broken (ONE-AI-CONVERSES-1029-
 *     QUEUE, prod 2026-10-29: a person who wrote to us waited hours in a queue that "moved"): stuck, red.
 * Everything else (a failure backoff, a refused dispatch, an unreadable read, a run in flight with no run moving)
 * is a defect somebody must look at.
 *
 * Read-only, fleet-wide, recomputed from the dated occurrence rows (the daily series needs nothing stored).
 */

/** How long an occurrence may wait for its answer before it is stuck. */
export const STUCK_OCCURRENCE_AFTER_MS = 30 * 60_000;
/** Tried at least this often (a first `run_in_flight` retry two minutes later is normal pacing). */
export const STUCK_OCCURRENCE_MIN_ATTEMPTS = 3;
/** Waiting its turn longer than this, even in a queue that moves, is broken: the queue is too slow. */
export const QUEUED_TOO_LONG_MS = 60 * 60_000;
/** A campaign that dispatched or finished a run this recently is draining its queue. */
export const MOVING_QUEUE_WINDOW_MS = 15 * 60_000;
const STUCK_LIST_LIMIT = 100;

/** Holds the CUSTOMER chose through their money: owed, never a defect. */
export const MONEY_HOLDS: ReadonlySet<string> = new Set(["sales_funnel_cap", "unfunded"]);
/** Holds that only mean "a run is busy": a turn in a queue, while the queue moves. */
export const QUEUE_HOLDS: ReadonlySet<string> = new Set(["run_in_flight", "cohort_run_in_flight"]);

/** Every campaign holding an occurrence back and why, read off `last_error` (`<campaignId> <reason>, ...`). Pure. */
export function heldBackBy(lastError: string | null): { campaignId: string | null; campaignIds: string[]; reasons: string[] } {
  if (!lastError) return { campaignId: null, campaignIds: [], reasons: [] };
  const pairs = [...lastError.matchAll(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}) ([a-z_]+)/g)];
  return { campaignId: pairs[0]?.[1] ?? null, campaignIds: [...new Set(pairs.map((p) => p[1]))], reasons: pairs.map((p) => p[2]) };
}

/**
 * Since when somebody has been waiting on an occurrence: its fact, or its recording when it was recorded later (a
 * composite occurrence replayed today for a fact of yesterday waited minutes, not a day: LEAD-EVENT-WHATSAPP-1027).
 * Pure.
 */
export function waitingSince(event: { occurredAt: Date; createdAt: Date }): Date {
  return event.occurredAt.getTime() >= event.createdAt.getTime() ? event.occurredAt : event.createdAt;
}

/** Whether an occurrence waits only on the customer's money. Pure. */
export function waitsOnlyOnMoney(lastError: string | null): boolean {
  const { reasons } = heldBackBy(lastError);
  return reasons.length > 0 && reasons.every((r) => MONEY_HOLDS.has(r));
}

/** Whether an occurrence only waits for a busy run, behind campaigns whose queue moved recently. Pure. */
export function waitsInMovingQueue(lastError: string | null, movingCampaignIds: ReadonlySet<string>): boolean {
  const { campaignIds, reasons } = heldBackBy(lastError);
  return reasons.length > 0 && reasons.every((r) => QUEUE_HOLDS.has(r)) && campaignIds.every((id) => movingCampaignIds.has(id));
}

export interface StuckOccurrences {
  generatedAt: string;
  days: number;
  stuckAfterMinutes: number;
  /** red = at least one occurrence stuck now. */
  status: "ok" | "red";
  stuck: number;
  /** Waiting their turn behind a run, in a queue that moves: not stuck, counted for the picture. */
  queued: number;
  stuckByReason: { reason: string; count: number; oldestWaitingSince: string }[];
  stuckOccurrences: {
    occurrenceId: string;
    orgId: string;
    brandId: string;
    offerId: string;
    triggerId: string | null;
    campaignId: string | null;
    campaignName: string | null;
    person: { name: string | null; email: string | null; phone: string | null } | null;
    reasons: string[];
    lastError: string | null;
    attempts: number;
    waitingSince: string;
  }[];
  /** Per UTC day of `waitingSince`, occurrences carrying somebody: how each ended, and how many waited too long. */
  byDay: {
    day: string;
    answered: number;
    /** Answered, but more than `stuckAfterMinutes` after the person acted. */
    answeredLate: number;
    skipped: number;
    failed: number;
    waiting: number;
    /**
     * How long the people answered that day waited, fact to answer (minutes, one decimal); null = nobody answered.
     * The chart's figure: p90 above `stuckAfterMinutes` is a slow day.
     */
    waitMinutes: { p50: number | null; p90: number | null; max: number | null };
  }[];
  /** How long the person waiting longest (not on money nor a channel outage, tried 3+ times) has waited now; null = nobody waits past `stuckAfterMinutes`. */
  oldestWaitingMinutes: number | null;
  /** Waiting longer than this in a queue that moves is stuck (red). */
  queuedTooLongMinutes: number;
}

/** Seconds (postgres numeric/float, maybe text) to minutes with one decimal. Pure. */
export function minutesOf(seconds: number | string | null | undefined): number | null {
  if (seconds === null || seconds === undefined) return null;
  const n = Number(seconds);
  return Number.isFinite(n) ? Math.round(n / 6) / 10 : null;
}

const rows = async <T>(q: ReturnType<typeof sql>) => (await db.execute(q)) as unknown as T[];

export async function readStuckOccurrences(days: number, now: Date = new Date()): Promise<StuckOccurrences> {
  // Bound as ISO text + cast: postgres.js refuses a Date in a raw sql`` parameter.
  const waitingBefore = new Date(now.getTime() - STUCK_OCCURRENCE_AFTER_MS).toISOString();
  const movingAfter = new Date(now.getTime() - MOVING_QUEUE_WINDOW_MS).toISOString();
  const since = new Date(now.getTime() - days * 86_400_000).toISOString();
  const lateSeconds = STUCK_OCCURRENCE_AFTER_MS / 1000;

  const candidates = await rows<{
    id: string;
    org_id: string;
    brand_id: string;
    offer_id: string;
    trigger_id: string | null;
    last_error: string | null;
    attempts: number;
    waiting_since: Date | string;
    person: { name?: string | null; email?: string | null; phone?: string | null } | null;
  }>(sql`
    SELECT id, org_id, brand_id, offer_id, trigger_id, last_error, attempts,
           greatest(occurred_at, created_at) AS waiting_since, detail->'person' AS person
    FROM trigger_events
    WHERE status <> 'done'
      AND attempts >= ${STUCK_OCCURRENCE_MIN_ATTEMPTS}
      AND last_error IS NOT NULL
      AND greatest(occurred_at, created_at) <= ${waitingBefore}::timestamptz
      AND (detail ? 'person' OR detail ? 'item')
    ORDER BY greatest(occurred_at, created_at)`);

  const holders = [...new Set(candidates.flatMap((c) => heldBackBy(c.last_error).campaignIds))];
  const moving = new Set(
    holders.length === 0
      ? []
      : (await rows<{ campaign_id: string }>(sql`
          SELECT DISTINCT campaign_id FROM trigger_event_deliveries
          WHERE campaign_id IN (${sql.join(holders.map((h) => sql`${h}`), sql`, `)})
            AND greatest(dispatched_at, coalesce(ended_at, dispatched_at)) > ${movingAfter}::timestamptz`)).map((r) => r.campaign_id),
  );

  let queued = 0;
  const queuedTooLongBefore = now.getTime() - QUEUED_TOO_LONG_MS;
  const stuck = candidates.filter((c) => {
    if (waitsOnlyOnMoney(c.last_error) || waitsOnlyOnChannel(c.last_error)) return false;
    if (waitsInMovingQueue(c.last_error, moving) && new Date(c.waiting_since).getTime() > queuedTooLongBefore) {
      queued += 1;
      return false;
    }
    return true;
  });

  const waitingTimes = candidates
    .filter((c) => !waitsOnlyOnMoney(c.last_error) && !waitsOnlyOnChannel(c.last_error))
    .map((c) => new Date(c.waiting_since).getTime());
  const oldestWaiting = waitingTimes.length > 0 ? Math.min(...waitingTimes) : null;

  const stuckCampaignIds = [...new Set(stuck.flatMap((c) => heldBackBy(c.last_error).campaignId ?? []))];
  const names = new Map(
    stuckCampaignIds.length === 0
      ? []
      : (await db.select({ id: campaigns.id, name: campaigns.name }).from(campaigns).where(inArray(sql`${campaigns.id}::text`, stuckCampaignIds)))
          .map((c) => [c.id, c.name] as const),
  );

  const iso = (v: Date | string) => new Date(v).toISOString();
  const byReason = new Map<string, { count: number; oldest: string }>();
  for (const c of stuck) {
    const reasons = heldBackBy(c.last_error).reasons;
    for (const reason of reasons.length > 0 ? [...new Set(reasons)] : ["unnamed"]) {
      const at = byReason.get(reason);
      if (!at) byReason.set(reason, { count: 1, oldest: iso(c.waiting_since) });
      else at.count += 1;
    }
  }

  const days_ = await rows<{
    day: string; answered: number; answered_late: number; skipped: number; failed: number; waiting: number;
    wait_p50_s: number | string | null; wait_p90_s: number | string | null; wait_max_s: number | string | null;
  }>(sql`
    SELECT to_char(date_trunc('day', greatest(occurred_at, created_at) AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
           count(*) FILTER (WHERE status = 'done' AND outcome = 'ran')::int AS answered,
           count(*) FILTER (WHERE status = 'done' AND outcome = 'ran'
             AND processed_at - greatest(occurred_at, created_at) > make_interval(secs => ${lateSeconds}))::int AS answered_late,
           count(*) FILTER (WHERE status = 'done' AND outcome = 'skipped')::int AS skipped,
           count(*) FILTER (WHERE status = 'done' AND outcome NOT IN ('ran', 'skipped'))::int AS failed,
           count(*) FILTER (WHERE status <> 'done')::int AS waiting,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM processed_at - greatest(occurred_at, created_at)))
             FILTER (WHERE status = 'done' AND outcome = 'ran') AS wait_p50_s,
           percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM processed_at - greatest(occurred_at, created_at)))
             FILTER (WHERE status = 'done' AND outcome = 'ran') AS wait_p90_s,
           max(extract(epoch FROM processed_at - greatest(occurred_at, created_at)))
             FILTER (WHERE status = 'done' AND outcome = 'ran') AS wait_max_s
    FROM trigger_events
    WHERE greatest(occurred_at, created_at) >= ${since}::timestamptz
      AND greatest(occurred_at, created_at) <= ${now.toISOString()}::timestamptz
      AND (detail ? 'person' OR detail ? 'item')
    GROUP BY 1
    ORDER BY 1`);

  return {
    generatedAt: now.toISOString(),
    days,
    stuckAfterMinutes: STUCK_OCCURRENCE_AFTER_MS / 60_000,
    queuedTooLongMinutes: QUEUED_TOO_LONG_MS / 60_000,
    status: stuck.length > 0 ? "red" : "ok",
    stuck: stuck.length,
    queued,
    stuckByReason: [...byReason.entries()]
      .map(([reason, v]) => ({ reason, count: v.count, oldestWaitingSince: v.oldest }))
      .sort((a, b) => b.count - a.count),
    stuckOccurrences: stuck.slice(0, STUCK_LIST_LIMIT).map((c) => {
      const held = heldBackBy(c.last_error);
      return {
        occurrenceId: c.id,
        orgId: c.org_id,
        brandId: c.brand_id,
        offerId: c.offer_id,
        triggerId: c.trigger_id,
        campaignId: held.campaignId,
        campaignName: held.campaignId ? names.get(held.campaignId) ?? null : null,
        person: c.person ? { name: c.person.name ?? null, email: c.person.email ?? null, phone: c.person.phone ?? null } : null,
        reasons: held.reasons,
        lastError: c.last_error,
        attempts: c.attempts,
        waitingSince: iso(c.waiting_since),
      };
    }),
    byDay: days_.map((d) => ({
      day: d.day,
      answered: d.answered,
      answeredLate: d.answered_late,
      skipped: d.skipped,
      failed: d.failed,
      waiting: d.waiting,
      waitMinutes: {
        p50: minutesOf(d.wait_p50_s),
        p90: minutesOf(d.wait_p90_s),
        max: minutesOf(d.wait_max_s),
      },
    })),
    oldestWaitingMinutes: oldestWaiting === null ? null : Math.round((now.getTime() - oldestWaiting) / 60_000),
  };
}
