import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { triggerEventDeliveries, triggerEvents } from "../db/schema.js";
import { RUN_LIVENESS_THRESHOLD_MS } from "./run-liveness.js";
import type { EventPerson } from "./trigger-person.js";

/**
 * A RUN ABOUT ONE PERSON LOCKS THAT PERSON, NOT THE WHOLE CAMPAIGN (REACTIVE-THROUGHPUT-1028).
 *
 * Prod 2026-10-28: the newsletter went out at 08:00 and ~160 people clicked within the hour. Each click is a
 * "Lead event" occurrence carrying ONE person, answered by the Lead Follow-up campaign. The step trigger held
 * every occurrence behind "never two runs of one campaign, never two runs of one brand cohort", so they were
 * answered one at a time (~30 s each, ~45 people/hour, average wait 62 min, one waited 38 attempts).
 *
 * That guard exists because a run over a POPULATION picks its own people: two of them at once would contact the
 * same people from the same mailboxes. A run carrying ONE person (`trigger.person`) contacts that person only,
 * so two runs about two different people cannot collide. Their exclusivity key is the PERSON:
 *   - the same person is never in two runs at once on any campaign of the brand's cohort (`person_run_in_flight`
 *     reads as `run_in_flight`: owed, retried);
 *   - one campaign carries at most `PERSON_RUNS_PER_CAMPAIGN_MAX` such runs at once.
 * Mailbox pacing stays the sender's (instantly / crm-service), never decided here.
 *
 * In flight = a delivery row (lib/trigger-deliveries.ts) still `dispatched`, dispatched inside the run liveness
 * window (`RUN_LIVENESS_THRESHOLD_MS`, the same definition runs-service liveness uses), so a run that never
 * reports holds its person at most that long. A run carrying nobody (the scheduler, a person's start, a campaign
 * naming its own people) keeps the campaign + cohort guard, byte-identical.
 *
 * Why 4: every DAG runs on the box's Windmill worker pool, 3 jobs at once for the whole fleet (2 worker containers
 * + the server's worker, owner 2026-10-28; `NUM_WORKERS>1` is ignored for non-native workers, the pool grows by
 * containers). 4 in flight keeps every worker busy on a burst with one run queued behind them, while a 160-person
 * burst never parks more than 1 extra job in front of every other campaign's run. Each
 * follow-up run also makes one LLM call through chat-service; 4 concurrent calls are far below its provider rate
 * limits. Raise it with the worker pool, never past what Windmill can run inside the liveness window.
 */
export const PERSON_RUNS_PER_CAMPAIGN_MAX = 4;

export interface PersonRunInFlight {
  campaignId: string;
  email: string | null;
  phone: string | null;
}

/** The person-carrying runs in flight on these campaigns. */
export async function personRunsInFlight(campaignIds: readonly string[], now: Date): Promise<PersonRunInFlight[]> {
  if (campaignIds.length === 0) return [];
  const aliveAfter = new Date(now.getTime() - RUN_LIVENESS_THRESHOLD_MS);
  const rows = await db
    .select({
      campaignId: triggerEventDeliveries.campaignId,
      email: sql<string | null>`${triggerEvents.detail}->'person'->>'email'`,
      phone: sql<string | null>`${triggerEvents.detail}->'person'->>'phone'`,
    })
    .from(triggerEventDeliveries)
    .innerJoin(triggerEvents, eq(triggerEvents.id, triggerEventDeliveries.eventId))
    .where(and(
      inArray(triggerEventDeliveries.campaignId, [...campaignIds]),
      eq(triggerEventDeliveries.status, "dispatched"),
      gt(triggerEventDeliveries.dispatchedAt, aliveAfter),
      sql`${triggerEvents.detail} ? 'person'`,
    ));
  return rows;
}

/** workflow-service's admission subject for a run about this person (`email:<addr>`, else `phone:<e164>`). Pure. */
export function executionSubjectOf(person: EventPerson): string | undefined {
  if (person.email) return `email:${person.email}`;
  return person.phone ? `phone:${person.phone}` : undefined;
}

/** Whether a run in flight is about this person (same email, or same phone for a phone-only person). Pure. */
export function samePerson(run: Pick<PersonRunInFlight, "email" | "phone">, person: EventPerson): boolean {
  if (person.email) return run.email === person.email;
  return !!person.phone && !run.email && run.phone === person.phone;
}

/**
 * Why a person-carrying run of `campaignId` must wait, or null when it may go now. Pure over the runs in flight on
 * the campaign's cohort (its own campaign included).
 */
export function personRunHold(
  campaignId: string,
  person: EventPerson,
  inFlight: readonly PersonRunInFlight[],
): string | null {
  const same = inFlight.find((r) => samePerson(r, person));
  if (same) return `a run about this person is already in flight (campaign ${same.campaignId})`;
  const own = inFlight.filter((r) => r.campaignId === campaignId).length;
  if (own >= PERSON_RUNS_PER_CAMPAIGN_MAX) {
    return `${own} runs of this campaign are already answering other people (at most ${PERSON_RUNS_PER_CAMPAIGN_MAX} at once)`;
  }
  return null;
}

