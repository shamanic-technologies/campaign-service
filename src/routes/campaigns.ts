import { Router } from "express";
import { eq, and, desc } from "drizzle-orm";
import { db } from "../db/index.js";
import { campaigns } from "../db/schema.js";
import { serviceAuth, requireApiKey, AuthenticatedRequest } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import { normalizeUrl, extractDomain } from "../lib/domain.js";
import { CreateCampaignBody, UpdateCampaignBody } from "../schemas.js";
import { executeCampaignWorkflow } from "../lib/workflows.js";

const router = Router();

// === Scheduler routes (API-key authed, must be before :id routes) ===

/**
 * GET /campaigns/list - List all campaigns across all orgs (for scheduler)
 */
router.get("/campaigns/list", requireApiKey, async (_req, res) => {
  try {
    const allCampaigns = await db
      .select({
        id: campaigns.id,
        orgId: campaigns.orgId,
        name: campaigns.name,
        workflowName: campaigns.workflowName,
        status: campaigns.status,
        maxBudgetDailyUsd: campaigns.maxBudgetDailyUsd,
        maxBudgetWeeklyUsd: campaigns.maxBudgetWeeklyUsd,
        maxBudgetMonthlyUsd: campaigns.maxBudgetMonthlyUsd,
        maxBudgetTotalUsd: campaigns.maxBudgetTotalUsd,
        maxLeads: campaigns.maxLeads,
        createdAt: campaigns.createdAt,
        brandUrl: campaigns.brandUrl,
        featureSlug: campaigns.featureSlug,
      })
      .from(campaigns)
      .orderBy(campaigns.createdAt);

    const enrichedCampaigns = allCampaigns.map(c => ({
      ...c,
      brandDomain: c.brandUrl ? extractDomain(c.brandUrl) : null,
      brandName: c.brandUrl ? extractDomain(c.brandUrl) : null,
    }));

    res.json({ campaigns: enrichedCampaigns });
  } catch (error) {
    console.error("[Campaign Service] List all campaigns error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// === User routes (service-auth) ===

/**
 * GET /campaigns - List all campaigns for org
 */
router.get("/campaigns", requireApiKey, serviceAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { brandId } = req.query;

    let results = await db
      .select()
      .from(campaigns)
      .where(eq(campaigns.orgId, req.orgId!))
      .orderBy(desc(campaigns.createdAt));

    if (brandId && typeof brandId === "string") {
      results = results.filter(c => c.brandId === brandId);
    }

    res.json({ campaigns: results });
  } catch (error) {
    console.error("[Campaign Service] List campaigns error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /campaigns/:id - Get a specific campaign
 */
router.get("/campaigns/:id", requireApiKey, serviceAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { id } = req.params;

    const campaign = await db.query.campaigns.findFirst({
      where: and(
        eq(campaigns.id, id),
        eq(campaigns.orgId, req.orgId!)
      ),
    });

    if (!campaign) {
      return res.status(404).json({ error: "Campaign not found" });
    }

    res.json({ campaign });
  } catch (error) {
    console.error("[Campaign Service] Get campaign error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * POST /campaigns - Create a new campaign
 */
router.post("/campaigns", requireApiKey, serviceAuth, validateBody(CreateCampaignBody), async (req: AuthenticatedRequest, res) => {
  try {
    const {
      name,
      workflowName,
      brandUrl,
      brandId,
      featureSlug,
      featureInputs,
      maxBudgetDailyUsd,
      maxBudgetWeeklyUsd,
      maxBudgetMonthlyUsd,
      maxBudgetTotalUsd,
      maxLeads,
      startDate,
      endDate,
      notifyFrequency,
      notifyChannel,
      notifyDestination,
    } = req.body;

    const normalizedBrandUrl = normalizeUrl(brandUrl);
    console.log(`[Campaign Service] Creating campaign with brandUrl: ${normalizedBrandUrl}`);

    const [campaign] = await db
      .insert(campaigns)
      .values({
        orgId: req.orgId!,
        createdByUserId: req.userId ?? null,
        name,
        workflowName,
        brandUrl: normalizedBrandUrl,
        brandId,
        featureSlug,
        featureInputs,
        maxBudgetDailyUsd,
        maxBudgetWeeklyUsd,
        maxBudgetMonthlyUsd,
        maxBudgetTotalUsd,
        maxLeads,
        startDate,
        endDate,
        notifyFrequency,
        notifyChannel,
        notifyDestination,
        status: "ongoing",
      })
      .returning();

    // Trigger first workflow execution (fire-and-forget)
    console.log(`[Campaign Service] Launching workflow run from CAMPAIGN CREATION — workflow=${campaign.workflowName}, campaignId=${campaign.id}`);
    executeCampaignWorkflow(campaign.workflowName, {
      campaignId: campaign.id,
      orgId: req.orgId!,
      brandId: campaign.brandId!,
      userId: req.userId,
      runId: req.runId,
      featureSlug: campaign.featureSlug || undefined,
    }).catch((err) => {
      console.error(`[Campaign Service] Failed to trigger initial workflow for campaign ${campaign.id}:`, err);
    });

    res.status(201).json({ campaign });
  } catch (error: any) {
    if (error?.code === "23505" && (error?.constraint === "uniq_campaigns_org_name" || error?.constraint_name === "uniq_campaigns_org_name")) {
      return res.status(409).json({ error: "A campaign with this name already exists in your organization" });
    }
    console.error("[Campaign Service] Create campaign error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * PATCH /campaigns/:id - Update a campaign (including status: "active" | "stopped")
 */
router.patch("/campaigns/:id", requireApiKey, serviceAuth, validateBody(UpdateCampaignBody), async (req: AuthenticatedRequest, res) => {
  try {
    const { id } = req.params;

    const existing = await db.query.campaigns.findFirst({
      where: and(
        eq(campaigns.id, id),
        eq(campaigns.orgId, req.orgId!)
      ),
    });

    if (!existing) {
      return res.status(404).json({ error: "Campaign not found" });
    }

    const statusMap: Record<string, string> = { activate: "ongoing", stop: "stopped" };
    const updates = { ...req.body, updatedAt: new Date() };
    if (updates.status) {
      updates.status = statusMap[updates.status] ?? updates.status;
    }

    const [updated] = await db
      .update(campaigns)
      .set(updates)
      .where(eq(campaigns.id, id))
      .returning();

    // Trigger workflow on activation
    if (req.body.status === "activate") {
      if (!updated.brandId) {
        return res.status(400).json({ error: "Cannot activate campaign without brandId" });
      }
      console.log(`[Campaign Service] Launching workflow run from CAMPAIGN ACTIVATION — workflow=${updated.workflowName}, campaignId=${updated.id}`);
      executeCampaignWorkflow(updated.workflowName, {
        campaignId: updated.id,
        orgId: req.orgId!,
        brandId: updated.brandId,
        userId: req.userId,
        runId: req.runId,
        featureSlug: updated.featureSlug || undefined,
      }).catch((err) => {
        console.error(`[Campaign Service] Failed to trigger workflow for campaign ${id}:`, err);
      });
    }

    res.json({ campaign: updated });
  } catch (error: any) {
    if (error?.code === "23505" && (error?.constraint === "uniq_campaigns_org_name" || error?.constraint_name === "uniq_campaigns_org_name")) {
      return res.status(409).json({ error: "A campaign with this name already exists in your organization" });
    }
    console.error("[Campaign Service] Update campaign error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * DELETE /campaigns/:id - Delete a campaign
 */
router.delete("/campaigns/:id", requireApiKey, serviceAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { id } = req.params;

    const result = await db
      .delete(campaigns)
      .where(and(
        eq(campaigns.id, id),
        eq(campaigns.orgId, req.orgId!)
      ))
      .returning();

    if (result.length === 0) {
      return res.status(404).json({ error: "Campaign not found" });
    }

    res.json({ message: "Campaign deleted successfully" });
  } catch (error) {
    console.error("[Campaign Service] Delete campaign error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
