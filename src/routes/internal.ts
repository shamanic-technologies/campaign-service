import { Router } from "express";
import { eq, and } from "drizzle-orm";
import { db } from "../db/index.js";
import { campaigns, orgs } from "../db/schema.js";
import { requireApiKey } from "../middleware/auth.js";
import { createRun, updateRun } from "@mcpfactory/runs-client";
import { runGateChecks } from "../lib/gate-check.js";
import { executeCampaignWorkflow } from "../lib/workflows.js";
import { extractDomain } from "../lib/domain.js";

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
 * POST /internal/start-run
 *
 * Performs gate checks, creates a run, and returns campaign data
 * for downstream DAG nodes (brand-profile, fetch-lead, etc.).
 *
 * Brand profile and lead fetching are handled by separate DAG nodes,
 * NOT by this endpoint.
 *
 * Returns:
 *   200 — run started, campaign data returned
 *   400 — bad request
 *   404 — campaign/org not found
 *   409 — gate check blocked
 *   500 — internal error
 */
router.post("/internal/start-run", requireApiKey, async (req, res) => {
  try {
    const { campaignId, clerkOrgId } = req.body;
    console.log(`[Start Run] Received request: campaignId=${campaignId}, clerkOrgId=${clerkOrgId}`);
    if (!campaignId || !clerkOrgId) {
      console.warn("[Start Run] Missing required fields");
      return res.status(400).json({ error: "campaignId and clerkOrgId are required" });
    }

    // Look up org + campaign
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

    // Gate checks
    console.log(`[Start Run] Running gate checks for campaign ${campaignId}...`);
    const gateResult = await runGateChecks({
      campaignId,
      clerkOrgId,
      brandId: campaign.brandId,
      status: campaign.status,
      maxBudgetDailyUsd: campaign.maxBudgetDailyUsd,
      maxBudgetWeeklyUsd: campaign.maxBudgetWeeklyUsd,
      maxBudgetMonthlyUsd: campaign.maxBudgetMonthlyUsd,
      maxBudgetTotalUsd: campaign.maxBudgetTotalUsd,
      maxLeads: campaign.maxLeads,
    });
    if (!gateResult.allowed) {
      console.warn(`[Start Run] Gate check BLOCKED: reason=${gateResult.reason}, autoStopped=${gateResult.autoStopped}`);
      return res.status(409).json({
        error: "Gate check failed",
        reason: gateResult.reason,
        autoStopped: gateResult.autoStopped || false,
      });
    }
    console.log(`[Start Run] Gate checks PASSED for campaign ${campaignId}`);

    // Register prompt template (best-effort, cached per org)
    console.log(`[Start Run] Ensuring prompt registered for org ${clerkOrgId} (cached=${promptRegisteredOrgs.has(clerkOrgId)})`);
    await ensurePromptRegistered(clerkOrgId);

    // Create run in runs-service
    console.log(`[Start Run] Creating run in runs-service for campaign ${campaignId}...`);
    const run = await createRun({
      clerkOrgId,
      appId: APP_ID,
      serviceName: "campaign-service",
      taskName: campaignId,
      campaignId,
      brandId: campaign.brandId,
      clerkUserId: campaign.createdByUserId || undefined,
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
    });
  } catch (error) {
    console.error("[Start Run] Unhandled error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * POST /internal/end-run
 *
 * Marks a run as completed or failed, then re-triggers the workflow
 * if the campaign is still ongoing.
 */
router.post("/internal/end-run", requireApiKey, async (req, res) => {
  try {
    const { runId, campaignId, clerkOrgId, success } = req.body;
    console.log(`[End Run] Received request: runId=${runId}, campaignId=${campaignId}, clerkOrgId=${clerkOrgId}, success=${success}`);
    if (!runId || !campaignId || !clerkOrgId) {
      console.warn("[End Run] Missing required fields");
      return res.status(400).json({ error: "runId, campaignId, and clerkOrgId are required" });
    }

    // Determine run status:
    // success === true → completed; anything else → failed
    const status = success === true ? "completed" : "failed";
    console.log(`[End Run] Updating run ${runId} to status=${status}`);
    await updateRun(runId, status);

    // Respond immediately, then re-trigger asynchronously
    res.json({ status });

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

      // Fire-and-forget: start-run in the next workflow execution will do gate checks
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
