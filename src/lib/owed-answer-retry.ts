import { eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { triggerEvents } from "../db/schema.js";
import { fetchFollowupDue } from "./followup-due-client.js";
import { REPLAY_STATE } from "./channel-down-replay.js";
import { ANSWERED_AFTER_FACT, BRAND_SILENCED_CODES, TEAM_ANSWERED_CODES } from "./unsent-answers.js";

/**
 * A PERSON OWED AN ANSWER ON A TRIGGER-RUN UNIT IS RETRIED (ANSWER-RETRY-TRIGGER-UNIT-1119).
 *
 * Prod 2026-11-19, Doc Dinners unit 95e0219e (`runs_on_trigger_id` lead_event): a prospect's Lead event run was
 * refused by the sender (`no_script`, an Engine gap since fixed) and the occurrence ended done / refused. lead-service
 * kept her OWED on that unit's queue (ANSWER-RETRY-1106: "the answering path retries then") and answered `owedNow`
 * true, yet nothing ran for 2 hours: a unit that runs on a trigger is parked as on demand (lib/on-demand-mode.ts)
 * BEFORE the reactive owed-wake (lib/reactive-wake.ts) is consulted, so only a NEW occurrence could ever retry her.
 *
 * The unit itself must still never run on its own: its pipe is a PROACTIVE one reused behind a trigger
 * (lib/sales-funnel-head-trigger.ts), and a run carrying no occurrence is a proactive run (an Engine run on `start`
 * finds its own subject through its vendors; a DAG serves a new lead when `/start-run` says `reactive: false`).
 * So the owed person is retried through the SAME path that failed them: the occurrence that carried them.
 *
 * When the scheduler claims a trigger-run unit (any trigger, any channel, any brand):
 *  1. ASK lead-service whether anyone is owed now on the unit's own queue (the occurrence made them due there). A
 *     read that fails changes nothing (logged; asked again on the next claim, `ON_DEMAND_RECHECK_MS`).
 *  2. Owed = every occurrence carrying a person or an item whose LATEST delivery on this unit ended without answering
 *     them (`failed`, `timed_out`, or a FINAL refusal: never a team answer / brand silence, never a channel-down
 *     refusal the replay owns, never `not_admitted` (the strategy's verdict), never `no_work` (the run read nothing
 *     to do)), done, not withdrawn, not folded, recorded within `OWED_RETRY_MAX_AGE_MS`, and that no completed run of
 *     the brand answered since (same person: email, phone or item human), is put back `pending` due NOW for THIS
 *     campaign only (`retryCampaignIds`, the redelivery path of lib/trigger-deliveries.ts). It then fires like a
 *     fresh occurrence: caps, On/Off, the person's filing and due state, folding, the writer's own reading of the
 *     whole thread. At most `OWED_RETRY_MAX` re-opens per occurrence x campaign (`detail.owedAnswerRetries`).
 *  3. The unit stays parked: nobody owed, or owed with nothing to re-open, never runs it.
 */

/** How old an occurrence may be and still be re-opened for a person owed an answer. */
export const OWED_RETRY_MAX_AGE_MS = 7 * 24 * 3_600_000;
/** Re-opens per occurrence x campaign: each one is a fresh redelivery chain of its own. */
export const OWED_RETRY_MAX = 3;
/** Occurrences re-opened per unit per claim. */
const OWED_RETRY_LIMIT = 10;
/** The hold named on a re-opened occurrence's `last_error`. */
export const OWED_ANSWER_RETRY_HOLD = "owed_answer_retry";

export interface OwedRetryUnit {
  id: string;
  orgId: string;
}

export type OwedRetryOutcome =
  | { kind: "unreadable" }
  | { kind: "nobody_owed" }
  | { kind: "reopened"; eventIds: string[] };

const rows = async <T>(q: ReturnType<typeof sql>) => (await db.execute(q)) as unknown as T[];
const own = (detail: unknown): Record<string, unknown> =>
  detail && typeof detail === "object" && !Array.isArray(detail) ? (detail as Record<string, unknown>) : {};
const clip = (v: string, max: number) => (v.length > max ? v.slice(0, max) : v);

/** The occurrences a person owed an answer on this unit is retried through (step 2 above). */
export async function owedOccurrencesOf(campaignId: string, now: Date = new Date()): Promise<Array<{ eventId: string; runId: string; status: string; refusalCode: string | null }>> {
  const since = new Date(now.getTime() - OWED_RETRY_MAX_AGE_MS).toISOString();
  const quiet = [...TEAM_ANSWERED_CODES, ...BRAND_SILENCED_CODES];
  const found = await rows<{ event_id: string; run_id: string; status: string; refusal_code: string | null }>(sql`
    WITH last AS (
      SELECT DISTINCT ON (event_id) event_id, run_id, status, refusal_code, channel_down_judged_at, replay_state, dispatched_at
      FROM trigger_event_deliveries
      WHERE campaign_id = ${campaignId} AND dispatched_at >= ${since}::timestamptz
      ORDER BY event_id, dispatched_at DESC
    )
    SELECT l.event_id, l.run_id, l.status, l.refusal_code
    FROM last l
    JOIN trigger_events e ON e.id = l.event_id
    WHERE e.status = 'done'
      AND greatest(e.occurred_at, e.created_at) >= ${since}::timestamptz
      AND (e.detail ? 'person' OR e.detail ? 'item' OR e.detail ? 'peopleCampaignIds')
      AND NOT (e.detail ? 'withdrawnAt')
      AND coalesce(e.skip_reason, '') <> ${ANSWERED_AFTER_FACT}
      AND NOT (coalesce(e.detail->'skipped', '[]'::jsonb) @> ${JSON.stringify([{ reason: ANSWERED_AFTER_FACT }])}::jsonb)
      AND (
        l.status IN ('failed', 'timed_out')
        OR (l.status = 'refused'
          AND l.channel_down_judged_at IS NOT NULL
          AND l.replay_state IN (${REPLAY_STATE.FINAL}, ${REPLAY_STATE.EXPIRED})
          AND coalesce(l.refusal_code, '') NOT IN (${sql.join(quiet.map((c) => sql`${c}`), sql`, `)}))
      )
      AND (
        SELECT count(*) FROM jsonb_array_elements(coalesce(e.detail->'owedAnswerRetries', '[]'::jsonb)) r
        WHERE r->>'campaignId' = ${campaignId}
      ) < ${OWED_RETRY_MAX}
      AND NOT EXISTS (
        SELECT 1
        FROM trigger_events o
        JOIN trigger_event_deliveries d ON d.event_id = o.id AND d.status = 'completed'
        WHERE o.org_id = e.org_id AND o.brand_id = e.brand_id
          AND d.dispatched_at >= greatest(e.occurred_at, e.created_at)
          AND (
            (e.detail->'person'->>'email' IS NOT NULL AND lower(o.detail->'person'->>'email') = lower(e.detail->'person'->>'email'))
            OR (e.detail->'person'->>'phone' IS NOT NULL AND o.detail->'person'->>'phone' = e.detail->'person'->>'phone')
            OR (e.detail->'item'->>'humanId' IS NOT NULL AND o.detail->'item'->>'humanId' = e.detail->'item'->>'humanId')
          )
      )
    ORDER BY l.dispatched_at DESC
    LIMIT ${OWED_RETRY_LIMIT}`);
  return found.map((r) => ({ eventId: r.event_id, runId: r.run_id, status: r.status, refusalCode: r.refusal_code }));
}

/** Put one done occurrence back `pending`, due now, for this campaign only. False when it moved meanwhile. */
async function reopen(campaignId: string, o: { eventId: string; runId: string; status: string; refusalCode: string | null }, now: Date): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [event] = await tx.select().from(triggerEvents).where(eq(triggerEvents.id, o.eventId)).for("update");
    if (!event || event.status !== "done") return false;
    const detail = own(event.detail);
    const retries = [
      ...(Array.isArray(detail.owedAnswerRetries) ? detail.owedAnswerRetries : []),
      { campaignId, afterRunId: o.runId, afterStatus: o.status, refusalCode: o.refusalCode, at: now.toISOString() },
    ];
    await tx
      .update(triggerEvents)
      .set({
        status: "pending",
        dueAt: now,
        claimedAt: null,
        outcome: null,
        skipReason: null,
        detail: {
          ...detail,
          // Only this campaign is asked again; a campaign that ran stays ran and is never dispatched twice.
          retryCampaignIds: [campaignId],
          priorRanCampaignIds: event.ranCampaignIds ?? [],
          // Young again (lib/trigger-events.ts): a passing hold then gets its short retries.
          redeliveredAt: now.toISOString(),
          owedAnswerRetries: retries,
        },
        lastError: clip(`${campaignId} ${OWED_ANSWER_RETRY_HOLD}: lead-service holds a person owed our answer on this unit; its last run here ended ${o.status}${o.refusalCode ? ` (${o.refusalCode})` : ""}`, 500),
      })
      .where(eq(triggerEvents.id, event.id));
    return true;
  });
}

