/**
 * DISTRY-CALL-IS-CAMPAIGN-1121 (owner 2026-11-21: « It is okay to wait. As long as Distry gets back the info about when
 * it's going to start »). WHEN a funnel campaign's next run will happen, and its PROGRESS (units made, spend, finished,
 * why it is idle). Generic: any funnel campaign, any outcome, any caller; never a branch on an outcome, channel or client.
 *
 * Both read the SAME facts the dispatch decides on, never a second judgment:
 *   - its status (a person's statement),
 *   - its units' `next_run_at` (set at start: due now),
 *   - its money: `salesFunnelUnitMoney`, the ONE answer gate-check, the planner and the step trigger ask (billing's caps:
 *     unfunded / cap reached / unreadable = held, with billing's figures),
 *   - for progress, billing's caps read (what its max budget / max volume consumed this period) and runs-service's
 *     ledger (what its units spent since birth).
 */
import { getOutcomePerformerStats, getStatsBudget } from "@distribute/runs-client";
import type { Campaign, SalesFunnelCampaign } from "../db/schema.js";
import {
  fetchSalesFunnelCaps,
  salesFunnelUnitMoney,
  salesFunnelUnitRef,
  type SalesFunnelCaps,
  type SalesFunnelMoneyVerdict,
} from "./sales-funnel-campaigns.js";

/**
 * A reasonable bound on how long a due unit waits for the scheduler: it is woken on every start, then the brand's turn
 * planner may defer it one turn (60 s). Stated so a reader can say "within a minute".
 */
export const DUE_DISPATCH_WITHIN_MS = 60_000;

export type NextRunState =
  /** Its run is due: the scheduler dispatches it within `withinSeconds` of `at`. */
  | "scheduled"
  /** It runs only when its trigger fires (a reactive campaign): no time can be named. */
  | "on_event"
  /** Ongoing but held: `reason` names why (no max budget/volume yet, a cap reached, caps unreadable). */
  | "waiting"
  /** Its one-off cap is reached: it has made what it was asked for and runs no more unless raised. */
  | "finished"
  /** Stopped by a person (or a payment hold): nothing runs until it is started. */
  | "stopped"
  /** It owns no unit that runs (only customer-operated pipes). */
  | "nothing_runs";

export interface NextRun {
  state: NextRunState;
  /** When the next run is expected (ISO), when one can be named; null otherwise. */
  at: string | null;
  /** How long after `at` the dispatch may land (the scheduler's turn), when `at` is named. */
  withinSeconds: number | null;
  /** A code naming why it waits / stopped (`unfunded`, `cap_reached`, `unreadable`, a stop reason), else null. */
  reason: string | null;
  /** One plain-English sentence a person (or Distry) can repeat. */
  detail: string;
}

/** The units that run on their own (a workflow or an Engine), not draining. Pure. */
function runningUnits(units: readonly Campaign[]): Campaign[] {
  return units.filter((u) => u.workflowSlug !== null && u.planRole !== "draining");
}

/** A held verdict whose cap is a ONE-OFF max reached = the campaign made what it was asked for. Pure. */
export function isOneOffFinished(verdict: SalesFunnelMoneyVerdict): boolean {
  return !verdict.run && verdict.kind === "cap_reached" && verdict.figures?.period === "one_off";
}

/**
 * PURE: the next run from what the dispatch reads. `verdict` = the money answer of its first running unit (null when
 * nothing runs or it is stopped).
 */
