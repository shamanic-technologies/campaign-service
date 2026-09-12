import { and, asc, gte, inArray, lte, or, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { campaignAudienceAvailability, campaignStatusTransitions } from "../db/schema.js";

/**
 * WAS THIS CAMPAIGN EARNING ON A GIVEN PAST UTC DAY?
 *
 * Two axes, both answered from RECORDED HISTORY rather than from current state, and a third value
 * that is neither true nor false:
 *
 *   status   — was the customer running it. `paused is not MRR`.
 *   audience — did it have anybody to work. A campaign holding budget with no audience left to
 *              work is not MRR either.
 *
 * A day is evaluated at its END (23:59:59.999Z), or at NOW for a day still in progress: the state
 * a campaign finished the day in is the one a daily run-rate counts, and a campaign stopped at
 * 16:00 was not earning that day's run-rate. Stated here because it is the one judgement call in
 * the whole replay, and a consumer summing months needs to know which end of the day it got.
 *
 * `not_recorded` is a FIRST-CLASS answer and is never collapsed to false. A day before a
 * campaign's record begins is not a day it was stopped, and the whole reason this exists is that a
 * month published as a guess came out negative. Nothing is backfilled, so early days read
 * `not_recorded` and a consumer decides what to do about them — it is not this service's place to
 * invent a value it can then be quoted on.
 */

export type RecordedStatus = "ongoing" | "stopped" | "not_recorded";
export type RecordedAudience = "available" | "exhausted" | "not_recorded";

export type EarningDay = {
  /** The UTC day, `YYYY-MM-DD`. */
  day: string;
  status: RecordedStatus;
  audience: RecordedAudience;
  /**
   * Running AND able to reach somebody. `null` when either axis is `not_recorded` — an unknown,
   * never a zero.
   */
  earning: boolean | null;
  /** Why `earning` is null, naming the axis. Absent when `earning` is a real answer. */
  unknownReason?: "status_not_recorded" | "audience_not_recorded" | "both_not_recorded";
};

export type CampaignEarningHistory = {
  campaignId: string;
  /**
   * The instant this campaign's history starts being answerable, per axis. Null = nothing recorded
   * at all yet. A consumer that wants to know why a day is `not_recorded` reads this rather than
   * inferring it.
   */
  statusRecordedSince: string | null;
  audienceRecordedSince: string | null;
  days: EarningDay[];
};

/** The UTC days from `from` to `to` inclusive, as `YYYY-MM-DD`. */
export function utcDaysBetween(from: string, to: string): string[] {
  const days: string[] = [];
  const cursor = new Date(`${from}T00:00:00.000Z`);
  const last = new Date(`${to}T00:00:00.000Z`);
  while (cursor.getTime() <= last.getTime()) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

/** The instant a day is evaluated at: its last millisecond, or now if the day has not ended. */
function evaluationInstant(day: string, now: Date): Date {
  const endOfDay = new Date(`${day}T23:59:59.999Z`);
  return endOfDay.getTime() > now.getTime() ? now : endOfDay;
}

/**
 * Replay the recorded history of each campaign over a UTC day range.
 *
 * Two bounded reads (one per axis) over the whole id set, then an in-memory walk — never a query
 * per campaign per day. Both reads are bounded by the range: a transition AFTER the range says
 * nothing about it, and the one row needed from BEFORE the range is the newest one at or before
 * its start, taken per campaign.
 */
export async function earningHistory(
  campaignIds: string[],
  from: string,
  to: string,
  now: Date = new Date(),
): Promise<CampaignEarningHistory[]> {
  const days = utcDaysBetween(from, to);
  if (campaignIds.length === 0 || days.length === 0) return [];

  const rangeEnd = evaluationInstant(days[days.length - 1], now);

  // Every transition at or before the end of the range, oldest first. Rows after it cannot change
  // any day inside it.
  const transitions = await db
    .select({
      campaignId: campaignStatusTransitions.campaignId,
      toStatus: campaignStatusTransitions.toStatus,
      reason: campaignStatusTransitions.reason,
      occurredAt: campaignStatusTransitions.occurredAt,
    })
    .from(campaignStatusTransitions)
    .where(
      and(
        inArray(campaignStatusTransitions.campaignId, campaignIds),
        lte(campaignStatusTransitions.occurredAt, rangeEnd),
      ),
    )
    .orderBy(asc(campaignStatusTransitions.occurredAt));

  // Every availability period that OVERLAPS the range: it started at or before the range ends, and
  // it either has not ended or ended at or after the range starts.
  const rangeStart = new Date(`${days[0]}T00:00:00.000Z`);
  const periods = await db
    .select({
      campaignId: campaignAudienceAvailability.campaignId,
      hasAudience: campaignAudienceAvailability.hasAudience,
      startedAt: campaignAudienceAvailability.startedAt,
      endedAt: campaignAudienceAvailability.endedAt,
    })
    .from(campaignAudienceAvailability)
    .where(
      and(
        inArray(campaignAudienceAvailability.campaignId, campaignIds),
        lte(campaignAudienceAvailability.startedAt, rangeEnd),
        or(
          isNull(campaignAudienceAvailability.endedAt),
          gte(campaignAudienceAvailability.endedAt, rangeStart),
        ),
      ),
    )
    .orderBy(asc(campaignAudienceAvailability.startedAt));

  // When each axis' record BEGINS — the oldest row of any age, which is what makes "not recorded"
  // distinguishable from "recorded and not running". Read separately from the range-bounded reads
  // above precisely because it may predate the range.
  const [statusSince, audienceSince] = await Promise.all([
    db
      .select({
        campaignId: campaignStatusTransitions.campaignId,
        occurredAt: campaignStatusTransitions.occurredAt,
      })
      .from(campaignStatusTransitions)
      .where(inArray(campaignStatusTransitions.campaignId, campaignIds))
      .orderBy(asc(campaignStatusTransitions.occurredAt)),
    db
      .select({
        campaignId: campaignAudienceAvailability.campaignId,
        startedAt: campaignAudienceAvailability.startedAt,
      })
      .from(campaignAudienceAvailability)
      .where(inArray(campaignAudienceAvailability.campaignId, campaignIds))
      .orderBy(asc(campaignAudienceAvailability.startedAt)),
  ]);

  const firstStatusAt = new Map<string, Date>();
  for (const row of statusSince) {
    if (!firstStatusAt.has(row.campaignId)) firstStatusAt.set(row.campaignId, row.occurredAt);
  }
  const firstAudienceAt = new Map<string, Date>();
  for (const row of audienceSince) {
    if (!firstAudienceAt.has(row.campaignId)) firstAudienceAt.set(row.campaignId, row.startedAt);
  }

  const transitionsByCampaign = new Map<string, typeof transitions>();
  for (const t of transitions) {
    const list = transitionsByCampaign.get(t.campaignId) ?? [];
    list.push(t);
    transitionsByCampaign.set(t.campaignId, list);
  }
  const periodsByCampaign = new Map<string, typeof periods>();
  for (const p of periods) {
    const list = periodsByCampaign.get(p.campaignId) ?? [];
    list.push(p);
    periodsByCampaign.set(p.campaignId, list);
  }

  return campaignIds.map((campaignId) => {
    const ts = transitionsByCampaign.get(campaignId) ?? [];
    const ps = periodsByCampaign.get(campaignId) ?? [];

    const dayRows = days.map((day): EarningDay => {
      const at = evaluationInstant(day, now);

      // The status is the newest transition at or before the instant. None → the record had not
      // begun, which is not the same as "stopped".
      let status: RecordedStatus = "not_recorded";
      for (const t of ts) {
        if (t.occurredAt.getTime() > at.getTime()) break;
        status = t.toStatus === "ongoing" ? "ongoing" : "stopped";
      }

      // The audience state is the period covering the instant. A period runs [startedAt, endedAt),
      // and an open one runs to the present — that is the last thing this service observed, not an
      // assumption about the future.
      let audience: RecordedAudience = "not_recorded";
      for (const p of ps) {
        if (p.startedAt.getTime() > at.getTime()) break;
        const ended = p.endedAt;
        if (ended && ended.getTime() <= at.getTime()) continue;
        audience = p.hasAudience ? "available" : "exhausted";
        break;
      }

      const statusUnknown = status === "not_recorded";
      const audienceUnknown = audience === "not_recorded";
      if (statusUnknown || audienceUnknown) {
        return {
          day,
          status,
          audience,
          earning: null,
          unknownReason:
            statusUnknown && audienceUnknown
              ? "both_not_recorded"
              : statusUnknown
                ? "status_not_recorded"
                : "audience_not_recorded",
        };
      }

      return {
        day,
        status,
        audience,
        earning: status === "ongoing" && audience === "available",
      };
    });

    return {
      campaignId,
      statusRecordedSince: firstStatusAt.get(campaignId)?.toISOString() ?? null,
      audienceRecordedSince: firstAudienceAt.get(campaignId)?.toISOString() ?? null,
      days: dayRows,
    };
  });
}
