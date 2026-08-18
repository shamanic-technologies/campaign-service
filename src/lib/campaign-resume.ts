import { and, asc, eq } from "drizzle-orm";
import type { IdentityHeaders } from "@distribute/runs-client";
import { db } from "../db/index.js";
import { campaigns } from "../db/schema.js";
import { STOP_REASONS } from "./stop-reason.js";
import { serveableAudienceIdsForCampaign } from "./serveable-audience.js";
import { campaignFunding } from "./campaign-funding.js";
import { ensureCampaignRunId } from "./trigger-run.js";
import type { DownstreamIdentity } from "./downstream-headers.js";

/**
 * How often the sweep asks features-service about the stopped-for-exhaustion population.
 *
 * Its OWN cadence, not the scheduler's. A tick fires as often as every 60s to catch /end-run
 * reschedules; asking the audience owner about every exhausted campaign at that rate would be a
 * per-minute fan-out for a state that changes when a customer edits their audiences — hours or
 * days apart. The customer was told their action is the trigger, so what they are owed is that
 * it works without them, not that it works within the minute.
 */
export const RESUME_SWEEP_INTERVAL_MS = 10 * 60_000; // 10 min

/**
 * Most campaigns examined in one sweep. Not a silent cap: going over it is logged with the
 * number left behind, and the sweep reads oldest-checked-first, so the remainder is picked up on
 * the following sweep rather than starved.
 */
export const RESUME_SWEEP_MAX_CAMPAIGNS = 100;

/** Why a candidate was NOT resumed, for the log line. */
type SkipReason = string;

let lastSweepAt = 0;

/** Test seam: forget the throttle so a test can run consecutive sweeps. */
export function resetResumeSweepThrottle(): void {
  lastSweepAt = 0;
}

/**
 * Bring back the campaigns that stopped because they ran out of people to contact and now have
 * people to contact again.
 *
 * The customer's action IS the trigger: they were emailed asking them to extend or add an
 * audience, they did it, and the new audience shows up in features-service's projection the
 * moment it goes active. Nothing here polls the whole stopped population — the candidates are
 * the campaigns that stated `audience_exhausted` when they stopped, which is a narrow and
 * durable population, and every other stopped campaign is invisible to this code.
 *
 * A candidate comes back only when ALL of these hold, and each failure says which one:
 *   - the customer funds a ceiling for it to spend against,
 *   - features-service reports at least one serveable, non-exhausted audience,
 *   - no ongoing campaign already holds its (org, brand, funnel, channel) identity.
 * Anything unreadable leaves the campaign stopped and logs why. A resume that cannot be decided
 * safely is not a resume.
 *
 * Returns how many campaigns were resumed.
 */
export async function resumeServeableCampaigns(now: Date = new Date()): Promise<number> {
  if (now.getTime() - lastSweepAt < RESUME_SWEEP_INTERVAL_MS) return 0;
  lastSweepAt = now.getTime();

  const candidates = await db.query.campaigns.findMany({
    where: and(
      eq(campaigns.status, "stopped"),
      eq(campaigns.stopReason, STOP_REASONS.AUDIENCE_EXHAUSTED),
    ),
    // Oldest-touched first, so a population larger than one sweep rotates instead of starving.
    orderBy: [asc(campaigns.updatedAt)],
    limit: RESUME_SWEEP_MAX_CAMPAIGNS + 1,
  });

  const examined = candidates.slice(0, RESUME_SWEEP_MAX_CAMPAIGNS);
  if (candidates.length > RESUME_SWEEP_MAX_CAMPAIGNS) {
    console.log(
      `[campaign-service] Resume sweep examining ${examined.length} of ${candidates.length}+ exhausted campaigns — the rest are examined on the next sweep (oldest first)`,
    );
  }
  if (examined.length === 0) return 0;

  let resumed = 0;
  for (const campaign of examined) {
    try {
      if (await resumeOneCampaign(campaign, now)) resumed++;
    } catch (err) {
      // An unreadable answer is not a decision: leave the campaign stopped and say so.
      console.warn(
        `[campaign-service] Resume check failed for campaign ${campaign.id} — leaving it stopped:`,
        err,
      );
    }
  }

  return resumed;
}

/**
 * Decide and, when everything holds, perform the resume for ONE campaign.
 * Returns true when the campaign came back.
 */