export function nextRunFrom(
  row: Pick<SalesFunnelCampaign, "status" | "stopReason">,
  units: readonly Campaign[],
  verdict: SalesFunnelMoneyVerdict | null,
  now: Date,
): NextRun {
  if (row.status !== "ongoing") {
    return {
      state: "stopped",
      at: null,
      withinSeconds: null,
      reason: row.stopReason ?? "stopped",
      detail: "The campaign is stopped: nothing runs until it is started.",
    };
  }
  const running = runningUnits(units);
  if (running.length === 0) {
    return { state: "nothing_runs", at: null, withinSeconds: null, reason: "no_running_unit", detail: "No part of this campaign runs on its own: its steps are done by the client's team." };
  }
  if (verdict && !verdict.run) {
    if (isOneOffFinished(verdict)) {
      return { state: "finished", at: null, withinSeconds: null, reason: "cap_reached", detail: `It has made what it was asked for: ${verdict.detail}` };
    }
    return { state: "waiting", at: null, withinSeconds: null, reason: verdict.kind, detail: verdict.detail };
  }
  // Runs only on its trigger's events (a reactive campaign): no clock time exists for it.
  const onOwn = running.filter((u) => !u.runsOnTriggerId);
  if (onOwn.length === 0) {
    return { state: "on_event", at: null, withinSeconds: null, reason: null, detail: "It runs each time its trigger fires." };
  }
  const dueMs = Math.min(...onOwn.map((u) => (u.nextRunAt ? u.nextRunAt.getTime() : now.getTime())));
  const at = new Date(Math.max(dueMs, now.getTime()));
  return {
    state: "scheduled",
    at: at.toISOString(),
    withinSeconds: DUE_DISPATCH_WITHIN_MS / 1000,
    reason: null,
    detail: at.getTime() <= now.getTime() + 1000
      ? "Its first run is due now: it starts within a minute."
      : `Its next run is due at ${at.toISOString()}.`,
  };
}

/** The money answer of a campaign's first running unit (null = stopped, or nothing runs). */
async function verdictOf(row: SalesFunnelCampaign, units: readonly Campaign[], now: Date): Promise<SalesFunnelMoneyVerdict | null> {
  if (row.status !== "ongoing") return null;
  const unit = runningUnits(units)[0];
  if (!unit) return null;
  return salesFunnelUnitMoney(salesFunnelUnitRef({ ...unit, salesFunnelId: unit.salesFunnelId ?? row.salesFunnelId }), now);
}

/** When its next run will happen, from the facts the dispatch reads. Never throws on a sibling outage (held = said so). */
export async function nextRunOf(row: SalesFunnelCampaign, units: readonly Campaign[], now: Date = new Date()): Promise<NextRun> {
  return nextRunFrom(row, units, await verdictOf(row, units, now), now);
}

// ── Progress ────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface CampaignProgress {
  salesFunnelCampaignId: string;
  status: string;
  target: string | null;
  /**
   * With a max volume: what it counted this period (billing's figure: the same one that ends it), with the cap. Without
   * one (or caps unreadable): the Units of its target its runs produced since its birth (runs-service ledger), `period`
   * null, `unit` = the target. null + `unavailableReason` when the count could not be read, never 0.
   */
  units: { made: number | null; maxVolume: number | null; period: string | null; unit: string | null; unavailableReason: string | null };
  /**
   * What its units spent since birth (runs-service ledger, decimal USD cents): `spentCents` = what the org pays (after
   * its usage discount), `spentBeforeDiscountCents` beside it. And its max budget this period (billing).
   */
  spend: {
    spentCents: number | null;
    spentBeforeDiscountCents: number | null;
    maxBudgetCents: number | null;
    maxBudgetConsumedCents: number | null;
    period: string | null;
    unavailableReason: string | null;
  };
  /** true = its one-off max budget or max volume is reached: it made what it was asked for. */
  finished: boolean;
  /** Its next run, or why it is idle. */
  nextRun: NextRun;
}

/** runs-service's Units read spans at most this many UTC days (since..until inclusive). */
export const LEDGER_UNITS_WINDOW_DAYS = 400;

const utcDay = (d: Date): string => d.toISOString().slice(0, 10);

export type MadeSinceStart = { ok: true; made: number } | { ok: false; reason: string };

/**
 * DISTRY-CALL-IS-CAMPAIGN-1121 follow-up: the Units of its TARGET its units' runs produced since its birth, read off
 * runs-service's ledger (the produced occurrences billing's max volume counts too; a reversed Unit nets out). Any
 * outcome, any channel: never a branch. Unreadable = a named reason, never 0.
 */
