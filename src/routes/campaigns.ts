import { Router } from "express";
import { eq, and, desc, inArray, isNull } from "drizzle-orm";
import { arrayContains } from "drizzle-orm/sql/expressions/conditions";
import { db } from "../db/index.js";
import { campaigns } from "../db/schema.js";
import { serviceAuth, requireApiKey, AuthenticatedRequest } from "../middleware/auth.js";
import { validateBody, validateQuery } from "../middleware/validate.js";
import { CreateCampaignBody, UpdateCampaignBody, CampaignsFilterQuery } from "../schemas.js";
import { executeCampaignWorkflow, validateWorkflowInputs } from "../lib/workflows.js";
import { wakeScheduler } from "../lib/scheduler.js";
import { traceEvent } from "../lib/trace-event.js";
import { campaignIdentityColumns } from "../lib/campaign-identity.js";
import { STOP_REASONS } from "../lib/stop-reason.js";
import { isSalesOutreachFeature } from "../lib/sales-outreach-campaign.js";
import { acceptedFunnelKeys, toFunnelKey } from "../lib/sales-funnel-vocabulary.js";

const router = Router();

// === Scheduler routes (API-key authed, must be before :id routes) ===

/**
 * GET /campaigns/list - List all campaigns across all orgs (for scheduler)
 */
