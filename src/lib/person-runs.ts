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
 * Why 4: every DAG runs on the box's Windmill worker pool, which is 2 workers for the whole fleet
 * (`NUM_WORKERS=2`, 2026-10-28). 4 in flight keeps both workers busy on a burst with two runs queued behind them,
 * while a 160-person burst never parks more than 2 extra jobs in front of every other campaign's run. Each
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
    const stored = await personRunsInFlight(cohortIds, now);
    const held = [...reservations.values()].filter((r) => r.cohortKey === cohortKey && now.getTime() - r.at < RESERVATION_TTL_MS);
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
 * fall due NOW, oldest waiting first, instead of on their 2-10 min retry. Without it the burst drains at the retry
 * cadence, not at the speed runs finish. Returns how many were made due.
 */
export async function wakeOccurrencesHeldBy(campaignId: string, now: Date = new Date()): Promise<number> {
  const held = `${campaignId} run_in_flight`;
  const woken = await db
    .update(triggerEvents)
    .set({ dueAt: now })
    .where(sql`${triggerEvents.id} IN (
      SELECT id FROM trigger_events
      WHERE status = 'pending'
        AND due_at > ${now.toISOString()}::timestamptz
        AND position(${held} in coalesce(last_error, '')) > 0
      ORDER BY greatest(occurred_at, created_at)
      LIMIT ${PERSON_RUNS_PER_CAMPAIGN_MAX}
    )`)
    .returning({ id: triggerEvents.id });
  return woken.length;
}
