import { Router } from "express";
import { eq, and, desc, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { campaigns, orgs } from "../db/schema.js";
import { serviceAuth, requireApiKey, AuthenticatedRequest } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import { normalizeUrl, extractDomain } from "../lib/domain.js";
import { listRuns, getRunsBatch, type Run, type RunWithCosts } from "@mcpfactory/runs-client";
import { CreateCampaignBody, UpdateCampaignBody, StatsFilterBody, BatchBudgetUsageBody } from "../schemas.js";
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
        type: campaigns.type,
        status: campaigns.status,
        targetAudience: campaigns.targetAudience,
        targetOutcome: campaigns.targetOutcome,
        valueForTarget: campaigns.valueForTarget,
        maxBudgetDailyUsd: campaigns.maxBudgetDailyUsd,
        maxBudgetWeeklyUsd: campaigns.maxBudgetWeeklyUsd,
        maxBudgetMonthlyUsd: campaigns.maxBudgetMonthlyUsd,
        maxBudgetTotalUsd: campaigns.maxBudgetTotalUsd,
        maxLeads: campaigns.maxLeads,
        createdAt: campaigns.createdAt,
        clerkOrgId: orgs.clerkOrgId,
        brandUrl: campaigns.brandUrl,
      })
      .from(campaigns)
      .innerJoin(orgs, eq(campaigns.orgId, orgs.id))
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

/**
 * POST /campaigns/batch-budget-usage - Get cost and run data for multiple campaigns
 */
