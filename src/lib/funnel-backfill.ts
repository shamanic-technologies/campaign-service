import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { campaigns } from "../db/schema.js";
import { readBrandGoal, resolveCampaignFunnelKey } from "./funnel-adoption.js";
import { SALES_OUTREACH_FEATURE_SLUGS } from "./sales-outreach-campaign.js";

/**
 * Write the funnel every existing campaign runs onto its own row, once, for the whole fleet.
 *
 * A campaign used to say what it was for only through its goal — its own when it stated one,
 * its brand's otherwise — so every consumer had to infer the funnel from that goal. The funnel
 * is now a stored fact: this pass reads each campaign's goal ONE last time and writes the funnel
 * it means. Nothing reads the goal to find the funnel afterwards, and there is no read-time
 * fallback anywhere.
 *
 * Idempotent: it only ever touches rows whose `funnel_key` is still NULL, so a re-boot (or a
 * second replica booting at the same moment) re-runs it for free and converges on the same rows.
 * Nothing is deleted, stopped or archived — a campaign's status, schedule and history are
 * untouched; the pass adds the funnel and nothing else.
 *
 * What it deliberately leaves NULL, and why:
 *   - every non-sales feature (PR, hiring, VC, AI-visibility …): a sales funnel is not a thing
 *     those campaigns run,
 *   - a goal that names no single funnel (`combinedSales` spans several; `websiteVisit`,
 *     `positiveReply`, `whatsappConversation` stop short of a paid client),
 *   - a brand whose goal cannot be read this boot: the next boot tries again rather than guess.
 *
 * Runs AFTER the port is bound, fire-and-forget: it makes N brand-service reads (one per
 * distinct org+brand pair), and a slow or sleeping sibling must never delay a deploy.
 */
export async function backfillCampaignFunnelKeys(): Promise<{
  scanned: number;
  stamped: number;
  undetermined: number;
}> {
  const rows = await db
    .select({
      id: campaigns.id,
      orgId: campaigns.orgId,
      brandIds: campaigns.brandIds,
      goal: campaigns.goal,
      createdByUserId: campaigns.createdByUserId,
      workflowSlug: campaigns.workflowSlug,
      featureSlug: campaigns.featureSlug,
    })
    .from(campaigns)
    .where(
      and(
        isNull(campaigns.funnelKey),
        inArray(campaigns.featureSlug, [...SALES_OUTREACH_FEATURE_SLUGS]),
      ),
    );

  if (rows.length === 0) return { scanned: 0, stamped: 0, undetermined: 0 };

  // One brand-service read per (org, brand) pair, not per campaign: the goal belongs to the
  // pair, and a brand with 40 stopped campaigns must not cost 40 reads.
  const brandGoals = new Map<string, string | null>();
  let stamped = 0;
  let undetermined = 0;

  for (const row of rows) {
    const brandId = row.brandIds?.[0];
    if (!brandId) {
      undetermined++;
      continue;
    }

    const pair = `${row.orgId}::${brandId}`;
    if (!brandGoals.has(pair)) {
      brandGoals.set(
        pair,
        await readBrandGoal(brandId, {
          orgId: row.orgId,
          userId: row.createdByUserId,
          campaignId: row.id,
          workflowSlug: row.workflowSlug,
          featureSlug: row.featureSlug,
        }),
      );
    }

    const funnelKey = resolveCampaignFunnelKey(row.goal, brandGoals.get(pair) ?? null);
    if (!funnelKey) {
      undetermined++;
      continue;
    }

    await db
      .update(campaigns)
      .set({ funnelKey })
      .where(and(eq(campaigns.id, row.id), isNull(campaigns.funnelKey)));
    stamped++;
  }

  return { scanned: rows.length, stamped, undetermined };
}

/** Boot entry point: never throws, logs one summary line, never blocks the port. */
export async function runFunnelBackfill(): Promise<void> {
  try {
    const { scanned, stamped, undetermined } = await backfillCampaignFunnelKeys();
    if (scanned === 0) return; // already converged — say nothing
    console.log(
      `[campaign-service] funnel backfill: ${stamped}/${scanned} campaigns now state their funnel, ` +
      `${undetermined} left null (their goal names no single funnel, or the brand could not be read)`,
    );
  } catch (err) {
    console.error("[campaign-service] funnel backfill failed:", err);
  }
}
