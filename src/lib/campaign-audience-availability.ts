import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { campaignAudienceAvailability } from "../db/schema.js";

/**
 * WHETHER a campaign could reach anybody, recorded as an effective-dated period rather than a
 * current flag.
 *
 * /end-run already computes this verdict on every run whose served audience came back empty
 * (`hasServeableAudience`) and threw it away — the read-side-derivation trap one level down: the
 * writer held the answer and dropped it, so a consumer replaying a past month had nothing to read.
 * Persisting it costs one indexed lookup per run and a write ONLY when the state actually changes.
 *
 * This is the only honest CAMPAIGN-grain answer. The per-audience exhaustion marks cannot be
 * summed into one: a campaign with three audiences and one dry one was working perfectly well, and
 * which audiences a campaign targeted on a past day is recorded nowhere.
 */

/**
 * Record what a run observed about this campaign's ability to reach anybody.
 *
 * Restating the current state moves `lastObservedAt` and nothing else. FLIPPING it closes the open
 * period at this instant and opens the opposite one — which is the end the record was missing: a
 * campaign that went dry and was later given an audience reads as earning again from that day.
 *
 * BOTH states are recorded, including "yes, it had people". A log of droughts alone cannot tell a
 * campaign that had people all month from one nobody was recording yet, so a day covered by no
 * period is `not_recorded` and nothing is ever guessed.
 */
export async function recordAudienceAvailability(
  campaignId: string,
  orgId: string,
  hasAudience: boolean,
  now: Date = new Date(),
): Promise<void> {
  const current = await db.query.campaignAudienceAvailability.findFirst({
    where: and(
      eq(campaignAudienceAvailability.campaignId, campaignId),
      isNull(campaignAudienceAvailability.endedAt),
    ),
  });

  if (current?.hasAudience === hasAudience) {
    // Same state, still true. Only the confirmation moves — a campaign that has had nobody since
    // Tuesday has had nobody since Tuesday, and the start is what the replay reads.
    await db
      .update(campaignAudienceAvailability)
      .set({ lastObservedAt: now })
      .where(eq(campaignAudienceAvailability.id, current.id));
    return;
  }

  if (current) {
    await db
      .update(campaignAudienceAvailability)
      .set({ endedAt: now })
      .where(eq(campaignAudienceAvailability.id, current.id));
  }

  await db
    .insert(campaignAudienceAvailability)
    .values({ campaignId, orgId, hasAudience, startedAt: now, lastObservedAt: now });
}
