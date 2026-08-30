import {
  toFunnelKey,
  type SalesFunnelKey,
} from "./sales-funnel-vocabulary.js";
import type { FunnelBudgetsRead } from "./funnel-budget-client.js";

/**
 * "Of the money this brand has CONFIGURED, how much is attached to a campaign that is actually
 * RUNNING?"
 *
 * Nobody could answer that from one service: billing-service knows what every ceiling is worth and
 * campaign-service is the only place that knows whether a campaign exists for it and whether that
 * campaign is ongoing. Every consumer was therefore reading billing's brand daily-budget figure —
 * the SUM of every configured ceiling regardless of whether anything is running behind it — so the
 * staff MRR figure read ~28% high (measured 2026-08-27: $138/day configured across 9 brands, ~$25
 * of it on funnels whose campaign is stopped or was never created, two brands with no campaign at
 * all), and "is this account active" was decided by a brand-level pause flag with no writer since
 * July. The dashboard patched it by fetching the campaign list and the per-funnel budgets and
 * joining them in the browser — duplicated in one app, absent in the other, unreachable from
 * features-service. The join belongs here.
 *
 * BOTH figures are served, never one. A campaign's own settings screen must still show the amount
 * the customer set even while it is paused, or it reads as zero and looks like the setting was
 * lost.
 *
 * NOTHING IS LEFT FOR A CONSUMER TO SUM. The brand total, each offer's total and each campaign's
 * total are all stated, alongside the individual ceiling rows that produced them — so a consumer
 * answers the same question for one offer or one campaign out of the SAME response, and can say
 * which campaigns contributed and which did not.
 */

/** A campaign of the (org, brand) pair, as this computation needs it. */
export interface SpendableCampaign {
  id: string;
  status: string;
  funnelKey: string | null;
  featureSlug: string | null;
  offerId: string | null;
  /** The single funnel LEG this campaign was bought for — the grain it is funded at. */
  legKey: string | null;
  createdAt: Date;
}

/**
 * WHICH billing grain the figures were computed at.
 *
 * billing serves the same money at five widths — per (funnel, channel, offer, LEG), per (funnel,
 * channel, offer), per (funnel, channel), per funnel, and one brand pot — and the coarser four are
 * SUMS of the finer, so exactly ONE of them may be counted or the same dollar is counted twice.
 * The finest one billing actually states is chosen, once, here.
 *
 * The LEG is the finest and it is the grain a campaign is BOUGHT at: one (funnel, channel, offer)
 * worked for two legs is TWO campaigns, so counting at the offer grain would find one campaign for
 * a row that funds two and report the other as running on nothing.
 */
export type SpendableGrain = "leg" | "offer" | "channel" | "funnel" | "brand" | "none";

/** One configured ceiling, and the campaign (if any) standing behind it. */
export interface SpendableRow {
  /** Canonical funnel key, or null at brand grain (one undifferentiated pot). */
  funnelKey: SalesFunnelKey | null;
  /** The acquisition channel this ceiling funds — a features-service feature slug — or null. */
  featureSlug: string | null;
  /** The offer billing SCOPED this ceiling to, or null for a ceiling written before offers. */
  offerId: string | null;
  /** The funnel LEG billing scoped this ceiling to, or null for a ceiling written before legs. */
  legKey: string | null;
  /**
   * The offer this money actually works for: billing's when it states one, else the offer of the
   * campaign standing behind it. Production still carries ceilings written before the offer level
   * while every running campaign carries an offer, so grouping on `offerId` alone would file real,
   * running money under "no offer" and it would appear on nobody's offer page.
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
  funnelKey: string | null;
  featureSlug: string | null;
  offerId: string | null;
  /** The single funnel LEG this campaign was bought for, or null when it states none. */
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
  /** Everything the customer has configured for this brand, at `grain`. */
  configuredDailyBudgetCents: number;
  /** The part of it attached to a campaign that is ongoing right now. */
  runningDailyBudgetCents: number;
  offers: SpendableOfferLine[];
  campaigns: SpendableCampaignLine[];
  rows: SpendableRow[];
}

interface RawRow {
  funnelKey: SalesFunnelKey | null;
  featureSlug: string | null;
  offerId: string | null;
  legKey: string | null;
  dailyBudgetCents: number;
}

/**
 * The finest grain billing actually states, and its rows. Exactly one grain is ever counted — the
 * coarser fields are billing's own sums of the finer ones, so mixing them double-counts.
 */
