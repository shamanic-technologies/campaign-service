import type { StatedSalesFunnelCap } from "./sales-funnel-campaigns.js";

/**
 * "Of the money this brand has CONFIGURED, how much is attached to a campaign that is actually
 * RUNNING?"
 *
 * Nobody could answer that from one service: billing-service knows what every ceiling is worth and
 * campaign-service is the only place that knows whether a campaign exists for it and whether that
 * campaign is ongoing. The join belongs here.
 *
 * BOTH figures are served, never one. A campaign's own settings screen must still show the amount
 * the customer set even while it is paused, or it reads as zero and looks like the setting was
 * lost.
 *
 * NOTHING IS LEFT FOR A CONSUMER TO SUM. The brand total, each offer's total and each campaign's
 * total are all stated.
 *
 * ONE money model (owner 2026-10-14): a campaign's money is its SALES FUNNEL's caps, counted under
 * `salesFunnels`. billing's per-campaign daily ceilings are retired and never read, so `rows` is
 * always empty and `grain` always `none` (both kept so a reader's shape does not move).
 */

/** A campaign of the (org, brand) pair, as this computation needs it. */
export interface SpendableCampaign {
  id: string;
  status: string;
  featureSlug: string | null;
  offerId: string | null;
  /** The single LEG this campaign was bought for — the grain it is funded at. */
  legKey: string | null;
  createdAt: Date;
  /**
   * Set on a SALES FUNNEL unit (lib/sales-funnel-campaigns.ts). A unit is never resolved onto a
   * per-pipe ceiling: its money is its funnel's caps, counted under `salesFunnels`.
   */
  salesFunnelCampaignId?: string | null;
}

/** A funnel campaign of the pair, as this computation needs it. */
export interface SpendableSalesFunnelCampaign {
  id: string;
  offerId: string;
  salesFunnelId: string;
  status: string;
}

/**
 * One SALES FUNNEL's money for the pair: its stated max budget as billing's own daily figure
 * (daily x1, weekly / 7, monthly / 30, one_off 0, reactive 0), and the funnel campaign spending it.
 */
export interface SpendableSalesFunnelLine {
  offerId: string;
  salesFunnelId: string;
  salesFunnelCampaignId: string | null;
  status: string | null;
  /** True ⟺ the funnel campaign exists AND is ongoing. */
  running: boolean;
  maxBudget: { amountCents: number; period: string } | null;
  /** billing's verdict: which cap funds it (null = not funded). `max_volume` = funded, $0/day. */
  fundedBy: "max_budget" | "max_volume" | "both" | null;
  dailyBudgetCents: number;
  /** False for a one-off or REACTIVE max budget: a real ceiling, but never a daily figure (adds 0). */
  recurring: boolean;
  unitCampaignIds: string[];
}

/**
 * The grain of the retired per-campaign / brand-pot rows. Always `none` since the one money model
 * (owner 2026-10-14); `campaign` and `brand` are no longer served.
 */
export type SpendableGrain = "campaign" | "brand" | "none";

/** One configured ceiling, and the campaign (if any) standing behind it. */
export interface SpendableRow {
  /** The acquisition channel this ceiling funds — a features-service feature slug — or null. */
  featureSlug: string | null;
  /** The offer billing SCOPED this ceiling to, or null for a ceiling written before offers. */
  offerId: string | null;
  /** The LEG billing scoped this ceiling to, or null for a ceiling written before legs. */
  legKey: string | null;
  /**
   * The offer this money actually works for: billing's when it states one, else the offer of the
   * campaign standing behind it — so money written before the offer level is filed under the
   * offer that spends it, not under "no offer".
   */
  resolvedOfferId: string | null;
  dailyBudgetCents: number;
  /** True ⟺ a campaign for this ceiling exists AND is ongoing. */
  running: boolean;
  /** The campaign standing behind this ceiling — ongoing when there is one, else the stopped one. */
  campaignId: string | null;
  campaignStatus: string | null;
}

export interface SpendableCampaignLine {
  campaignId: string;
  status: string;
  running: boolean;
  featureSlug: string | null;
  offerId: string | null;
  /** The single LEG this campaign was bought for, or null when it states none. */
  legKey: string | null;
  /** The funnel campaign owning this unit; null on a pre-funnel campaign. A unit's own figures are 0. */
  salesFunnelCampaignId: string | null;
  configuredDailyBudgetCents: number;
  runningDailyBudgetCents: number;
}

