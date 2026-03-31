import { Router } from "express";
import { eq, and, desc, inArray, sql } from "drizzle-orm";
import { arrayContains } from "drizzle-orm/sql/expressions/conditions";
import { db } from "../db/index.js";
import { campaigns } from "../db/schema.js";
import { serviceAuth, requireApiKey, AuthenticatedRequest } from "../middleware/auth.js";
import { validateBody, validateQuery } from "../middleware/validate.js";
import { normalizeUrl, extractDomain } from "../lib/domain.js";
import { CreateCampaignBody, UpdateCampaignBody, CampaignsFilterQuery } from "../schemas.js";
import { executeCampaignWorkflow, validateWorkflowInputs } from "../lib/workflows.js";
import {
  resolveLatestWorkflowSlug,
  resolveLatestFeatureSlug,
  resolveWorkflowDynastySlugs,
  resolveFeatureDynastySlugs,
} from "../lib/dynasty-client.js";

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
        workflowSlug: campaigns.workflowSlug,
        workflowDynastySlug: campaigns.workflowDynastySlug,
        featureDynastySlug: campaigns.featureDynastySlug,
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
 *
 * Supports filtering by brandId, workflowSlug, featureSlug,
 * workflowDynastySlug, and featureDynastySlug.
 */
router.get("/campaigns", requireApiKey, serviceAuth, validateQuery(CampaignsFilterQuery), async (req: AuthenticatedRequest, res) => {
  try {
    const {
      brandId, workflowSlug, featureSlug,
      workflowDynastySlug, featureDynastySlug,
    } = req.query as {
      brandId?: string;
      workflowSlug?: string;
      featureSlug?: string;
      workflowDynastySlug?: string;
      featureDynastySlug?: string;
    };

    const conditions = [eq(campaigns.orgId, req.orgId!)];

    if (brandId) conditions.push(arrayContains(campaigns.brandIds, [brandId]));

    // Dynasty slugs resolve to all versioned slugs and take priority
    if (workflowDynastySlug) {
      const resolved = await resolveWorkflowDynastySlugs(workflowDynastySlug);
      if (resolved.length === 0) {
        return res.json({ campaigns: [] });
      }
      conditions.push(inArray(campaigns.workflowSlug, resolved));
    } else if (workflowSlug) {
      conditions.push(eq(campaigns.workflowSlug, workflowSlug));
    }

    if (featureDynastySlug) {
      const resolved = await resolveFeatureDynastySlugs(featureDynastySlug);
      if (resolved.length === 0) {
        return res.json({ campaigns: [] });
      }
      conditions.push(inArray(campaigns.featureSlug, resolved));
    } else if (featureSlug) {
      conditions.push(eq(campaigns.featureSlug, featureSlug));
    }

    const results = await db
      .select()
      .from(campaigns)
      .where(and(...conditions))
      .orderBy(desc(campaigns.createdAt));

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
      workflowSlug: bodyWorkflowSlug,
      workflowDynastySlug,
      brandUrl,
      brandIds,
      featureSlug: bodyFeatureSlug,
      featureDynastySlug,
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

    // Resolve workflow slug: explicit versioned slug takes priority, otherwise resolve from dynasty
    let resolvedWorkflowSlug: string;
    if (bodyWorkflowSlug) {
      resolvedWorkflowSlug = bodyWorkflowSlug;
    } else {
      console.log(`[Campaign Service] Resolving workflowDynastySlug=${workflowDynastySlug} to latest versioned slug`);
      resolvedWorkflowSlug = await resolveLatestWorkflowSlug(workflowDynastySlug!);
      console.log(`[Campaign Service] Resolved to workflowSlug=${resolvedWorkflowSlug}`);
    }

    // featureSlug comes exclusively from x-feature-slug header
    const resolvedFeatureSlug = req.featureSlug || "";

    // Validate all required workflow fields BEFORE creating the campaign
    const brandIdCsv = (brandIds as string[]).join(",");
    const preCheckInputs = {
      campaignId: "pending",  // will be assigned after insert
      orgId: req.orgId!,
      brandId: brandIdCsv || "",
      userId: req.userId || "",
      runId: req.runId || "",
      featureSlug: resolvedFeatureSlug,
    };
    const missing = validateWorkflowInputs(preCheckInputs);
    // campaignId is always "pending" here — exclude it from the check
    const actualMissing = missing.filter((f) => f !== "campaignId");
    if (actualMissing.length > 0) {
      const headerMap: Record<string, string> = {
        userId: "x-user-id", runId: "x-run-id", brandId: "x-brand-id",
        featureSlug: "x-feature-slug", orgId: "x-org-id",
      };
      const missingHeaders = actualMissing.map((f) => headerMap[f] || f);
      return res.status(400).json({
        error: `Cannot create campaign — missing required headers for workflow execution: ${missingHeaders.join(", ")}`,
      });
    }

    const [campaign] = await db
      .insert(campaigns)
      .values({
        orgId: req.orgId!,
        createdByUserId: req.userId ?? null,
        name,
        workflowSlug: resolvedWorkflowSlug,
        workflowDynastySlug: workflowDynastySlug ?? null,
        featureDynastySlug: featureDynastySlug ?? null,
        brandUrl: normalizedBrandUrl,
        brandIds,
        featureSlug: resolvedFeatureSlug,
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
    const workflowInputs = {
      campaignId: campaign.id,
      orgId: req.orgId!,
      brandId: (campaign.brandIds ?? []).join(","),
      userId: req.userId!,
      runId: req.runId!,
      featureSlug: campaign.featureSlug!,
    };
    console.log(`[Campaign Service] Launching workflow run from CAMPAIGN CREATION — workflow=${campaign.workflowSlug}, campaignId=${campaign.id}`);
    executeCampaignWorkflow(campaign.workflowSlug, workflowInputs).catch((err) => {
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

    // Validate required workflow fields BEFORE activating
    if (req.body.status === "activate") {
      const preActivateInputs = {
        campaignId: id,
        orgId: req.orgId!,
        brandId: (existing.brandIds ?? []).join(",") || "",
        userId: req.userId || "",
        runId: req.runId || "",
        featureSlug: req.featureSlug || "",
      };
      const missingActivate = validateWorkflowInputs(preActivateInputs);
      if (missingActivate.length > 0) {
        const headerMap: Record<string, string> = {
          userId: "x-user-id", runId: "x-run-id", brandId: "x-brand-id",
          featureSlug: "x-feature-slug", orgId: "x-org-id", campaignId: "campaignId",
        };
        const missingHeaders = missingActivate.map((f) => headerMap[f] || f);
        return res.status(400).json({
          error: `Cannot activate campaign — missing required headers for workflow execution: ${missingHeaders.join(", ")}`,
        });
      }
    }

    const statusMap: Record<string, string> = { activate: "ongoing", stop: "stopped" };
    const updates = { ...req.body, updatedAt: new Date() };
    if (updates.status) {
      updates.status = statusMap[updates.status] ?? updates.status;
    }
    // If featureDynastySlug is provided on update, resolve to latest versioned slug
    if (updates.featureDynastySlug && !updates.featureSlug) {
      console.log(`[Campaign Service] Resolving featureDynastySlug=${updates.featureDynastySlug} on PATCH`);
      updates.featureSlug = await resolveLatestFeatureSlug(updates.featureDynastySlug);
      console.log(`[Campaign Service] Resolved to featureSlug=${updates.featureSlug}`);
    }

    const [updated] = await db
      .update(campaigns)
      .set(updates)
      .where(eq(campaigns.id, id))
      .returning();

    // Trigger workflow on activation
    if (req.body.status === "activate") {
      const activateInputs = {
        campaignId: updated.id,
        orgId: req.orgId!,
        brandId: (updated.brandIds ?? []).join(","),
        userId: req.userId!,
        runId: req.runId!,
        featureSlug: req.featureSlug!,
      };
      console.log(`[Campaign Service] Launching workflow run from CAMPAIGN ACTIVATION — workflow=${updated.workflowSlug}, campaignId=${updated.id}`);
      executeCampaignWorkflow(updated.workflowSlug, activateInputs).catch((err) => {
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
