import { db } from "../db/index.js";
import { campaigns } from "../db/schema.js";
import { eq, and, lte, isNotNull, isNull } from "drizzle-orm";
import { executeCampaignWorkflow } from "./workflows.js";
import { listRuns } from "@distribute/runs-client";

const SCHEDULER_INTERVAL_MS = 60_000; // 1 minute

// A run is considered "fresh" (campaign actively executing) if it started within this window.
// Older running rows are treated as orphans (workflow died without /end-run).
const STUCK_RUN_FRESHNESS_THRESHOLD_MS = 10 * 60_000; // 10 minutes

/**
 * Find all ongoing campaigns whose nextRunAt has passed,
 * atomically claim them (clear nextRunAt), and re-trigger their workflow.
 *
 * Uses UPDATE ... RETURNING to atomically claim campaigns, preventing
 * duplicate triggers from overlapping ticks or multiple service instances.
 */
export async function reRunDueCampaigns(): Promise<number> {
  const now = new Date();

  // Atomic claim: UPDATE + RETURNING ensures only one instance/tick processes each campaign.
  // PostgreSQL row-level locks prevent two concurrent UPDATEs from claiming the same row.
  const dueCampaigns = await db
    .update(campaigns)
    .set({ nextRunAt: null, updatedAt: now })
    .where(
      and(
        eq(campaigns.status, "ongoing"),
        isNotNull(campaigns.nextRunAt),
        lte(campaigns.nextRunAt, now),
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

  for (const campaign of dueCampaigns) {
    try {
      const missingFields: string[] = [];
      if (!campaign.brandIds || campaign.brandIds.length === 0) missingFields.push("brandIds");
      if (!campaign.createdByUserId) missingFields.push("createdByUserId");
      if (!campaign.featureSlug) missingFields.push("featureSlug");
      if (missingFields.length > 0) {
        console.warn(`[campaign-service] Campaign ${campaign.id} missing required fields for workflow execution: ${missingFields.join(", ")} — skipping re-run`);
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

/**
 * Heartbeat: detect ongoing campaigns whose workflow died without calling /end-run.
 *
 * State `(status=ongoing, nextRunAt=NULL)` is shared by two cases:
 *   1. Campaign currently running (cleared by reRunDueCampaigns at claim time)
 *   2. Campaign whose workflow process died mid-run (no /end-run call ever happened)
 *
 * runs-service is the oracle: if a fresh `running` run exists for the campaign,
 * it's case 1 — leave it alone. Otherwise it's case 2 — set nextRunAt=now so the
 * next reRunDueCampaigns tick picks it up.
 */
export async function claimStuckCampaigns(): Promise<number> {
  const now = new Date();
  const freshnessCutoff = new Date(now.getTime() - STUCK_RUN_FRESHNESS_THRESHOLD_MS);

  const candidates = await db.query.campaigns.findMany({
    where: and(
      eq(campaigns.status, "ongoing"),
      isNull(campaigns.nextRunAt),
    ),
    columns: { id: true, orgId: true },
  });

  if (candidates.length === 0) return 0;

  let claimedCount = 0;

  for (const candidate of candidates) {
    const { runs } = await listRuns({
      orgId: candidate.orgId,
      serviceName: "campaign-service",
      taskName: candidate.id,
      status: "running",
      startedAfter: freshnessCutoff.toISOString(),
    });

    if (runs.length > 0) {
      // Fresh run in flight → campaign is alive, not stuck.
      continue;
    }

    const claimed = await db
      .update(campaigns)
      .set({ nextRunAt: now, updatedAt: now })
      .where(
        and(
          eq(campaigns.id, candidate.id),
          eq(campaigns.status, "ongoing"),
          isNull(campaigns.nextRunAt),
        ),
      )
      .returning({ id: campaigns.id });

    if (claimed.length > 0) {
      claimedCount++;
      console.log(`[campaign-service] Claimed stuck campaign ${candidate.id} (no fresh run in last ${STUCK_RUN_FRESHNESS_THRESHOLD_MS / 60_000}min)`);
    }
  }

  return claimedCount;
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
    claimStuckCampaigns()
      .then(() => reRunDueCampaigns())
      .catch((err) => {
        console.error("[campaign-service] Unhandled error:", err);
      })
      .finally(() => {
        isRunning = false;
      });
  }, SCHEDULER_INTERVAL_MS);

  return () => clearInterval(handle);
}
