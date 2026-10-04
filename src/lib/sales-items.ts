/**
 * ITEMS MODE — "you choose, we run" (owner, 2026-10-04).
 *
 * The customer ACTIVATES sales paths on an offer (brand-service holds which) and budgets every
 * (channel x leg) ITEM of them (billing-service holds the budgets). billing then answers the brand's
 * sales-budget mode as `items`, carrying the list. From that moment the brand's money is the items,
 * and only the items:
 *
 *   - An item's budget is spent ONLY by the campaign performing exactly that (offer, leg, channel).
 *     No fuzzy match, no fallback to a coarser figure: a campaign no item names is NOT funded (it
 *     waits, like any unfunded campaign; its status never changes).
 *   - The global pot does not exist for that brand. Items are independent: one item spent, held or
 *     unreadable never stops another item's campaign.
 *   - `period: "day"` (prepaid / postpaid): the budget is what the campaign may commit today.
 *   - `period: "month"` (subscriber): the budget covers billing's stated period. A PROACTIVE item is
 *     paced evenly over what is left of it: today's allowance = (budget - spent in the period
 *     before today) / days left including today, so an under-spent day is caught up and an
 *     over-spent one is paid back. A REACTIVE item (a leg out of a step a lead reaches) is capped on
 *     the period only: it spends when a lead arrives, and leads are bursty.
 *   - A per-campaign ceiling that exists today (the campaign's own `dailyBudgetCents`, or a billing
 *     ceiling at the campaign grain) stays an upper bound on the item's daily allowance.
 *   - An item on a channel we do not run spends nothing: this service never creates a campaign from
 *     money (owner rule 1), and an item billing states `managed: false` funds no run even if a
 *     campaign performed it.
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
  /**
   * false = a channel we do not run yet: billing records the commitment and charges nothing, and
   * this service never lets it fund a run, even if some campaign happened to perform it.
   */
  managed: boolean;
}

export interface SalesItemKey {
  offerId?: string | null;
  legKey?: string | null;
  featureSlug?: string | null;
}

/**
 * The items that are this campaign's money: exactly its (offer, leg, channel), and only one we run
 * (`managed`). An unmanaged item funds nothing.
 */
export function itemsOf(items: readonly SalesItem[], c: SalesItemKey): SalesItem[] {
  if (!c.offerId || !c.legKey || !c.featureSlug) return [];
  return items.filter(
    (i) => i.managed && i.offerId === c.offerId && i.legKey === c.legKey && i.featureSlug === c.featureSlug,
  );
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
  | { ok: true; spentCents: number; capCents: number; item: SalesItem }
  | {
      ok: false;
      /** `no_item`: nothing funds it (an expected state). `period_not_current` / `ambiguous`: a fault. */
      reason: "no_item" | "period_not_current" | "ambiguous";
      detail: string;
    };

/**
 * Today's allowance for ONE campaign, from its item and its spend.
 *
 * `spentTodayCents`: committed today. `spentInPeriodCents`: committed since the item's period start
 * (monthly items only; ignored for a daily item).
 */
export function itemPace(input: {
  items: readonly SalesItem[];
  campaign: SalesItemKey;
  reactive: boolean;
  spentTodayCents: number;
  spentInPeriodCents?: number;
  now: Date;
}): ItemPace {
  const { campaign, reactive, spentTodayCents, now } = input;
  const scope = `offer ${campaign.offerId ?? "none"}, leg ${campaign.legKey ?? "none"}, channel ${campaign.featureSlug ?? "none"}`;
  const mine = itemsOf(input.items, campaign);
  if (mine.length === 0) {
    return { ok: false, reason: "no_item", detail: `no active sales path budgets this campaign (${scope})` };
  }
  if (mine.length > 1) {
    return { ok: false, reason: "ambiguous", detail: `billing states ${mine.length} item budgets for one campaign (${scope})` };
  }
  const item = mine[0];

  if (item.period === "day") {
    return { ok: true, spentCents: spentTodayCents, capCents: item.budgetCents, item };
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
  return { ok: true, spentCents: todayInPeriod, capCents, item };
}

/** A per-campaign ceiling that exists stays an upper bound: today's cap is the lower of the two. */
export function boundedCap(capCents: number, upperBoundCents: number | null): number {
  return upperBoundCents === null ? capCents : Math.min(capCents, upperBoundCents);
}

/** Can the campaign still spend today? A zero cap never runs. */
export function underCap(spentCents: number, capCents: number): boolean {
  return capCents > 0 && spentCents < capCents;
}
