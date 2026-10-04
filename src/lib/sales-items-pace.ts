import { getStatsBudget, type IdentityHeaders } from "@distribute/runs-client";
import { campaignCeilingCents, fetchCampaignBudgets, type CampaignBudgetsRead } from "./campaign-budget-client.js";
import { fetchChannelCatalogue } from "./channel-operator-client.js";
import { isReactiveLeg } from "./global-sales-budget.js";
import { fetchBrandSalesBudget, type BrandSalesBudgetRead } from "./brand-sales-budget-client.js";
import { boundedCap, itemPace, itemsOf, startOfDay, underCap, type SalesItem } from "./sales-items.js";

/**
 * ITEMS MODE — the reads, shared by the three places a run can start (turn planner, step trigger,
 * gate-check), so all three judge one campaign's item the same way. Rules: `sales-items.ts`.
 *
 * Every verdict is about ONE campaign: an unreadable spend or ceiling holds that campaign only,
 * never its siblings (a held item never stops another item).
 */

/** How long a campaign whose item is spent, unfunded or unreadable waits before it is re-judged. */
export const ITEM_RECHECK_MS = 10 * 60_000; // 10 min

/** The rollover or ten minutes, whichever is nearer: a raised item lands within the window. */
export function itemRecheckAt(now: Date): Date {
  const next = startOfDay(now);
  next.setDate(next.getDate() + 1);
  return new Date(Math.min(next.getTime(), now.getTime() + ITEM_RECHECK_MS));
}

/**
 * Committed spend, net, on the basis the gate paces on: today, and since `periodStart` when given.
 * null when it cannot be read (the campaign is held, fail-closed).
 */
export async function readItemSpend(
  orgId: string,
  campaignId: string,
  featureSlug: string,
  periodStart: Date | null,
  now: Date,
): Promise<{ todayCents: number; periodCents?: number } | null> {
  const windows = [{ label: "today", since: startOfDay(now).toISOString() }];
  if (periodStart) windows.push({ label: "period", since: periodStart.toISOString() });
  try {
    const budget = await getStatsBudget({ orgId, campaignId, featureSlug, windows });
    const read = (label: string): number | null => {
      const w = budget.windows.find((x) => x.label === label);
      if (!w) return 0;
      const cents = parseFloat(w.netTotalCostInUsdCents ?? w.totalCostInUsdCents);
      return Number.isFinite(cents) ? cents : null;
    };
    const todayCents = read("today");
    if (todayCents === null) return null;
    if (!periodStart) return { todayCents };
    const periodCents = read("period");
    if (periodCents === null) return null;
    return { todayCents, periodCents };
  } catch {
    return null;
  }
}

/** Is this leg reactive? An unreadable catalogue reads PROACTIVE: paced, the conservative side. */
export async function readLegIsReactive(legKey: string | null | undefined): Promise<boolean> {
  if (!legKey) return false;
  const catalogue = await fetchChannelCatalogue();
  if (!catalogue.ok) {
    console.warn(
      `[campaign-service] items mode: channel catalogue unreadable (${catalogue.detail}) — leg ${legKey} paced as proactive.`,
    );
    return false;
  }
  return isReactiveLeg(legKey, catalogue.legs);
}

export interface ItemCampaign {
  id: string;
  orgId: string;
  offerId: string | null;
  legKey: string | null;
  featureSlug: string | null;
  /** The campaign's OWN daily ceiling, when one is stated. */
  dailyBudgetCents: number | null;
}

export type ItemVerdict =
  /** `reactive`: the item's effective role (billing's, else our catalogue read). */
  | { run: true; spentCents: number; capCents: number; reactive: boolean }
  | {
      run: false;
      /** `unfunded` and `reached` are expected states (info); `unreadable` is a fault (warn). */
      kind: "unfunded" | "reached" | "unreadable";
      detail: string;
      nextRunAt: Date;
      spentCents?: number;
      capCents?: number;
    };

/**
 * May this campaign spend now, on its item?
 *
 * `budgets` is billing's per-campaign ceiling read when the caller already holds it (the planner);
 * otherwise it is read only when no own ceiling answers the upper bound.
 */
