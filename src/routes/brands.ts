import { Router } from "express";
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { brandPause } from "../db/schema.js";
import { serviceAuth, requireApiKey, AuthenticatedRequest } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import { UpdateBrandPauseBody } from "../schemas.js";
import { wakeScheduler } from "../lib/scheduler.js";

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
 * ONE mutable row per brand. Un-pausing wakes the scheduler so the brand's held campaigns
 * resume promptly instead of waiting out the current idle sleep.
 */
router.patch("/brands/:brandId/pause", requireApiKey, serviceAuth, validateBody(UpdateBrandPauseBody), async (req: AuthenticatedRequest, res) => {
  try {
    const { brandId } = req.params;
    const orgId = req.orgId!;
    const { paused } = req.body as { paused: boolean };
    const now = new Date();

    const [row] = await db
      .insert(brandPause)
      .values({ brandId, orgId, paused, updatedAt: now })
      .onConflictDoUpdate({
        target: brandPause.brandId,
        set: { orgId, paused, updatedAt: now },
      })
      .returning();

    // Un-pause → wake the scheduler so the brand's ongoing campaigns are re-claimed on the
    // next tick rather than waiting out a deep idle sleep. (Pausing needs no wake.)
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
