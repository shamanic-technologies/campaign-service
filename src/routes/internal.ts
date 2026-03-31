import { Router } from "express";
import { eq, and } from "drizzle-orm";
import { db } from "../db/index.js";
import { campaigns } from "../db/schema.js";
import { requireApiKey, trackingHeaders, type AuthenticatedRequest } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import { createRun, listRuns, updateRun, type IdentityHeaders } from "@distribute/runs-client";
import { runGateChecks } from "../lib/gate-check.js";
import { executeCampaignWorkflow, validateWorkflowInputs } from "../lib/workflows.js";
import { GateCheckBody, StartRunBody, EndRunBody } from "../schemas.js";

const router = Router();

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
 *   404 — campaign not found
 *   500 — internal error
 */
router.post("/gate-check", requireApiKey, trackingHeaders, validateBody(GateCheckBody), async (req: AuthenticatedRequest, res) => {
  try {
    const { campaignId, orgId } = req.body;
    console.log(`[Gate Check] Received request: campaignId=${campaignId}, orgId=${orgId}`);

    const campaign = await db.query.campaigns.findFirst({
      where: and(eq(campaigns.id, campaignId), eq(campaigns.orgId, orgId)),
    });
    if (!campaign) {
      console.warn(`[Gate Check] Campaign not found: ${campaignId}`);
      return res.status(404).json({ error: "Campaign not found" });
    }

    console.log(`[Gate Check] Running checks for campaign ${campaignId} (status=${campaign.status})...`);
    const resolvedBrandIds = (req.brandIds && req.brandIds.length > 0) ? req.brandIds : (campaign.brandIds ?? []);
    const result = await runGateChecks({
      campaignId,
      orgId,
      userId: req.headers["x-user-id"] as string | undefined,
      runId: req.headers["x-run-id"] as string | undefined,
      brandId: resolvedBrandIds.join(","),
      workflowSlug: req.workflowSlug || campaign.workflowSlug,
      status: campaign.status,
      maxBudgetDailyUsd: campaign.maxBudgetDailyUsd,
      maxBudgetWeeklyUsd: campaign.maxBudgetWeeklyUsd,
      maxBudgetMonthlyUsd: campaign.maxBudgetMonthlyUsd,
      maxBudgetTotalUsd: campaign.maxBudgetTotalUsd,
      maxLeads: campaign.maxLeads,
    });

    if (!result.allowed) {
      console.warn(`[Gate Check] BLOCKED: reason=${result.reason}, autoStopped=${result.autoStopped}`);

      // Save toResumeAt so the scheduler can re-trigger when the budget window resets
      if (result.toResumeAt) {
        await db.update(campaigns)
          .set({ toResumeAt: result.toResumeAt, updatedAt: new Date() })
          .where(eq(campaigns.id, campaignId));
        console.log(`[Gate Check] Set toResumeAt=${result.toResumeAt.toISOString()} for campaign ${campaignId}`);
      }
    } else {
      console.log(`[Gate Check] PASSED for campaign ${campaignId}`);
    }

    res.json({
      allowed: result.allowed,
      ...(result.reason && { reason: result.reason }),
      ...(result.autoStopped && { autoStopped: result.autoStopped }),
    });
  } catch (error) {
    console.error("[Gate Check] Unhandled error:", error);
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
 *   400 — bad request (missing brandIds)
 *   404 — campaign not found
 *   500 — internal error
 */
router.post("/start-run", requireApiKey, trackingHeaders, validateBody(StartRunBody), async (req: AuthenticatedRequest, res) => {
  try {
    const { campaignId, orgId } = req.body;
    console.log(`[Start Run] Received request: campaignId=${campaignId}, orgId=${orgId}`);

    const campaign = await db.query.campaigns.findFirst({
      where: and(eq(campaigns.id, campaignId), eq(campaigns.orgId, orgId)),
    });
    if (!campaign) {
      console.warn(`[Start Run] Campaign not found: ${campaignId} (orgId=${orgId})`);
      return res.status(404).json({ error: "Campaign not found" });
    }
    console.log(`[Start Run] Campaign found: name=${campaign.name}, workflowSlug=${campaign.workflowSlug}, status=${campaign.status}`);
    if (!campaign.brandIds || campaign.brandIds.length === 0) {
      console.warn(`[Start Run] Campaign ${campaignId} has no brandIds`);
      return res.status(400).json({ error: "Campaign has no brandIds" });
    }

    // featureSlug comes exclusively from x-feature-slug header
    const featureSlug = req.featureSlug || undefined;

    // Create run in runs-service (x-run-id from caller becomes parentRunId)
    const parentRunId = req.headers["x-run-id"] as string | undefined;
    const brandIdCsv = campaign.brandIds!.join(",");
    console.log(`[Start Run] Creating run in runs-service for campaign ${campaignId} (parentRunId=${parentRunId || "none"}, featureSlug=${featureSlug || "none"})...`);
    const run = await createRun({
      orgId,
      serviceName: "campaign-service",
      taskName: campaignId,
      campaignId,
      brandId: brandIdCsv,
      userId: campaign.createdByUserId || undefined,
      parentRunId: parentRunId || undefined,
      workflowSlug: campaign.workflowSlug,
      featureSlug,
    });
    console.log(`[Start Run] Run created: runId=${run.id}`);

    // Build searchParams from featureInputs
    const featureInputs = campaign.featureInputs as Record<string, unknown> | null;
    const searchParams = (featureInputs && Object.keys(featureInputs).length > 0) ? featureInputs : null;

    console.log(`[Start Run] SUCCESS — runId=${run.id}, searchParams=${searchParams ? "yes" : "none"}`);

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
    console.error("[Start Run] Unhandled error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * POST /end-run
 *
 * Marks the running run as completed or failed, then re-triggers the
 * workflow if the campaign is still ongoing.
 *
 * Does NOT require runId — finds the running run via runs-service.
 * This lets it handle both the happy path (email-send → end-run) and
 * the error path (onError → end-run-error) including cases where
 * no run was created (gate-check blocked).
 */
router.post("/end-run", requireApiKey, trackingHeaders, validateBody(EndRunBody), async (req: AuthenticatedRequest, res) => {
  try {
    const { campaignId, orgId, success, leadFound } = req.body;
    console.log(`[End Run] Received request: campaignId=${campaignId}, orgId=${orgId}, success=${success}, leadFound=${leadFound}`);

    const status = success === true ? "completed" : "failed";
    const identity: IdentityHeaders = {
      orgId: (req.headers["x-org-id"] as string) || orgId,
      userId: req.headers["x-user-id"] as string | undefined,
      runId: req.headers["x-run-id"] as string | undefined,
      campaignId: req.campaignId,
      brandId: req.brandIds?.join(","),
      workflowSlug: req.workflowSlug,
      featureSlug: req.featureSlug,
    };

    // Find and update running runs for this campaign
    try {
      const { runs } = await listRuns({
        orgId,
        serviceName: "campaign-service",
        taskName: campaignId,
      });

      const runningRuns = runs.filter((r) => r.status === "running");
      if (runningRuns.length > 0) {
        for (const run of runningRuns) {
          console.log(`[End Run] Updating run ${run.id} to status=${status}`);
          await updateRun(run.id, status, identity);
        }
      } else {
        console.log(`[End Run] No running runs found for campaign ${campaignId} — skipping run update`);
      }
    } catch (err) {
      console.error(`[End Run] Failed to update runs:`, err);
    }

    // Respond immediately, then handle re-trigger asynchronously
    res.json({ status });

    // No leads found → auto-stop campaign, no re-trigger
    if (success === true && leadFound === false) {
      try {
        await db.update(campaigns)
          .set({ status: "stopped" })
          .where(and(eq(campaigns.id, campaignId), eq(campaigns.orgId, orgId)));
        console.log(`[End Run] No leads found — auto-stopped campaign ${campaignId}`);
      } catch (err) {
        console.error(`[End Run] Failed to auto-stop campaign:`, err);
      }
      return;
    }

    // Re-trigger if campaign is still ongoing
    try {
      // Re-fetch campaign for fresh status (may have been auto-stopped by gate-check)
      const freshCampaign = await db.query.campaigns.findFirst({
        where: and(eq(campaigns.id, campaignId), eq(campaigns.orgId, orgId)),
      });
      console.log(`[End Run] Campaign status for re-trigger: ${freshCampaign?.status || "NOT FOUND"}, workflowSlug=${freshCampaign?.workflowSlug || "N/A"}`);
      if (freshCampaign?.status !== "ongoing") {
        console.log(`[End Run] Campaign ${campaignId} is not ongoing — skipping re-trigger`);
        return;
      }

      const resolvedBrandIdCsv = (req.brandIds && req.brandIds.length > 0) ? req.brandIds.join(",") : (freshCampaign.brandIds ?? []).join(",");
      const resolvedFeatureSlug = identity.featureSlug || "";

      const retriggerInputs = {
        campaignId,
        orgId,
        brandId: resolvedBrandIdCsv || "",
        userId: identity.userId || "",
        runId: identity.runId || "",
        featureSlug: resolvedFeatureSlug,
      };
      const missingRetrigger = validateWorkflowInputs(retriggerInputs);
      if (missingRetrigger.length > 0) {
        console.warn(`[End Run] Cannot re-trigger campaign ${campaignId} — missing required fields: ${missingRetrigger.join(", ")}`);
        return;
      }

      // Fire-and-forget: gate-check in the next workflow execution will validate limits
      console.log(`[Campaign Service] Launching workflow run from END-RUN handler — workflow=${freshCampaign.workflowSlug}, campaignId=${campaignId}, previousRunSuccess=${success}`);
      executeCampaignWorkflow(freshCampaign.workflowSlug, retriggerInputs).catch((err) => {
        console.error(`[End Run] Re-trigger failed for campaign ${campaignId}:`, err);
      });
    } catch (err) {
      console.error(`[End Run] Re-trigger check failed:`, err);
    }
  } catch (error) {
    console.error("[End Run] Unhandled error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
