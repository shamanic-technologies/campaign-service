import { Router } from "express";
import { eq, and, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { campaigns, type Campaign } from "../db/schema.js";
import { requireApiKey } from "../middleware/auth.js";
import { validateBody, validateQuery } from "../middleware/validate.js";
import { getStatsBudget } from "@mcpfactory/runs-client";
import { BatchBudgetUsageBody, StatsFilterQuery } from "../schemas.js";
import {
  resolveWorkflowDynastySlugs,
  resolveFeatureDynastySlugs,
  getWorkflowDynastyMap,
  getFeatureDynastyMap,
} from "../lib/dynasty-client.js";

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
 * workflowDynastySlug, featureDynastySlug, groupBy as query params.
 */
router.get("/stats", requireApiKey, validateQuery(StatsFilterQuery), async (req, res) => {
  try {
    const {
      orgId, brandId, campaignId,
      workflowSlug, featureSlug,
      workflowDynastySlug, featureDynastySlug,
      groupBy,
    } = req.query as {
      orgId?: string;
      brandId?: string;
      campaignId?: string;
      workflowSlug?: string;
      featureSlug?: string;
      workflowDynastySlug?: string;
      featureDynastySlug?: string;
      groupBy?: string;
    };

    // Resolve dynasty slugs into versioned slug lists
    let resolvedWorkflowSlugs: string[] | undefined;
    let resolvedFeatureSlugs: string[] | undefined;

    if (workflowDynastySlug) {
      resolvedWorkflowSlugs = await resolveWorkflowDynastySlugs(workflowDynastySlug);
      if (resolvedWorkflowSlugs.length === 0) {
        if (groupBy) {
          return res.json({ groupedStats: {} });
        }
        return res.json({ stats: computeStats([]) });
      }
    }

    if (featureDynastySlug) {
      resolvedFeatureSlugs = await resolveFeatureDynastySlugs(featureDynastySlug);
      if (resolvedFeatureSlugs.length === 0) {
        if (groupBy) {
          return res.json({ groupedStats: {} });
        }
        return res.json({ stats: computeStats([]) });
      }
    }

    // Build conditions
    const conditions = [];
    if (orgId) conditions.push(eq(campaigns.orgId, orgId));
    if (brandId) conditions.push(eq(campaigns.brandId, brandId));
    if (campaignId) conditions.push(eq(campaigns.id, campaignId));

    // Dynasty slugs take priority over exact slugs
    if (resolvedWorkflowSlugs && resolvedWorkflowSlugs.length > 0) {
      conditions.push(inArray(campaigns.workflowSlug, resolvedWorkflowSlugs));
    } else if (workflowSlug) {
      conditions.push(eq(campaigns.workflowSlug, workflowSlug));
    }

    if (resolvedFeatureSlugs && resolvedFeatureSlugs.length > 0) {
      conditions.push(inArray(campaigns.featureSlug, resolvedFeatureSlugs));
    } else if (featureSlug) {
      conditions.push(eq(campaigns.featureSlug, featureSlug));
    }

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
    let dynastyMap: Map<string, string> | undefined;

    if (groupBy === "workflowDynastySlug") {
      dynastyMap = await getWorkflowDynastyMap();
    } else if (groupBy === "featureDynastySlug") {
      dynastyMap = await getFeatureDynastyMap();
    }

    const groups = new Map<string, Campaign[]>();

    for (const c of matching) {
      let key: string;

      if (groupBy === "workflowSlug") {
        key = c.workflowSlug;
      } else if (groupBy === "featureSlug") {
        key = c.featureSlug || "__null__";
      } else if (groupBy === "workflowDynastySlug") {
        key = dynastyMap!.get(c.workflowSlug) || c.workflowSlug;
      } else {
        // featureDynastySlug
        key = c.featureSlug ? (dynastyMap!.get(c.featureSlug) || c.featureSlug) : "__null__";
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
    console.error("[Campaign Service] Stats error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
