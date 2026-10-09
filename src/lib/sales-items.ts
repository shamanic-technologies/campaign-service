import { sameLeg } from "./leg-identity.js";
/**
 * ITEMS MODE — one budget per CAMPAIGN (owner, 2026-10-04).
 *
 * The customer sets one budget per campaign (offer x leg x channel) on the offer's Sales path page
 * and turns each campaign on or off (that on/off is this service's own campaign status, never
 * billing's). billing-service holds the budget on the campaign's ceiling row and answers the brand's
 * sales-budget mode as `items` for a brand holding a subscriber's MONTHLY budget; every other brand
 * reads its ceilings exactly as before. From that moment the brand's money is its items, and only
 * its items:
 *
 *   - An item's budget is spent ONLY by the campaign performing exactly that (offer, leg, channel).
 *     No fuzzy match, no fallback to a coarser figure: a campaign no item names is NOT funded (it
 *     waits, like any unfunded campaign; its status never changes).
 *   - The global pot does not exist for that brand. Items are independent: one item spent, held or
 *     unreadable never stops another item's campaign.
 *   - `period: "day"`: the budget is what the campaign may commit today.
 *   - `period: "month"` (any payment mode, subscribers included): the budget covers billing's stated
 *     period and is a MAX on it, proactive or reactive alike: the campaign spends as fast as the work
 *     allows while what it committed since the period start is under the budget, then waits for the
 *     next period (owner 2026-10-05: "exactly like a daily budget, per month"). No even pacing, no
 *     daily allowance derived from it.
 *   - Proactive or reactive is billing's `role` when it states one (it priced the budget on it);
 *     `null` (billing could not read the catalogue for it) falls back to this service's own catalogue
 *     read of the leg.
 *   - A per-campaign ceiling that exists today (the campaign's own `dailyBudgetCents`, or a billing
 *     ceiling at the campaign grain) stays an upper bound on a DAILY item. A MONTHLY item is bound
 *     only by the campaign's own `dailyBudgetCents` (a person's daily cap, against today's spend):
 *     billing's campaign-grain ceiling for a monthly row is that same budget / 30, the pacing the
 *     owner does not want.
 *   - An item on a channel we do not run (`managed: false`) spends nothing; `managed: null` (billing
 *     could not say) holds THAT campaign as unreadable. This service never creates a campaign from
 *     money (owner rule 1).
 *
 * Pure rules only (no I/O), each with a unit test. The reads live in `sales-items-pace.ts`.
 */

export interface SalesItem {
  offerId: string;
  legKey: string;
  /** The channel, a features-service feature slug. */
  featureSlug: string;
  /** For the whole period, in cents (directly comparable to runs-service *CostInUsdCents). */
  budgetCents: number;
  period: "day" | "month";
  /** The billing period a monthly budget covers. null for a daily item. */
  periodStart: Date | null;
  periodEnd: Date | null;
  /** billing's statement of how the budget is meant; null = billing could not read the catalogue. */
  role: "proactive" | "reactive" | null;
  /**
   * false = a channel we do not run yet: billing records the commitment and charges nothing, and
   * this service never lets it fund a run, even if some campaign happened to perform it.
   * null = billing could not say (its catalogue read failed): the campaign is held as unreadable.
   */
  managed: boolean | null;
}

export interface SalesItemKey {
  offerId?: string | null;
  legKey?: string | null;
  featureSlug?: string | null;
}

/**
 * The items naming exactly this campaign's (offer, leg, channel). Offer ids are UUIDs compared
 * case-insensitively (billing stores them lowercased). Whether an item may FUND a run (`managed`)
 * is `itemPace`'s question, not this match's.
 */
export function itemsOf(items: readonly SalesItem[], c: SalesItemKey): SalesItem[] {
  if (!c.offerId || !c.legKey || !c.featureSlug) return [];
  const offerId = c.offerId.toLowerCase();
  return items.filter(
    (i) => i.offerId.toLowerCase() === offerId && i.featureSlug === c.featureSlug && sameLeg(c.featureSlug, i.legKey, c.legKey),
  );
}

