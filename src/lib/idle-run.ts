/**
 * A run that had NOTHING TO DO waits on the timescale of the reason it had nothing to do.
 *
 * Some acquisition channels serve ONE interested prospect per run: the DAG asks another service
 * for the next person owed an answer, and when nobody is owed one the run legitimately does
 * nothing. That run completes normally, so the campaign used to be rescheduled on the RUN cadence
 * (`RERUN_GRACE_MS`, 10s) — a workflow every eleven seconds, forever, for a campaign whose
 * situation cannot change in eleven seconds. Measured in prod over 24h on ONE such campaign that
 * had answered nobody: 14,841 run rows attributed to it against 28,336 across the whole fleet, so
 * one idle campaign was 52% of the platform's entire run ledger — plus one affordability
 * gate-check per turn for a run that would do nothing.
 *
 * "Nobody to answer right now" is the MONEY kind of wait, not the TURN kind: it moves when a
 * prospect states an interest, minutes or hours apart. So it reschedules on the same 10 minutes
 * and for the same reason as `FUNDING_RECHECK_MS` and `NO_SERVEABLE_AUDIENCE_RECHECK_MS`, and
 * that interval IS the idle latency ceiling.
 *
 * It is a CEILING and not the reactivity: when a prospect actually shows interest the responsible
 * campaign is run IMMEDIATELY through `POST /internal/campaigns/trigger-for-step`, which dispatches
 * without consulting `nextRunAt` at all. This slower cadence is only what happens when nothing has
 * happened.
 *
 * It is deliberately NOT the audience-exhaustion recheck, whose vocabulary is a cold-email audience
 * running out of PEOPLE — a different fact, reached by a different signal, that gates a STOP.
 * Nothing on this path stops a campaign or marks anything exhausted: the campaign is funded and
 * correct, it simply has nobody to answer this minute.
 */
export const NO_WORK_RECHECK_MS = 10 * 60_000; // 10 min

/**
 * An idle run never pushes back a turn already scheduled SOONER (OLIVE-OWED-STARVED-1029).
 *
 * "Nothing to do" is the run's statement about ITS OWN work. An occurrence run (a trigger fired for one person) that
 * refuses its person says nothing about the campaign's queue, yet each one rewrote `nextRunAt` to now + 10 min,
 * overwriting the earlier turn a previous idle run had set. On a reactive campaign whose trigger fires every minute
 * (Lead event: every prospect fact reaches the client check-in pipe, which refuses them all), the turn that reads
 * who is OWED moved ten minutes away every minute and never came while the day was busy: prod 2026-10-29, a client
 * owed a WhatsApp check-in at 13:28 was still unclaimed at 13:56 (lead-service answered owedNow=true), idle turns ran
 * only at night. Keep the earlier of the two; a turn already due (in the past) is the one that just ran.
 */
export function idleNextRunAt(now: Date, current: Date | null | undefined): Date {
  const idle = new Date(now.getTime() + NO_WORK_RECHECK_MS);
  if (current && current.getTime() > now.getTime() && current.getTime() < idle.getTime()) return current;
  return idle;
}