export async function itemVerdict(input: {
  campaign: ItemCampaign;
  brandId: string;
  items: readonly SalesItem[];
  reactive: boolean;
  identity: IdentityHeaders;
  now: Date;
  budgets?: CampaignBudgetsRead;
}): Promise<ItemVerdict> {
  const { campaign, brandId, items, reactive, identity, now } = input;
  // `reactive` is our catalogue read of the leg, used only where billing states no role.
  const recheck = itemRecheckAt(now);
  const mine = itemsOf(items, campaign);
  const periodStart = mine.length === 1 && mine[0].period === "month" ? mine[0].periodStart : null;

  // Nothing to read when nothing funds it.
  const probe = itemPace({ items, campaign, reactive, spentTodayCents: 0, spentInPeriodCents: 0, now });
  if (!probe.ok) {
    const unfunded = probe.reason === "no_item" || probe.reason === "unmanaged";
    return { run: false, kind: unfunded ? "unfunded" : "unreadable", detail: probe.detail, nextRunAt: recheck };
  }

  const spend = await readItemSpend(campaign.orgId, campaign.id, campaign.featureSlug ?? "", periodStart, now);
  if (!spend) {
    return {
      run: false,
      kind: "unreadable",
      detail: `the spend of campaign ${campaign.id} could not be read, so its item budget cannot be judged`,
      nextRunAt: recheck,
    };
  }
  const pace = itemPace({
    items,
    campaign,
    reactive,
    spentTodayCents: spend.todayCents,
    spentInPeriodCents: spend.periodCents,
    now,
  });
  if (!pace.ok) return { run: false, kind: "unreadable", detail: pace.detail, nextRunAt: recheck };

  // The per-campaign ceiling that exists today stays an upper bound.
  let upper: number | null = campaign.dailyBudgetCents;
  if (upper === null) {
    const budgets = input.budgets ?? (await fetchCampaignBudgets(brandId, identity));
    if (!budgets.ok) {
      return {
        run: false,
        kind: "unreadable",
        detail: `billing's campaign ceilings for brand ${brandId} could not be read, so the upper bound on this item is unknown`,
        nextRunAt: recheck,
      };
    }
    const ceiling = campaignCeilingCents(budgets, campaign);
    // Only a ceiling at the CAMPAIGN grain bounds an item; the brand pot is what items replace.
    upper = ceiling.grain === "campaign" ? ceiling.cents : null;
  }
  const capCents = boundedCap(pace.capCents, upper);
  if (!underCap(pace.spentCents, capCents)) {
    const basis = pace.item.period === "day" ? "daily" : pace.reactive ? "monthly (period cap)" : "monthly (paced)";
    return {
      run: false,
      kind: "reached",
      detail: `its ${basis} item budget allows ${capCents.toFixed(0)} cents today and ${pace.spentCents.toFixed(0)} are committed`,
      nextRunAt: recheck,
      spentCents: pace.spentCents,
      capCents,
    };
  }
  return { run: true, spentCents: pace.spentCents, capCents, reactive: pace.reactive };
}

/** gate-check's `reason` for each item verdict. */
export const ITEM_GATE_REASONS = {
  unfunded: "Campaign not funded",
  reached: "Item budget reached",
  unreadable: "Item budget unavailable",
} as const;

export type ItemsGate =
  /** The brand is in items mode: `block` is the refusal, or null when the item lets the run spend. */
  | { applies: true; block: { reason: string; nextRunAt: Date; detail: string } | null }
  /** Not items mode: the caller runs today's path, reusing this read of the mode (never read twice). */
  | { applies: false; salesBudget: BrandSalesBudgetRead | null };

/**
 * gate-check's items branch. Only a single-brand campaign can be in items mode (items are per brand);
 * a co-branded one never is, and its mode is not read here.
 */
export async function salesItemsGate(
  campaign: ItemCampaign & { brandIds: string[] },
  identity: IdentityHeaders,
  now: Date = new Date(),
): Promise<ItemsGate> {
  if (campaign.brandIds.length !== 1) return { applies: false, salesBudget: null };
  const brandId = campaign.brandIds[0];
  const salesBudget = await fetchBrandSalesBudget(brandId, identity);
  if (!salesBudget.ok || salesBudget.mode !== "items") return { applies: false, salesBudget };
  const verdict = await itemVerdict({
    campaign,
    brandId,
    items: salesBudget.items,
    reactive: await readLegIsReactive(campaign.legKey),
    identity,
    now,
  });
  if (verdict.run) return { applies: true, block: null };
  return { applies: true, block: { reason: ITEM_GATE_REASONS[verdict.kind], nextRunAt: verdict.nextRunAt, detail: verdict.detail } };
}
