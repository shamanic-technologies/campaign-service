import { inArray, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { campaigns } from "../db/schema.js";
import { REPLAY_STATE } from "./channel-down-replay.js";
import { fetchSentAfter, type SentAfterAsk } from "./crm-sent-after-client.js";

/**
 * AN ANSWER WE OWED A PERSON AND NEVER SENT TURNS THE MONITORING HUB RED (ONE-AI-REFUSED-ANSWERS-1029).
 *
 * Owner (2026-10-29): « ON VEUT UNE PUTAIN D'IA QUI CONVERSE AVEC LES LEADS ET LES CLIENTS AU BON MOMENT ET DE LA
 * BONNE FAÇON ». A person writes to a brand, the Lead event campaign's run decides write now / later / nothing,
 * and sends. When the run WROTE the answer but the sender REFUSED it (`/end-run` `delivery: refused`, PUSHED-TRUTH-
 * 1015), or every run for it FAILED and we gave up, the person who wrote got nothing. Monitoring rule (owner
 * 2026-10-16/22): red on dashboard v2 Monitoring, never an email, red ONLY when something is broken.
 *
 * One rule for every occurrence carrying somebody (a person or an item), whatever its trigger, channel or campaign.
 * Unit = the OCCURRENCE (the person who acted), read from the last delivery of each campaign that ran for it (one
 * campaign failing while another answers the same person is not a person left unanswered: a shared reactive pipe
 * redelivers to whichever campaign runs it).
 *   - `answered`: a run completed its work (a decision to write later or nothing is a completed run: never counted).
 *   - while the occurrence is still owed to a campaign (not done): `replaying` when a campaign refused only because
 *     the brand's channel was down and it is replayed (lib/channel-down-replay.ts, `scheduled`), a normal "not yet";
 *     otherwise not counted (a redelivery in progress: the stuck occurrences card, lib/stuck-occurrences.ts, turns
 *     red when it is blocked).
 *   - done, nobody completed:
 *     - `answeredByTeam`: refused because the brand's TEAM already answered that person by hand (crm-service code
 *       `human_in_conversation`, `TEAM_ANSWERED_CODES`): the person got an answer, not a defect.
 *     - `refused`: any other refusal (no channel for this person, cannot write, not verified, a recent-contact guard,
 *       a channel still down past the replay window). RED: the person wrote to us and got no answer. "Not on
 *       WhatsApp" or "cannot write" are RED on purpose: a person who acted is reachable where they acted, so a writer
 *       that cannot reach them is a defect to fix, never a normal "not yet".
 *     - `failed`: runs failed or never reported and nothing redelivers them any more. RED. Except an occurrence
 *       ended because a person turned the campaign OFF (`campaign_off`): their choice.
 *     - `nothingToDo`: every run that carried the person ended well but said "nothing to do" (`no_work`, the pipe's
 *       queue owed that person nothing). Not a failure of the sender, never named one: counted on its own, not red
 *       (UNSENT-ANSWERED-ELSEWHERE-1103: six such runs for Senthil read "every run failed").
 *     - not counted: `not_admitted` only (the pipe's strategy does not answer that person), and an occurrence whose
 *       fact its caller WITHDREW (`detail.withdrawnAt`: e.g. crm-service setting aside our own alert bot taken for a
 *       hot lead): nobody acted, nobody is owed.
 *
 * ANSWERED AFTER THE FACT, BY ANYONE (UNSENT-ANSWERED-ELSEWHERE-1103, prod 2026-11-03: 5 "answers not sent", none
 * true). A person who got an answer from us after their message is answered, whatever answered: the occurrence's own
 * campaign folded it (`answered_after_fact`: a later run of it read their whole timeline, Tari), or a run of ANY
 * campaign of the brand completed for the same person (same email, phone, or human the item names) dispatched after
 * the fact. Checked before any refusal / failure verdict; a person with no answer anywhere keeps their verdict.
 * Then, for what is still red, crm-service (it holds the conversation, lib/crm-sent-after-client.ts) is asked whether
 * the brand wrote to that person after the fact on ANY channel, by anyone (Sophie on WhatsApp answered Senthil outside
 * any campaign): written by a human of the brand = `answeredByTeam`, else `answered`. crm unreadable / the person
 * unknown to it = the verdict stays (logged): an outage never turns a real red green.
 *
 * Read-only, recomputed from the dated delivery rows (the daily series needs nothing stored). Day = UTC day of the
 * last delivery's end (when we learned the answer did not leave).
 */

/** Refusal codes meaning the brand's own team already answered the person: not a defect. */
export const TEAM_ANSWERED_CODES: ReadonlySet<string> = new Set(["human_in_conversation"]);
/** How far back a broken answer keeps the card red. */
export const UNSENT_ANSWER_RED_WINDOW_MS = 24 * 3_600_000;
const UNSENT_LIST_LIMIT = 100;

export type AnswerState = "answered" | "answeredByTeam" | "replaying" | "refused" | "failed" | "nothingToDo" | null;

/** The occurrence's own skip reason (and per-campaign skip) meaning a later run already answered that person. */
export const ANSWERED_AFTER_FACT = "answered_after_fact";

/** The LAST delivery of one campaign for an occurrence. */
export interface CampaignDelivery {
  campaignId: string;
  status: string;
  refusalCode: string | null;
  replayState: string | null;
  /** Any delivery of this campaign completed. */
  anyCompleted: boolean;
}

/**
 * What the person behind an occurrence finally got, and which campaign's delivery says so. null = not an answer
 * question (in progress, or only refused by the pipe's strategy). Pure.
 */
export function answerState(
  deliveries: CampaignDelivery[],
  event: { done: boolean; skipReason: string | null; answeredAfterFact?: boolean },
): { state: AnswerState; by: CampaignDelivery | null } {
  const first = (pred: (d: CampaignDelivery) => boolean) => deliveries.find(pred) ?? null;
  const answered = first((d) => d.anyCompleted);
  if (answered) return { state: "answered", by: answered };
  if (event.answeredAfterFact) return { state: "answered", by: deliveries[0] ?? null };
  const refused = (d: CampaignDelivery) => d.status === "refused";
  if (!event.done) {
    const replaying = first((d) => refused(d) && d.replayState === REPLAY_STATE.SCHEDULED);
    return { state: replaying ? "replaying" : null, by: replaying };
  }
  const team = first((d) => refused(d) && d.refusalCode !== null && TEAM_ANSWERED_CODES.has(d.refusalCode));
  if (team) return { state: "answeredByTeam", by: team };
  const refusal = first(refused);
  if (refusal) return { state: "refused", by: refusal };
  const failed = first((d) => d.status === "failed" || d.status === "timed_out");
  if (failed && event.skipReason !== "campaign_off") return { state: "failed", by: failed };
  const nothing = first((d) => d.status === "no_work");
  if (nothing && event.skipReason !== "campaign_off") return { state: "nothingToDo", by: nothing };
  return { state: null, by: null };
}

export interface UnsentAnswers {
  generatedAt: string;
  days: number;
  /** red = an answer we owed was refused or given up in the last 24 h. */
  status: "ok" | "red";
  redWindowHours: number;
  /** Broken answers inside the red window. */
  brokenLast24h: number;
  unsent: {
    occurrenceId: string;
    orgId: string;
    brandId: string;
    offerId: string;
    triggerId: string | null;
    campaignId: string;
    campaignName: string | null;
    person: { name: string | null; email: string | null; phone: string | null } | null;
    state: "refused" | "failed";
    refusalCode: string | null;
    refusalReason: string | null;
    runs: number;
    at: string;
  }[];
  byDay: {
    day: string;
    answered: number;
    answeredByTeam: number;
    replaying: number;
    refused: number;
    failed: number;
    nothingToDo: number;
    refusedByCode: { code: string; count: number }[];
  }[];
}

const rows = async <T>(q: ReturnType<typeof sql>) => (await db.execute(q)) as unknown as T[];

export async function readUnsentAnswers(days: number, now: Date = new Date()): Promise<UnsentAnswers> {
  // Bound as ISO text + cast: postgres.js refuses a Date in a raw sql`` parameter.
  const since = new Date(now.getTime() - days * 86_400_000).toISOString();
  const redAfter = now.getTime() - UNSENT_ANSWER_RED_WINDOW_MS;

  const pairs = await rows<{
    event_id: string;
    campaign_id: string;
    status: string;
    refusal_code: string | null;
    refusal_reason: string | null;
    replay_state: string | null;
    at: Date | string;
    any_completed: boolean;
    any_failed: boolean;
    runs: number;
    org_id: string;
    brand_id: string;
    offer_id: string;
    trigger_id: string | null;
    event_status: string;
    skip_reason: string | null;
    folded: boolean;
    fact_at: Date | string;
    item_relation_key: string | null;
    item_human_id: string | null;
    person: { name?: string | null; email?: string | null; phone?: string | null } | null;
  }>(sql`
    WITH last AS (
      SELECT DISTINCT ON (event_id, campaign_id)
             event_id, campaign_id, status, refusal_code, refusal_reason, replay_state,
             coalesce(ended_at, dispatched_at) AS at
      FROM trigger_event_deliveries
      WHERE dispatched_at >= ${since}::timestamptz
      ORDER BY event_id, campaign_id, dispatched_at DESC
    ), agg AS (
      SELECT event_id, campaign_id, bool_or(status = 'completed') AS any_completed,
             bool_or(status IN ('failed', 'timed_out')) AS any_failed, count(*)::int AS runs
      FROM trigger_event_deliveries
      WHERE dispatched_at >= ${since}::timestamptz
      GROUP BY event_id, campaign_id
    )
    SELECT l.event_id, l.campaign_id, l.status, l.refusal_code, l.refusal_reason, l.replay_state, l.at,
           a.any_completed, a.any_failed, a.runs, e.org_id, e.brand_id, e.offer_id, e.trigger_id,
           e.status AS event_status, e.skip_reason,
           (e.skip_reason = ${ANSWERED_AFTER_FACT}
             OR coalesce(e.detail->'skipped', '[]'::jsonb) @> ${JSON.stringify([{ reason: ANSWERED_AFTER_FACT }])}::jsonb) AS folded,
           greatest(e.occurred_at, e.created_at) AS fact_at,
           e.detail->'item'->>'relationKey' AS item_relation_key,
           e.detail->'item'->>'humanId' AS item_human_id,
           e.detail->'person' AS person
    FROM last l
    JOIN agg a ON a.event_id = l.event_id AND a.campaign_id = l.campaign_id
    JOIN trigger_events e ON e.id = l.event_id
    WHERE (e.detail ? 'person' OR e.detail ? 'item' OR e.detail ? 'peopleCampaignIds')
      -- A fact its caller WITHDREW (lib/trigger-withdrawal.ts: not a person, a machine) owes nobody an answer.
      AND NOT (e.detail ? 'withdrawnAt')`);

  const iso = (v: Date | string) => new Date(v).toISOString();
  const byEvent = new Map<string, typeof pairs>();
  for (const p of pairs) byEvent.set(p.event_id, [...(byEvent.get(p.event_id) ?? []), p]);

  // Occurrences none of their own runs answered: did any run of the brand answer the same person after the fact?
  const unanswered = [...byEvent.entries()].filter(([, ps]) => !ps.some((p) => p.any_completed) && !ps[0].folded).map(([id]) => id);
  const answeredLater = await answeredLaterByOwnRuns(unanswered);

  const classified = [...byEvent.values()]
    .map((ps) => {
      const head = ps[0];
      const { state, by } = answerState(
        // A campaign that failed a run and then found nothing to do still failed the person (as its give-up says).
        ps.map((p) => ({ campaignId: p.campaign_id, status: p.status === "no_work" && p.any_failed ? "failed" : p.status, refusalCode: p.refusal_code, replayState: p.replay_state, anyCompleted: p.any_completed })),
        { done: head.event_status === "done", skipReason: head.skip_reason, answeredAfterFact: head.folded || answeredLater.has(head.event_id) },
      );
      const row = ps.find((p) => p.campaign_id === by?.campaignId) ?? head;
      return {
        p: row,
        state,
        runs: ps.reduce((n, p) => n + p.runs, 0),
        at: ps.map((p) => iso(p.at)).sort().at(-1) as string,
      };
    })
    .filter((c) => c.state !== null);

  await settleByConversation(classified.filter((c) => c.state === "refused" || c.state === "failed"));

  const broken = classified
    .filter((c) => c.state === "refused" || c.state === "failed")
    .sort((a, b) => b.at.localeCompare(a.at));
  const brokenLast24h = broken.filter((c) => new Date(c.at).getTime() >= redAfter).length;

  const listed = broken.slice(0, UNSENT_LIST_LIMIT);
  const campaignIds = [...new Set(listed.map((c) => c.p.campaign_id))];
  const names = new Map(
    campaignIds.length === 0
      ? []
      : (await db.select({ id: campaigns.id, name: campaigns.name }).from(campaigns).where(inArray(sql`${campaigns.id}::text`, campaignIds)))
          .map((c) => [String(c.id), c.name] as const),
  );

  // Every day of the window is served, a quiet one with zeros (it renders in normal colours).
  const byDay = new Map<string, UnsentAnswers["byDay"][number] & { codes: Map<string, number> }>();
  const emptyDay = (day: string) => ({ day, answered: 0, answeredByTeam: 0, replaying: 0, refused: 0, failed: 0, nothingToDo: 0, refusedByCode: [], codes: new Map<string, number>() });
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(now.getTime() - i * 86_400_000).toISOString().slice(0, 10);
    byDay.set(day, emptyDay(day));
  }
  for (const c of classified) {
    const day = c.at.slice(0, 10);
    let d = byDay.get(day);
    if (!d) {
      d = emptyDay(day);
      byDay.set(day, d);
    }
    d[c.state as Exclude<AnswerState, null>] += 1;
    if (c.state === "refused") {
      const code = c.p.refusal_code ?? "unnamed";
      d.codes.set(code, (d.codes.get(code) ?? 0) + 1);
    }
  }

  return {
    generatedAt: now.toISOString(),
    days,
    status: brokenLast24h > 0 ? "red" : "ok",
    redWindowHours: UNSENT_ANSWER_RED_WINDOW_MS / 3_600_000,
    brokenLast24h,
    unsent: listed.map((c) => ({
      occurrenceId: c.p.event_id,
      orgId: c.p.org_id,
      brandId: c.p.brand_id,
      offerId: c.p.offer_id,
      triggerId: c.p.trigger_id,
      campaignId: c.p.campaign_id,
      campaignName: names.get(c.p.campaign_id) ?? null,
      person: c.p.person ? { name: c.p.person.name ?? null, email: c.p.person.email ?? null, phone: c.p.person.phone ?? null } : null,
      state: c.state as "refused" | "failed",
      refusalCode: c.state === "refused" ? c.p.refusal_code : null,
      refusalReason: c.state === "refused" ? c.p.refusal_reason : null,
      runs: c.runs,
      at: c.at,
    })),
    byDay: [...byDay.values()]
      .sort((a, b) => a.day.localeCompare(b.day))
      .map(({ codes, ...d }) => ({
        ...d,
        refusedByCode: [...codes.entries()].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count),
      })),
  };
}