/** Steps 1-2 for one claimed trigger-run unit. Never throws; never dispatches the unit itself. */
export async function retryOwedAnswersOnTriggerUnit(unit: OwedRetryUnit, now: Date = new Date()): Promise<OwedRetryOutcome> {
  let owedNow: boolean;
  try {
    owedNow = (await fetchFollowupDue({ orgId: unit.orgId, actingCampaignId: unit.id, campaignIds: [unit.id] })).owedNow;
  } catch (err) {
    console.error(
      `[campaign-service] trigger-run unit ${unit.id}: could not read who is owed (${err instanceof Error ? err.message : String(err)}); asked again on its next claim`,
    );
    return { kind: "unreadable" };
  }
  if (!owedNow) return { kind: "nobody_owed" };
  const eventIds: string[] = [];
  try {
    for (const o of await owedOccurrencesOf(unit.id, now)) {
      if (await reopen(unit.id, o, now)) eventIds.push(o.eventId);
    }
  } catch (err) {
    console.error(`[campaign-service] trigger-run unit ${unit.id}: owed occurrences could not be re-opened:`, err);
  }
  if (eventIds.length > 0) {
    console.warn(
      `[campaign-service] trigger-run unit ${unit.id}: someone is owed our answer; re-opened occurrence(s) ${eventIds.join(", ")} for it (ANSWER-RETRY-TRIGGER-UNIT-1119)`,
    );
  }
  return { kind: "reopened", eventIds };
}
