import { Router } from "express";
import { eq, and } from "drizzle-orm";
import { db } from "../db/index.js";
import { campaigns, orgs } from "../db/schema.js";
import { serviceAuth, requireApiKey, AuthenticatedRequest } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import { listRuns, getRun, createRun, updateRun } from "@mcpfactory/runs-client";
import { RunStatusUpdate } from "../schemas.js";

const router = Router();

// === Scheduler routes (API-key authed, must be before :runId routes) ===

/**
 * GET /campaigns/:campaignId/runs/list - Get campaign runs (for scheduler, no org scoping)
 */
router.get("/campaigns/:campaignId/runs/list", requireApiKey, async (req, res) => {
  try {
    const { campaignId } = req.params;

    const campaign = await db.query.campaigns.findFirst({
      where: eq(campaigns.id, campaignId),
      columns: { orgId: true, brandId: true, appId: true },
    });
    if (!campaign) {
      return res.status(404).json({ error: "Campaign not found" });
    }

    const org = await db.query.orgs.findFirst({
      where: eq(orgs.id, campaign.orgId),
      columns: { clerkOrgId: true },
    });
    if (!org) {
      return res.status(404).json({ error: "Organization not found" });
    }

    const result = await listRuns({
      clerkOrgId: org.clerkOrgId,
      appId: "mcpfactory",
      serviceName: "campaign-service",
      taskName: campaignId,
    });

    res.json({ runs: result.runs });
  } catch (error) {
    console.error("[Campaign Service] Get campaign runs error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// === User routes (Clerk JWT authed) ===

/**
 * GET /campaigns/:campaignId/runs - List all runs for a campaign
 */
router.get("/campaigns/:campaignId/runs", requireApiKey, serviceAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { campaignId } = req.params;

    const campaign = await db.query.campaigns.findFirst({
      where: and(
        eq(campaigns.id, campaignId),
        eq(campaigns.orgId, req.orgId!)
      ),
    });

    if (!campaign) {
      return res.status(404).json({ error: "Campaign not found" });
    }

    const result = await listRuns({
      clerkOrgId: req.clerkOrgId!,
      appId: "mcpfactory",
      serviceName: "campaign-service",
      taskName: campaignId,
    });

    res.json({ runs: result.runs });
  } catch (error) {
    console.error("[Campaign Service] List runs error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /campaigns/:campaignId/runs/:runId - Get a specific run
 */
router.get("/campaigns/:campaignId/runs/:runId", requireApiKey, serviceAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { campaignId, runId } = req.params;

    const campaign = await db.query.campaigns.findFirst({
      where: and(
        eq(campaigns.id, campaignId),
        eq(campaigns.orgId, req.orgId!)
      ),
    });

    if (!campaign) {
      return res.status(404).json({ error: "Campaign not found" });
    }

    const run = await getRun(runId);

    res.json({ run });
  } catch (error) {
    console.error("[Campaign Service] Get run error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// === Service routes (API-key authed) ===

/**
 * POST /campaigns/:campaignId/runs - Create a new run
 */
router.post("/campaigns/:campaignId/runs", requireApiKey, async (req, res) => {
  try {
    const { campaignId } = req.params;

    const campaign = await db.query.campaigns.findFirst({
      where: eq(campaigns.id, campaignId),
    });

    if (!campaign) {
      return res.status(404).json({ error: "Campaign not found" });
    }

    const org = await db.query.orgs.findFirst({
      where: eq(orgs.id, campaign.orgId),
    });

    if (!org) {
      return res.status(500).json({ error: "Organization not found" });
    }

    const run = await createRun({
      clerkOrgId: org.clerkOrgId,
      appId: "mcpfactory",
      serviceName: "campaign-service",
      taskName: campaignId,
      brandId: campaign.brandId ?? undefined,
      campaignId,
    });

    res.status(201).json({ run });
  } catch (error) {
    console.error("[Campaign Service] Create run error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * PATCH /runs/:runId - Update run status
 */
router.patch("/runs/:runId", requireApiKey, validateBody(RunStatusUpdate), async (req, res) => {
  try {
    const { runId } = req.params;
    const { status } = req.body;

    const run = await updateRun(runId, status);

    res.json({ run });
  } catch (error) {
    console.error("[Campaign Service] Update run error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