/**
 * Of these occurrences, the ones whose person a run of ANY campaign of the same (org, brand) answered after the
 * fact: a `completed` delivery of another occurrence naming the same person (email, else phone; an item's human)
 * dispatched at or after `greatest(occurred_at, created_at)`. One read; [] = nothing asked.
 */
export async function answeredLaterByOwnRuns(eventIds: string[]): Promise<Set<string>> {
  if (eventIds.length === 0) return new Set();
  const found = await rows<{ event_id: string }>(sql`
    SELECT DISTINCT e.id AS event_id
    FROM trigger_events e
    JOIN trigger_events o ON o.org_id = e.org_id AND o.brand_id = e.brand_id AND o.id <> e.id
    JOIN trigger_event_deliveries d ON d.event_id = o.id AND d.status = 'completed'
    WHERE e.id IN (${sql.join(eventIds.map((id) => sql`${id}`), sql`, `)})
      AND d.dispatched_at >= greatest(e.occurred_at, e.created_at)
      AND (
        (e.detail->'person'->>'email' IS NOT NULL
          AND lower(o.detail->'person'->>'email') = lower(e.detail->'person'->>'email'))
        OR (e.detail->'person'->>'phone' IS NOT NULL
          AND o.detail->'person'->>'phone' = e.detail->'person'->>'phone')
        OR (e.detail->'item'->>'humanId' IS NOT NULL
          AND o.detail->'item'->>'humanId' = e.detail->'item'->>'humanId')
      )`);
  return new Set(found.map((r) => r.event_id));
}

