import { and, eq, gt } from "drizzle-orm";
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

/** Record (or refresh) an audience's exhaustion mark for a campaign. */
export async function markAudienceExhausted(campaignId: string, audienceId: string): Promise<void> {
  const now = new Date();
  await db
    .insert(campaignAudienceExhaustion)
    .values({ campaignId, audienceId, exhaustedAt: now })
    .onConflictDoUpdate({
      target: [campaignAudienceExhaustion.campaignId, campaignAudienceExhaustion.audienceId],
      set: { exhaustedAt: now },
    });
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
        gt(campaignAudienceExhaustion.exhaustedAt, cutoff),
      ),
    );
  return rows.map((r) => r.audienceId);
}
