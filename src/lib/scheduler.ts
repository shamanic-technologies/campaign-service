import { db } from "../db/index.js";
import { campaigns } from "../db/schema.js";
import { eq, and, lte, isNotNull } from "drizzle-orm";
import { executeCampaignWorkflow } from "./workflows.js";

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
      workflowName: campaigns.workflowName,
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
      // Clear toResumeAt before re-triggering (prevent double-fire)
      await db.update(campaigns)
        .set({ toResumeAt: null, updatedAt: new Date() })
        .where(eq(campaigns.id, campaign.id));

      console.log(`[Scheduler] Re-triggering campaign ${campaign.id} (workflow=${campaign.workflowName})`);
      executeCampaignWorkflow(campaign.workflowName, {
        campaignId: campaign.id,
        orgId: campaign.orgId,
        userId: campaign.createdByUserId ?? undefined,
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