/**
 * Ask crm-service, per (org, brand), whether the brand wrote to each still-red person after their fact, and move the
 * ones it did (see header). Mutates `state`. Never throws: crm unreadable keeps every verdict, said in the log.
 */
async function settleByConversation(
  red: Array<{
    p: { event_id: string; org_id: string; brand_id: string; fact_at: Date | string; item_relation_key: string | null; item_human_id: string | null; person: { email?: string | null; phone?: string | null } | null };
    state: AnswerState;
  }>,
): Promise<void> {
  const byScope = new Map<string, typeof red>();
  for (const c of red) {
    const k = `${c.p.org_id}|${c.p.brand_id}`;
    byScope.set(k, [...(byScope.get(k) ?? []), c]);
  }
  for (const [scope, list] of byScope) {
    const [orgId, brandId] = scope.split("|");
    const asks: SentAfterAsk[] = [];
    for (const c of list) {
      const ask: SentAfterAsk = { ref: c.p.event_id, after: new Date(c.p.fact_at).toISOString() };
      if (c.p.person?.email) ask.email = c.p.person.email;
      if (c.p.person?.phone) ask.phone = c.p.person.phone;
      if (c.p.item_relation_key) ask.relationKey = c.p.item_relation_key;
      if (c.p.item_human_id) ask.humanId = c.p.item_human_id;
      if (ask.email || ask.phone || ask.relationKey || ask.humanId) asks.push(ask);
    }
    try {
      const verdicts = new Map((await fetchSentAfter(orgId, brandId, asks)).map((v) => [v.ref, v]));
      for (const c of list) {
        const v = verdicts.get(c.p.event_id);
        if (v?.status === "sent") c.state = v.sentBy === "person" ? "answeredByTeam" : "answered";
      }
    } catch (err) {
      console.error(`[campaign-service] unsent-answers: crm-service sent-after unreadable for brand ${brandId}, ${asks.length} red answers keep their verdict:`, err);
    }
  }
}
