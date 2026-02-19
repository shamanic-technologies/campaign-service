import { Router } from "express";
import { eq, and } from "drizzle-orm";
import { db } from "../db/index.js";
import { campaigns, orgs } from "../db/schema.js";
import { requireApiKey } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import { createRun, listRuns, updateRun } from "@mcpfactory/runs-client";
import { runGateChecks } from "../lib/gate-check.js";
import { executeCampaignWorkflow } from "../lib/workflows.js";
import { extractDomain } from "../lib/domain.js";
import { GateCheckBody, StartRunBody, EndRunBody } from "../schemas.js";

const router = Router();
const APP_ID = "mcpfactory";

// In-memory cache: skip prompt registration if already done for this org
const promptRegisteredOrgs = new Set<string>();

async function ensurePromptRegistered(clerkOrgId: string): Promise<void> {
  if (promptRegisteredOrgs.has(clerkOrgId)) return;

  const url = process.env.EMAILGENERATION_SERVICE_URL;
  const apiKey = process.env.EMAILGENERATION_SERVICE_API_KEY;
  if (!url || !apiKey) return;

  try {
    const { COLD_EMAIL_PROMPT, COLD_EMAIL_VARIABLES } = await import("../lib/workflows.js");
    const res = await fetch(`${url}/prompts`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "x-clerk-org-id": clerkOrgId,
      },
      body: JSON.stringify({
        appId: APP_ID,
        type: "cold-email",
        prompt: COLD_EMAIL_PROMPT,
        variables: COLD_EMAIL_VARIABLES,
      }),
    });

    if (res.ok) {
      promptRegisteredOrgs.add(clerkOrgId);
    } else {
      console.warn(`[Start Run] Prompt registration failed (${res.status})`);
    }
  } catch (err) {
    console.warn("[Start Run] Prompt registration error (best-effort):", err);
  }
}

/**
 * POST /gate-check
 *
 * Checks whether a campaign is allowed to run a new iteration.
 * Validates budget limits, volume limits, consecutive failures,
 * and campaign status.
 *
 * Called as the first DAG node. Returns { allowed: true } to proceed
 * or { allowed: false, reason } to stop. Windmill uses validateResponse
 * to treat allowed=false as a node error → triggers onError handler.
 *
 * Returns:
 *   200 — gate check result (allowed or blocked)
 *   404 — campaign/org not found
 *   500 — internal error
 */
