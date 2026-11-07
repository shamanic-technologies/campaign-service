import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { campaigns } from "../db/schema.js";
import { stopOrgCampaignsWithHistory, TRANSITION_SOURCES } from "./campaign-status-history.js";
import { paymentStopReason, readPaymentHold } from "./payment-hold.js";

/**
 * How often the scheduler asks billing whether an org with live campaigns can still be charged.
 * This bounds the latency between billing saying "cannot charge" and the campaigns of an org that
 * launches NO run in the meantime stopping. The sweep runs BEFORE the tick dispatches anything, so
 * a due campaign of a just-declined org is stopped rather than fired whenever the two land on the
 * same tick. Every run ALSO asks at its own gate (`gate-check.ts` block 0b), so an org that keeps
 * sending is stopped by its very next run, never by this clock.
 *
 * One minute since INSTANT-STOP-ON-DECLINE-1103 (was ten): prod 2026-11-03, Beyond Logic's first
 * emails kept going between billing's verdict and the next sweep. 14 orgs with a live campaign on
 * that day = 14 billing reads a minute.
 */
export const PAYMENT_HOLD_RECHECK_MS = 60_000;

let lastSweepAt = 0;

/** Test hook: forget when the sweep last ran. */
export function resetPaymentHoldSweepClock(): void {
  lastSweepAt = 0;
}

/**
 * Stop every live campaign of every org billing cannot charge (see `lib/payment-hold.ts`).
 *
 * Only orgs with a campaign ONGOING are asked — a stopped campaign spends nothing, and it cannot be
 * started again while the org is held because every start path refuses (`paymentStartRefusal`).
 * The population is a handful of orgs (16 on 2026-09-26), one billing read each, every ten minutes.
 *
 * Fail-SOFT: an org billing cannot answer for is left exactly as it is and warned about. A billing
 * outage must not stop every customer's campaigns; the start refusal is what fails closed.
 *
 * Idempotent: the stop is scoped to `status = 'ongoing'`, so a re-run finds nothing to stop, and
 * each stopped campaign gets exactly one transition naming `payment_hold` as the path.
 */
export async function holdPaymentDeclinedOrgs(now: number = Date.now()): Promise<number> {
  if (now - lastSweepAt < PAYMENT_HOLD_RECHECK_MS) return 0;
  lastSweepAt = now;

  const rows = await db
    .selectDistinct({ orgId: campaigns.orgId })
    .from(campaigns)
    .where(eq(campaigns.status, "ongoing"));

  // Every org is asked AT ONCE (FLEET-STALL-1107): the sweep runs first in every scheduler tick, so
  // it must cost one bounded billing read, never one per org in a row. Prod 2026-11-07: billing
  // answered each read with a 502 after ~2.3 min while Postgres was saturated, the orgs were read
  // one after the other, and the tick (every client's dispatch) waited ~40 min behind it.
  const counts = await Promise.all(rows.map(async ({ orgId }) => {
    try {
      const read = await readPaymentHold(orgId);
      if (!read.ok) {
        console.warn(`[campaign-service] Payment hold: could not read billing for org ${orgId} (${read.detail}) — left as is`);
        return 0;
      }
      if (!read.held) return 0;
      return (await stopHeldOrg(orgId, read.blockedReason)).length;
    } catch (err) {
      console.error(`[campaign-service] Payment hold failed for org ${orgId}:`, err);
      return 0;
    }
  }));
  return counts.reduce((a, b) => a + b, 0);
}

/**
 * Stop every ongoing campaign of an org billing says it cannot charge — the ONE stop both the sweep
 * and a run's gate (`gate-check.ts` block 0b) make. Idempotent: scoped to `ongoing`, so a second
 * caller finds nothing and writes no second transition. What was ALREADY sent keeps its follow-ups
 * (owner 2026-10-06): instantly-service cuts only the never-sent sequences of a stopped campaign.
 */
export async function stopHeldOrg(orgId: string, blockedReason: string): Promise<{ id: string }[]> {
  const ids = await db.transaction((tx) =>
    stopOrgCampaignsWithHistory(
      tx,
      orgId,
      paymentStopReason(blockedReason),
      and(eq(campaigns.orgId, orgId), eq(campaigns.status, "ongoing")),
      TRANSITION_SOURCES.PAYMENT_HOLD,
    ),
  );
  if (ids.length > 0) {
    console.warn(
      `[campaign-service] Payment hold: billing cannot charge org ${orgId} (${blockedReason}) — ` +
      `stopped ${ids.length} campaign(s): ${ids.map((c) => c.id).join(", ")}`,
    );
  }
  return ids;
}
