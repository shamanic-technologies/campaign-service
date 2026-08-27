import { Router } from "express";
import { and, asc, eq, inArray, or } from "drizzle-orm";
import { arrayContains } from "drizzle-orm/sql/expressions/conditions";
import { db } from "../db/index.js";
import { brandPauseTransitions, campaigns } from "../db/schema.js";
import { serviceAuth, requireApiKey, AuthenticatedRequest } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import { BatchSpendableBudgetBody, SetBrandCampaignsDailyBudgetBody } from "../schemas.js";
import { fetchFunnelBudgets } from "../lib/funnel-budget-client.js";
import { brandHeldFromBudgets } from "../lib/campaign-funding.js";
import {
  OUTBOUND_SALES_FEATURE_SLUGS,
  SALES_FUNNEL_FEATURE_SLUGS,
} from "../lib/sales-outreach-campaign.js";
import {
  computeSpendableBudget,
  type SpendableBudget,
  type SpendableCampaign,
} from "../lib/spendable-budget.js";

// The per-campaign `daily_budget_cents` MIRROR — the legacy brand-page lever, which gate-check
// still prefers over every billing ceiling when it is set. Scoped to the OUTBOUND cold-email
// channels, i.e. exactly the campaigns that carry it today.
//
// A paid-reach campaign is deliberately NOT stamped: its ceiling is billing's, stated per (funnel,
// channel, offer) and read live on every plan, and writing a brand-level number onto its row would
// bind it AHEAD of the offer ceiling it was funded on — a second representation of one fact, which
// is the thing this service keeps deleting.
const SALES_FEATURE_SLUGS = [...OUTBOUND_SALES_FEATURE_SLUGS];

const router = Router();

/**
 * GET /brands/:brandId/pause — is this brand HELD, i.e. does the customer fund nothing for it?
 *
 * The answer is the MONEY's, not a flag's. It used to be a stored boolean (`brand_pause.paused`)
 * that the customer dashboard wrote; that control was deleted when the product decided a customer
 * stops a funnel by dropping its ceiling to zero, and the flag outlived its writer — 27 brands
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
 * brand daily budget again. Scoped to the OUTBOUND cold-email channels — see SALES_FEATURE_SLUGS
 * for why a paid-reach campaign is left to the live billing ceiling instead.
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

/**
 * The sales-family campaigns of one (org, brand) pair — ongoing AND stopped.
 *
 * A stopped campaign is what makes "configured but not running" legible: naming it is the
 * difference between "this funnel's money is idle because the campaign is stopped" and "there is
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
      funnelKey: campaigns.funnelKey,
      featureSlug: campaigns.featureSlug,
      offerId: campaigns.offerId,
      createdAt: campaigns.createdAt,
    })
    .from(campaigns)
    .where(and(
      eq(campaigns.orgId, orgId),
      or(eq(campaigns.brandId, brandId), arrayContains(campaigns.brandIds, [brandId])),
      inArray(campaigns.featureSlug, [...SALES_FUNNEL_FEATURE_SLUGS]),
    ));
  return rows;
}

/** Read billing once for the pair, join the pair's campaigns onto it, and answer both figures. */
async function spendableBudgetFor(
  orgId: string,
  brandId: string,
  userId?: string,
): Promise<{ ok: true; budget: SpendableBudget } | { ok: false; reason: string }> {
  const budgets = await fetchFunnelBudgets(brandId, { orgId, userId });
  // Fail LOUD. A brand whose ceilings cannot be read is not a brand funding nothing, and
  // reporting it as a smaller figure is exactly the silent under-count this endpoint exists to
  // remove from the staff numbers.
  if (!budgets.ok) return { ok: false, reason: "billing did not answer the brand's budget" };

  const campaignRows = await loadSalesCampaigns(orgId, brandId);
  return { ok: true, budget: computeSpendableBudget(orgId, brandId, budgets, campaignRows) };
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