/**
 * Occurrences fire in parallel (the composite queue, the tick, the door), and a run's delivery row is written only
 * once its dispatch returns. So the check and the claim of a slot happen under ONE in-process lock per cohort, and
 * the claim is held in memory until the delivery row exists (`RESERVATION_TTL_MS`, or released at once when the
 * dispatch does not happen). In flight = the union of both, one per person. campaign-service runs one process.
 */
const RESERVATION_TTL_MS = 2 * 60_000;
const reservations = new Map<string, PersonRunInFlight & { cohortKey: string; at: number }>();
const cohortLocks = new Map<string, Promise<unknown>>();

const personKey = (p: Pick<PersonRunInFlight, "email" | "phone">) => (p.email ? `e:${p.email}` : `p:${p.phone ?? ""}`);

async function underCohortLock<T>(cohortKey: string, work: () => Promise<T>): Promise<T> {
  const prior = cohortLocks.get(cohortKey) ?? Promise.resolve();
  const mine = prior.then(work, work);
  const tail = mine.catch(() => undefined);
  cohortLocks.set(cohortKey, tail);
  try {
    return await mine;
  } finally {
    if (cohortLocks.get(cohortKey) === tail) cohortLocks.delete(cohortKey);
  }
}

/**
 * Claim a slot for a run of `campaignId` about `person`, or say why it must wait. `cohortKey` names the brand's
 * cohort (org, brand, cohort); `cohortIds` its live campaigns. The caller releases the claim when it does not
 * dispatch; a dispatched claim lapses by itself once the delivery row carries it.
 */
export async function reservePersonRun(
  cohortKey: string,
  cohortIds: readonly string[],
  campaignId: string,
  person: EventPerson,
  now: Date,
): Promise<{ ok: true; release: () => void } | { ok: false; detail: string }> {
  return underCohortLock(cohortKey, async () => {
    // Claims FIRST, rows second: a claim is released only after its row is written, so a run is always seen in
    // one of the two (read the other way round, a run whose row landed and claim went during the read is missed).
    const held = [...reservations.values()].filter((r) => r.cohortKey === cohortKey && now.getTime() - r.at < RESERVATION_TTL_MS);
    const stored = await personRunsInFlight(cohortIds, now);
    const byPerson = new Map<string, PersonRunInFlight>();
    for (const r of [...stored, ...held]) byPerson.set(`${r.campaignId}|${personKey(r)}`, r);
    const hold = personRunHold(campaignId, person, [...byPerson.values()]);
    if (hold) return { ok: false as const, detail: hold };
    const key = `${cohortKey}|${campaignId}|${personKey({ email: person.email, phone: person.phone ?? null })}|${crypto.randomUUID()}`;
    reservations.set(key, { campaignId, email: person.email, phone: person.phone ?? null, cohortKey, at: now.getTime() });
    for (const [k, r] of reservations) if (now.getTime() - r.at >= RESERVATION_TTL_MS) reservations.delete(k);
    return { ok: true as const, release: () => void reservations.delete(key) };
  });
}

/** The delivery rows of these dispatched runs exist now: their in-memory claims are no longer needed. */
export function releasePersonRunReservations(campaignIds: readonly string[], person: EventPerson): void {
  const who = personKey({ email: person.email, phone: person.phone ?? null });
  for (const [k, r] of reservations) {
    if (campaignIds.includes(r.campaignId) && personKey(r) === who) reservations.delete(k);
  }
}

/** Test hook: forget every in-memory claim. */
export function resetPersonRunReservations(): void {
  reservations.clear();
}

/**
 * A run of `campaignId` just ended: a slot is free, so the occurrences it held back (`<campaignId> run_in_flight`)
 * fall due NOW, instead of on their 2-10 min retry. Without it the burst drains at the retry cadence, not at the
 * speed runs finish. Returns how many were made due.
 *
 * NEWEST FACT FIRST (ONE-AI-CONVERSES-1029-QUEUE, prod 2026-10-29): oldest-first put a person who had just written
 * to us behind 388 newsletter clicks from the morning, so the answer that matters most (now) came hours late, and
 * every click was answered hours late anyway. Newest first answers what just happened within a run's time whatever
 * the backlog; an older fact about the same person is then folded into that answer (`personAnsweredAfterFact`).
 * Generic: no trigger, channel or brand is ranked above another.
 *
 * A hold set after a FAILED run (`<campaignId> failure_backoff`) is woken the same way: a run that ends is the moment
 * the backoff may have cleared (a success resets it), and a woken occurrence still in a backoff is simply held again
 * until the backoff's own end (lib/trigger-events.ts `heldBackDueAt`). Before, those waited 10 min each.
 */