function rowsAtFinestGrain(
  budgets: Extract<FunnelBudgetsRead, { ok: true }>,
): { grain: SpendableGrain; rows: RawRow[] } {
  // The LEG grain first: it is the finest billing stores and the one a campaign is bought at.
  const legs = budgets.legs ?? [];
  if (legs.length > 0) {
    return {
      grain: "leg",
      rows: legs.map((l) => ({
        funnelKey: l.funnelKey,
        featureSlug: l.featureSlug,
        offerId: l.offerId,
        legKey: l.legKey,
        dailyBudgetCents: l.dailyBudgetCents,
      })),
    };
  }

  const offers = budgets.offers ?? [];
  if (offers.length > 0) {
    return {
      grain: "offer",
      rows: offers.map((o) => ({
        funnelKey: o.funnelKey,
        featureSlug: o.featureSlug,
        offerId: o.offerId,
        legKey: null,
        dailyBudgetCents: o.dailyBudgetCents,
      })),
    };
  }

  const channels = budgets.channels ?? [];
  if (channels.length > 0) {
    return {
      grain: "channel",
      rows: channels.map((c) => ({
        funnelKey: c.funnelKey,
        featureSlug: c.featureSlug,
        offerId: null,
        legKey: null,
        dailyBudgetCents: c.dailyBudgetCents,
      })),
    };
  }

  if (budgets.funnels.length > 0) {
    return {
      grain: "funnel",
      rows: budgets.funnels.map((f) => ({
        funnelKey: f.funnelKey,
        featureSlug: null,
        offerId: null,
        legKey: null,
        dailyBudgetCents: f.dailyBudgetCents,
      })),
    };
  }

  if (budgets.brandDailyBudgetCents !== null) {
    return {
      grain: "brand",
      rows: [
        {
          funnelKey: null,
          featureSlug: null,
          offerId: null,
          legKey: null,
          dailyBudgetCents: budgets.brandDailyBudgetCents,
        },
      ],
    };
  }

  return { grain: "none", rows: [] };
}

/**
 * The campaign standing behind ONE ceiling, or null.
 *
 * The matching rules are billing's own, mirrored from `channelCeilingCents` / `offerCeilingCents`
 * so that a campaign counts as running here exactly when the gate would let it spend that ceiling:
 *
 *   - the funnel must match (canonicalised on both sides — billing still emits the pre-rename
 *     spellings to this day, so comparing raw tokens reads a fully funded funnel as unfunded);
 *   - the channel must match, EXCEPT where the funnel is worked through exactly one channel, which
 *     binds whatever feature the campaign states;
 *   - a ceiling that NAMES an offer belongs to that offer's campaign; an UNSCOPED ceiling (every
 *     ceiling written before offers existed, and most of production today) belongs to the campaign
 *     on its (funnel, channel) whatever offer that campaign states — dropping those would report a
 *     running figure of zero for brands that are demonstrably spending.
 *
 * An ONGOING campaign always wins over a stopped one, whatever their creation dates: the stopped
 * row is history, the ongoing one is what spends the money. Ties break on the oldest campaign so
 * the answer is stable between calls.
 */
function campaignForRow(row: RawRow, all: SpendableCampaign[], rowsOfGrain: RawRow[]): SpendableCampaign | null {
  const byFunnel = all.filter((c) => {
    if (row.funnelKey === null) return true; // brand grain — one pot, every campaign draws on it
    return c.funnelKey ? toFunnelKey(c.funnelKey) === row.funnelKey : false;
  });
  if (byFunnel.length === 0) return null;

  let candidates = byFunnel;
  if (row.featureSlug) {
    const exact = byFunnel.filter((c) => c.featureSlug === row.featureSlug);
    if (exact.length > 0) {
      candidates = exact;
    } else {
      // billing's sole-channel rule: a funnel funded through exactly one channel binds whatever
      // feature the campaign states. A funnel SPLIT across channels funds only what it names.
      const channelsOfFunnel = new Set(
        rowsOfGrain.filter((r) => r.funnelKey === row.funnelKey).map((r) => r.featureSlug),
      );
      if (channelsOfFunnel.size !== 1) return null;
    }
  }

  if (row.offerId) {
    candidates = candidates.filter((c) => c.offerId === row.offerId);
  }
  // The LEG is what the campaign was BOUGHT for, so a ceiling that names one belongs to the
  // campaign of THAT leg and to no other. Without this, two campaigns of one (funnel, channel,
  // offer) both match both of its leg rows and the older one is reported as running the money
  // funded for the other.
  if (row.legKey) {
    candidates = candidates.filter((c) => c.legKey === row.legKey);
  }
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
  budgets: Extract<FunnelBudgetsRead, { ok: true }>,
  campaigns: SpendableCampaign[],
): SpendableBudget {
  const { grain, rows: rawRows } = rowsAtFinestGrain(budgets);

  const configuredByCampaign = new Map<string, number>();
  const runningByCampaign = new Map<string, number>();
  const seenCampaign = new Map<string, SpendableCampaign>();

  const rows: SpendableRow[] = rawRows.map((raw) => {
    const campaign = campaignForRow(raw, campaigns, rawRows);
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
      funnelKey: raw.funnelKey,
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
      funnelKey: c.funnelKey,
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