router.post("/campaigns/batch-budget-usage", requireApiKey, validateBody(BatchBudgetUsageBody), async (req, res) => {
  try {
    const { campaignIds } = req.body;

    const campaignRows = await db
      .select({
        id: campaigns.id,
        appId: campaigns.appId,
        status: campaigns.status,
        maxLeads: campaigns.maxLeads,
        maxBudgetTotalUsd: campaigns.maxBudgetTotalUsd,
        clerkOrgId: orgs.clerkOrgId,
      })
      .from(campaigns)
      .innerJoin(orgs, eq(campaigns.orgId, orgs.id))
      .where(inArray(campaigns.id, campaignIds));

    const campaignMap = new Map(
      campaignRows.map(r => [r.id, r])
    );

    const results: Record<string, unknown> = {};

    await Promise.all(
      campaignIds.map(async (campaignId: string) => {
        const row = campaignMap.get(campaignId);
        if (!row) {
          results[campaignId] = { error: "Campaign not found" };
          return;
        }

        try {
          const runResult = await listRuns({
            clerkOrgId: row.clerkOrgId,
            appId: row.appId || "",
            serviceName: "campaign-service",
            taskName: campaignId,
          });
          const runs = runResult.runs;
          const runIds = runs.map((r: Run) => r.id);

          const runsWithCosts = runIds.length > 0
            ? await getRunsBatch(runIds).catch(() => new Map() as Map<string, RunWithCosts>)
            : new Map() as Map<string, RunWithCosts>;

          let totalCostInUsdCents = 0;
          for (const run of runsWithCosts.values()) {
            totalCostInUsdCents += parseFloat(run.totalCostInUsdCents) || 0;
          }

          results[campaignId] = {
            status: row.status,
            maxLeads: row.maxLeads,
            maxBudgetTotalUsd: row.maxBudgetTotalUsd,
            runs: {
              total: runs.length,
              completed: runs.filter((r: Run) => r.status === "completed").length,
              failed: runs.filter((r: Run) => r.status === "failed").length,
              running: runs.filter((r: Run) => r.status === "running").length,
            },
            totalCostInUsdCents: totalCostInUsdCents > 0 ? String(totalCostInUsdCents) : null,
          };
        } catch (err) {
          console.warn(`[Campaign Service] Batch budget usage failed for campaign ${campaignId}:`, err);
          results[campaignId] = { error: "Failed to fetch stats" };
        }
      })
    );

    res.json({ results });
  } catch (error) {
    console.error("[Campaign Service] Batch budget usage error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * POST /campaigns/stats - Campaign stats from own DB
 */
router.post("/campaigns/stats", requireApiKey, validateBody(StatsFilterBody), async (req, res) => {
  try {
    const { clerkOrgId, appId, brandId, campaignId } = req.body;

    const conditions = [];
    if (clerkOrgId) {
      const org = await db.query.orgs.findFirst({
        where: eq(orgs.clerkOrgId, clerkOrgId),
        columns: { id: true },
      });
      if (org) conditions.push(eq(campaigns.orgId, org.id));
      else return res.json({ stats: { totalCampaigns: 0, byStatus: {}, budgetTotalUsd: null, maxLeadsTotal: null } });
    }
    if (appId) conditions.push(eq(campaigns.appId, appId));
    if (brandId) conditions.push(eq(campaigns.brandId, brandId));
    if (campaignId) conditions.push(eq(campaigns.id, campaignId));

    const where = conditions.length === 1 ? conditions[0] : and(...conditions);

    const matching = await db
      .select()
      .from(campaigns)
      .where(where);

    const byStatus: Record<string, number> = {};
    let budgetTotalUsd = 0;
    let maxLeadsTotal = 0;

    for (const c of matching) {
      byStatus[c.status] = (byStatus[c.status] || 0) + 1;
      if (c.maxBudgetTotalUsd) budgetTotalUsd += parseFloat(c.maxBudgetTotalUsd);
      if (c.maxLeads) maxLeadsTotal += c.maxLeads;
    }

    res.json({
      stats: {
        totalCampaigns: matching.length,
        byStatus,
        budgetTotalUsd: budgetTotalUsd > 0 ? budgetTotalUsd : null,
        maxLeadsTotal: maxLeadsTotal > 0 ? maxLeadsTotal : null,
      },
    });
  } catch (error) {
    console.error("[Campaign Service] Stats error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// === User routes (Clerk JWT authed) ===

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
      type,
      parentRunId,
      brandUrl,
      brandId,
      appId,
      targetAudience,
      targetOutcome,
      valueForTarget,
      urgency,
      scarcity,
      riskReversal,
      socialProof,
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
        type,
        parentRunId,
        appId,
        brandUrl: normalizedBrandUrl,
        brandId,
        targetAudience,
        targetOutcome,
        valueForTarget,
        urgency,
        scarcity,
        riskReversal,
        socialProof,
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
    console.log(`[Campaign Service] Campaign created: campaignId=${campaign.id}, type=${campaign.type}, triggering first workflow execution`);
    executeCampaignWorkflow(campaign.type, {
      campaignId: campaign.id,
      clerkOrgId: req.clerkOrgId!,
      appId: campaign.appId || "",
    }).catch((err) => {
      console.error(`[Campaign Service] Failed to trigger initial workflow for campaign ${campaign.id}:`, err);
    });

    res.status(201).json({ campaign });
  } catch (error) {
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

    // Activating requires a parentRunId (api-service creates a parent run first)
    if (req.body.status === "activate" && !req.body.parentRunId) {
      return res.status(400).json({ error: "parentRunId is required when activating a campaign" });
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

    // Trigger workflow on activation, routed by campaign type
    if (req.body.status === "activate") {
      console.log(`[Campaign Service] Activation triggered: campaignId=${updated.id}, type=${updated.type}, clerkOrgId=${req.clerkOrgId}`);
      executeCampaignWorkflow(updated.type, {
        campaignId: updated.id,
        clerkOrgId: req.clerkOrgId!,
        appId: updated.appId || "",
      }).catch((err) => {
        console.error(`[Campaign Service] Failed to trigger workflow for campaign ${id}:`, err);
      });
    }

    res.json({ campaign: updated });
  } catch (error) {
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