/** Is this item reactive? billing's stated role wins; null falls back to our own catalogue read. */
export function itemIsReactive(item: SalesItem, catalogueReactive: boolean): boolean {
  return item.role === null ? catalogueReactive : item.role === "reactive";
}

/** Start of the day `now` falls in, on the same (server-local) clock every daily window here uses. */
export function startOfDay(now: Date): Date {
  const d = new Date(now.getTime());
  d.setHours(0, 0, 0, 0);
  return d;
}

export type ItemPace =
  /**
   * The campaign may run while `spentCents < capCents`: today's figures for a daily item, the
   * period's for a monthly one. `spentTodayCents` is today's committed spend either way.
   */
  | { ok: true; spentCents: number; capCents: number; spentTodayCents: number; item: SalesItem; reactive: boolean }
  | {
      ok: false;
      /**
       * `no_item` / `unmanaged`: nothing funds it (an expected state). `period_not_current`,
       * `ambiguous`, `managed_unknown`: a fault (the campaign is held, fail-closed).
       */
      reason: "no_item" | "unmanaged" | "period_not_current" | "ambiguous" | "managed_unknown";
      detail: string;
    };

/**
 * What ONE campaign may commit, from its item and its spend: today's budget for a daily item, the
 * whole period's for a monthly one.
 *
 * `spentTodayCents`: committed today. `spentInPeriodCents`: committed since the item's period start
 * (monthly items only; ignored for a daily item). `reactive`: our own catalogue read of the leg, used
 * only when billing states no role.
 */
export function itemPace(input: {
  items: readonly SalesItem[];
  campaign: SalesItemKey;
  reactive: boolean;
  spentTodayCents: number;
  spentInPeriodCents?: number;
  now: Date;
}): ItemPace {
  const { campaign, spentTodayCents, now } = input;
  const scope = `offer ${campaign.offerId ?? "none"}, leg ${campaign.legKey ?? "none"}, channel ${campaign.featureSlug ?? "none"}`;
  const mine = itemsOf(input.items, campaign);
  if (mine.length === 0) {
    return { ok: false, reason: "no_item", detail: `no active sales path budgets this campaign (${scope})` };
  }
  if (mine.length > 1) {
    return { ok: false, reason: "ambiguous", detail: `billing states ${mine.length} item budgets for one campaign (${scope})` };
  }
  const item = mine[0];
  if (item.managed === false) {
    return { ok: false, reason: "unmanaged", detail: `the channel of ${scope} is not one we run, so its budget funds no run` };
  }
  if (item.managed === null) {
    return { ok: false, reason: "managed_unknown", detail: `billing could not say whether we run the channel of ${scope}` };
  }
  const reactive = itemIsReactive(item, input.reactive);

  if (item.period === "day") {
    return { ok: true, spentCents: spentTodayCents, capCents: item.budgetCents, spentTodayCents, item, reactive };
  }

  const start = item.periodStart!;
  const end = item.periodEnd!;
  if (now < start || now >= end) {
    return {
      ok: false,
      reason: "period_not_current",
      detail: `the monthly item budget for ${scope} covers ${start.toISOString()} to ${end.toISOString()}, which is not now`,
    };
  }
  const inPeriod = Math.max(0, input.spentInPeriodCents ?? 0);
  return { ok: true, spentCents: inPeriod, capCents: item.budgetCents, spentTodayCents: Math.max(0, spentTodayCents), item, reactive };
}

/** A per-campaign ceiling that exists stays an upper bound on a daily item: the cap is the lower of the two. */
export function boundedCap(capCents: number, upperBoundCents: number | null): number {
  return upperBoundCents === null ? capCents : Math.min(capCents, upperBoundCents);
}

/** Can the campaign still spend today? A zero cap never runs. */
export function underCap(spentCents: number, capCents: number): boolean {
  return capCents > 0 && spentCents < capCents;
}
