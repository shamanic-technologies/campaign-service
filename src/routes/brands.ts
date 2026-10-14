import { Router } from "express";
import { and, asc, eq, inArray, isNotNull, or } from "drizzle-orm";
import { arrayContains } from "drizzle-orm/sql/expressions/conditions";
import { db } from "../db/index.js";
import { brandPauseTransitions, campaigns, salesFunnelCampaigns } from "../db/schema.js";
import { fetchBrandSalesFunnelCaps } from "../lib/sales-funnel-campaigns.js";
import { serviceAuth, requireApiKey, AuthenticatedRequest } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import { BatchSpendableBudgetBody } from "../schemas.js";
import { fetchBrandDailyBudget } from "../lib/brand-daily-budget-client.js";
import { SALES_FAMILY_FEATURE_SLUGS } from "../lib/sales-outreach-campaign.js";
import { LIVE_SOURCE_ORIGIN_SLUGS, RETIRED_SOURCE_ORIGIN_SLUGS } from "../lib/source-campaigns.js";
import {
  computeSpendableBudget,
  type SpendableBudget,
  type SpendableCampaign,
} from "../lib/spendable-budget.js";

const SOURCE_ORIGIN_SLUGS = [...LIVE_SOURCE_ORIGIN_SLUGS, ...RETIRED_SOURCE_ORIGIN_SLUGS];

const router = Router();

/**
 * GET /brands/:brandId/pause — is this brand HELD, i.e. does the customer fund nothing for it?
 *
 * The answer is the MONEY's, not a flag's (the stored `brand_pause.paused` flag outlived its writer
 * and is gone). Held ⟺ billing's brand daily budget (`GET /internal/brands/:id/daily-budget`) is not
 * positive AND no sales funnel of the brand is funded (billing's verdict, max budget and/or max
 * volume). billing's retired per-campaign ceilings are never read (owner 2026-10-14).
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

    const budget = await fetchBrandDailyBudget(brandId, { orgId, userId: req.userId ?? undefined });
    if (!budget.ok) {
      res.status(502).json({ error: "Brand funding unavailable" });
      return;
    }

    // A brand with a FUNDED sales funnel (max budget and/or max volume, billing's verdict) is not held.
    let paused = !(budget.dailyBudgetCents !== null && budget.dailyBudgetCents > 0);
    if (paused) {
      const caps = await fetchBrandSalesFunnelCaps(orgId, brandId);
      if (!caps.ok) {
        res.status(502).json({ error: "Brand funding unavailable" });
        return;
      }
      if (caps.caps.some((c) => c.fundedBy !== null)) paused = false;
    }

    res.json({
      brandId,
      orgId,
      paused,
      updatedAt: null,
    });
  } catch (error) {
    console.error("[campaign-service] Get brand pause error:", error);
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

/**
 * The sales-family and lead-source campaigns of one (org, brand) pair — ongoing AND stopped.
 *
 * A stopped campaign is what makes "configured but not running" legible: naming it is the
 * difference between "this campaign's money is idle because the campaign is stopped" and "there is
 * no such campaign", which are different things to a customer and to a staff audit.
 *
 * The brand is matched on the scalar identity column AND on the historical `brand_ids` array: the
 * scalar is written at creation and nothing re-derives it, but rows older than migration 0044
 * carry only the array, and a brand whose campaigns are all older would otherwise report nothing
 * running while it spends.
 */
async function loadSalesCampaigns(orgId: string, brandId: string): Promise<SpendableCampaign[]> {
  const rows = await db
    .select({
      id: campaigns.id,
      status: campaigns.status,
      featureSlug: campaigns.featureSlug,
      offerId: campaigns.offerId,
      legKey: campaigns.legKey,
      createdAt: campaigns.createdAt,
      salesFunnelCampaignId: campaigns.salesFunnelCampaignId,
    })
    .from(campaigns)
    .where(and(
      eq(campaigns.orgId, orgId),
      or(eq(campaigns.brandId, brandId), arrayContains(campaigns.brandIds, [brandId])),
      // Lead SOURCE campaigns too: billing funds each source per (offer, origin, start_to_lead_found),
      // and without its campaign here that money always read "not running". Sources stay OUT of the
      // sales family (that list is a pacing statement, lib/sales-outreach-campaign.ts).
      // SALES FUNNEL units of any channel too (their money is their funnel's, never a ceiling here).
      or(
        inArray(campaigns.featureSlug, [...SALES_FAMILY_FEATURE_SLUGS, ...SOURCE_ORIGIN_SLUGS]),
        isNotNull(campaigns.salesFunnelCampaignId),
      ),
    ));
  return rows;
}

