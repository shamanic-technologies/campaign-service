import { Router } from "express";
import { eq, and, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { campaigns } from "../db/schema.js";
import { requireApiKey, requirePipelineHeaders, trackingHeaders, type AuthenticatedRequest } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import { createRun, listRuns, updateRun, type IdentityHeaders } from "@distribute/runs-client";
import { runGateChecks } from "../lib/gate-check.js";
import { EndRunBody, TransferBrandBody } from "../schemas.js";
import { wakeScheduler } from "../lib/scheduler.js";
import { traceEvent } from "../lib/trace-event.js";

const router = Router();

// Backoff applied to a BLOCKED gate result that carries no scheduler decision
// (neither autoStopped nor a window nextRunAt). Guarantees the campaign is not
// re-claimed + re-fired on the very next scheduler tick.
const GATE_BLOCK_BACKOFF_MS = 15 * 60_000; // 15 min

/**
 * POST /gate-check
 *
 * Checks whether a campaign is allowed to run a new iteration.
 * Validates budget limits, volume limits, consecutive failures,
 * and campaign status.
 *
 * Called as the first DAG node. Returns { allowed: true } to proceed
 * or { allowed: false, reason } to stop. The DAG uses stopAfterIf to
 * end the flow cleanly without triggering onError.
 *
 * Returns:
 *   200 — gate check result (allowed or blocked)
 *   400 — missing required headers
 *   404 — campaign not found
 *   500 — internal error
 */
router.post("/gate-check", requireApiKey, requirePipelineHeaders, trackingHeaders, async (req: AuthenticatedRequest, res) => {
  try {
    const campaignId = req.campaignId!;
    const orgId = req.orgId!;

    const campaign = await db.query.campaigns.findFirst({
      where: and(eq(campaigns.id, campaignId), eq(campaigns.orgId, orgId)),
    });
    if (!campaign) {
      console.warn(`[campaign-service] Campaign not found: ${campaignId}`);
      return res.status(404).json({ error: "Campaign not found" });
    }
    const resolvedBrandIds = (req.brandIds && req.brandIds.length > 0) ? req.brandIds : (campaign.brandIds ?? []);

    if (req.runId) {
      traceEvent(req.runId, {
        service: "campaign-service",
        event: "gate-check-start",
        detail: `Running gate checks for campaign ${campaignId} — status=${campaign.status}, brandIds=[${resolvedBrandIds.join(",")}]`,
        data: { campaignId, status: campaign.status, brandIds: resolvedBrandIds },
      }, req.headers).catch(() => {});
    }

    const result = await runGateChecks({
      campaignId,
      orgId,
      userId: req.userId,
      runId: req.runId,
      brandId: resolvedBrandIds.join(","),
      workflowSlug: req.workflowSlug || campaign.workflowSlug,
      status: campaign.status,
      maxBudgetDailyUsd: campaign.maxBudgetDailyUsd,
      maxBudgetWeeklyUsd: campaign.maxBudgetWeeklyUsd,
      maxBudgetMonthlyUsd: campaign.maxBudgetMonthlyUsd,
      maxBudgetTotalUsd: campaign.maxBudgetTotalUsd,
      maxLeads: campaign.maxLeads,
    });

    if (req.runId) {
      traceEvent(req.runId, {
        service: "campaign-service",
        event: "gate-check-result",
        detail: `Gate check ${result.allowed ? "PASSED" : "BLOCKED"} for campaign ${campaignId}${result.reason ? ` — reason: ${result.reason}` : ""}${result.autoStopped ? " (auto-stopped)" : ""}`,
        level: result.allowed ? "info" : "warn",
        data: { campaignId, allowed: result.allowed, reason: result.reason, autoStopped: result.autoStopped },
      }, req.headers).catch(() => {});
    }

    if (!result.allowed) {
      // Invariant: every BLOCKED result must persist a scheduler decision — either
      // terminal (autoStopped) OR a future nextRunAt. A null here would let
      // claimStuckCampaigns re-claim the (ongoing, nextRunAt=null) campaign every tick
      // and re-fire the Windmill flow indefinitely. Window blocks carry their own
      // nextRunAt (reset boundary); any other no-decision block backs off explicitly.
      let nextRunAt = result.nextRunAt ?? null;
      if (!nextRunAt && !result.autoStopped) {
        nextRunAt = new Date(Date.now() + GATE_BLOCK_BACKOFF_MS);
      }
      if (nextRunAt) {
        await db.update(campaigns)
          .set({ nextRunAt, updatedAt: new Date() })
          .where(eq(campaigns.id, campaignId));
      }
    }

    res.json({
      allowed: result.allowed,
      ...(result.reason && { reason: result.reason }),
      ...(result.autoStopped && { autoStopped: result.autoStopped }),
    });
  } catch (error) {
    console.error("[campaign-service] Unhandled error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * POST /start-run
 *
 * Creates a run and returns campaign data for downstream DAG nodes
 * (brand-profile, fetch-lead, etc.).
 *
 * Gate checks are handled by the /gate-check DAG node upstream.
 *
 * Returns:
 *   200 — run started, campaign data returned
 *   400 — bad request (missing headers or brandIds)
 *   404 — campaign not found
 *   500 — internal error
 */
router.post("/start-run", requireApiKey, requirePipelineHeaders, trackingHeaders, async (req: AuthenticatedRequest, res) => {
  try {
    const campaignId = req.campaignId!;
    const orgId = req.orgId!;

    const campaign = await db.query.campaigns.findFirst({
      where: and(eq(campaigns.id, campaignId), eq(campaigns.orgId, orgId)),
    });
    if (!campaign) {
      console.warn(`[campaign-service] Campaign not found: ${campaignId} (orgId=${orgId})`);
      return res.status(404).json({ error: "Campaign not found" });
    }
    if (!campaign.brandIds || campaign.brandIds.length === 0) {
      console.warn(`[campaign-service] Campaign ${campaignId} has no brandIds`);
      return res.status(400).json({ error: "Campaign has no brandIds" });
    }

    // featureSlug comes exclusively from x-feature-slug header
    const featureSlug = req.featureSlug || undefined;

    if (req.runId) {
      traceEvent(req.runId, {
        service: "campaign-service",
        event: "start-run",
        detail: `Starting run for campaign ${campaignId} — brandIds=[${campaign.brandIds!.join(",")}], workflowSlug=${campaign.workflowSlug}, featureSlug=${featureSlug ?? "none"}`,
        data: { campaignId, brandIds: campaign.brandIds, workflowSlug: campaign.workflowSlug, featureSlug },
      }, req.headers).catch(() => {});
    }

    // Create run in runs-service (x-run-id from caller becomes parentRunId)
    const parentRunId = req.runId;
    const brandIdCsv = campaign.brandIds!.join(",");
    const run = await createRun({
      orgId,
      serviceName: "campaign-service",
      taskName: campaignId,
      campaignId,
      brandId: brandIdCsv,
      userId: campaign.createdByUserId || undefined,
      parentRunId: parentRunId || undefined,
      workflowSlug: req.workflowSlug || campaign.workflowSlug,
      featureSlug,
    });
    // Build searchParams from featureInputs
    const featureInputs = campaign.featureInputs as Record<string, unknown> | null;
    const searchParams = (featureInputs && Object.keys(featureInputs).length > 0) ? featureInputs : null;

    if (req.runId) {
      traceEvent(req.runId, {
        service: "campaign-service",
        event: "run-created",
        detail: `Run created id=${run.id} for campaign ${campaignId} — parentRunId=${parentRunId ?? "none"}`,
        data: { runId: run.id, campaignId, parentRunId },
      }, req.headers).catch(() => {});
    }

    // Return campaign data for downstream DAG nodes
    res.json({
      runId: run.id,
      campaignId,
      orgId,
      brandIds: campaign.brandIds,
      workflowSlug: campaign.workflowSlug,
      userId: campaign.createdByUserId ?? null,
      featureSlug: campaign.featureSlug ?? null,
      featureInputs: featureInputs ?? null,
      searchParams,
    });
  } catch (error) {
    console.error("[campaign-service] Unhandled error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * POST /end-run
 *
 * Marks the running run as completed or failed, then re-triggers the
 * workflow if the campaign is still ongoing and stopCampaign is false.
 *
 * Body: { success: boolean, stopCampaign: boolean }
 *   - success: whether the run completed successfully
 *   - stopCampaign: whether to auto-stop the campaign (no more work to do)
 *
 * Does NOT require runId — finds the running run via runs-service.
 * This lets it handle both the happy path (email-send → end-run) and
 * the error path (onError → end-run-error) including cases where
 * no run was created (gate-check blocked).
 */
router.post("/end-run", requireApiKey, requirePipelineHeaders, trackingHeaders, validateBody(EndRunBody), async (req: AuthenticatedRequest, res) => {
  try {
    const campaignId = req.campaignId!;
    const orgId = req.orgId!;
    const { success, stopCampaign } = req.body;

    const status = success === true ? "completed" : "failed";
    const identity: IdentityHeaders = {
      orgId,
      userId: req.userId,
      runId: req.runId,
      campaignId,
      brandId: req.brandIds?.join(","),
      workflowSlug: req.workflowSlug,
      featureSlug: req.featureSlug,
    };

    if (req.runId) {
      traceEvent(req.runId, {
        service: "campaign-service",
        event: "end-run",
        detail: `Ending run for campaign ${campaignId} — success=${success}, stopCampaign=${stopCampaign}, status=${status}`,
        data: { campaignId, success, stopCampaign, status },
      }, req.headers).catch(() => {});
    }

    // Finalize ONLY this caller's own run row, matched by parentRunId === req.runId.
    // Sibling parent runs (concurrent campaign runs from a stale schedule) are NOT touched —
    // each is responsible for ending its own row when its DAG terminates. The previous
    // "mark all running runs failed" behavior swept siblings and was the root cause of
    // the serial-invariant violation seen at lead-service.
    if (!req.runId) {
      console.warn(`[campaign-service] /end-run called without x-run-id for campaign ${campaignId} — cannot finalize a run row`);
    } else {
      try {
        const { runs } = await listRuns({
          orgId,
          serviceName: "campaign-service",
          taskName: campaignId,
          parentRunId: req.runId,
          status: "running",
        });
        for (const run of runs) {
          await updateRun(run.id, status, identity);
        }
      } catch (err) {
        console.error(`[campaign-service] Failed to update run for campaign ${campaignId}:`, err);
      }
    }

    // Respond immediately, then handle re-trigger asynchronously
    res.json({ status });

    // stopCampaign → auto-stop campaign, no re-trigger
    if (stopCampaign === true) {
      try {
        await db.update(campaigns)
          .set({ status: "stopped", updatedAt: new Date() })
          .where(and(eq(campaigns.id, campaignId), eq(campaigns.orgId, orgId)));
        console.warn(`[campaign-service] stopCampaign=true — auto-stopped campaign ${campaignId}`);
      } catch (err) {
        console.error(`[campaign-service] Failed to auto-stop campaign:`, err);
      }
      return;
    }

    // Schedule re-trigger via nextRunAt — the scheduler picks it up on the next tick.
    // This prevents exponential cascades when downstream services are down.
    try {
      const freshCampaign = await db.query.campaigns.findFirst({
        where: and(eq(campaigns.id, campaignId), eq(campaigns.orgId, orgId)),
      });
      if (freshCampaign?.status !== "ongoing") {
        return;
      }

      // Failed runs get a 60s backoff; completed runs re-run immediately
      const delayMs = status === "failed" ? 60_000 : 0;
      const nextRunAt = new Date(Date.now() + delayMs);

      if (req.runId) {
        traceEvent(req.runId, {
          service: "campaign-service",
          event: "re-trigger-scheduled",
          detail: `Scheduled re-trigger for campaign ${campaignId} via nextRunAt=${nextRunAt.toISOString()} (delay=${delayMs}ms)`,
          data: { campaignId, nextRunAt: nextRunAt.toISOString(), delayMs },
        }, req.headers).catch(() => {});
      }

      await db.update(campaigns)
        .set({ nextRunAt, updatedAt: new Date() })
        .where(eq(campaigns.id, campaignId));

      // Re-run scheduled → wake the scheduler so it fires at (or near) nextRunAt
      // instead of waiting out the current idle sleep.
      wakeScheduler();

      if (status === "failed") {
        console.warn(`[campaign-service] Run failed — rescheduled campaign ${campaignId} in ${delayMs}ms (nextRunAt=${nextRunAt.toISOString()})`);
      } else {
        console.log(`[campaign-service] Set nextRunAt=${nextRunAt.toISOString()} for campaign ${campaignId} (status=${status})`);
      }
    } catch (err) {
      console.error(`[campaign-service] Failed to schedule re-trigger for campaign ${campaignId}:`, err);
    }
  } catch (error) {
    console.error("[campaign-service] Unhandled error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * POST /internal/transfer-brand
 *
 * Transfers all solo-brand campaigns from one org to another.
 * Solo-brand = brand_ids array contains exactly one element matching sourceBrandId.
 * Skips co-branding rows (multiple brand IDs).
 *
 * Two-step process:
 *   Step 1: UPDATE org_id WHERE brand_ids = [sourceBrandId] AND org_id = sourceOrgId
 *   Step 2 (when targetBrandId present): UPDATE brand_ids WHERE brand_ids = [sourceBrandId] (no org filter)
 *
 * Idempotent: re-running with same params is a no-op.
 */
router.post("/internal/transfer-brand", requireApiKey, validateBody(TransferBrandBody), async (req, res) => {
  try {
    const { sourceBrandId, sourceOrgId, targetOrgId, targetBrandId } = req.body;

    // Step 1: Move matching rows to target org
    const step1 = await db.execute(
      sql`WITH updated AS (
            UPDATE campaigns
            SET org_id = ${targetOrgId},
                updated_at = NOW()
            WHERE org_id = ${sourceOrgId}
              AND brand_ids = ARRAY[${sourceBrandId}]::text[]
            RETURNING id
          )
          SELECT count(*)::int AS cnt FROM updated`
    );

    const movedCount = Number((step1 as unknown as Array<{ cnt: number }>)[0]?.cnt ?? 0);

    // Step 2: Rewrite brand_ids (no org filter — catches all rows with sourceBrandId)
    let remappedCount = 0;
    if (targetBrandId) {
      const step2 = await db.execute(
        sql`WITH updated AS (
              UPDATE campaigns
              SET brand_ids = ARRAY[${targetBrandId}]::text[],
                  updated_at = NOW()
              WHERE brand_ids = ARRAY[${sourceBrandId}]::text[]
              RETURNING id
            )
            SELECT count(*)::int AS cnt FROM updated`
      );
      remappedCount = Number((step2 as unknown as Array<{ cnt: number }>)[0]?.cnt ?? 0);
    }

    const totalCount = Math.max(movedCount, remappedCount);

    console.log(`[campaign-service] transfer-brand: moved ${movedCount}, remapped ${remappedCount} campaigns (sourceBrandId=${sourceBrandId}, targetBrandId=${targetBrandId ?? "none"}, ${sourceOrgId} -> ${targetOrgId})`);

    res.json({
      updatedTables: [{ tableName: "campaigns", count: totalCount }],
    });
  } catch (error) {
    console.error("[campaign-service] transfer-brand error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
