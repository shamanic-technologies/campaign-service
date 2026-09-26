import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { campaigns } from "../db/schema.js";
import { stopOrgCampaignsWithHistory, TRANSITION_SOURCES } from "./campaign-status-history.js";
import { paymentStopReason, readPaymentHold } from "./payment-hold.js";

/**
 * How often the scheduler asks billing whether an org with live campaigns can still be charged.
 * This IS the latency between a declined card and its campaigns stopping. The sweep runs BEFORE
 * the tick dispatches anything, so a due campaign of a just-declined org is stopped rather than
 * fired whenever the two land on the same tick.
 */
export const PAYMENT_HOLD_RECHECK_MS = 10 * 60_000;

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

  let stopped = 0;
  for (const { orgId } of rows) {
    try {
      const read = await readPaymentHold(orgId);
      if (!read.ok) {
        console.warn(`[campaign-service] Payment hold: could not read billing for org ${orgId} (${read.detail}) — left as is`);
        continue;
      }
      if (!read.held) continue;

      const ids = await db.transaction((tx) =>
        stopOrgCampaignsWithHistory(
          tx,
          orgId,
          paymentStopReason(read.blockedReason),
          and(eq(campaigns.orgId, orgId), eq(campaigns.status, "ongoing")),
          TRANSITION_SOURCES.PAYMENT_HOLD,
        ),
      );
      stopped += ids.length;
      if (ids.length > 0) {
        console.warn(
          `[campaign-service] Payment hold: billing cannot charge org ${orgId} (${read.blockedReason}) — ` +
          `stopped ${ids.length} campaign(s): ${ids.map((c) => c.id).join(", ")}`,
        );
      }
    } catch (err) {
      console.error(`[campaign-service] Payment hold failed for org ${orgId}:`, err);
    }
  }
  return stopped;
}