router.post("/gate-check", requireApiKey, validateBody(GateCheckBody), async (req, res) => {
  try {
    const { campaignId, clerkOrgId } = req.body;
    console.log(`[Gate Check] Received request: campaignId=${campaignId}, clerkOrgId=${clerkOrgId}`);

    const org = await db.query.orgs.findFirst({
      where: eq(orgs.clerkOrgId, clerkOrgId),
    });
    if (!org) {
      console.warn(`[Gate Check] Org not found: ${clerkOrgId}`);
      return res.status(404).json({ error: "Organization not found" });
    }

    const campaign = await db.query.campaigns.findFirst({
      where: and(eq(campaigns.id, campaignId), eq(campaigns.orgId, org.id)),
    });
    if (!campaign) {
      console.warn(`[Gate Check] Campaign not found: ${campaignId}`);
      return res.status(404).json({ error: "Campaign not found" });
    }

    console.log(`[Gate Check] Running checks for campaign ${campaignId} (status=${campaign.status})...`);
    const result = await runGateChecks({
      campaignId,
      clerkOrgId,
      brandId: campaign.brandId || "",
      status: campaign.status,
      maxBudgetDailyUsd: campaign.maxBudgetDailyUsd,
      maxBudgetWeeklyUsd: campaign.maxBudgetWeeklyUsd,
      maxBudgetMonthlyUsd: campaign.maxBudgetMonthlyUsd,
      maxBudgetTotalUsd: campaign.maxBudgetTotalUsd,
      maxLeads: campaign.maxLeads,
    });

    if (!result.allowed) {
      console.warn(`[Gate Check] BLOCKED: reason=${result.reason}, autoStopped=${result.autoStopped}`);
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
 *   400 — bad request (missing brandUrl/brandId)
 *   404 — campaign/org not found
 *   500 — internal error
 */
router.post("/start-run", requireApiKey, validateBody(StartRunBody), async (req, res) => {
  try {
    const { campaignId, clerkOrgId } = req.body;
    console.log(`[Start Run] Received request: campaignId=${campaignId}, clerkOrgId=${clerkOrgId}`);

    const org = await db.query.orgs.findFirst({
      where: eq(orgs.clerkOrgId, clerkOrgId),
    });
    if (!org) {
      console.warn(`[Start Run] Org not found: ${clerkOrgId}`);
      return res.status(404).json({ error: "Organization not found" });
    }

    const campaign = await db.query.campaigns.findFirst({
      where: and(eq(campaigns.id, campaignId), eq(campaigns.orgId, org.id)),
    });
    if (!campaign) {
      console.warn(`[Start Run] Campaign not found: ${campaignId} (orgId=${org.id})`);
      return res.status(404).json({ error: "Campaign not found" });
    }
    console.log(`[Start Run] Campaign found: name=${campaign.name}, type=${campaign.type}, status=${campaign.status}, brandUrl=${campaign.brandUrl}`);
    if (!campaign.brandUrl) {
      console.warn(`[Start Run] Campaign ${campaignId} has no brandUrl`);
      return res.status(400).json({ error: "Campaign has no brandUrl" });
    }
    if (!campaign.brandId) {
      console.warn(`[Start Run] Campaign ${campaignId} has no brandId`);
      return res.status(400).json({ error: "Campaign has no brandId" });
    }

    // Register prompt template (best-effort, cached per org)
    console.log(`[Start Run] Ensuring prompt registered for org ${clerkOrgId} (cached=${promptRegisteredOrgs.has(clerkOrgId)})`);
    await ensurePromptRegistered(clerkOrgId);

    // Create run in runs-service (parentRunId links to api-service's parent run)
    console.log(`[Start Run] Creating run in runs-service for campaign ${campaignId} (parentRunId=${campaign.parentRunId || "none"})...`);
    const run = await createRun({
      clerkOrgId,
      appId: APP_ID,
      serviceName: "campaign-service",
      taskName: campaignId,
      campaignId,
      brandId: campaign.brandId,
      clerkUserId: campaign.createdByUserId || undefined,
      parentRunId: campaign.parentRunId || undefined,
    });
    console.log(`[Start Run] Run created: runId=${run.id}`);

    // Pass all user context as unstructured searchParams so lead-service's
    // LLM can transform them into structured Apollo search params.
    const hasSearchContext = campaign.targetAudience || campaign.targetOutcome || campaign.valueForTarget;
    const searchParams = hasSearchContext
      ? {
          targetAudience: campaign.targetAudience,
          targetOutcome: campaign.targetOutcome,
          valueForTarget: campaign.valueForTarget,
        }
      : null;

    const brandDomain = extractDomain(campaign.brandUrl);

    console.log(`[Start Run] SUCCESS — runId=${run.id}, brandDomain=${brandDomain}, searchParams=${searchParams ? "yes" : "none"}`);

    // Return campaign data for downstream DAG nodes
    res.json({
      runId: run.id,
      campaignId,
      clerkOrgId,
      brandId: campaign.brandId,
      brandUrl: campaign.brandUrl,
      brandDomain,
      appId: campaign.appId || APP_ID,
      clerkUserId: campaign.createdByUserId,
      targetOutcome: campaign.targetOutcome,
      valueForTarget: campaign.valueForTarget,
      searchParams,
      keySource: campaign.keySource,
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
router.post("/end-run", requireApiKey, validateBody(EndRunBody), async (req, res) => {
  try {
    const { campaignId, clerkOrgId, success, leadFound } = req.body;
    console.log(`[End Run] Received request: campaignId=${campaignId}, clerkOrgId=${clerkOrgId}, success=${success}, leadFound=${leadFound}`);

    const status = success === true ? "completed" : "failed";

    // Find and update running runs for this campaign
    try {
      const { runs } = await listRuns({
        clerkOrgId,
        appId: APP_ID,
        serviceName: "campaign-service",
        taskName: campaignId,
      });

      const runningRuns = runs.filter((r) => r.status === "running");
      if (runningRuns.length > 0) {
        for (const run of runningRuns) {
          console.log(`[End Run] Updating run ${run.id} to status=${status}`);
          await updateRun(run.id, status);
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
        const org = await db.query.orgs.findFirst({
          where: eq(orgs.clerkOrgId, clerkOrgId),
        });
        if (org) {
          await db.update(campaigns)
            .set({ status: "stopped" })
            .where(and(eq(campaigns.id, campaignId), eq(campaigns.orgId, org.id)));
          console.log(`[End Run] No leads found — auto-stopped campaign ${campaignId}`);
        }
      } catch (err) {
        console.error(`[End Run] Failed to auto-stop campaign:`, err);
      }
      return;
    }

    // Re-trigger if campaign is still ongoing
    try {
      const org = await db.query.orgs.findFirst({
        where: eq(orgs.clerkOrgId, clerkOrgId),
      });
      if (!org) {
        console.warn(`[End Run] Org not found for re-trigger: ${clerkOrgId}`);
        return;
      }

      const campaign = await db.query.campaigns.findFirst({
        where: and(eq(campaigns.id, campaignId), eq(campaigns.orgId, org.id)),
      });
      console.log(`[End Run] Campaign status for re-trigger: ${campaign?.status || "NOT FOUND"}, type=${campaign?.type || "N/A"}`);
      if (campaign?.status !== "ongoing") {
        console.log(`[End Run] Campaign ${campaignId} is not ongoing — skipping re-trigger`);
        return;
      }

      // Fire-and-forget: gate-check in the next workflow execution will validate limits
      console.log(`[End Run] Re-triggering workflow type=${campaign.type} for campaign ${campaignId}`);
      executeCampaignWorkflow(campaign.type, { campaignId, clerkOrgId }).catch((err) => {
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