export interface SpendableOfferLine {
  offerId: string | null;
  configuredDailyBudgetCents: number;
  runningDailyBudgetCents: number;
  campaignIds: string[];
}

export interface SpendableBudget {
  orgId: string;
  brandId: string;
  grain: SpendableGrain;
  /** Everything the customer has configured for this brand. */
  configuredDailyBudgetCents: number;
  /** The part of it attached to a campaign that is ongoing right now. */
  runningDailyBudgetCents: number;
  offers: SpendableOfferLine[];
  campaigns: SpendableCampaignLine[];
  rows: SpendableRow[];
  /** The brand's sales funnels with a stated cap; their daily figures are inside both totals. */
  salesFunnels: SpendableSalesFunnelLine[];
}

/**
 * Answer both figures for one (org, brand), from ceilings and campaigns ALREADY read — so a
 * fleet-wide caller judges every brand with one read each rather than one request per brand.
 *
 * `campaigns` must be the pair's sales-family campaigns (ongoing AND stopped): a stopped campaign
 * is what makes "configured but not running" legible, and it is named rather than merely absent.
 */
export function computeSpendableBudget(
  orgId: string,
  brandId: string,
  campaigns: SpendableCampaign[],
  owned: { caps: StatedSalesFunnelCap[]; salesFunnelCampaigns: SpendableSalesFunnelCampaign[] } = { caps: [], salesFunnelCampaigns: [] },
): SpendableBudget {
  // Every ONGOING campaign is named even when nothing funds it — a running campaign funded at
  // nothing is exactly what a consumer needs to see, and its absence would read as "there is no
  // such campaign". A campaign's own figures are 0: its money is its funnel's, counted below.
  const campaignLines: SpendableCampaignLine[] = campaigns
    .filter((c) => c.status === "ongoing")
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .map((c) => ({
      campaignId: c.id,
      status: c.status,
      running: true,
      featureSlug: c.featureSlug,
      offerId: c.offerId,
      legKey: c.legKey,
      salesFunnelCampaignId: c.salesFunnelCampaignId ?? null,
      configuredDailyBudgetCents: 0,
      runningDailyBudgetCents: 0,
    }));

  const offerMap = new Map<string | null, SpendableOfferLine>();

  // SALES FUNNELS: each stated cap counts once, by its max budget per day, under its offer. A cap
  // with no funnel campaign yet is configured money that nothing runs.
  const salesFunnels: SpendableSalesFunnelLine[] = owned.caps.map((cap) => {
    const fc = owned.salesFunnelCampaigns.find(
      (f) => f.offerId === cap.offerId && f.salesFunnelId === cap.salesFunnelId,
    ) ?? null;
    const running = fc?.status === "ongoing";
    // billing's own per-day figure of the cap (reactive and one-off = 0), never recomputed here.
    const dailyBudgetCents = cap.maxBudget?.dailyBudgetCents ?? 0;
    const unitCampaignIds = fc
      ? campaigns.filter((c) => c.salesFunnelCampaignId === fc.id).map((c) => c.id)
      : [];
    const line = offerMap.get(cap.offerId) ?? {
      offerId: cap.offerId,
      configuredDailyBudgetCents: 0,
      runningDailyBudgetCents: 0,
      campaignIds: [],
    };
    line.configuredDailyBudgetCents += dailyBudgetCents;
    if (running) line.runningDailyBudgetCents += dailyBudgetCents;
    for (const id of unitCampaignIds) if (!line.campaignIds.includes(id)) line.campaignIds.push(id);
    offerMap.set(cap.offerId, line);
    return {
      offerId: cap.offerId,
      salesFunnelId: cap.salesFunnelId,
      salesFunnelCampaignId: fc?.id ?? null,
      status: fc?.status ?? null,
      running,
      maxBudget: cap.maxBudget ? { amountCents: cap.maxBudget.amountCents, period: cap.maxBudget.period } : null,
      fundedBy: cap.fundedBy,
      dailyBudgetCents,
      recurring: dailyBudgetCents > 0,
      unitCampaignIds,
    };
  });

  const capsConfigured = salesFunnels.reduce((sum, f) => sum + f.dailyBudgetCents, 0);
  const capsRunning = salesFunnels.reduce((sum, f) => sum + (f.running ? f.dailyBudgetCents : 0), 0);

  return {
    orgId,
    brandId,
    grain: "none",
    configuredDailyBudgetCents: capsConfigured,
    runningDailyBudgetCents: capsRunning,
    offers: [...offerMap.values()],
    campaigns: campaignLines,
    rows: [],
    salesFunnels,
  };
}