export async function madeSinceStart(
  row: Pick<SalesFunnelCampaign, "id" | "orgId" | "target" | "createdAt">,
  units: readonly Pick<Campaign, "id">[],
  now: Date,
): Promise<MadeSinceStart> {
  if (!row.target) return { ok: false, reason: "no_target" };
  if (units.length === 0) return { ok: true, made: 0 };
  const since = utcDay(row.createdAt);
  const until = utcDay(now);
  const days = Math.round((Date.parse(until) - Date.parse(since)) / 86_400_000) + 1;
  if (days > LEDGER_UNITS_WINDOW_DAYS) return { ok: false, reason: "older_than_ledger_window" };
  try {
    const counts = await Promise.all(
      units.map((u) =>
        getOutcomePerformerStats({ orgId: row.orgId, campaignId: u.id, outcomeKey: row.target!, since, until, groupBy: ["outcomeKey"] }).then((r) => {
          if (typeof r?.totals?.count !== "number") throw new Error("runs-service outcome-performers stated no totals.count");
          return r.totals.count;
        }),
      ),
    );
    return { ok: true, made: counts.reduce((a, b) => a + b, 0) };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`[campaign-service] Progress of sales funnel campaign ${row.id}: Units unreadable (${detail})`);
    return { ok: false, reason: `runs_unavailable: ${detail}` };
  }
}

const centsOf = (v: string | undefined): number | null => {
  if (v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** What a funnel campaign has made and spent, whether it finished, and why it is idle. */
export async function campaignProgress(
  row: SalesFunnelCampaign,
  units: readonly Campaign[],
  now: Date = new Date(),
): Promise<CampaignProgress> {
  const [verdict, capsRead, spendRead] = await Promise.all([
    verdictOf(row, units, now),
    fetchSalesFunnelCaps({
      orgId: row.orgId,
      brandId: row.brandId,
      offerId: row.offerId,
      salesFunnelId: row.salesFunnelId,
      salesFunnelCampaignId: row.id,
    }, now.getTime()),
    Promise.all(
      units.map((u) =>
        getStatsBudget({ orgId: row.orgId, campaignId: u.id, windows: [{ label: "all" }] }).then((r) => r.windows.find((w) => w.label === "all")),
      ),
    ).then(
      (windows) => ({ ok: true as const, windows }),
      (err: unknown) => ({ ok: false as const, detail: err instanceof Error ? err.message : String(err) }),
    ),
  ]);

  const caps: SalesFunnelCaps | null = capsRead.ok ? capsRead.caps : null;
  const volume = caps?.maxVolume ?? null;
  const budget = caps?.maxBudget ?? null;
  // No max volume stated (or caps unreadable): its Units are counted off the ledger since its birth. A stated max volume
  // keeps billing's figure (the one that ends it), unchanged.
  const ledgerMade = volume ? null : await madeSinceStart(row, units, now);

  let spentCents: number | null = null;
  let spentBeforeDiscountCents: number | null = null;
  let spendUnavailable: string | null = null;
  if (spendRead.ok) {
    spentCents = 0;
    spentBeforeDiscountCents = 0;
    for (const w of spendRead.windows) {
      const gross = centsOf(w?.totalCostInUsdCents) ?? 0;
      spentBeforeDiscountCents += gross;
      spentCents += centsOf(w?.netTotalCostInUsdCents) ?? gross;
    }
  } else {
    spendUnavailable = `runs_unavailable: ${spendRead.detail}`;
    console.error(`[campaign-service] Progress of sales funnel campaign ${row.id}: spend unreadable (${spendRead.detail})`);
  }

  const oneOffReached =
    (volume?.period === "one_off" && volume.reached === true) || (budget?.period === "one_off" && budget.reached === true);
  const nextRun = nextRunFrom(row, units, verdict, now);

  return {
    salesFunnelCampaignId: row.id,
    status: row.status,
    target: row.target ?? null,
    units: volume
      ? {
          made: volume.consumed,
          maxVolume: volume.count,
          period: volume.period,
          unit: volume.unit,
          unavailableReason: volume.consumed === null ? (volume.consumedUnavailableReason ?? "not_measured") : null,
        }
      : {
          made: ledgerMade?.ok ? ledgerMade.made : null,
          maxVolume: null,
          period: null,
          unit: ledgerMade?.ok ? (row.target ?? null) : null,
          unavailableReason: ledgerMade && !ledgerMade.ok ? ledgerMade.reason : null,
        },
    spend: {
      spentCents,
      spentBeforeDiscountCents,
      maxBudgetCents: budget?.amountCents ?? null,
      maxBudgetConsumedCents: budget?.consumedCents ?? null,
      period: budget?.period ?? null,
      unavailableReason: spendUnavailable ?? (capsRead.ok ? null : `caps_unavailable: ${capsRead.detail}`),
    },
    finished: oneOffReached || nextRun.state === "finished",
    nextRun,
  };
}
