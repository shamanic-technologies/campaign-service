import { eq, gte, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { campaigns, triggerEvents, triggerHealthDays, triggerSilenceWatch, type Campaign } from "../db/schema.js";
import { fetchChannelCatalogue, type CatalogueTriggerType } from "./channel-operator-client.js";
import { answersTrigger } from "./sales-funnel-head-trigger.js";
import { fetchStepReachers, StepNotObservableError } from "./step-reach-client.js";

/**
 * IS A TRIGGER BROKEN? A RED CHART ON DASHBOARD V2 MONITORING, NEVER AN EMAIL (TRIGGER-SILENCE-NO-EMAIL-1028).
 *
 * A reactive campaign runs only when its trigger asks (lib/trigger-events.ts). If the service that should fire it
 * stops calling, nothing errors anywhere: the campaign simply never runs. History: 2026-10-09 a coded type with a live
 * campaign behind it and no event for 3 days sent staff a `trigger_silent` EMAIL. 2026-10-28 it sent 4 at once, and 2
 * were quiet weeks (nobody filled a form, a client stopped pushing), not breakage. Owner rule (2026-10-22): « no email
 * in my inbox please »; a monitoring alert is RED on the Monitoring hub, fed by a stored daily series.
 *
 * So nothing is sent, and ABSENCE alone is never red. A watched type (coded, with a live campaign answering it,
 * `answersTrigger`) is RED only on POSITIVE evidence:
 *   - `never_fired`: watched for `NEVER_FIRED_AFTER_MS` (3 days) and not ONE occurrence of it was ever recorded.
 *     A pipe that has never worked once while campaigns wait on it is not a slow week.
 *   - `facts_without_event`: the trigger's own STEP (catalogue `fromStepKey`, kind `event`) was reached by people
 *     lead-service recorded (`step-reached`: CRM facts + outcome ledger) on a brand with a live campaign behind the
 *     type, inside the last `FACT_WINDOW_MS` (3 days, and since the watch started), at least `FACT_SETTLE_MS` (1 h)
 *     ago, and NO occurrence of the type reached us on that brand since the first of those facts (minus the settle
 *     margin). The fact happened, the trigger did not ring: the wire between them is broken.
 * Otherwise ok, however quiet. A step lead-service cannot see per person (`step_not_observable`: a reply, a serve) is
 * judged on `never_fired` only. lead-service unreadable = `unknown` (never red on a guess, never ok on one either).
 * `reported` / `delay` / `poll` / composite kinds: their `fromStepKey` is not their own fact, so `never_fired` only.
 *
 * Each hourly check UPSERTS today's row per watched type (`trigger_health_days`): the last check of a day is that
 * day's verdict. The read (`readTriggerHealth`) serves the stored verdicts beside the per-day occurrence counts,
 * recomputed from the dated occurrence rows. Fail-SOFT: an unreadable catalogue changes nothing.
 */

export const NEVER_FIRED_AFTER_MS = 3 * 24 * 60 * 60_000;
export const FACT_WINDOW_MS = 3 * 24 * 60 * 60_000;
/** A fact younger than this may still be on its way to us as an occurrence. */
export const FACT_SETTLE_MS = 60 * 60_000;
/** How often the check runs. */
export const TRIGGER_HEALTH_RECHECK_MS = 60 * 60_000;

let lastCheckAt = 0;

/** Test hook: forget when the check last ran. */
export function resetTriggerHealthClock(): void {
  lastCheckAt = 0;
}

export type TriggerHealthStatus = "ok" | "red" | "unknown";
export type TriggerHealthReason = "never_fired" | "facts_without_event" | "facts_unreadable";

export interface MissingEvents {
  orgId: string;
  brandId: string;
  /** People lead-service saw reach the step on this brand, with no occurrence reaching us. */
  people: number;
  firstReachedAt: string;
}

/** What the fact check found for a type: not asked, unreadable, or the brands where facts landed and no event did. */
export type FactCheck =
  | { state: "not_observable" }
  | { state: "unreadable"; detail: string }
  | { state: "read"; missing: MissingEvents[] };

export interface TriggerVerdict {
  status: TriggerHealthStatus;
  reason: TriggerHealthReason | null;
  sentence: string;
  factsWithoutEvent: number | null;
  missing: MissingEvents[] | null;
}

const days = (ms: number) => Math.floor(ms / 86_400_000);
const stepWords = (step: string | null) => (step ?? "its step").replace(/_/g, " ");

/** The verdict of one watched type. Pure. */
export function triggerVerdict(input: {
  eventsEver: number;
  watchedSince: Date;
  now: Date;
  liveCampaigns: number;
  fromStepKey: string | null;
  facts: FactCheck;
}): TriggerVerdict {
  const { eventsEver, watchedSince, now, liveCampaigns, facts } = input;
  const watchedFor = now.getTime() - watchedSince.getTime();
  const missing = facts.state === "read" ? facts.missing : null;
  const factsWithoutEvent = missing ? missing.reduce((n, m) => n + m.people, 0) : null;
  const waiting = liveCampaigns === 1 ? "1 live campaign waits" : `${liveCampaigns} live campaigns wait`;

  if (eventsEver === 0 && watchedFor >= NEVER_FIRED_AFTER_MS) {
    return {
      status: "red",
      reason: "never_fired",
      sentence: `Never fired in ${days(watchedFor)} days while ${waiting} on it.`,
      factsWithoutEvent,
      missing,
    };
  }
  if (missing && missing.length > 0) {
    return {
      status: "red",
      reason: "facts_without_event",
      sentence:
        `${factsWithoutEvent} ${factsWithoutEvent === 1 ? "person" : "people"} reached ${stepWords(input.fromStepKey)} on ` +
        `${missing.length} brand${missing.length === 1 ? "" : "s"}, and no trigger event reached us.`,
      factsWithoutEvent,
      missing,
    };
  }
  if (facts.state === "unreadable") {
    return {
      status: "unknown",
      reason: "facts_unreadable",
      sentence: `Could not read who reached ${stepWords(input.fromStepKey)}: ${facts.detail.slice(0, 160)}`,
      factsWithoutEvent: null,
      missing: null,
    };
  }
  return {
    status: "ok",
    reason: null,
    sentence: eventsEver === 0
      ? `Watched for ${days(watchedFor)} days, nothing to fire yet.`
      : facts.state === "read"
        ? "Working: every fact we can see came with its event."
        : "Has fired before; quiet is not a break.",
    factsWithoutEvent,
    missing,
  };
}

const utcDay = (d: Date) => d.toISOString().slice(0, 10);

/** Whether the type's `fromStepKey` is its OWN fact (a service rings it when a person reaches that step). */
function factIsOwnStep(type: CatalogueTriggerType): boolean {
  return !!type.fromStepKey && (type.kind ?? "event") === "event";
}

async function checkFacts(type: CatalogueTriggerType, behind: Campaign[], since: Date, now: Date): Promise<FactCheck> {
  if (!factIsOwnStep(type)) return { state: "not_observable" };
  const settledBefore = now.getTime() - FACT_SETTLE_MS;
  const scopes = new Map<string, { orgId: string; brandId: string }>();
  for (const c of behind) {
    const brandId = c.brandId ?? c.brandIds?.[0] ?? null;
    if (brandId) scopes.set(`${c.orgId}|${brandId}`, { orgId: c.orgId, brandId });
  }
  const missing: MissingEvents[] = [];
  for (const scope of scopes.values()) {
    let reachedAt: Date[];
    try {
      reachedAt = (await fetchStepReachers({ ...scope, step: type.fromStepKey!, since }))
        .map((p) => p.reachedAt)
        .filter((at) => at.getTime() <= settledBefore);
    } catch (err) {
      if (err instanceof StepNotObservableError) return { state: "not_observable" };
      return { state: "unreadable", detail: err instanceof Error ? err.message : String(err) };
    }
    if (reachedAt.length === 0) continue;
    const first = new Date(Math.min(...reachedAt.map((d) => d.getTime())));
    const after = new Date(first.getTime() - FACT_SETTLE_MS).toISOString();
    const [hit] = (await db.execute(sql`
      SELECT 1 FROM trigger_events
      WHERE trigger_id = ${type.id} AND org_id = ${scope.orgId} AND brand_id = ${scope.brandId}
        AND greatest(occurred_at, created_at) >= ${after}::timestamptz
      LIMIT 1`)) as unknown as unknown[];
    if (!hit) missing.push({ ...scope, people: reachedAt.length, firstReachedAt: first.toISOString() });
  }
  return { state: "read", missing };
}

/**
 * Check every coded trigger type with a live campaign behind it and store today's verdict. Returns the verdicts
 * written. Runs at most once per `TRIGGER_HEALTH_RECHECK_MS`. Sends nothing.
 */
export async function checkTriggerHealth(now: Date = new Date()): Promise<Array<TriggerVerdict & { triggerId: string }>> {
  if (now.getTime() - lastCheckAt < TRIGGER_HEALTH_RECHECK_MS) return [];
  lastCheckAt = now.getTime();

  const catalogue = await fetchChannelCatalogue();
  if (!catalogue.ok) {
    console.warn(`[campaign-service] Trigger health check skipped: catalogue unreadable (${catalogue.detail})`);
    return [];
  }
  const types = [...(catalogue.triggers?.values() ?? [])].filter((t) => t.coded);
  const transitions = catalogue.triggerTransitions ?? [];
  const live = await db.query.campaigns.findMany({ where: eq(campaigns.status, "ongoing") });

  const written: Array<TriggerVerdict & { triggerId: string }> = [];
  for (const type of types) {
    const behind = live.filter((c) => answersTrigger(c, type.id, transitions));
    if (behind.length === 0) {
      await db.delete(triggerSilenceWatch).where(eq(triggerSilenceWatch.triggerId, type.id));
      continue;
    }
    await db.insert(triggerSilenceWatch).values({ triggerId: type.id, watchedSince: now }).onConflictDoNothing();
    const [watch] = await db.select().from(triggerSilenceWatch).where(eq(triggerSilenceWatch.triggerId, type.id));
    const [ever] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(triggerEvents)
      .where(eq(triggerEvents.triggerId, type.id));
    const windowStart = new Date(Math.max(now.getTime() - FACT_WINDOW_MS, watch.watchedSince.getTime()));
    const facts = await checkFacts(type, behind, windowStart, now);
    if (facts.state === "unreadable") {
      console.error(`[campaign-service] Trigger health: ${type.id} facts unreadable: ${facts.detail}`);
    }
    const verdict = triggerVerdict({
      eventsEver: ever?.n ?? 0,
      watchedSince: watch.watchedSince,
      now,
      liveCampaigns: behind.length,
      fromStepKey: type.fromStepKey,
      facts,
    });
    const row = {
      triggerId: type.id,
      day: utcDay(now),
      label: type.label,
      firedBy: type.firedBy,
      status: verdict.status,
      reason: verdict.reason,
      sentence: verdict.sentence,
      liveCampaigns: behind.length,
      factsWithoutEvent: verdict.factsWithoutEvent,
      missing: verdict.missing,
      checkedAt: now,
    };
    await db
      .insert(triggerHealthDays)
      .values(row)
      .onConflictDoUpdate({ target: [triggerHealthDays.triggerId, triggerHealthDays.day], set: row });
    written.push({ triggerId: type.id, ...verdict });
  }

  // Types no longer declared or no longer coded are not watched.
  const coded = types.map((t) => t.id);
  if (coded.length === 0) await db.delete(triggerSilenceWatch);
  else await db.delete(triggerSilenceWatch).where(sql`${triggerSilenceWatch.triggerId} NOT IN (${sql.join(coded.map((id) => sql`${id}`), sql`, `)})`);
  return written;
}

export interface TriggerHealth {
  generatedAt: string;
  days: number;
  /** red = at least one watched trigger is red right now. */
  status: "ok" | "red";
  /** When the latest check ran (null = never). */
  checkedAt: string | null;
  triggers: {
    triggerId: string;
    label: string;
    firedBy: string;
    /** A live campaign answers it now. Unwatched types keep their history but no current verdict. */
    watched: boolean;
    watchedSince: string | null;
    status: TriggerHealthStatus | null;
    reason: TriggerHealthReason | null;
    sentence: string | null;
    liveCampaigns: number;
    factsWithoutEvent: number | null;
    missing: MissingEvents[];
    lastEventAt: string | null;
    byDay: { day: string; events: number; status: TriggerHealthStatus | null }[];
  }[];
}

/** Every trigger type checked in the window: its current verdict and its daily series. Read-only. */
export async function readTriggerHealth(windowDays: number, now: Date = new Date()): Promise<TriggerHealth> {
  const firstDay = utcDay(new Date(now.getTime() - (windowDays - 1) * 86_400_000));
  const stored = await db
    .select()
    .from(triggerHealthDays)
    .where(gte(triggerHealthDays.day, firstDay))
    .orderBy(triggerHealthDays.day);
  const watches = new Map((await db.select().from(triggerSilenceWatch)).map((w) => [w.triggerId, w.watchedSince]));
  const ids = [...new Set(stored.map((r) => r.triggerId))];

  const counts = ids.length === 0
    ? []
    : ((await db.execute(sql`
        SELECT trigger_id, to_char(date_trunc('day', occurred_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day, count(*)::int AS n
        FROM trigger_events
        WHERE trigger_id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
          AND occurred_at >= ${`${firstDay}T00:00:00Z`}::timestamptz AND occurred_at <= ${now.toISOString()}::timestamptz
        GROUP BY 1, 2`)) as unknown as { trigger_id: string; day: string; n: number }[]);
  const lastEvents = ids.length === 0
    ? []
    : ((await db.execute(sql`
        SELECT trigger_id, max(occurred_at) AS at FROM trigger_events
        WHERE trigger_id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)}) AND occurred_at <= ${now.toISOString()}::timestamptz
        GROUP BY 1`)) as unknown as { trigger_id: string; at: Date | string }[]);
  const lastEventAt = new Map(lastEvents.map((r) => [r.trigger_id, new Date(r.at).toISOString()]));

  const dayList: string[] = [];
  for (let i = windowDays - 1; i >= 0; i -= 1) dayList.push(utcDay(new Date(now.getTime() - i * 86_400_000)));

  const triggers = ids.map((id) => {
    const rows = stored.filter((r) => r.triggerId === id);
    const latest = rows[rows.length - 1];
    const watchedSince = watches.get(id) ?? null;
    const watched = watchedSince !== null;
    return {
      triggerId: id,
      label: latest.label,
      firedBy: latest.firedBy,
      watched,
      watchedSince: watchedSince ? watchedSince.toISOString() : null,
      status: watched ? (latest.status as TriggerHealthStatus) : null,
      reason: watched ? (latest.reason as TriggerHealthReason | null) : null,
      sentence: watched ? latest.sentence : null,
      liveCampaigns: watched ? latest.liveCampaigns : 0,
      factsWithoutEvent: watched ? latest.factsWithoutEvent : null,
      missing: watched ? ((latest.missing as MissingEvents[] | null) ?? []) : [],
      lastEventAt: lastEventAt.get(id) ?? null,
      byDay: dayList.map((day) => ({
        day,
        events: counts.find((c) => c.trigger_id === id && c.day === day)?.n ?? 0,
        status: (rows.find((r) => r.day === day)?.status as TriggerHealthStatus | undefined) ?? null,
      })),
    };
  });
  const rank = (t: (typeof triggers)[number]) => (t.status === "red" ? 0 : t.status === "unknown" ? 1 : t.watched ? 2 : 3);
  triggers.sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label));

  const checkedAt = stored.reduce<Date | null>((m, r) => (!m || r.checkedAt > m ? r.checkedAt : m), null);
  return {
    generatedAt: now.toISOString(),
    days: windowDays,
    status: triggers.some((t) => t.status === "red") ? "red" : "ok",
    checkedAt: checkedAt ? checkedAt.toISOString() : null,
    triggers,
  };
}
