import { and, eq, gt, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { campaignAudienceExhaustion } from "../db/schema.js";

// A run narrows to ONE bandit-picked audience; when that audience's serve returns no leads the
// DAG sends stopCampaign=true. That is AUDIENCE-scoped exhaustion, not "the whole campaign is
// done" — the run says nothing about the campaign's other audiences. We mark the audience
// exhausted so the bandit skips it, and stop the campaign only when EVERY targeted audience is
// exhausted.
//
// The mark expires after this TTL so the audience is re-probed daily: Apollo can add new
// matching leads to an audience over time (and a cross-audience-suppressed audience frees up
// as its re-contact window rolls), so an exhaustion is never permanent. 1 day.
export const AUDIENCE_EXHAUSTION_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * WHY an exhaustion period ended. Two answers, and they are genuinely different facts:
 *
 *   served — a run picked this audience again and came back with somebody. Observed.
 *   lapsed — nobody re-confirmed the dryness within the TTL, so the bandit stopped excluding this
 *            audience at that instant. Derived from the live rule, which is what "exhausted" has
 *            meant here since the TTL existed — not a guess about what happened.
 */
export const EXHAUSTION_END_REASONS = {
  SERVED: "served",
  LAPSED: "lapsed",
} as const;

/**
 * Record (or re-confirm) an audience's exhaustion for a campaign.
 *
 * Exhaustion is a PERIOD, not a mark. It used to be one row per pair whose timestamp was
 * overwritten on every observation — a beginning, restated, with no end — so a replay could see a
 * campaign go dry and never see it come back. Three cases:
 *
 *   - no open period → open one. The dryness starts now.
 *   - an open period still inside the TTL → re-confirm it. Same episode, still dry.
 *   - an open period whose last confirmation has LAPSED past the TTL → that episode ENDED when the
 *     TTL ran out (the instant the bandit stopped excluding this audience, which is the live rule
 *     read backwards, not a guess), so close it there and open a new one. Stretching the old
 *     period over the gap would claim the audience was dry during hours it was being served.
 */
export async function markAudienceExhausted(
  campaignId: string,
  audienceId: string,
  now: Date = new Date(),
): Promise<void> {
  const open = await db.query.campaignAudienceExhaustion.findFirst({
    where: and(
      eq(campaignAudienceExhaustion.campaignId, campaignId),
      eq(campaignAudienceExhaustion.audienceId, audienceId),
      isNull(campaignAudienceExhaustion.endedAt),
    ),
  });

  if (open) {
    const lapsedAt = new Date(open.lastObservedAt.getTime() + AUDIENCE_EXHAUSTION_TTL_MS);
    if (lapsedAt > now) {
      await db
        .update(campaignAudienceExhaustion)
        .set({ lastObservedAt: now })
        .where(eq(campaignAudienceExhaustion.id, open.id));
      return;
    }
    await db
      .update(campaignAudienceExhaustion)
      .set({ endedAt: lapsedAt, endReason: EXHAUSTION_END_REASONS.LAPSED })
      .where(eq(campaignAudienceExhaustion.id, open.id));
  }

  await db
    .insert(campaignAudienceExhaustion)
    .values({ campaignId, audienceId, exhaustedAt: now, lastObservedAt: now });
}

/**
 * The audience served somebody again — close its open exhaustion period, now.
 *
 * This is the END the record was missing, and it is OBSERVED rather than assumed: a run picked
 * this audience and came back with a lead, which is the only evidence that says the dryness is
 * over. Nothing happens when there is no open period (the common case — most runs serve leads from
 * an audience that was never dry), so this is one cheap indexed write on a narrow population.
 */
export async function resolveAudienceExhaustion(
  campaignId: string,
  audienceId: string,
  now: Date = new Date(),
): Promise<void> {
  await db
    .update(campaignAudienceExhaustion)
    .set({ endedAt: now, endReason: EXHAUSTION_END_REASONS.SERVED })
    .where(
      and(
        eq(campaignAudienceExhaustion.campaignId, campaignId),
        eq(campaignAudienceExhaustion.audienceId, audienceId),
        isNull(campaignAudienceExhaustion.endedAt),
      ),
    );
}

/**
 * Has this campaign EVER exhausted a real audience?
 *
 * Deliberately ignores the TTL: this answers "did outreach ever run out of people in an
 * audience it actually had", not "is an audience dry right now". A brand that never had an
 * audience — and therefore never contacted anybody — never writes a row here, because the
 * DAG's stopCampaign carries no audience id for it (the same case /end-run already logs as
 * "no audience ran"). That distinction is what separates a campaign that finished its people
 * from one that never had any.
 *
 * TWO legs read it, and they must read the same one: the auto-STOP itself (a campaign that has
 * exhausted nothing has not exhausted everything, so it is never stopped as
 * `audience_exhausted`) and the extend-audience email that stop sends (never claim everyone was
 * contacted when nobody was). A campaign stopped on this reason is sticky against funding, so a
 * wrong verdict here parks a funded channel indefinitely.
 */
export async function hasExhaustedAudience(campaignId: string): Promise<boolean> {
  const rows = await db
    .select({ audienceId: campaignAudienceExhaustion.audienceId })
    .from(campaignAudienceExhaustion)
    .where(eq(campaignAudienceExhaustion.campaignId, campaignId))
    .limit(1);
  return rows.length > 0;
}

/**
 * How long a campaign with NOBODY to contact waits before it is looked at again.
 *
 * A campaign with nobody to contact is never stopped — that is a system condition, and only the
 * customer changes a status. It is rescheduled instead. Rescheduled on the RUN cadence
 * (`RERUN_GRACE_MS`, 10s) that meant a workflow fired every eleven seconds for a campaign whose
 * situation cannot change in eleven seconds: "nobody to contact" moves when a customer edits
 * their audiences, or when a channel that has never run finally accumulates evidence — hours or
 * days apart, never within the same minute.
 *
 * So it waits on the reason's own timescale, exactly as an unfunded campaign waits on
 * `FUNDING_RECHECK_MS` rather than on its turn: the same 10 minutes, for the same reason, and it
 * is the feature's latency — a campaign starts running within ten minutes of having somebody to
 * contact, with no manual step and no stop to undo.
 */
export const NO_SERVEABLE_AUDIENCE_RECHECK_MS = 10 * 60_000; // 10 min

/**
 * Audience ids currently exhausted for a campaign — i.e. marked within the TTL window.
 * Marks older than the TTL are ignored (the audience is due for a re-probe), so they never
 * appear here and the bandit will consider that audience again on the next run.
 */
export async function getFreshExhaustedAudienceIds(
  campaignId: string,
  now: Date = new Date(),
): Promise<string[]> {
  const cutoff = new Date(now.getTime() - AUDIENCE_EXHAUSTION_TTL_MS);
  const rows = await db
    .select({ audienceId: campaignAudienceExhaustion.audienceId })
    .from(campaignAudienceExhaustion)
    .where(
      and(
        eq(campaignAudienceExhaustion.campaignId, campaignId),
        // Only an OPEN period excludes an audience: one a run has since served from is over,
        // whatever its timestamps say. `lastObservedAt` is the value the old `exhaustedAt`
        // overwrite used to carry, so the window is byte-identical to what the bandit had before
        // exhaustion became a period.
        isNull(campaignAudienceExhaustion.endedAt),
        gt(campaignAudienceExhaustion.lastObservedAt, cutoff),
      ),
    );
  return rows.map((r) => r.audienceId);
}