/** Read the pair's funnel caps, join the pair's campaigns onto them, and answer both figures. */
async function spendableBudgetFor(
  orgId: string,
  brandId: string,
  userId?: string,
): Promise<{ ok: true; budget: SpendableBudget } | { ok: false; reason: string }> {
  // The brand's SALES FUNNEL caps (billing) count each funnel campaign by its max budget per day: the
  // only money a campaign has (owner 2026-10-14). Fail LOUD: a smaller figure is the silent
  // under-count this endpoint removes.
  const caps = await fetchBrandSalesFunnelCaps(orgId, brandId);
  if (!caps.ok) return { ok: false, reason: `billing did not answer the brand's sales funnel caps (${caps.detail})` };
  const ownerRows = await db
    .select({
      id: salesFunnelCampaigns.id,
      offerId: salesFunnelCampaigns.offerId,
      salesFunnelId: salesFunnelCampaigns.salesFunnelId,
      status: salesFunnelCampaigns.status,
    })
    .from(salesFunnelCampaigns)
    .where(and(eq(salesFunnelCampaigns.orgId, orgId), eq(salesFunnelCampaigns.brandId, brandId)));

  const campaignRows = await loadSalesCampaigns(orgId, brandId);
  return {
    ok: true,
    budget: computeSpendableBudget(orgId, brandId, campaignRows, {
      caps: caps.caps,
      salesFunnelCampaigns: ownerRows,
    }),
  };
}

/**
 * GET /brands/:brandId/spendable-budget — of the money configured for this brand, how much is
 * attached to a campaign that is currently RUNNING?
 *
 * Both figures, always: `configuredDailyBudgetCents` is what the customer set (a paused campaign's
 * settings screen must still show it, or it reads as lost), `runningDailyBudgetCents` is the part
 * of it a live campaign stands behind. `offers`, `campaigns` and `rows` decompose the same answer
 * per offer, per campaign and per ceiling, so a consumer never adds anything up and can say which
 * campaigns contributed and which did not.
 *
 * 502 when billing cannot be read — never a smaller figure. Org-scoped via x-org-id.
 */
router.get("/brands/:brandId/spendable-budget", requireApiKey, serviceAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { brandId } = req.params;
    const orgId = req.orgId!;

    const result = await spendableBudgetFor(orgId, brandId, req.userId ?? undefined);
    if (!result.ok) {
      res.status(502).json({ error: "Brand funding unavailable" });
      return;
    }
    res.json(result.budget);
  } catch (error) {
    console.error("[campaign-service] Get brand spendable budget error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * POST /brands/spendable-budget — the same answer for MANY (org, brand) pairs in one request.
 *
 * A staff audit walks every account, so one request per brand is not an option. The pairs come in
 * the body because the answer is per (org, brand) — the same brand row is claimed by several orgs
 * and each claim configures its own money — and because a staff caller crosses orgs, which no
 * single `x-org-id` can express.
 *
 * A pair billing cannot be read for is named in `unavailable` and carries NO figures at all: a
 * zero would silently shrink a fleet total, which is the very failure this endpoint removes.
 * Every brand answered here is answered by the same code as the per-brand route above, so the two
 * cannot drift.
 */
router.post("/brands/spendable-budget", requireApiKey, validateBody(BatchSpendableBudgetBody), async (req, res) => {
  try {
    const { brands } = req.body as { brands: Array<{ orgId: string; brandId: string }> };

    const answered: SpendableBudget[] = [];
    const unavailable: Array<{ orgId: string; brandId: string; reason: string }> = [];

    // Bounded fan-out: one billing read per pair, a few at a time, so a fleet sweep does not open
    // 500 sockets at once against billing.
    const CONCURRENCY = 8;
    let cursor = 0;
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, brands.length) }, async () => {
        for (;;) {
          const index = cursor++;
          const pair = brands[index];
          if (!pair) return;
          const result = await spendableBudgetFor(pair.orgId, pair.brandId);
          if (result.ok) answered.push(result.budget);
          else unavailable.push({ orgId: pair.orgId, brandId: pair.brandId, reason: result.reason });
        }
      }),
    );

    res.json({ brands: answered, unavailable });
  } catch (error) {
    console.error("[campaign-service] Batch brand spendable budget error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
