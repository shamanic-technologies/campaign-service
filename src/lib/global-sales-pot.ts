import { and, arrayContains, eq } from "drizzle-orm";
import { getStatsBudget, type IdentityHeaders } from "@distribute/runs-client";
import { db } from "../db/index.js";
import { campaigns } from "../db/schema.js";
import { isSalesFamilyFeature } from "./sales-outreach-campaign.js";
import { fetchBrandSalesBudget } from "./brand-sales-budget-client.js";
import { isGlobalBudgetExhausted } from "./global-sales-budget.js";

/**
 * GLOBAL MODE — THE ONE POT, READ (owner-decided 2026-10-03).
 *
 * A brand in global mode stated ONE daily sales budget, and it is the pot for EVERY sales campaign
 * of the brand, proactive and reactive alike: what a reply-handling leg spends today comes out of
 * the same pot the entry legs draw from. The pure rules live in `global-sales-budget.ts`; this
 * module holds the reads, shared by the three places a run can start:
 *
 *   - the turn planner (`brand-turns.ts`), before a scheduled run is dispatched;
 *   - the step trigger (`step-trigger.ts`), before an event-driven run is dispatched;
 *   - gate-check, the first node of every DAG, which is what makes the pot binding whatever
 *     dispatched the run.
 *
 * A refused REACTIVE run loses nobody: its DAG claims the lead it works from lead-service's
 * follow-up queue AFTER gate-check, so a lead that reached the step stays due there and is worked by
 * the first run the pot can pay for (the next day at the latest).
 */

/** How long a run refused on a spent pot waits before it is looked at again (the rollover wins when nearer). */
export const POT_RECHECK_MS = 10 * 60_000; // 10 min

/** The rollover or ten minutes, whichever comes first: a raised budget lands within the window. */
export function potRecheckAt(now: Date): Date {
  return new Date(Math.min(nextDayStart(now).getTime(), now.getTime() + POT_RECHECK_MS));
}

/**
 * Committed spend today for ONE campaign, net, on the same basis the gate paces on (actual +
 * provisioned). null when it cannot be read: the pot is fail-closed.
 */
export async function readSpentTodayCents(orgId: string, campaignId: string, featureSlug: string): Promise<number | null> {
  try {
    const budget = await getStatsBudget({
      orgId,
      campaignId,
      featureSlug,
      windows: [{ label: "today", since: startOfToday().toISOString() }],
    });
    const today = budget.windows.find((w) => w.label === "today");
    if (!today) return 0;
    const cents = parseFloat(today.netTotalCostInUsdCents ?? today.totalCostInUsdCents);
    return Number.isFinite(cents) ? cents : null;
  } catch {
    return null;
  }
}

/**
 * Committed spend today across EVERY sales campaign of the brand, whatever its leg — what has
 * already come out of the pot. Not only the campaigns claimed this tick: the one running right now
 * is precisely the one NOT claimed (its nextRunAt is null while in flight), and one stopped this
 * afternoon already spent its share of today.
 *
 * `known` carries spends the caller already read (null = unreadable). Returns null when ANY
 * campaign's spend cannot be read.
 */
export async function brandSalesSpentTodayCents(
  orgId: string,
  brandId: string,
  fallbackFeatureSlug: string,
  known: ReadonlyMap<string, number | null> = new Map(),
): Promise<number | null> {
  const rows = await db.query.campaigns.findMany({
    where: and(eq(campaigns.orgId, orgId), arrayContains(campaigns.brandIds, [brandId])),
    columns: { id: true, featureSlug: true, status: true, updatedAt: true },
  });
  const dayStart = startOfToday().getTime();
  const ids = new Map<string, string>();
  for (const r of rows ?? []) {
    if (!isSalesFamilyFeature(r.featureSlug)) continue;
    const touchedToday = r.updatedAt instanceof Date ? r.updatedAt.getTime() >= dayStart : true;
    if (r.status !== "ongoing" && !touchedToday) continue;
    ids.set(r.id, r.featureSlug ?? fallbackFeatureSlug);
  }
  // Campaigns the caller already holds are always counted, whatever the DB read returned.
  for (const id of known.keys()) if (!ids.has(id)) ids.set(id, fallbackFeatureSlug);

  let total = 0;
  for (const [id, slug] of ids) {
    const cents = known.has(id) ? known.get(id)! : await readSpentTodayCents(orgId, id, slug);
    if (cents === null || cents === undefined) return null;
    total += cents;
  }
  return total;
}

export interface PotBlock {
  /** Gate-check's `reason` vocabulary. */
  reason: "Global sales budget reached" | "Global sales budget unavailable";
  detail: string;
  nextRunAt: Date;
}

/**
 * Must this sales run be refused because its brand's pot is spent?
 *
 * null = the pot does not stop it (the brand is not in global mode, or the pot still has money).
 * Fail-CLOSED: an unreadable mode or an unreadable spend is a pot that cannot be judged, and a run
 * refused here loses nothing (see the module doc), while one let through could spend past the
 * amount the customer stated.
 */
export async function globalSalesPotBlock(
  input: { orgId: string; brandId: string; featureSlug: string; identity: IdentityHeaders },
  now: Date = new Date(),
): Promise<PotBlock | null> {
  const recheck = potRecheckAt(now);
  const mode = await fetchBrandSalesBudget(input.brandId, input.identity);
  if (!mode.ok) {
    return {
      reason: "Global sales budget unavailable",
      detail: `billing's sales-budget mode for brand ${input.brandId} could not be read (${mode.detail})`,
      nextRunAt: recheck,
    };
  }
  if (mode.mode !== "global") return null;

  const spent = await brandSalesSpentTodayCents(input.orgId, input.brandId, input.featureSlug);
  if (spent === null) {
    return {
      reason: "Global sales budget unavailable",
      detail: `the spend today of brand ${input.brandId} could not be read, so its global daily sales budget of ${mode.dailyBudgetCents} cents cannot be judged`,
      nextRunAt: recheck,
    };
  }
  if (isGlobalBudgetExhausted(spent, mode.dailyBudgetCents)) {
    return {
      reason: "Global sales budget reached",
      detail: `brand ${input.brandId} has committed ${spent.toFixed(0)} of its ${mode.dailyBudgetCents} cents global daily sales budget today`,
      nextRunAt: recheck,
    };
  }
  return null;
}

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function nextDayStart(now: Date): Date {
  const d = new Date(now.getTime());
  d.setDate(d.getDate() + 1);
  d.setHours(0, 0, 0, 0);
  return d;
}