export async function wakeOccurrencesHeldBy(campaignId: string, now: Date = new Date()): Promise<number> {
  const held = `${campaignId} run_in_flight`;
  const backedOff = `${campaignId} failure_backoff`;
  const woken = await db
    .update(triggerEvents)
    .set({ dueAt: now })
    .where(sql`${triggerEvents.id} IN (
      SELECT id FROM trigger_events
      WHERE status = 'pending'
        AND due_at > ${now.toISOString()}::timestamptz
        AND (position(${held} in coalesce(last_error, '')) > 0 OR position(${backedOff} in coalesce(last_error, '')) > 0)
      ORDER BY greatest(occurred_at, created_at) DESC
      LIMIT ${PERSON_RUNS_PER_CAMPAIGN_MAX}
    )`)
    .returning({ id: triggerEvents.id });
  return woken.length;
}

/**
 * A PERSON'S PENDING FACTS COLLAPSE INTO ONE ANSWER (ONE-AI-CONVERSES-1029-QUEUE).
 *
 * A run about a person reads that person's whole timeline when it runs, so a run of `campaignId` about them that
 * was DISPATCHED AFTER this occurrence's fact was recorded and fell due (`greatest(occurred_at, created_at, first
 * due date)`: a follow-up planned for a later date is never folded into a run before that date) and did its work
 * (`completed`, or `not_admitted`: the pipe's strategy already judged that person) has already seen this fact.
 * Running again for it would spend a slot to answer the same person twice (prod 2026-10-29: a newsletter click
 * arrives as 3 occurrences in the same second, 884 pending for 607 people). Returns that run, or null.
 * Any trigger, any campaign: the key is only (campaign, person, time).
 */
export async function personAnsweredAfterFact(
  campaignId: string,
  person: EventPerson,
  eventId: string,
): Promise<{ runId: string; dispatchedAt: Date } | null> {
  const samePersonSql = person.email
    ? sql`e.detail->'person'->>'email' = ${person.email}`
    : person.phone
      ? sql`(e.detail->'person'->>'email') IS NULL AND e.detail->'person'->>'phone' = ${person.phone}`
      : null;
  if (!samePersonSql) return null;
  const rows = (await db.execute(sql`
    SELECT d.run_id, d.dispatched_at
    FROM trigger_event_deliveries d
    JOIN trigger_events e ON e.id = d.event_id
    JOIN trigger_events me ON me.id = ${eventId}
    WHERE d.campaign_id = ${campaignId}
      AND d.event_id <> ${eventId}
      AND d.status IN ('completed', 'not_admitted')
      AND d.dispatched_at >= greatest(me.occurred_at, me.created_at, coalesce((me.detail->>'fellDueAt')::timestamptz, me.due_at))
      AND ${samePersonSql}
    ORDER BY d.dispatched_at
    LIMIT 1`)) as unknown as Array<{ run_id: string; dispatched_at: Date | string }>;
  const row = rows[0];
  return row ? { runId: row.run_id, dispatchedAt: new Date(row.dispatched_at) } : null;
}

/**
 * Which of these runs were dispatched for an occurrence carrying ONE person (a delivery row whose occurrence has a
 * `person`). Their exclusivity is the person lock above, taken at dispatch: the DAG's gate must not refuse them as
 * "a run is already in progress" because ANOTHER person's run is (lib/gate-check.ts block 2).
 */
export async function personCarryingRunIds(runIds: readonly string[]): Promise<Set<string>> {
  if (runIds.length === 0) return new Set();
  const rows = await db
    .select({ runId: triggerEventDeliveries.runId })
    .from(triggerEventDeliveries)
    .innerJoin(triggerEvents, eq(triggerEvents.id, triggerEventDeliveries.eventId))
    .where(and(inArray(triggerEventDeliveries.runId, [...runIds]), sql`${triggerEvents.detail} ? 'person'`));
  return new Set(rows.map((r) => r.runId));
}

/**
 * Whether `runId` is a person-carrying run, waiting briefly for its delivery row: the DAG's gate often reaches us
 * BEFORE the dispatch that started it has written that row (prod 2026-10-29: median +0.16 s, up to 2.6 s early).
 * Asked only when the gate would otherwise refuse, so a run nothing contends with never waits.
 */
export async function isPersonCarryingRun(
  runId: string,
  tries: number = PERSON_RUN_ROW_TRIES,
  waitMs: number = PERSON_RUN_ROW_WAIT_MS,
): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    if ((await personCarryingRunIds([runId])).has(runId)) return true;
    if (i < tries - 1) await new Promise((r) => setTimeout(r, waitMs));
  }
  return false;
}
export const PERSON_RUN_ROW_TRIES = 8;
export const PERSON_RUN_ROW_WAIT_MS = 500;
