import { db } from "../db/index.js";
import { campaigns } from "../db/schema.js";
import { eq, and, lte, isNotNull } from "drizzle-orm";
import { executeCampaignWorkflow } from "./workflows.js";
import { createRun } from "@distribute/runs-client";

const SCHEDULER_INTERVAL_MS = 60_000; // 1 minute

/**
 * Find all ongoing campaigns whose toResumeAt has passed,
 * clear the flag, and re-trigger their workflow.
 */
export async function resumeDueCampaigns(): Promise<number> {
  const now = new Date();

  const dueCampaigns = await db
    .select({
      id: campaigns.id,
      orgId: campaigns.orgId,
      createdByUserId: campaigns.createdByUserId,
      workflowSlug: campaigns.workflowSlug,
      brandIds: campaigns.brandIds,
      featureSlug: campaigns.featureSlug,
    })
    .from(campaigns)
    .where(
      and(
        eq(campaigns.status, "ongoing"),
        isNotNull(campaigns.toResumeAt),
        lte(campaigns.toResumeAt, now),
      ),
    );

  if (dueCampaigns.length === 0) return 0;

  console.log(`[Scheduler] Found ${dueCampaigns.length} campaign(s) due for resume`);

  for (const campaign of dueCampaigns) {
    try {
      const missingFields: string[] = [];
      if (!campaign.brandIds || campaign.brandIds.length === 0) missingFields.push("brandIds");
      if (!campaign.createdByUserId) missingFields.push("createdByUserId");
      if (!campaign.featureSlug) missingFields.push("featureSlug");
      if (missingFields.length > 0) {
        console.warn(`[Scheduler] Campaign ${campaign.id} missing required fields for workflow execution: ${missingFields.join(", ")} — skipping resume`);
        continue;
      }

      // Clear toResumeAt before re-triggering (prevent double-fire)
      await db.update(campaigns)
        .set({ toResumeAt: null, updatedAt: new Date() })
        .where(eq(campaigns.id, campaign.id));

      // All three fields are validated non-null above
      const brandIdCsv = campaign.brandIds!.join(",");
      const userId = campaign.createdByUserId!;
      const featureSlug = campaign.featureSlug!;

      const run = await createRun({
        orgId: campaign.orgId,
        serviceName: "campaign-service",
        taskName: "scheduler-resume",
        userId,
        campaignId: campaign.id,
        brandId: brandIdCsv,
        workflowSlug: campaign.workflowSlug,
        featureSlug,
      });
      executeCampaignWorkflow(campaign.workflowSlug, {
        campaignId: campaign.id,
        orgId: campaign.orgId,
        brandId: brandIdCsv,
        userId,
        runId: run.id,
        featureSlug,
      }).catch((err) => {
        console.error(`[Scheduler] Failed to re-trigger campaign ${campaign.id}:`, err);
      });
    } catch (err) {
      console.error(`[Scheduler] Error processing campaign ${campaign.id}:`, err);
    }
  }

  return dueCampaigns.length;
}

/**
 * Start the scheduler interval. Returns a cleanup function.
 */
export function startScheduler(): () => void {
  console.log(`[Scheduler] Starting (interval=${SCHEDULER_INTERVAL_MS}ms)`);

  const handle = setInterval(() => {
    resumeDueCampaigns().catch((err) => {
      console.error("[Scheduler] Unhandled error:", err);
    });
  }, SCHEDULER_INTERVAL_MS);

  return () => clearInterval(handle);
}
