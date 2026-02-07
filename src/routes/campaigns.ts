import { Router } from "express";
import { eq, and, desc } from "drizzle-orm";
import { db } from "../db/index.js";
import { campaigns } from "../db/schema.js";
import { clerkAuth, requireOrg, requireApiKey, AuthenticatedRequest } from "../middleware/auth.js";
import { normalizeUrl } from "../lib/domain.js";
import { getFilteredStats } from "../lib/service-client.js";

const router = Router();

/**
 * GET /campaigns - List all campaigns for org
 * Query param: brandId to filter by brand (from brand-service)
 */
router.get("/campaigns", clerkAuth, requireOrg, async (req: AuthenticatedRequest, res) => {
  try {
    const { brandId } = req.query;
    
    let results = await db
      .select()
      .from(campaigns)
      .where(eq(campaigns.orgId, req.orgId!))
      .orderBy(desc(campaigns.createdAt));

    // Filter by brandId if provided
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
router.get("/campaigns/:id", clerkAuth, requireOrg, async (req: AuthenticatedRequest, res) => {
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
router.post("/campaigns", clerkAuth, requireOrg, async (req: AuthenticatedRequest, res) => {
  try {
    const {
      name,
      brandUrl,  // URL of the brand to promote
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
      startDate,
      endDate,
      notifyFrequency,
      notifyChannel,
      notifyDestination,
      appId,
    } = req.body;

    if (!name) {
      return res.status(400).json({ error: "Campaign name is required" });
    }

    if (!brandUrl) {
      return res.status(400).json({ error: "brandUrl is required" });
    }

    // Normalize the brandUrl
    const normalizedBrandUrl = normalizeUrl(brandUrl);
    console.log(`[Campaign Service] Creating campaign with brandUrl: ${normalizedBrandUrl}`);

    const [campaign] = await db
      .insert(campaigns)
      .values({
        orgId: req.orgId!,
        createdByUserId: req.userId!,
        name,
        appId: appId || null,
        brandUrl: normalizedBrandUrl,  // Store brandUrl directly, brand-service is source of truth
        personTitles,
        qOrganizationKeywordTags,
        organizationLocations,
        organizationNumEmployeesRanges,
        qOrganizationIndustryTagIds,
        qKeywords,
        requestRaw: { ...req.body, brandUrl: normalizedBrandUrl },
        maxBudgetDailyUsd,
        maxBudgetWeeklyUsd,
        maxBudgetMonthlyUsd,
        maxBudgetTotalUsd,
        startDate,
        endDate,
        notifyFrequency,
        notifyChannel,
        notifyDestination,
        status: "draft",
      })
      .returning();

    res.status(201).json({ campaign });
  } catch (error) {
    console.error("[Campaign Service] Create campaign error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * PATCH /campaigns/:id - Update a campaign
 */
router.patch("/campaigns/:id", clerkAuth, requireOrg, async (req: AuthenticatedRequest, res) => {
  try {
    const { id } = req.params;

    // Verify ownership
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
 * POST /campaigns/:id/activate - Activate a campaign
 */
router.post("/campaigns/:id/activate", clerkAuth, requireOrg, async (req: AuthenticatedRequest, res) => {
  try {
    const { id } = req.params;

    const [updated] = await db
      .update(campaigns)
      .set({
        status: "active",
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
    console.error("[Campaign Service] Activate campaign error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * POST /campaigns/:id/pause - Pause a campaign
 */
router.post("/campaigns/:id/pause", clerkAuth, requireOrg, async (req: AuthenticatedRequest, res) => {
  try {
    const { id } = req.params;

    const [updated] = await db
      .update(campaigns)
      .set({
        status: "paused",
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
    console.error("[Campaign Service] Pause campaign error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * DELETE /campaigns/:id - Delete a campaign
 */
router.delete("/campaigns/:id", clerkAuth, requireOrg, async (req: AuthenticatedRequest, res) => {
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

/**
 * POST /stats - Get aggregated stats with direct filters
 * Passes filters to downstream services (no runId resolution needed)
 * Requires API key for service-to-service auth
 */
router.post("/stats", requireApiKey, async (req, res) => {
  try {
    const { clerkOrgId, appId, brandId, campaignId } = req.body;

    if (!clerkOrgId && !appId && !brandId && !campaignId) {
      return res.status(400).json({ error: "At least one filter required: clerkOrgId, appId, brandId, or campaignId" });
    }

    const result = await getFilteredStats({ clerkOrgId, appId, brandId, campaignId });

    res.json({
      stats: result.stats,
      serviceErrors: result.errors.length > 0 ? result.errors : undefined,
    });
  } catch (error) {
    console.error("[Campaign Service] Filtered stats error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