async function resumeOneCampaign(
  campaign: typeof campaigns.$inferSelect,
  now: Date,
): Promise<boolean> {
  const brandId = campaign.brandId ?? campaign.brandIds?.[0];
  const featureSlug = campaign.featureSlug;
  const userId = campaign.createdByUserId;

  if (!brandId) return skip(campaign, "no brand on the campaign");
  if (!featureSlug) return skip(campaign, "no feature slug on the campaign");
  if (!userId) return skip(campaign, "no createdByUserId — nothing could run it");

  // The campaign's own ancestor run. The downstream reads below are real, attributable calls, so
  // the id they carry has to resolve in runs-service — a minted one does not, and it is the same
  // id the scheduler then hands workflow-service when this campaign takes its first turn back
  // (where an unresolvable ancestor means the execution is refused outright). Established once and
  // persisted; a campaign that cannot be given one is left stopped by the caller's catch.
  const runId = await ensureCampaignRunId(campaign);
  const identity: DownstreamIdentity = {
    orgId: campaign.orgId,
    userId,
    runId,
    campaignId: campaign.id,
    brandId,
    workflowSlug: campaign.workflowSlug,
    featureSlug,
  };

  const funding = await fundingCeiling(campaign, brandId, identity);
  if (funding !== null) return skip(campaign, funding);

  const serveableAudienceIds = await serveableAudienceIdsForCampaign(campaign, featureSlug, identity);
  if (serveableAudienceIds.length === 0) {
    // The expected state for most candidates on most sweeps: still nobody to contact. Not logged
    // — it fires for every exhausted campaign of every client on every sweep, and it is already
    // observable in the campaign staying stopped.
    return false;
  }

  // At most one ongoing campaign per (org, brand, funnel, channel) — the partial unique index
  // enforces it, and this read is what turns "the index rejected the write" into a decision we
  // can explain. Both are needed: the index is the guarantee, this is the reason. Scoped to the
  // rows the index actually covers (it is partial on a stated brand AND channel).
  if (campaign.brandId && campaign.acquisitionChannel) {
    const siblings = await db.query.campaigns.findMany({
      where: and(
        eq(campaigns.orgId, campaign.orgId),
        eq(campaigns.status, "ongoing"),
        eq(campaigns.brandId, campaign.brandId),
        eq(campaigns.acquisitionChannel, campaign.acquisitionChannel),
      ),
      columns: { id: true, funnelKey: true },
    });
    const incumbent = siblings.find((s) => (s.funnelKey ?? "") === (campaign.funnelKey ?? ""));
    if (incumbent) {
      return skip(
        campaign,
        `campaign ${incumbent.id} is already ongoing for this brand, funnel and channel`,
      );
    }
  }

  // Conditional on the state we decided from, so two sweeps (or a sweep racing a human
  // un-pause) cannot both bring the same campaign back, and a campaign a person stopped between
  // the read and the write is not resumed.
  let claimed: Array<{ id: string }>;
  try {
    claimed = await db
      .update(campaigns)
      .set({
        status: "ongoing",
        // The reason described a stop that is over. Clearing it keeps the column describing the
        // CURRENT state and stops a second sweep treating an ongoing campaign as a candidate.
        stopReason: null,
        // Due immediately: the very next scheduler tick treats it like any other running campaign.
        nextRunAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(campaigns.id, campaign.id),
          eq(campaigns.status, "stopped"),
          eq(campaigns.stopReason, STOP_REASONS.AUDIENCE_EXHAUSTED),
        ),
      )
      .returning({ id: campaigns.id });
  } catch (err) {
    // The identity index refused the write — another campaign took this identity between the
    // check above and here. That is the index doing its job; the campaign stays stopped.
    if ((err as { code?: string } | null)?.code === "23505") {
      return skip(campaign, "another campaign took this identity first (unique index)");
    }
    throw err;
  }

  if (claimed.length === 0) {
    return skip(campaign, "no longer stopped-for-exhaustion when the resume was written");
  }

  console.log(
    `[campaign-service] Resumed campaign ${campaign.id} (org ${campaign.orgId}, brand ${brandId}, funnel ${campaign.funnelKey ?? "none"}) — stopped for audience exhaustion, now serveable: ${serveableAudienceIds.join(", ")}`,
  );
  return true;
}

/**
 * Is there still a ceiling to spend against? Returns null when funded, or the reason it is not.
 *
 * One definition, shared with the leg that HOLDS an ongoing campaign (`campaignFunding`), because
 * a rule that decides whether to START spending and a rule that decides whether to KEEP spending
 * must be the same rule — two legs on two definitions is how a campaign gets held by one and
 * never picked up by the other.
 *
 * Fail-CLOSED: an unreadable budget leaves the campaign stopped.
 */
async function fundingCeiling(
  campaign: typeof campaigns.$inferSelect,
  brandId: string,
  identity: IdentityHeaders,
): Promise<SkipReason | null> {
  const verdict = await campaignFunding(campaign, brandId, identity);
  return verdict.funded ? null : verdict.reason;
}

/** Leave a campaign stopped and say why. Never silent: a refused resume is a decision. */
function skip(campaign: { id: string }, reason: SkipReason): false {
  console.log(`[campaign-service] Not resuming campaign ${campaign.id} — ${reason}`);
  return false;
}
