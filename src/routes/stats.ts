import { Router } from "express";
import { eq, and, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { campaigns } from "../db/schema.js";
import { requireApiKey } from "../middleware/auth.js";
import { validateBody, validateQuery } from "../middleware/validate.js";
import { getStatsBudget } from "@mcpfactory/runs-client";
import { BatchBudgetUsageBody, StatsFilterQuery } from "../schemas.js";

const router = Router();

/**
 * POST /stats/batch-budget - Get cost and run data for multiple campaigns
 *
 * New canonical path for POST /campaigns/batch-budget-usage.
 */
router.post("/stats/batch-budget", requireApiKey, validateBody(BatchBudgetUsageBody), async (req, res) => {
  try {
    const { campaignIds } = req.body;

    const campaignRows = await db
      .select({
        id: campaigns.id,
        orgId: campaigns.orgId,
        status: campaigns.status,
        maxLeads: campaigns.maxLeads,
        maxBudgetTotalUsd: campaigns.maxBudgetTotalUsd,
      })
      .from(campaigns)
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
          const budgetResult = await getStatsBudget({
            orgId: row.orgId,
            campaignId,
            windows: [{ label: "total" }],
          });

          const totalWindow = budgetResult.windows.find(w => w.label === "total");
          const totalCostCents = totalWindow ? parseFloat(totalWindow.totalCostInUsdCents) || 0 : 0;

          results[campaignId] = {
            status: row.status,
            maxLeads: row.maxLeads,
            maxBudgetTotalUsd: row.maxBudgetTotalUsd,
            totalCostInUsdCents: totalCostCents > 0 ? String(totalCostCents) : null,
          };
        } catch (err) {
          console.warn(`[Campaign Service] Batch budget failed for campaign ${campaignId}:`, err);
          results[campaignId] = { error: "Failed to fetch stats" };
        }
      })
    );

    res.json({ results });
  } catch (error) {
    console.error("[Campaign Service] Batch budget error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /stats - Campaign stats from own DB (query-param filters)
 *
 * New canonical path for POST /campaigns/stats.
 * Accepts orgId, brandId, campaignId as query params.
 */
router.get("/stats", requireApiKey, validateQuery(StatsFilterQuery), async (req, res) => {
  try {
    const { orgId, brandId, campaignId } = req.query as {
      orgId?: string;
      brandId?: string;
      campaignId?: string;
    };

    const conditions = [];
    if (orgId) conditions.push(eq(campaigns.orgId, orgId));
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

export default router;
