import { Router } from "express";
import { and, asc, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { brandPause, brandPauseTransitions } from "../db/schema.js";
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
      // Prior state — no row means the brand was effectively un-paused (default false).
      const existing = await tx.query.brandPause.findFirst({
        where: and(eq(brandPause.brandId, brandId), eq(brandPause.orgId, orgId)),
      });
      const priorPaused = existing?.paused ?? false;

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

      // Append a transition row ONLY on an actual state flip — a no-op PATCH (same value)
      // records nothing. Forward-only history for the CS health board.
      if (paused !== priorPaused) {
        await tx.insert(brandPauseTransitions).values({
          brandId,
          orgId,
          paused,
          transitionedAt: now,
        });
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

/**
 * GET /brands/:brandId/pause-history — read the forward-only pause on/off transition timeline.
 *
 * Org-scoped (same (brandId, orgId) key as the current-state read). Returns transitions oldest
 * first so the Customer Success health board can render "paused <date>, resumed <date>". No row →
 * empty transitions array. Does NOT change the current-state read (GET /brands/:brandId/pause).
 */
router.get("/brands/:brandId/pause-history", requireApiKey, serviceAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { brandId } = req.params;
    const orgId = req.orgId!;

    const rows = await db.query.brandPauseTransitions.findMany({
      where: and(eq(brandPauseTransitions.brandId, brandId), eq(brandPauseTransitions.orgId, orgId)),
      orderBy: asc(brandPauseTransitions.transitionedAt),
    });

    res.json({
      brandId,
      orgId,
      transitions: rows.map((r) => ({
        paused: r.paused,
        transitionedAt: r.transitionedAt.toISOString(),
      })),
    });
  } catch (error) {
    console.error("[campaign-service] Get brand pause history error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
