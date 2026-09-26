import { ceilingEntriesOf, type CampaignBudgetsRead } from "./campaign-budget-client.js";

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
 * total are all stated, alongside the individual ceiling entries that produced them.
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
}

/**
 * WHICH billing grain the figures were computed at: `campaign` when billing states ceilings per
 * (offer, leg, channel), `brand` when the brand has only its one pot, `none` when nothing was ever
 * configured.
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
}

interface RawRow {
  featureSlug: string | null;
  offerId: string | null;
  legKey: string | null;
  dailyBudgetCents: number;
}

/**
 * The campaign standing behind ONE ceiling entry, or null.
 *
 * A campaign stands behind an entry exactly when that entry is among the ceilings it is PACED on
 * (`ceilingEntriesOf`, billing's own rule) — so a campaign counts as running here exactly when the
 * gate would let it spend that money. At brand grain every campaign draws on the one pot.
 *
 * An ONGOING campaign always wins over a stopped one, whatever their creation dates: the stopped
 * row is history, the ongoing one is what spends the money. Ties break on the oldest campaign so
 * the answer is stable between calls.
 */
function campaignForRow(
  row: RawRow,
  all: SpendableCampaign[],
  budgets: Extract<CampaignBudgetsRead, { ok: true }>,
  grain: SpendableGrain,
): SpendableCampaign | null {
  const candidates = grain === "brand"
    ? all
    : all.filter((c) => ceilingEntriesOf(budgets, c).some(
      (e) => e.featureSlug === row.featureSlug && e.offerId === row.offerId && e.legKey === row.legKey,
    ));
  if (candidates.length === 0) return null;
  const rank = (c: SpendableCampaign) => (c.status === "ongoing" ? 0 : 1);
  return [...candidates].sort(
    (a, b) => rank(a) - rank(b) || a.createdAt.getTime() - b.createdAt.getTime(),
  )[0]!;
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
  budgets: Extract<CampaignBudgetsRead, { ok: true }>,
  campaigns: SpendableCampaign[],
): SpendableBudget {
  let grain: SpendableGrain;
  let rawRows: RawRow[];
  if (budgets.campaigns.length > 0) {
    grain = "campaign";
    rawRows = budgets.campaigns.map((e) => ({ ...e }));
  } else if (budgets.brandDailyBudgetCents !== null) {
    grain = "brand";
    rawRows = [{ featureSlug: null, offerId: null, legKey: null, dailyBudgetCents: budgets.brandDailyBudgetCents }];
  } else {
    grain = "none";
    rawRows = [];
  }

  const configuredByCampaign = new Map<string, number>();
  const runningByCampaign = new Map<string, number>();
  const seenCampaign = new Map<string, SpendableCampaign>();

  const rows: SpendableRow[] = rawRows.map((raw) => {
    const campaign = campaignForRow(raw, campaigns, budgets, grain);
    const running = campaign?.status === "ongoing";
    if (campaign) {
      seenCampaign.set(campaign.id, campaign);
      configuredByCampaign.set(
        campaign.id,
        (configuredByCampaign.get(campaign.id) ?? 0) + raw.dailyBudgetCents,
      );
      if (running) {
        runningByCampaign.set(
          campaign.id,
          (runningByCampaign.get(campaign.id) ?? 0) + raw.dailyBudgetCents,
        );
      }
    }
    return {
      featureSlug: raw.featureSlug,
      offerId: raw.offerId,
      legKey: raw.legKey,
      resolvedOfferId: raw.offerId ?? campaign?.offerId ?? null,
      dailyBudgetCents: raw.dailyBudgetCents,
      running,
      campaignId: campaign?.id ?? null,
      campaignStatus: campaign?.status ?? null,
    };
  });

  // Every ONGOING campaign is named even when no ceiling stands behind it — a running campaign
  // funded at nothing is exactly what a consumer needs to see, and its absence would read as
  // "there is no such campaign".
  for (const c of campaigns) {
    if (c.status === "ongoing") seenCampaign.set(c.id, c);
  }

  const campaignLines: SpendableCampaignLine[] = [...seenCampaign.values()]
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .map((c) => ({
      campaignId: c.id,
      status: c.status,
      running: c.status === "ongoing",
      featureSlug: c.featureSlug,
      offerId: c.offerId,
      legKey: c.legKey,
      configuredDailyBudgetCents: configuredByCampaign.get(c.id) ?? 0,
      runningDailyBudgetCents: runningByCampaign.get(c.id) ?? 0,
    }));

  const offerMap = new Map<string | null, SpendableOfferLine>();
  for (const row of rows) {
    const key = row.resolvedOfferId;
    const line = offerMap.get(key) ?? {
      offerId: key,
      configuredDailyBudgetCents: 0,
      runningDailyBudgetCents: 0,
      campaignIds: [],
    };
    line.configuredDailyBudgetCents += row.dailyBudgetCents;
    if (row.running) line.runningDailyBudgetCents += row.dailyBudgetCents;
    if (row.campaignId && !line.campaignIds.includes(row.campaignId)) {
      line.campaignIds.push(row.campaignId);
    }
    offerMap.set(key, line);
  }

  return {
    orgId,
    brandId,
    grain,
    configuredDailyBudgetCents: rows.reduce((sum, r) => sum + r.dailyBudgetCents, 0),
    runningDailyBudgetCents: rows.reduce((sum, r) => sum + (r.running ? r.dailyBudgetCents : 0), 0),
    offers: [...offerMap.values()],
    campaigns: campaignLines,
    rows,
  };
}
