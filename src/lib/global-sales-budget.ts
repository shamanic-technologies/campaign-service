import { legIsReactive, sameLeg, type CatalogueLegView } from "./leg-identity.js";
import type { SalesPathEntry } from "./offer-sales-paths-client.js";

/**
 * GLOBAL MODE — a brand stated ONE daily sales budget, and this service decides where it goes.
 *
 * Pure rules only (no I/O), so every one of them carries a real unit test. The planner
 * (`brand-turns.ts`) and the pot reads (`global-sales-pot.ts`) apply these.
 *
 * Owner-decided 2026-10-03 (ONE pot, bottom of the funnel first), replacing the 2026-09-29 rule
 * that capped only proactive spend:
 *   - The global budget is the ONE pot for EVERY sales campaign of the brand, proactive AND
 *     reactive. What a reactive leg (a leg OUT of a step a lead reaches) spends today comes out of
 *     it, and so does what an entry leg spends. Per-campaign ceilings stay an upper bound; the pot
 *     is the binding limit.
 *   - Bottom first: a reactive leg runs whenever the pot has money and a lead is waiting, and it
 *     takes its cohort's turn before an entry leg does. Entry legs get only what is left of the pot
 *     after everything already spent today, and stop as soon as brand-wide spend reaches it.
 *   - No step takes more than it needs: a reactive leg spends only when a lead reached its step; an
 *     entry leg stops at the pot.
 *   - Pot spent: EVERY sales campaign of the brand is held until the rollover (or a raise). A lead
 *     that reached a reactive step is never dropped: it stays due in lead-service's queue and is
 *     worked by the first run the pot can pay for.
 *   - Among entry legs the money goes to the best-ROI sales path first (features-service ranks
 *     them, per offer); it spills to the next path only when the better one cannot run (no matching
 *     live funded campaign, or that campaign is at its own ceiling). A path with no ROI still gets
 *     money if nothing better can run.
 */

/**
 * Is this campaign's leg REACTIVE — a leg out of a step a lead reaches, rather than an entry leg?
 *
 * Read from the catalogue features-service publishes: the (channel, leg) transition's `reactive`,
 * else the leg's `fromStep` (`legIsReactive`, either outbound spelling). A leg the catalogue does
 * not name, or a campaign stating no leg, is treated as PROACTIVE: the conservative side, because
 * only a reactive leg takes its turn ahead of the entry legs. Both draw on the same pot.
 */
export function isReactiveLeg(
  legKey: string | null | undefined,
  catalogue: CatalogueLegView,
  featureSlug?: string | null,
): boolean {
  return legIsReactive(catalogue, featureSlug, legKey) === true;
}

/**
 * What is left of the pot today, in cents: the budget minus EVERYTHING the brand's sales campaigns
 * already committed today (reactive included). Never negative.
 */
export function potLeftCents(spentCents: number, budgetCents: number): number {
  return Math.max(0, budgetCents - spentCents);
}

/** A global budget of zero, or one already spent, holds every sales campaign of the brand. */
export function isGlobalBudgetExhausted(spentCents: number, budgetCents: number): boolean {
  return !(budgetCents > 0) || potLeftCents(spentCents, budgetCents) <= 0;
}

/** One ENTRY (offer, leg, channel) a sales path buys, in the order money goes to it. */
export interface EntryTarget {
  offerId: string;
  legKey: string;
  featureSlug: string;
  roi: number | null;
  pathKey: string;
}

/**
 * Every offer's ranked paths flattened into ONE order: ROI descending across the whole brand, a
 * null ROI last, then features-service's own rank, then the path key (deterministic).
 *
 * A path whose entry leg no channel of ours is priced for (`entryChannelSlug` null) buys nothing
 * a campaign here performs, so it is not a target.
 */
export function rankEntryTargets(pathsByOffer: ReadonlyMap<string, readonly SalesPathEntry[]>): EntryTarget[] {
  const rows: Array<EntryTarget & { rank: number }> = [];
  for (const [offerId, paths] of pathsByOffer) {
    for (const p of paths) {
      if (!p.entryChannelSlug) continue;
      rows.push({
        offerId,
        legKey: p.entryLegKey,
        featureSlug: p.entryChannelSlug,
        roi: p.roi,
        pathKey: p.pathKey,
        rank: p.rank,
      });
    }
  }
  rows.sort((a, b) => {
    if (a.roi !== null && b.roi !== null && a.roi !== b.roi) return b.roi - a.roi;
    if ((a.roi === null) !== (b.roi === null)) return a.roi === null ? 1 : -1;
    if (a.rank !== b.rank) return a.rank - b.rank;
    if (a.offerId !== b.offerId) return a.offerId < b.offerId ? -1 : 1;
    return a.pathKey < b.pathKey ? -1 : a.pathKey > b.pathKey ? 1 : 0;
  });
  return rows.map(({ rank: _rank, ...t }) => t);
}

/** A proactive campaign in the running for the brand's global budget. */
export interface GlobalCandidate {
  campaignId: string;
  offerId: string | null;
  legKey: string;
  featureSlug: string | null;
  /** Committed spend today for THIS campaign, in cents. */
  spentCents: number;
  /** This campaign's own daily ceiling, in cents. The gate still paces on it. */
  ceilingCents: number;
}

export interface PathRoiPick {
  campaignId: string;
  /** The path it was picked for, or null when it was picked from the unranked remainder. */
  pathKey: string | null;
}

function canRun(c: GlobalCandidate): boolean {
  return c.ceilingCents > 0 && c.spentCents / c.ceilingCents < 1;
}

function lowestFill(cs: GlobalCandidate[]): GlobalCandidate | null {
  let best: GlobalCandidate | null = null;
  let bestRatio = Infinity;
  let bestKey = "";
  for (const c of cs) {
    if (!canRun(c)) continue;
    const ratio = c.spentCents / c.ceilingCents;
    const key = `${c.legKey}\u0000${c.campaignId}`;
    if (ratio < bestRatio || (ratio === bestRatio && key < bestKey)) {
      best = c;
      bestRatio = ratio;
      bestKey = key;
    }
  }
  return best;
}

/**
 * Which proactive campaign takes the brand's global budget: the one performing the best-ROI path
 * that can still run.
 *
 * Walk the targets in order; the first whose (offer, entry leg, channel) matches a candidate that is
 * under its own ceiling wins (several matches — which one identity should never produce — break on
 * the lowest fill ratio). Candidates matching NO target (an offer whose paths could not be read,
 * or a campaign no path names) are the last resort, ranked on the fill ratio exactly as the
 * campaigns-mode planner ranks them: live and funded, so starving them silently would be worse.
 *
 * Returns null when every candidate is at its own ceiling.
 */
export function selectByPathRoi(candidates: GlobalCandidate[], targets: EntryTarget[]): PathRoiPick | null {
  const matched = new Set<string>();
  for (const t of targets) {
    const matches = candidates.filter(
      (c) => c.offerId === t.offerId && c.featureSlug === t.featureSlug && sameLeg(t.featureSlug, c.legKey, t.legKey),
    );
    for (const m of matches) matched.add(m.campaignId);
    const pick = lowestFill(matches);
    if (pick) return { campaignId: pick.campaignId, pathKey: t.pathKey };
  }
  const rest = lowestFill(candidates.filter((c) => !matched.has(c.campaignId)));
  return rest ? { campaignId: rest.campaignId, pathKey: null } : null;
}
