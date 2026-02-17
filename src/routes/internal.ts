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
 * Performs gate checks, creates a run, fetches campaign + brand profile + next lead.
 * Returns all data needed for the email pipeline, or an error status.
 *
 * Returns:
 *   200 — run started, lead found
 *   204 — no lead found (run created then immediately failed)
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

    // Fetch brand sales profile (best-effort)
    const brandDomain = extractDomain(campaign.brandUrl);
    let clientData: Record<string, unknown> = {
      companyName: brandDomain,
      brandUrl: campaign.brandUrl,
    };

    try {
      const brandUrl = process.env.BRAND_SERVICE_URL;
      const brandApiKey = process.env.BRAND_SERVICE_API_KEY;
      if (brandUrl && brandApiKey) {
        console.log(`[Start Run] Fetching brand profile from ${brandUrl}/sales-profile...`);
        const profileRes = await fetch(`${brandUrl}/sales-profile`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": brandApiKey,
          },
          body: JSON.stringify({
            appId: campaign.appId || APP_ID,
            clerkOrgId,
            url: campaign.brandUrl,
            clerkUserId: campaign.createdByUserId || "system",
            keyType: "byok",
            parentRunId: run.id,
          }),
        });
        if (profileRes.ok) {
          const profile = await profileRes.json() as Record<string, unknown>;
          console.log(`[Start Run] Brand profile OK: companyName=${profile.companyName}`);
          clientData = {
            companyName: (profile.companyName as string) || brandDomain,
            brandUrl: campaign.brandUrl,
            companyOverview: profile.companyOverview,
            valueProposition: profile.valueProposition,
            targetAudience: profile.targetAudience,
            customerPainPoints: Array.isArray(profile.customerPainPoints) && profile.customerPainPoints.length ? profile.customerPainPoints : undefined,
            keyFeatures: Array.isArray(profile.keyFeatures) && profile.keyFeatures.length ? profile.keyFeatures : undefined,
            productDifferentiators: Array.isArray(profile.productDifferentiators) && profile.productDifferentiators.length ? profile.productDifferentiators : undefined,
            competitors: Array.isArray(profile.competitors) && profile.competitors.length ? profile.competitors : undefined,
            socialProof: profile.socialProof,
            callToAction: profile.callToAction,
            additionalContext: profile.additionalContext,
          };
        } else {
          console.warn(`[Start Run] Brand profile failed (${profileRes.status}), using fallback: companyName=${brandDomain}`);
        }
      } else {
        console.warn("[Start Run] BRAND_SERVICE_URL or BRAND_SERVICE_API_KEY not set, using fallback clientData");
      }
    } catch (err) {
      console.warn("[Start Run] Brand profile fetch failed (best-effort):", err);
    }

    // Fetch next lead from lead-service (non-idempotent, no retry)
    const leadServiceUrl = process.env.LEAD_SERVICE_URL;
    const leadApiKey = process.env.LEAD_SERVICE_API_KEY;
    if (!leadServiceUrl || !leadApiKey) {
      console.error("[Start Run] LEAD_SERVICE_URL or LEAD_SERVICE_API_KEY not set — failing run");
      await updateRun(run.id, "failed");
      return res.status(500).json({ error: "Lead service not configured" });
    }

    let lead: { externalId: string; data: Record<string, unknown> } | null = null;
    try {
      console.log(`[Start Run] Fetching next lead from ${leadServiceUrl}/buffer/next for campaign ${campaignId}...`);
      const leadRes = await fetch(`${leadServiceUrl}/buffer/next`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": leadApiKey,
          "x-app-id": APP_ID,
          "x-org-id": clerkOrgId,
        },
        body: JSON.stringify({
          campaignId,
          brandId: campaign.brandId,
          parentRunId: run.id,
        }),
      });

      if (!leadRes.ok) {
        throw new Error(`Lead service returned ${leadRes.status}`);
      }

      const leadData = await leadRes.json() as { found?: boolean; lead?: { externalId: string; data: Record<string, unknown> } };
      console.log(`[Start Run] Lead response: found=${leadData.found}, hasLead=${!!leadData.lead}, email=${leadData.lead?.data?.email || "none"}`);
      if (!leadData.found || !leadData.lead || !leadData.lead.data?.email) {
        // No lead found or no email → fail run immediately
        console.warn(`[Start Run] No lead available — failing run ${run.id} and returning 204`);
        await updateRun(run.id, "failed");
        return res.status(204).send();
      }
      lead = leadData.lead;
    } catch (err) {
      console.error("[Start Run] Lead fetch failed:", err);
      await updateRun(run.id, "failed");
      return res.status(204).send();
    }

    console.log(`[Start Run] SUCCESS — runId=${run.id}, leadEmail=${lead.data.email}, leadExternalId=${lead.externalId}`);

    // Return all data for the downstream DAG nodes
    res.json({
      runId: run.id,
      campaignId,
      clerkOrgId,
      brandId: campaign.brandId,
      appId: campaign.appId || APP_ID,
      clerkUserId: campaign.createdByUserId,
      targetOutcome: campaign.targetOutcome,
      valueForTarget: campaign.valueForTarget,
      lead: {
        externalId: lead.externalId,
        data: lead.data,
      },
      clientData,
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
