import { Router } from "express";
import { eq, and, inArray } from "drizzle-orm";
import { arrayContains } from "drizzle-orm/sql/expressions/conditions";
import { db } from "../db/index.js";
import { campaigns, type Campaign } from "../db/schema.js";
import { requireApiKey } from "../middleware/auth.js";
import { validateBody, validateQuery } from "../middleware/validate.js";
import { getStatsBudget } from "@distribute/runs-client";
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
          console.warn(`[campaign-service] Batch budget failed for campaign ${campaignId}:`, err);
          results[campaignId] = { error: "Failed to fetch stats" };
        }
      })
    );

    res.json({ results });
  } catch (error) {
    console.error("[campaign-service] Batch budget error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

function computeStats(rows: Campaign[]) {
  const byStatus: Record<string, number> = {};
  let budgetTotalUsd = 0;
  let maxLeadsTotal = 0;

  for (const c of rows) {
    byStatus[c.status] = (byStatus[c.status] || 0) + 1;
    if (c.maxBudgetTotalUsd) budgetTotalUsd += parseFloat(c.maxBudgetTotalUsd);
    if (c.maxLeads) maxLeadsTotal += c.maxLeads;
  }

  return {
    totalCampaigns: rows.length,
    byStatus,
    budgetTotalUsd: budgetTotalUsd > 0 ? budgetTotalUsd : null,
    maxLeadsTotal: maxLeadsTotal > 0 ? maxLeadsTotal : null,
  };
}

/**
 * GET /stats - Campaign stats from own DB (query-param filters)
 *
 * Accepts orgId, brandId, campaignId, workflowSlug, featureSlug,
 * groupBy as query params.
 */
router.get("/stats", requireApiKey, validateQuery(StatsFilterQuery), async (req, res) => {
  try {
    const {
      orgId, brandId, campaignId,
      workflowSlug, featureSlug,
      groupBy,
    } = req.query as {
      orgId?: string;
      brandId?: string;
      campaignId?: string;
      workflowSlug?: string;
      featureSlug?: string;
      groupBy?: string;
    };

    const conditions = [];
    if (orgId) conditions.push(eq(campaigns.orgId, orgId));
    if (brandId) conditions.push(arrayContains(campaigns.brandIds, [brandId]));
    if (campaignId) conditions.push(eq(campaigns.id, campaignId));
    if (workflowSlug) conditions.push(eq(campaigns.workflowSlug, workflowSlug));
    if (featureSlug) conditions.push(eq(campaigns.featureSlug, featureSlug));

    const where = conditions.length === 1 ? conditions[0] : conditions.length > 1 ? and(...conditions) : undefined;

    const matching = await db
      .select()
      .from(campaigns)
      .where(where);

    // If no groupBy, return flat stats
    if (!groupBy) {
      return res.json({ stats: computeStats(matching) });
    }

    // GroupBy logic
    const groups = new Map<string, Campaign[]>();

    for (const c of matching) {
      let key: string;

      if (groupBy === "workflowSlug") {
        key = c.workflowSlug;
      } else {
        // featureSlug
        key = c.featureSlug || "__null__";
      }

      const list = groups.get(key) || [];
      list.push(c);
      groups.set(key, list);
    }

    const groupedStats: Record<string, ReturnType<typeof computeStats>> = {};
    for (const [key, rows] of groups) {
      groupedStats[key] = computeStats(rows);
    }

    return res.json({ groupedStats });
  } catch (error) {
    console.error("[campaign-service] Stats error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
