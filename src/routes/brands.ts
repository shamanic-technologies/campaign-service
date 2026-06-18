import { Router } from "express";
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { brandPause } from "../db/schema.js";
import { serviceAuth, requireApiKey, AuthenticatedRequest } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import { UpdateBrandPauseBody } from "../schemas.js";
import { wakeScheduler } from "../lib/scheduler.js";
import { ensureRunnableSalesOutreachCampaign } from "../lib/sales-outreach-campaign.js";

const router = Router();

/**
 * GET /brands/:brandId/pause — read a brand's pause state.
 *
 * Org-scoped: reads the row keyed on (brandId, orgId) so one org can never see another org's
 * pause state. No row → default paused=false, updatedAt=null (orgId echoed from the authed org).
 */
router.get("/brands/:brandId/pause", requireApiKey, serviceAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { brandId } = req.params;
    const orgId = req.orgId!;

    const row = await db.query.brandPause.findFirst({
      where: and(eq(brandPause.brandId, brandId), eq(brandPause.orgId, orgId)),
    });

    res.json({
      brandId,
      orgId,
      paused: row?.paused ?? false,
      updatedAt: row ? row.updatedAt.toISOString() : null,
    });
  } catch (error) {
    console.error("[campaign-service] Get brand pause error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * PATCH /brands/:brandId/pause — set a brand's pause state (upsert in place).
 *
 * ONE mutable row per brand. Un-pausing also ensures the brand has a runnable sales outreach
 * campaign behind it, then wakes the scheduler so work resumes promptly.
 */
router.patch("/brands/:brandId/pause", requireApiKey, serviceAuth, validateBody(UpdateBrandPauseBody), async (req: AuthenticatedRequest, res) => {
  try {
    const { brandId } = req.params;
    const orgId = req.orgId!;
    const { paused } = req.body as { paused: boolean };
    const now = new Date();

    const row = await db.transaction(async (tx) => {
      if (!paused) {
        await ensureRunnableSalesOutreachCampaign(tx, {
          orgId,
          brandId,
          userId: req.userId,
          runId: req.runId,
          now,
        });
      }

      const [updated] = await tx
        .insert(brandPause)
        .values({ brandId, orgId, paused, updatedAt: now })
        .onConflictDoUpdate({
          target: brandPause.brandId,
          set: { orgId, paused, updatedAt: now },
        })
        .returning();

      if (!updated) {
        throw new Error(`Cannot update brand pause for brand ${brandId}`);
      }

      return updated;
    });

    // Un-pause → wake the scheduler so the brand's sales campaign is claimed on the next tick
    // rather than waiting out a deep idle sleep. (Pausing needs no wake and does not stop.)
    if (!paused) {
      wakeScheduler();
    }

    res.json({
      brandId: row.brandId,
      orgId: row.orgId,
      paused: row.paused,
      updatedAt: row.updatedAt.toISOString(),
    });
  } catch (error) {
    console.error("[campaign-service] Update brand pause error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
