import { db } from "../db/index.js";
import { campaigns } from "../db/schema.js";
import { eq, and, lte, isNotNull } from "drizzle-orm";
import { executeCampaignWorkflow } from "./workflows.js";

const SCHEDULER_INTERVAL_MS = 60_000; // 1 minute

/**
 * Find all ongoing campaigns whose toResumeAt has passed,
 * atomically claim them (clear toResumeAt), and re-trigger their workflow.
 *
 * Uses UPDATE ... RETURNING to atomically claim campaigns, preventing
 * duplicate triggers from overlapping ticks or multiple service instances.
 */
export async function resumeDueCampaigns(): Promise<number> {
  const now = new Date();

  // Atomic claim: UPDATE + RETURNING ensures only one instance/tick processes each campaign.
  // PostgreSQL row-level locks prevent two concurrent UPDATEs from claiming the same row.
  const dueCampaigns = await db
    .update(campaigns)
    .set({ toResumeAt: null, updatedAt: now })
    .where(
      and(
        eq(campaigns.status, "ongoing"),
        isNotNull(campaigns.toResumeAt),
        lte(campaigns.toResumeAt, now),
      ),
    )
    .returning({
      id: campaigns.id,
      orgId: campaigns.orgId,
      createdByUserId: campaigns.createdByUserId,
      parentRunId: campaigns.parentRunId,
      workflowSlug: campaigns.workflowSlug,
      brandIds: campaigns.brandIds,
      featureSlug: campaigns.featureSlug,
    });

  if (dueCampaigns.length === 0) return 0;

  console.log(`[campaign-service] Claimed ${dueCampaigns.length} campaign(s) for resume`);

  for (const campaign of dueCampaigns) {
    try {
      const missingFields: string[] = [];
      if (!campaign.brandIds || campaign.brandIds.length === 0) missingFields.push("brandIds");
      if (!campaign.createdByUserId) missingFields.push("createdByUserId");
      if (!campaign.featureSlug) missingFields.push("featureSlug");
      if (missingFields.length > 0) {
        console.warn(`[campaign-service] Campaign ${campaign.id} missing required fields for workflow execution: ${missingFields.join(", ")} — skipping resume`);
        continue;
      }

      const brandIdCsv = campaign.brandIds!.join(",");
      const userId = campaign.createdByUserId!;
      const featureSlug = campaign.featureSlug!;

      // Do NOT create a run here — /start-run in the workflow DAG creates it.
      // Creating one here with a different taskName caused orphan runs that were
      // invisible to gate-check and never cleaned up.
      const runId = campaign.parentRunId || crypto.randomUUID();

      executeCampaignWorkflow(campaign.workflowSlug, {
        campaignId: campaign.id,
        orgId: campaign.orgId,
        brandId: brandIdCsv,
        userId,
        runId,
        featureSlug,
      }).catch((err) => {
        console.error(`[campaign-service] Failed to re-trigger campaign ${campaign.id}:`, err);
      });
    } catch (err) {
      console.error(`[campaign-service] Error processing campaign ${campaign.id}:`, err);
    }
  }

  return dueCampaigns.length;
}

/** Tracks whether a scheduler tick is currently running. */
let isRunning = false;

/**
 * Start the scheduler interval. Returns a cleanup function.
 *
 * Uses a concurrency guard so overlapping ticks (when processing takes > 60s)
 * are skipped rather than causing duplicate triggers.
 */
export function startScheduler(): () => void {
  console.log(`[campaign-service] Starting (interval=${SCHEDULER_INTERVAL_MS}ms)`);

  const handle = setInterval(() => {
    if (isRunning) {
      console.warn("[campaign-service] Previous tick still running, skipping");
      return;
    }
    isRunning = true;
    resumeDueCampaigns()
      .catch((err) => {
        console.error("[campaign-service] Unhandled error:", err);
      })
      .finally(() => {
        isRunning = false;
      });
  }, SCHEDULER_INTERVAL_MS);

  return () => clearInterval(handle);
}