router.get("/campaigns/list", requireApiKey, async (_req, res) => {
  try {
    const allCampaigns = await db
      .select()
      .from(campaigns)
      .orderBy(campaigns.createdAt);

    res.json({ campaigns: allCampaigns });
  } catch (error) {
    console.error("[campaign-service] List all campaigns error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// === User routes (service-auth) ===

/**
 * GET /campaigns - List all campaigns for org
 *
 * Supports filtering by brandId, workflowSlug, featureSlug.
 */
router.get("/campaigns", requireApiKey, serviceAuth, validateQuery(CampaignsFilterQuery), async (req: AuthenticatedRequest, res) => {
  try {
    const {
      brandId, workflowSlug, featureSlug,
    } = req.query as {
      brandId?: string;
      workflowSlug?: string;
      featureSlug?: string;
    };

    const conditions = [eq(campaigns.orgId, req.orgId!)];

    if (brandId) conditions.push(arrayContains(campaigns.brandIds, [brandId]));
    if (workflowSlug) conditions.push(eq(campaigns.workflowSlug, workflowSlug));
    if (featureSlug) conditions.push(eq(campaigns.featureSlug, featureSlug));

    const results = await db
      .select()
      .from(campaigns)
      .where(and(...conditions))
      .orderBy(desc(campaigns.createdAt));

    res.json({ campaigns: results });
  } catch (error) {
    console.error("[campaign-service] List campaigns error:", error);
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
      console.warn(`[campaign-service] GET /campaigns/:id 404 — id=${id}, x-org-id=${req.orgId}`);
      return res.status(404).json({ error: "Campaign not found" });
    }

    res.json({ campaign });
  } catch (error) {
    console.error("[campaign-service] Get campaign error:", error);
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
      workflowSlug,
      brandIds,
      featureSlug: bodyFeatureSlug,
      featureInputs,
      activeGoalId,
      brandProfileId,
      audienceId,
      funnelKey: bodyFunnelKey,
      audienceIds,
      servicesOffered,
      clickDestinationUrl,
      maxBudgetDailyUsd,
      maxBudgetWeeklyUsd,
      maxBudgetMonthlyUsd,
      maxBudgetTotalUsd,
      dailyBudgetCents,
      maxLeads,
      startDate,
      endDate,
      notifyFrequency,
      notifyChannel,
      notifyDestination,
    } = req.body;

    // featureSlug comes exclusively from x-feature-slug header
    const resolvedFeatureSlug = req.featureSlug || "";

    // A sales campaign STATES the funnel it sells, at birth. The creator provisions per funded
    // funnel, so it already knows which one — nothing is inferred here, not from a goal, not from
    // the brand's declared set, not ever. A sales campaign with no funnel is what left a customer
    // funding a funnel and never getting a campaign for it, so this is a hard 400 rather than a
    // row nobody can attribute. Every other feature sells through no sales funnel and states none.
    const funnelKey = isSalesOutreachFeature(resolvedFeatureSlug)
      ? toFunnelKey(bodyFunnelKey)
      : null;
    if (isSalesOutreachFeature(resolvedFeatureSlug) && !funnelKey) {
      return res.status(400).json({
        error: bodyFunnelKey
          ? `Unknown sales funnel "${bodyFunnelKey}" — expected one of: ${acceptedFunnelKeys().join(", ")}`
          : `Cannot create a ${resolvedFeatureSlug} campaign without stating its sales funnel — ` +
            `funnelKey is required (one of: ${acceptedFunnelKeys().join(", ")})`,
      });
    }

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

    if (req.runId) {
      traceEvent(req.runId, {
        service: "campaign-service",
        event: "create-campaign",
        detail: `Creating campaign "${name}" — workflowSlug=${workflowSlug}, brandIds=[${brandIds}], featureSlug=${resolvedFeatureSlug}`,
        data: { name, workflowSlug, brandIds, featureSlug: resolvedFeatureSlug },
      }, req.headers).catch(() => {});
    }

    // A campaign is unique on (org, brand, sales funnel, acquisition channel). The WORKFLOW is not
    // part of that identity: a campaign changes workflow whenever selection picks a better one, and
    // it is not replaced by a new campaign each time it does. Creating one per workflow is what grew
    // a single brand 137 rows — one per workflow version — each holding a slice of a history nobody
    // could read as one campaign. So a create that names an identity already alive UPDATES that
    // campaign to the requested workflow and configuration and hands it back.
    const identity = campaignIdentityColumns({ brandIds, featureSlug: resolvedFeatureSlug });
    const incumbent = identity.brandId && identity.acquisitionChannel
      ? await db.query.campaigns.findFirst({
          where: and(
            eq(campaigns.orgId, req.orgId!),
            eq(campaigns.status, "ongoing"),
            eq(campaigns.brandId, identity.brandId),
            eq(campaigns.acquisitionChannel, identity.acquisitionChannel),
            // The identity includes the funnel: an incumbent is the campaign alive on THIS funnel
            // (or the funnel-less one, for a feature that sells through no sales funnel).
            funnelKey ? eq(campaigns.funnelKey, funnelKey) : isNull(campaigns.funnelKey),
          ),
          orderBy: [campaigns.createdAt],
        })
      : null;

    if (incumbent) {
      // Only what the caller actually sent moves. The NAME is deliberately left alone: it is the
      // campaign's own label (and unique per org), not a restatement of which workflow is running.
      const [updated] = await db
        .update(campaigns)
        .set({
          workflowSlug,
          ...(featureInputs !== undefined ? { featureInputs } : {}),
          ...(activeGoalId !== undefined ? { activeGoalId } : {}),
          ...(brandProfileId !== undefined ? { brandProfileId } : {}),
          ...(audienceId !== undefined ? { audienceId } : {}),
          ...(audienceIds !== undefined ? { audienceIds } : {}),
          ...(servicesOffered !== undefined ? { servicesOffered } : {}),
          ...(clickDestinationUrl !== undefined ? { clickDestinationUrl } : {}),
          ...(maxBudgetDailyUsd !== undefined ? { maxBudgetDailyUsd } : {}),
          ...(maxBudgetWeeklyUsd !== undefined ? { maxBudgetWeeklyUsd } : {}),
          ...(maxBudgetMonthlyUsd !== undefined ? { maxBudgetMonthlyUsd } : {}),
          ...(maxBudgetTotalUsd !== undefined ? { maxBudgetTotalUsd } : {}),
          ...(dailyBudgetCents !== undefined ? { dailyBudgetCents } : {}),
          ...(maxLeads !== undefined ? { maxLeads } : {}),
          ...(startDate !== undefined ? { startDate } : {}),
          ...(endDate !== undefined ? { endDate } : {}),
          ...(notifyFrequency !== undefined ? { notifyFrequency } : {}),
          ...(notifyChannel !== undefined ? { notifyChannel } : {}),
          ...(notifyDestination !== undefined ? { notifyDestination } : {}),
          updatedAt: new Date(),
        })
        .where(and(eq(campaigns.id, incumbent.id), eq(campaigns.orgId, req.orgId!)))
        .returning();

      if (req.runId) {
        traceEvent(req.runId, {
          service: "campaign-service",
          event: "campaign-workflow-changed",
          detail: `Campaign ${updated.id} already runs this (brand, funnel, channel) — switched its workflow to "${workflowSlug}" instead of creating a second campaign`,
          data: { campaignId: updated.id, workflowSlug, brandId: identity.brandId, acquisitionChannel: identity.acquisitionChannel },
        }, req.headers).catch(() => {});
      }

      executeCampaignWorkflow(updated.workflowSlug, {
        campaignId: updated.id,
        orgId: req.orgId!,
        brandId: (updated.brandIds ?? []).join(","),
        userId: req.userId!,
        runId: req.runId!,
        featureSlug: updated.featureSlug!,
        activeGoalId: updated.activeGoalId,
        brandProfileId: updated.brandProfileId,
        audienceId: updated.audienceId,
      }).catch((err) => {
        console.error(`[campaign-service] Failed to trigger workflow for campaign ${updated.id}:`, err);
      });

      wakeScheduler();
      return res.status(200).json({ campaign: updated });
    }

    const [campaign] = await db
      .insert(campaigns)
      .values({
        ...identity,
        orgId: req.orgId!,
        createdByUserId: req.userId ?? null,
        parentRunId: req.runId ?? null,
        name,
        workflowSlug,
        brandIds,
        featureSlug: resolvedFeatureSlug,
        featureInputs,
        activeGoalId: activeGoalId ?? null,
        brandProfileId: brandProfileId ?? null,
        audienceId: audienceId ?? null,
        funnelKey,
        audienceIds: audienceIds ?? null,
        servicesOffered: servicesOffered ?? null,
        clickDestinationUrl: clickDestinationUrl ?? null,
        maxBudgetDailyUsd,
        maxBudgetWeeklyUsd,
        maxBudgetMonthlyUsd,
        maxBudgetTotalUsd,
        dailyBudgetCents: dailyBudgetCents ?? null,
        maxLeads,
        startDate,
        endDate,
        notifyFrequency,
        notifyChannel,
        notifyDestination,
        status: "ongoing",
      })
      .returning();

    if (req.runId) {
      traceEvent(req.runId, {
        service: "campaign-service",
        event: "campaign-created",
        detail: `Campaign created id=${campaign.id}, triggering workflow "${campaign.workflowSlug}"`,
        data: { campaignId: campaign.id, workflowSlug: campaign.workflowSlug },
      }, req.headers).catch(() => {});
    }

    // Trigger first workflow execution (fire-and-forget)
    const workflowInputs = {
      campaignId: campaign.id,
      orgId: req.orgId!,
      brandId: (campaign.brandIds ?? []).join(","),
      userId: req.userId!,
      runId: req.runId!,
      featureSlug: campaign.featureSlug!,
      activeGoalId: campaign.activeGoalId,
      brandProfileId: campaign.brandProfileId,
      audienceId: campaign.audienceId,
    };
    executeCampaignWorkflow(campaign.workflowSlug, workflowInputs).catch((err) => {
      console.error(`[campaign-service] Failed to trigger initial workflow for campaign ${campaign.id}:`, err);
    });

    // New ongoing campaign → wake the scheduler so it resumes monitoring from idle.
    wakeScheduler();

    res.status(201).json({ campaign });
  } catch (error: any) {
    const constraint = error?.constraint ?? error?.constraint_name;
    if (error?.code === "23505" && constraint === "uniq_campaigns_org_name") {
      return res.status(409).json({ error: "A campaign with this name already exists in your organization" });
    }
    // Two creates raced the same identity. The loser does not get a second campaign for it — the
    // one that won IS this identity's campaign, so hand that one back rather than an error.
    if (error?.code === "23505" && constraint === "uniq_campaigns_org_brand_funnel_channel") {
      const racedFunnelKey = isSalesOutreachFeature(req.featureSlug)
        ? toFunnelKey(req.body.funnelKey)
        : null;
      const winner = await db.query.campaigns.findFirst({
        where: and(
          eq(campaigns.orgId, req.orgId!),
          eq(campaigns.status, "ongoing"),
          eq(campaigns.brandId, (req.body.brandIds as string[])[0]),
          racedFunnelKey ? eq(campaigns.funnelKey, racedFunnelKey) : isNull(campaigns.funnelKey),
        ),
        orderBy: [campaigns.createdAt],
      });
      if (winner) return res.status(200).json({ campaign: winner });
    }
    console.error("[campaign-service] Create campaign error:", error);
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

    if (req.runId) {
      traceEvent(req.runId, {
        service: "campaign-service",
        event: "update-campaign",
        detail: `Updating campaign ${id} — fields: ${Object.keys(req.body).join(", ")}`,
        data: { campaignId: id, fields: Object.keys(req.body) },
      }, req.headers).catch(() => {});
    }

    const statusMap: Record<string, string> = { activate: "ongoing", stop: "stopped" };
    const updates = { ...req.body, updatedAt: new Date() };
    if (updates.status) {
      updates.status = statusMap[updates.status] ?? updates.status;
      // A person stopping a campaign is a decision, and it says so on the row: `manual` is not
      // resumable, so nothing brings this campaign back on its own. Activating clears the reason
      // — the stop it described is over.
      updates.stopReason = req.body.status === "stop" ? STOP_REASONS.MANUAL : null;
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
        activeGoalId: updated.activeGoalId,
        brandProfileId: updated.brandProfileId,
        audienceId: updated.audienceId,
      };
      executeCampaignWorkflow(updated.workflowSlug, activateInputs).catch((err) => {
        console.error(`[campaign-service] Failed to trigger workflow for campaign ${id}:`, err);
      });
      // Campaign just activated (status → ongoing) → wake the scheduler from idle.
      wakeScheduler();
    }

    res.json({ campaign: updated });
  } catch (error: any) {
    if (error?.code === "23505" && (error?.constraint === "uniq_campaigns_org_name" || error?.constraint_name === "uniq_campaigns_org_name")) {
      return res.status(409).json({ error: "A campaign with this name already exists in your organization" });
    }
    console.error("[campaign-service] Update campaign error:", error);
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
    console.error("[campaign-service] Delete campaign error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
