/**
 * Internal routes for service-to-service calls
 * Uses serviceAuth (x-clerk-org-id header) instead of clerkAuth (JWT)
 */

import { Router } from "express";
import { eq, and, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { campaigns, orgs } from "../db/schema.js";
import { serviceAuth, requireApiKey, AuthenticatedRequest } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import { getLeadsForRuns, aggregateCompaniesFromLeads } from "../lib/service-client.js";
import { extractDomain } from "../lib/domain.js";
import { ensureOrganization, listRuns, getRunsBatch, createRun, updateRun, type Run, type RunWithCosts } from "@mcpfactory/runs-client";
import { CreateCampaignInternalBody, UpdateCampaignBody, BatchStatsBody, RunStatusUpdate } from "../schemas.js";

const router = Router();

/**
 * Helper: get clerkOrgId from a campaign's org (for no-auth routes)
 */
async function getClerkOrgIdFromCampaign(campaignId: string): Promise<string | null> {
  const campaign = await db.query.campaigns.findFirst({
    where: eq(campaigns.id, campaignId),
    columns: { orgId: true },
  });
  if (!campaign) return null;

  const org = await db.query.orgs.findFirst({
    where: eq(orgs.id, campaign.orgId),
    columns: { clerkOrgId: true },
  });
  return org?.clerkOrgId || null;
}

/**
 * Helper: get run IDs from runs-service for a given campaign
 */
async function getRunIds(clerkOrgId: string, campaignId: string): Promise<string[]> {
  const runsOrgId = await ensureOrganization(clerkOrgId);
  const result = await listRuns({
    organizationId: runsOrgId,
    serviceName: "campaign-service",
    taskName: campaignId,
  });
  return result.runs.map((r: Run) => r.id);
}

/**
 * Helper: get runs from runs-service for a given campaign
 */
async function getRunsForCampaign(clerkOrgId: string, campaignId: string): Promise<Run[]> {
  const runsOrgId = await ensureOrganization(clerkOrgId);
  const result = await listRuns({
    organizationId: runsOrgId,
    serviceName: "campaign-service",
    taskName: campaignId,
  });
  return result.runs;
}

/**
 * GET /internal/campaigns - List all campaigns for org
 * Query params:
 * - brandId: optional, filter by brand ID (from brand-service)
 */
router.get("/campaigns", serviceAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const brandId = req.query.brandId as string;

    let orgCampaigns = await db.query.campaigns.findMany({
      where: eq(campaigns.orgId, req.orgId!),
      orderBy: (campaigns, { desc }) => [desc(campaigns.createdAt)],
    });

    // Filter by brandId if provided
    if (brandId) {
      orgCampaigns = orgCampaigns.filter(c => c.brandId === brandId);
    }

    res.json({ campaigns: orgCampaigns });
  } catch (error) {
    console.error("[Campaign Service] List campaigns error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /internal/campaigns/all - List all campaigns across all orgs (for scheduler)
 * Requires API key for service-to-service auth
 * Returns campaigns with clerkOrgId and brandUrl for downstream service calls
 */
router.get("/campaigns/all", requireApiKey, async (_req, res) => {
  try {
    const allCampaigns = await db
      .select({
        id: campaigns.id,
        orgId: campaigns.orgId,
        name: campaigns.name,
        status: campaigns.status,
        personTitles: campaigns.personTitles,
        organizationLocations: campaigns.organizationLocations,
        qOrganizationKeywordTags: campaigns.qOrganizationKeywordTags,
        organizationNumEmployeesRanges: campaigns.organizationNumEmployeesRanges,
        qOrganizationIndustryTagIds: campaigns.qOrganizationIndustryTagIds,
        qKeywords: campaigns.qKeywords,
        maxBudgetDailyUsd: campaigns.maxBudgetDailyUsd,
        maxBudgetWeeklyUsd: campaigns.maxBudgetWeeklyUsd,
        maxBudgetMonthlyUsd: campaigns.maxBudgetMonthlyUsd,
        maxBudgetTotalUsd: campaigns.maxBudgetTotalUsd,
        maxLeads: campaigns.maxLeads,
        requestRaw: campaigns.requestRaw,
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
 * GET /internal/campaigns/:id - Get a specific campaign
 */
router.get("/campaigns/:id", serviceAuth, async (req: AuthenticatedRequest, res) => {
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
 * POST /internal/campaigns - Create a new campaign
 */
router.post("/campaigns", serviceAuth, validateBody(CreateCampaignInternalBody), async (req: AuthenticatedRequest, res) => {
  try {
    console.log("[Campaign Service] POST /internal/campaigns - orgId:", req.orgId, "userId:", req.userId, "body:", JSON.stringify(req.body));

    const {
      name,
      brandUrl,
      personTitles,
      qOrganizationKeywordTags,
      organizationLocations,
      organizationNumEmployeesRanges,
      qOrganizationIndustryTagIds,
      qKeywords,
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
      appId,
    } = req.body;

    const brandDomain = extractDomain(brandUrl);
    console.log(`[Campaign Service] Using brandUrl: ${brandUrl} (domain: ${brandDomain})`);

    const insertData = {
      orgId: req.orgId!,
      brandUrl,
      appId: appId || null,
      createdByUserId: req.userId || null,
      name,
      personTitles,
      qOrganizationKeywordTags,
      organizationLocations,
      organizationNumEmployeesRanges,
      qOrganizationIndustryTagIds,
      qKeywords,
      requestRaw: req.body,
      maxBudgetDailyUsd,
      maxBudgetWeeklyUsd,
      maxBudgetMonthlyUsd,
      maxBudgetTotalUsd,
      maxLeads: maxLeads ? parseInt(maxLeads, 10) : null,
      startDate,
      endDate,
      notifyFrequency,
      notifyChannel,
      notifyDestination,
      status: "ongoing",
    };

    console.log("[Campaign Service] Insert data:", JSON.stringify(insertData));

    const [campaign] = await db
      .insert(campaigns)
      .values(insertData)
      .returning();

    res.status(201).json({ campaign });
  } catch (error: any) {
    console.error("[Campaign Service] Create campaign error:", error.message, error.stack);
    res.status(500).json({ error: error.message || "Internal server error" });
  }
});

/**
 * PATCH /internal/campaigns/:id - Update a campaign
 */
router.patch("/campaigns/:id", serviceAuth, validateBody(UpdateCampaignBody), async (req: AuthenticatedRequest, res) => {
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

    const [updated] = await db
      .update(campaigns)
      .set({
        ...req.body,
        updatedAt: new Date(),
      })
      .where(eq(campaigns.id, id))
      .returning();

    res.json({ campaign: updated });
  } catch (error) {
    console.error("[Campaign Service] Update campaign error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * POST /internal/campaigns/:id/stop - Stop a campaign
 */
router.post("/campaigns/:id/stop", serviceAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { id } = req.params;

    const [updated] = await db
      .update(campaigns)
      .set({
        status: "stopped",
        updatedAt: new Date(),
      })
      .where(and(
        eq(campaigns.id, id),
        eq(campaigns.orgId, req.orgId!)
      ))
      .returning();

    if (!updated) {
      return res.status(404).json({ error: "Campaign not found" });
    }

    res.json({ campaign: updated });
  } catch (error) {
    console.error("[Campaign Service] Stop campaign error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * POST /internal/campaigns/:id/resume - Resume a stopped campaign
 */
router.post("/campaigns/:id/resume", serviceAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { id } = req.params;

    const [updated] = await db
      .update(campaigns)
      .set({
        status: "ongoing",
        updatedAt: new Date(),
      })
      .where(and(
        eq(campaigns.id, id),
        eq(campaigns.orgId, req.orgId!)
      ))
      .returning();

    if (!updated) {
      return res.status(404).json({ error: "Campaign not found" });
    }

    res.json({ campaign: updated });
  } catch (error) {
    console.error("[Campaign Service] Resume campaign error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /internal/campaigns/:id/runs - Get campaign runs
 */
router.get("/campaigns/:id/runs", serviceAuth, async (req: AuthenticatedRequest, res) => {
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

    const runs = await getRunsForCampaign(req.clerkOrgId!, id);

    res.json({ runs });
  } catch (error) {
    console.error("[Campaign Service] Get campaign runs error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /internal/campaigns/:id/runs/all - Get campaign runs (for scheduler)
 */
router.get("/campaigns/:id/runs/all", requireApiKey, async (req, res) => {
  try {
    const { id } = req.params;

    const clerkOrgId = await getClerkOrgIdFromCampaign(id);
    if (!clerkOrgId) {
      return res.status(404).json({ error: "Campaign or org not found" });
    }

    const runs = await getRunsForCampaign(clerkOrgId, id);

    res.json({ runs });
  } catch (error) {
    console.error("[Campaign Service] Get campaign runs error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * POST /internal/campaigns/:id/runs - Create a new campaign run (for scheduler)
 */
router.post("/campaigns/:id/runs", requireApiKey, async (req, res) => {
  try {
    const { id } = req.params;

    const clerkOrgId = await getClerkOrgIdFromCampaign(id);
    if (!clerkOrgId) {
      return res.status(404).json({ error: "Campaign or org not found" });
    }

    const runsOrgId = await ensureOrganization(clerkOrgId);
    const run = await createRun({
      organizationId: runsOrgId,
      serviceName: "campaign-service",
      taskName: id,
    });

    console.log(`[Campaign Service] Created campaign run ${run.id} for campaign ${id}`);
    res.json({ run });
  } catch (error) {
    console.error("[Campaign Service] Create campaign run error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * PATCH /internal/runs/:id - Update a campaign run
 */
router.patch("/runs/:id", requireApiKey, validateBody(RunStatusUpdate), async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const run = await updateRun(id, status);

    res.json({ run });
  } catch (error) {
    console.error("[Campaign Service] Update campaign run error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /internal/campaigns/:id/debug - Get detailed debug info for a campaign
 */
router.get("/campaigns/:id/debug", serviceAuth, async (req: AuthenticatedRequest, res) => {
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

    const runs = await getRunsForCampaign(req.clerkOrgId!, id);

    const debug = {
      campaign: {
        id: campaign.id,
        name: campaign.name,
        status: campaign.status,
        createdAt: campaign.createdAt,
        updatedAt: campaign.updatedAt,
        targeting: {
          personTitles: campaign.personTitles,
          locations: campaign.organizationLocations,
          industries: campaign.qOrganizationKeywordTags,
        },
        budget: {
          daily: campaign.maxBudgetDailyUsd,
          weekly: campaign.maxBudgetWeeklyUsd,
          monthly: campaign.maxBudgetMonthlyUsd,
          total: campaign.maxBudgetTotalUsd,
        },
      },
      runs: runs.map(run => ({
        id: run.id,
        status: run.status,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        createdAt: run.createdAt,
      })),
      summary: {
        totalRuns: runs.length,
        completed: runs.filter(r => r.status === "completed").length,
        failed: runs.filter(r => r.status === "failed").length,
        running: runs.filter(r => r.status === "running").length,
        lastRunAt: runs[0]?.createdAt || null,
      },
    };

    res.json(debug);
  } catch (error) {
    console.error("[Campaign Service] Get campaign debug error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /internal/campaigns/:id/stats - Campaign stats from own DB + runs-service
 */
router.get("/campaigns/:id/stats", serviceAuth, async (req: AuthenticatedRequest, res) => {
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

    const runs = await getRunsForCampaign(req.clerkOrgId!, id);
    const runIds = runs.map(r => r.id);

    const runsWithCosts = runIds.length > 0
      ? await getRunsBatch(runIds).catch((err) => {
          console.warn("[Campaign Service] Failed to fetch run costs:", err);
          return new Map();
        })
      : new Map();

    let totalCostInUsdCents = 0;
    for (const run of runsWithCosts.values()) {
      totalCostInUsdCents += parseFloat(run.totalCostInUsdCents) || 0;
    }

    res.json({
      campaignId: id,
      status: campaign.status,
      maxLeads: campaign.maxLeads,
      budget: {
        daily: campaign.maxBudgetDailyUsd,
        weekly: campaign.maxBudgetWeeklyUsd,
        monthly: campaign.maxBudgetMonthlyUsd,
        total: campaign.maxBudgetTotalUsd,
      },
      runs: {
        total: runs.length,
        completed: runs.filter(r => r.status === "completed").length,
        failed: runs.filter(r => r.status === "failed").length,
        running: runs.filter(r => r.status === "running").length,
      },
      totalCostInUsdCents: totalCostInUsdCents > 0 ? String(totalCostInUsdCents) : null,
      createdAt: campaign.createdAt,
      updatedAt: campaign.updatedAt,
    });
  } catch (error) {
    console.error("[Campaign Service] Get campaign stats error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /internal/campaigns/:id/leads - Get all leads for a campaign
 */
router.get("/campaigns/:id/leads", serviceAuth, async (req: AuthenticatedRequest, res) => {
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

    const runIds = await getRunIds(req.clerkOrgId!, id);
    const leads = await getLeadsForRuns(runIds, req.clerkOrgId!);

    const mappedLeads = leads.map(lead => ({
      id: lead.id,
      firstName: lead.firstName,
      lastName: lead.lastName,
      email: lead.email,
      title: lead.title,
      organizationName: lead.organizationName,
      linkedinUrl: lead.linkedinUrl,
      enrichmentRunId: lead.enrichmentRunId,
      status: "found",
      createdAt: lead.createdAt,
    }));

    res.json({ leads: mappedLeads });
  } catch (error) {
    console.error("[Campaign Service] Get campaign leads error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /internal/campaigns/:id/companies - Get all companies for a campaign
 */
router.get("/campaigns/:id/companies", serviceAuth, async (req: AuthenticatedRequest, res) => {
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

    const runIds = await getRunIds(req.clerkOrgId!, id);
    const leads = await getLeadsForRuns(runIds, req.clerkOrgId!);
    const companies = aggregateCompaniesFromLeads(leads);

    res.json({ companies });
  } catch (error) {
    console.error("[Campaign Service] Get campaign companies error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * POST /internal/campaigns/batch-stats - Get stats for multiple campaigns
 * Returns campaign DB data + run counts (no downstream service proxying)
 */
router.post("/campaigns/batch-stats", requireApiKey, validateBody(BatchStatsBody), async (req, res) => {
  try {
    const { campaignIds } = req.body;

    const campaignRows = await db
      .select({
        id: campaigns.id,
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
          const runs = await getRunsForCampaign(row.clerkOrgId, campaignId);
          const runIds = runs.map(r => r.id);

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
              completed: runs.filter(r => r.status === "completed").length,
              failed: runs.filter(r => r.status === "failed").length,
              running: runs.filter(r => r.status === "running").length,
            },
            totalCostInUsdCents: totalCostInUsdCents > 0 ? String(totalCostInUsdCents) : null,
          };
        } catch (err) {
          console.warn(`[Campaign Service] Batch stats failed for campaign ${campaignId}:`, err);
          results[campaignId] = { error: "Failed to fetch stats" };
        }
      })
    );

    res.json({ results });
  } catch (error) {
    console.error("[Campaign Service] Batch stats error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
