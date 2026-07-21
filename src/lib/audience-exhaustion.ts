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
