import { Router } from "express";
import { and, asc, eq, inArray } from "drizzle-orm";
import { arrayContains } from "drizzle-orm/sql/expressions/conditions";
import { db } from "../db/index.js";
import { brandPauseTransitions, campaigns } from "../db/schema.js";
import { serviceAuth, requireApiKey, AuthenticatedRequest } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import { SetBrandCampaignsDailyBudgetBody } from "../schemas.js";
import { fetchFunnelBudgets } from "../lib/funnel-budget-client.js";
import { brandHeldFromBudgets } from "../lib/campaign-funding.js";
import { SALES_OUTREACH_FEATURE_SLUGS } from "../lib/sales-outreach-campaign.js";

// The daily budget is a sales-outreach pacing lever (the ONLY feature family the sales gate
// enforces it for), so the brand-page propagation targets that family's campaigns
// (every acquisition channel that sells a sales funnel).
const SALES_FEATURE_SLUGS = [...SALES_OUTREACH_FEATURE_SLUGS];

const router = Router();

/**
 * GET /brands/:brandId/pause — is this brand HELD, i.e. does the customer fund nothing for it?
 *
 * The answer is the MONEY's, not a flag's. It used to be a stored boolean (`brand_pause.paused`)
 * that the customer dashboard wrote; that control was deleted when the product decided a customer
 * stops a chain by dropping its ceiling to zero, and the flag outlived its writer — 27 brands
 * stored paused, 10 of them funded, holding campaigns with no API path back. The flag is gone and
 * this route answers from billing's per-funnel ceilings, which is the same fact the customer is
 * already editing.
 *
 * Held ⟺ no sales funnel of this (org, brand) carries a positive ceiling AND the brand-level pot
 * is not positive either. Funding any one funnel releases it, with no other step.
 *
 * Fail-LOUD (502) when billing cannot be read: answering `paused:false` on an unreadable budget
 * would tell a consumer a brand is running when nobody knows whether it is.
 *
 * `updatedAt` is null: the state is no longer stored here, so this service has no timestamp for
 * it. `GET /brands/:brandId/pause-history` still serves the flag-era transition timeline.
 */
router.get("/brands/:brandId/pause", requireApiKey, serviceAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { brandId } = req.params;
    const orgId = req.orgId!;

    const budgets = await fetchFunnelBudgets(brandId, { orgId, userId: req.userId ?? undefined });
    if (!budgets.ok) {
      res.status(502).json({ error: "Brand funding unavailable" });
      return;
    }

    res.json({
      brandId,
      orgId,
      paused: brandHeldFromBudgets(budgets),
      updatedAt: null,
    });
  } catch (error) {
    console.error("[campaign-service] Get brand pause error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * PATCH /brands/:brandId/daily-budget — set the daily budget (cents) for EVERY sales campaign
 * of a brand at once.
 *
 * This is the brand-page propagation lever (NEED 5b): when a customer edits their daily budget
 * on the brand page, that number must flow down to the brand's campaign(s) so per-campaign
 * pacing enforces it immediately. Org-scoped (only this org's campaigns for the brand are
 * touched). dailyBudgetCents:null clears each campaign's own budget → they fall back to the
 * brand daily budget again. Scoped to the sales-outreach feature family
 * (every acquisition channel that sells a sales funnel) — the only features the daily budget paces.
 */
router.patch("/brands/:brandId/daily-budget", requireApiKey, serviceAuth, validateBody(SetBrandCampaignsDailyBudgetBody), async (req: AuthenticatedRequest, res) => {
  try {
    const { brandId } = req.params;
    const orgId = req.orgId!;
    const { dailyBudgetCents } = req.body as { dailyBudgetCents: number | null };

    const updated = await db
      .update(campaigns)
      .set({ dailyBudgetCents, updatedAt: new Date() })
      .where(and(
        eq(campaigns.orgId, orgId),
        arrayContains(campaigns.brandIds, [brandId]),
        inArray(campaigns.featureSlug, SALES_FEATURE_SLUGS),
      ))
      .returning({ id: campaigns.id });

    res.json({
      brandId,
      orgId,
      dailyBudgetCents,
      updatedCount: updated.length,
    });
  } catch (error) {
    console.error("[campaign-service] Set brand campaigns daily budget error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /brands/:brandId/pause-history — read the pause on/off transition timeline.
 *
 * CLOSED history. These rows were written by `PATCH /brands/:brandId/pause` while a brand-wide
 * pause flag existed; that route and the flag are gone, so no new transition can ever be
 * recorded. The timeline is kept and still served because it is a real record of what happened to
 * these brands, and the Customer Success health board reads it — deleting it would lose the
 * history without answering anything. What a brand's CURRENT held state is comes from the money
 * (`GET /brands/:brandId/pause`), which is a different question with a different owner.
 *
 * Org-scoped. Returns transitions oldest first. No row → empty transitions array.
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
