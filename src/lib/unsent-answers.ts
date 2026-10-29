import { inArray, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { campaigns } from "../db/schema.js";
import { REPLAY_STATE } from "./channel-down-replay.js";

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
 *     - not counted: `not_admitted` only (the pipe's strategy does not answer that person).
 *
 * Read-only, recomputed from the dated delivery rows (the daily series needs nothing stored). Day = UTC day of the
 * last delivery's end (when we learned the answer did not leave).
 */

/** Refusal codes meaning the brand's own team already answered the person: not a defect. */
export const TEAM_ANSWERED_CODES: ReadonlySet<string> = new Set(["human_in_conversation"]);
/** How far back a broken answer keeps the card red. */
export const UNSENT_ANSWER_RED_WINDOW_MS = 24 * 3_600_000;
const UNSENT_LIST_LIMIT = 100;

export type AnswerState = "answered" | "answeredByTeam" | "replaying" | "refused" | "failed" | null;

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
  event: { done: boolean; skipReason: string | null },
): { state: AnswerState; by: CampaignDelivery | null } {
  const first = (pred: (d: CampaignDelivery) => boolean) => deliveries.find(pred) ?? null;
  const answered = first((d) => d.anyCompleted);
  if (answered) return { state: "answered", by: answered };
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
    runs: number;
    org_id: string;
    brand_id: string;
    offer_id: string;
    trigger_id: string | null;
    event_status: string;
    skip_reason: string | null;
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
      SELECT event_id, campaign_id, bool_or(status = 'completed') AS any_completed, count(*)::int AS runs
      FROM trigger_event_deliveries
      WHERE dispatched_at >= ${since}::timestamptz
      GROUP BY event_id, campaign_id
    )
    SELECT l.event_id, l.campaign_id, l.status, l.refusal_code, l.refusal_reason, l.replay_state, l.at,
           a.any_completed, a.runs, e.org_id, e.brand_id, e.offer_id, e.trigger_id,
           e.status AS event_status, e.skip_reason,
           e.detail->'person' AS person
    FROM last l
    JOIN agg a ON a.event_id = l.event_id AND a.campaign_id = l.campaign_id
    JOIN trigger_events e ON e.id = l.event_id
    WHERE (e.detail ? 'person' OR e.detail ? 'item')`);

  const iso = (v: Date | string) => new Date(v).toISOString();
  const byEvent = new Map<string, typeof pairs>();
  for (const p of pairs) byEvent.set(p.event_id, [...(byEvent.get(p.event_id) ?? []), p]);

  const classified = [...byEvent.values()]
    .map((ps) => {
      const head = ps[0];
      const { state, by } = answerState(
        ps.map((p) => ({ campaignId: p.campaign_id, status: p.status, refusalCode: p.refusal_code, replayState: p.replay_state, anyCompleted: p.any_completed })),
        { done: head.event_status === "done", skipReason: head.skip_reason },
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
  const emptyDay = (day: string) => ({ day, answered: 0, answeredByTeam: 0, replaying: 0, refused: 0, failed: 0, refusedByCode: [], codes: new Map<string, number>() });
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
