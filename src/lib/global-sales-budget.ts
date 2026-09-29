import type { CatalogueLeg } from "./channel-operator-client.js";
import type { SalesPathEntry } from "./offer-sales-paths-client.js";

/**
 * GLOBAL MODE — a brand stated ONE daily sales budget, and this service decides where it goes.
 *
 * Pure rules only (no I/O), so every one of them carries a real unit test. The planner
 * (`brand-turns.ts`) does the reads and applies these.
 *
 * Owner-decided 2026-09-29:
 *   - The global budget caps the brand's PROACTIVE sales spend — the campaigns bought for an
 *     ENTRY leg (a leg from nothing, fired on the daily-budget clock).
 *   - It goes to the best-ROI sales path first (features-service ranks them, per offer); it spills
 *     to the next path only when the better one cannot run (no matching live funded campaign, or
 *     that campaign is at its own ceiling). A path with no ROI still gets money if nothing better
 *     can run.
 *   - REACTIVE legs (a leg OUT of a step, fired when a lead reaches it) are NEVER held on the
 *     global budget. They keep their own caps, exactly as today.
 */

/**
 * Is this campaign's leg REACTIVE — a leg out of a step a lead reaches, rather than an entry leg?
 *
 * Read from the catalogue features-service publishes (`fromStep` null = entry). A leg the catalogue
 * does not name, or a campaign stating no leg, is treated as PROACTIVE: the conservative side,
 * because a proactive campaign is capped by the global budget and a reactive one is not. An
 * unknown leg must never be the reason money is spent past what the customer stated.
 */
export function isReactiveLeg(legKey: string | null | undefined, legs: readonly CatalogueLeg[]): boolean {
  if (!legKey) return false;
  const leg = legs.find((l) => l.legKey === legKey);
  return leg !== undefined && leg.fromStepKey !== null;
}

/** A global budget of zero, or one already spent, holds every proactive campaign of the brand. */
export function isGlobalBudgetExhausted(spentCents: number, budgetCents: number): boolean {
  return !(budgetCents > 0) || spentCents >= budgetCents;
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
      (c) => c.offerId === t.offerId && c.legKey === t.legKey && c.featureSlug === t.featureSlug,
    );
    for (const m of matches) matched.add(m.campaignId);
    const pick = lowestFill(matches);
    if (pick) return { campaignId: pick.campaignId, pathKey: t.pathKey };
  }
  const rest = lowestFill(candidates.filter((c) => !matched.has(c.campaignId)));
  return rest ? { campaignId: rest.campaignId, pathKey: null } : null;
}
