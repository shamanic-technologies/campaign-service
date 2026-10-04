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
 *   - `period: "month"` (subscriber): the budget covers billing's stated period. A PROACTIVE item is
 *     paced evenly over what is left of it: today's allowance = (budget - spent in the period
 *     before today) / days left including today, so an under-spent day is caught up and an
 *     over-spent one is paid back. A REACTIVE item is a MAX on the period: it spends only when a
 *     lead reached its step, and leads are bursty.
 *   - Proactive or reactive is billing's `role` when it states one (it priced the budget on it);
 *     `null` (billing could not read the catalogue for it) falls back to this service's own catalogue
 *     read of the leg.
 *   - A per-campaign ceiling that exists today (the campaign's own `dailyBudgetCents`, or a billing
 *     ceiling at the campaign grain) stays an upper bound on the item's daily allowance.
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
    (i) => i.offerId.toLowerCase() === offerId && i.legKey === c.legKey && i.featureSlug === c.featureSlug,
  );
}

/** Is this item reactive? billing's stated role wins; null falls back to our own catalogue read. */
export function itemIsReactive(item: SalesItem, catalogueReactive: boolean): boolean {
  return item.role === null ? catalogueReactive : item.role === "reactive";
}

const DAY_MS = 24 * 60 * 60_000;

/** Start of the day `now` falls in, on the same (server-local) clock every daily window here uses. */
export function startOfDay(now: Date): Date {
  const d = new Date(now.getTime());
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Days left in the period, today included. Never below 1 while the period is current. */
export function daysLeftInPeriod(now: Date, periodEnd: Date): number {
  return Math.max(1, Math.ceil((periodEnd.getTime() - startOfDay(now).getTime()) / DAY_MS));
}

export type ItemPace =
  /** The campaign may run while `spentCents < capCents` (both TODAY's figures). */
  | { ok: true; spentCents: number; capCents: number; item: SalesItem; reactive: boolean }
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
 * Today's allowance for ONE campaign, from its item and its spend.
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
    return { ok: true, spentCents: spentTodayCents, capCents: item.budgetCents, item, reactive };
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
  // A period that began today: what was spent today before it began is not this period's.
  const todayInPeriod = Math.min(Math.max(0, spentTodayCents), inPeriod);
  const leftBeforeToday = Math.max(0, item.budgetCents - (inPeriod - todayInPeriod));
  const capCents = reactive ? leftBeforeToday : leftBeforeToday / daysLeftInPeriod(now, end);
  return { ok: true, spentCents: todayInPeriod, capCents, item, reactive };
}

/** A per-campaign ceiling that exists stays an upper bound: today's cap is the lower of the two. */
export function boundedCap(capCents: number, upperBoundCents: number | null): number {
  return upperBoundCents === null ? capCents : Math.min(capCents, upperBoundCents);
}

/** Can the campaign still spend today? A zero cap never runs. */
export function underCap(spentCents: number, capCents: number): boolean {
  return capCents > 0 && spentCents < capCents;
}
