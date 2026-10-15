import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { triggerEventDeliveries, triggerEvents } from "../db/schema.js";

/**
 * AN OCCURRENCE IS CONSUMED ONLY BY A RUN THAT COMPLETED ITS WORK (2026-10-14, PUSHED-EMAIL-REDELIVERY-1014).
 *
 * Observed in prod (event a19923ec, campaign 3a75c953): a client pushed an email it wrote
 * (`email_pushed_via_api`, the email on the occurrence's `item`); the run dispatched for it failed
 * downstream (instantly-service timed out), but the occurrence was already recorded `ran`. The next run of
 * the campaign carried no trigger, so the email was gone: nothing retried. The pushed text lives ONLY on the
 * occurrence, so an occurrence must stay owed until a run that carried it did its work.
 *
 * A property of EVERY occurrence that carries something (a `person` or an `item`: lib/trigger-person.ts,
 * the detectors), never a per-trigger branch:
 *  1. each run dispatched for it is recorded here (`dispatched`) with the run id workflow-service answered
 *     on `/execute`, the very `x-run-id` the DAG's `/end-run` carries;
 *  2. `/end-run` settles it: `completed` when the run did its work (success, and it neither reported nothing
 *     to do nor no lead: the work of a carrying occurrence is the person / item it carries), else `failed`;
 *  3. a failed delivery puts the occurrence back `pending` for THAT campaign only (`retryCampaignIds`), on
 *     `TRIGGER_DELIVERY_RETRY_DELAYS_MS`; the redelivered run carries the SAME event (`trigger.eventId`) and,
 *     for a person, files + makes them due again, so a workflow keying its send on the event never sends twice
 *     (email-sending keys on `email-sending:<eventId>`);
 *  4. after `TRIGGER_DELIVERY_MAX` failed runs for a campaign the occurrence is DONE for it, loudly: the
 *     campaign leaves `ranCampaignIds`, `detail.failedDeliveries` names every run, `lastError` says why, and
 *     with no other campaign served the outcome is `failed` / `run_failed`.
 * A run that succeeded is never redelivered. An event with nothing carried is byte-identical to before.
 *
 * A PERSON THE PIPE DOES NOT ADMIT (REPLY-ANY-LEAD-1015, owner 2026-10-15): who a pipe answers is its strategy's
 * (features-service plays), stated by its workflow on the person's claim at lead-service ("leads only" = pure
 * prospect: never the owner's personal contacts, the brand's customers, team, investors...). A refused person is
 * reported on `/end-run` `personNotAdmitted {reason}`: the delivery settles `not_admitted`, FINAL for that campaign
 * (never redelivered: asking again cannot change who the person is), the campaign leaves `ranCampaignIds`,
 * `detail.notAdmitted[]` names it with lead-service's reason verbatim, and with no other campaign served the
 * outcome is `skipped` / `person_not_admitted`. campaign-service never judges who a person is.
 */

/** Runs a campaign gets for one occurrence before it gives up (the first + 5 redeliveries, ~3h45 apart in all). */
export const TRIGGER_DELIVERY_MAX = 6;
/** Delay before redelivery N (index = failed runs so far - 1; the last value repeats). */
export const TRIGGER_DELIVERY_RETRY_DELAYS_MS = [2, 10, 30, 60, 120].map((m) => m * 60_000);
/** Outcome + skip reason of an occurrence whose every campaign gave up. */
export const TRIGGER_EVENT_FAILED = { OUTCOME: "failed", REASON: "run_failed" } as const;
/** Skip reason of an occurrence whose person no campaign's pipe admitted (and nobody else served it). */
export const PERSON_NOT_ADMITTED = "person_not_admitted" as const;

/** What `/end-run` says about the run that ended. */
export interface RunEnd {
  success: boolean;
  stopCampaign?: boolean;
  noWorkAvailable?: boolean;
  personNotAdmitted?: { reason: string };
}

/** While the event is being fired, a settle waits this long between tries (the fire ends in seconds). */
const FIRING_WAIT_MS = 3_000;
const FIRING_TRIES = 5;

/** Does the event's own detail carry something a run must deliver (a person or an item)? Pure. */
export function eventCarries(detail: unknown): boolean {
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) return false;
  const own = detail as Record<string, unknown>;
  return (own.person !== undefined && own.person !== null) || (own.item !== undefined && own.item !== null);
}

/** The delay before the next delivery, after `failedRuns` failed runs (>= 1). Pure. */
export function redeliveryDelayMs(failedRuns: number): number {
  const i = Math.min(Math.max(failedRuns, 1), TRIGGER_DELIVERY_RETRY_DELAYS_MS.length) - 1;
  return TRIGGER_DELIVERY_RETRY_DELAYS_MS[i];
}

/** Did a run do the work of the occurrence it carried? Pure. */
export function runDelivered(end: RunEnd): boolean {
  return end.success === true && end.stopCampaign !== true && end.noWorkAvailable !== true;
}

/** Record the runs just dispatched for a carrying occurrence. A dispatch with no run id cannot be settled: said. */
export async function recordDeliveries(
  eventId: string,
  triggered: ReadonlyArray<{ campaignId: string; runId?: string }>,
): Promise<void> {
  for (const t of triggered) {
    if (!t.runId) {
      console.error(
        `[campaign-service] trigger event ${eventId}: the run dispatched for campaign ${t.campaignId} has no run id (workflow-service named none), so a failure of it cannot redeliver the event`,
      );
      continue;
    }
    await db
      .insert(triggerEventDeliveries)
      .values({ eventId, campaignId: t.campaignId, runId: t.runId, status: "dispatched" })
      .onConflictDoNothing();
  }
}

export type DeliverySettlement =
  | { kind: "not_a_delivery" }
  | { kind: "completed"; eventId: string; campaignId: string }
  | { kind: "redelivered"; eventId: string; campaignId: string; failedRuns: number; dueAt: Date }
  | { kind: "gave_up"; eventId: string; campaignId: string; failedRuns: number }
  | { kind: "event_busy"; eventId: string; campaignId: string }
  | { kind: "not_admitted"; eventId: string; campaignId: string; reason: string };

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * `/end-run`: settle the delivery whose run just ended. Not a delivery (any run not dispatched for a carrying
 * occurrence, or already settled) = nothing. Never throws on a missing row; a DB error propagates to the caller,
 * which logs it (run finalization never depends on it).
 */
export async function settleTriggerDelivery(
  runId: string,
  end: RunEnd,
  now: Date = new Date(),
  waitMs: number = FIRING_WAIT_MS,
): Promise<DeliverySettlement> {
  if (end.success === true && end.personNotAdmitted) return settleNotAdmitted(runId, end.personNotAdmitted.reason, now, waitMs);
  const delivered = runDelivered(end);
  const [d] = await db
    .update(triggerEventDeliveries)
    .set({ status: delivered ? "completed" : "failed", endedAt: now })
    .where(and(eq(triggerEventDeliveries.runId, runId), eq(triggerEventDeliveries.status, "dispatched")))
    .returning();
  if (!d) return { kind: "not_a_delivery" };
  if (delivered) return { kind: "completed", eventId: d.eventId, campaignId: d.campaignId };

  const failedRuns = await db
    .select({ runId: triggerEventDeliveries.runId })
    .from(triggerEventDeliveries)
    .where(and(
      eq(triggerEventDeliveries.eventId, d.eventId),
      eq(triggerEventDeliveries.campaignId, d.campaignId),
      eq(triggerEventDeliveries.status, "failed"),
    ));
  const giveUp = failedRuns.length >= TRIGGER_DELIVERY_MAX;
  const dueAt = new Date(now.getTime() + redeliveryDelayMs(failedRuns.length));

  for (let attempt = 1; attempt <= FIRING_TRIES; attempt++) {
    const applied = await db.transaction(async (tx) => {
      const [event] = await tx
        .select()
        .from(triggerEvents)
        .where(eq(triggerEvents.id, d.eventId))
        .for("update");
      if (!event) return "missing" as const;
      // Being fired right now: its write would overwrite ours. Wait for it.
      if (event.status === "firing") return "busy" as const;

      const own = event.detail && typeof event.detail === "object" && !Array.isArray(event.detail)
        ? (event.detail as Record<string, unknown>)
        : {};
      const pending = event.status === "pending";
      const others = (ids: string[]) => ids.filter((id) => id !== d.campaignId);
      const ran = others(event.ranCampaignIds ?? []);
      const priorRan = others(strings(own.priorRanCampaignIds));

      if (giveUp) {
        const failedDeliveries = [
          ...(Array.isArray(own.failedDeliveries) ? own.failedDeliveries : []),
          { campaignId: d.campaignId, runIds: failedRuns.map((r) => r.runId), gaveUpAt: now.toISOString() },
        ];
        const why = `campaign ${d.campaignId}: all ${failedRuns.length} runs failed (last ${runId}), not redelivered again`;
        await tx
          .update(triggerEvents)
          .set(pending
            ? {
                // Still owed to other campaigns: their fire writes the outcome, this campaign is no longer asked.
                detail: { ...own, failedDeliveries, priorRanCampaignIds: priorRan, retryCampaignIds: others(strings(own.retryCampaignIds)) },
                lastError: why.slice(0, 500),
              }
            : {
                outcome: ran.length > 0 ? "ran" : TRIGGER_EVENT_FAILED.OUTCOME,
                skipReason: ran.length > 0 ? null : TRIGGER_EVENT_FAILED.REASON,
                ranCampaignIds: ran,
                detail: { ...own, failedDeliveries },
                lastError: why.slice(0, 500),
                processedAt: now,
              })
          .where(eq(triggerEvents.id, d.eventId));
        return "applied" as const;
      }

      const retry = [...new Set([...(pending ? strings(own.retryCampaignIds) : []), d.campaignId])];
      const why = `campaign ${d.campaignId}: run ${runId} did not complete its work (${failedRuns.length} of ${TRIGGER_DELIVERY_MAX}), redelivered at ${dueAt.toISOString()}`;
      await tx
        .update(triggerEvents)
        .set({
          status: "pending",
          dueAt: pending && event.dueAt.getTime() < dueAt.getTime() ? event.dueAt : dueAt,
          claimedAt: null,
          outcome: null,
          skipReason: null,
          ranCampaignIds: ran,
          // Only the failed campaign is asked again; the ones that ran stay ran and are never dispatched twice.
          detail: { ...own, retryCampaignIds: retry, priorRanCampaignIds: pending ? priorRan : ran, redeliveredAt: now.toISOString() },
          lastError: why.slice(0, 500),
        })
        .where(eq(triggerEvents.id, d.eventId));
      return "applied" as const;
    });
    if (applied === "missing") {
      console.error(`[campaign-service] delivery ${d.id}: trigger event ${d.eventId} no longer exists, nothing to redeliver`);
      return { kind: "not_a_delivery" };
    }
    if (applied === "applied") {
      if (giveUp) {
        console.error(
          `[campaign-service] trigger event ${d.eventId}: campaign ${d.campaignId} failed all ${failedRuns.length} runs for it (last ${runId}); the occurrence is given up for that campaign (${TRIGGER_EVENT_FAILED.REASON})`,
        );
        return { kind: "gave_up", eventId: d.eventId, campaignId: d.campaignId, failedRuns: failedRuns.length };
      }
      console.warn(
        `[campaign-service] trigger event ${d.eventId}: run ${runId} of campaign ${d.campaignId} did not complete its work (${failedRuns.length} of ${TRIGGER_DELIVERY_MAX}); redelivered at ${dueAt.toISOString()}`,
      );
      return { kind: "redelivered", eventId: d.eventId, campaignId: d.campaignId, failedRuns: failedRuns.length, dueAt };
    }
    if (attempt < FIRING_TRIES) await sleep(waitMs);
  }
  console.error(
    `[campaign-service] trigger event ${d.eventId} stayed firing while run ${runId} of campaign ${d.campaignId} ended unfinished: NOT redelivered (delivery ${d.id})`,
  );
  return { kind: "event_busy", eventId: d.eventId, campaignId: d.campaignId };
}

/**
 * The run's pipe refused the occurrence's person (see header): final for that campaign, never redelivered. Waits
 * out a fire in progress like a failed delivery does.
 */
async function settleNotAdmitted(runId: string, reason: string, now: Date, waitMs: number): Promise<DeliverySettlement> {
  const [d] = await db
    .update(triggerEventDeliveries)
    .set({ status: "not_admitted", endedAt: now })
    .where(and(eq(triggerEventDeliveries.runId, runId), eq(triggerEventDeliveries.status, "dispatched")))
    .returning();
  if (!d) return { kind: "not_a_delivery" };

  for (let attempt = 1; attempt <= FIRING_TRIES; attempt++) {
    const applied = await db.transaction(async (tx) => {
      const [event] = await tx
        .select()
        .from(triggerEvents)
        .where(eq(triggerEvents.id, d.eventId))
        .for("update");
      if (!event) return "missing" as const;
      if (event.status === "firing") return "busy" as const;

      const own = event.detail && typeof event.detail === "object" && !Array.isArray(event.detail)
        ? (event.detail as Record<string, unknown>)
        : {};
      const others = (ids: string[]) => ids.filter((id) => id !== d.campaignId);
      const ran = others(event.ranCampaignIds ?? []);
      const priorRan = others(strings(own.priorRanCampaignIds));
      const notAdmitted = [
        ...(Array.isArray(own.notAdmitted) ? own.notAdmitted : []),
        { campaignId: d.campaignId, runId, reason, at: now.toISOString() },
      ];
      const detail = {
        ...own,
        notAdmitted,
        priorRanCampaignIds: priorRan,
        ...(own.retryCampaignIds !== undefined ? { retryCampaignIds: others(strings(own.retryCampaignIds)) } : {}),
      };
      // `ranLeads` is served only for campaigns still in `ranCampaignIds` / `priorRanCampaignIds`: nothing to drop.
      const servedElsewhere = ran.length > 0 || priorRan.length > 0;
      await tx
        .update(triggerEvents)
        .set(event.status === "pending"
          // Still owed to other campaigns: their fire writes the outcome, this campaign is no longer asked.
          ? { ranCampaignIds: ran, detail }
          : {
              ranCampaignIds: ran,
              outcome: servedElsewhere ? "ran" : "skipped",
              skipReason: servedElsewhere ? null : PERSON_NOT_ADMITTED,
              detail,
              processedAt: now,
            })
        .where(eq(triggerEvents.id, d.eventId));
      return "applied" as const;
    });
    if (applied === "missing") {
      console.error(`[campaign-service] delivery ${d.id}: trigger event ${d.eventId} no longer exists, nothing to record`);
      return { kind: "not_a_delivery" };
    }
    if (applied === "applied") {
      console.log(
        `[campaign-service] trigger event ${d.eventId}: campaign ${d.campaignId}'s pipe does not admit its person (${reason}, run ${runId}); final, not redelivered`,
      );
      return { kind: "not_admitted", eventId: d.eventId, campaignId: d.campaignId, reason };
    }
    if (attempt < FIRING_TRIES) await sleep(waitMs);
  }
  console.error(
    `[campaign-service] trigger event ${d.eventId} stayed firing while run ${runId} of campaign ${d.campaignId} reported its person not admitted: outcome not rewritten (delivery ${d.id})`,
  );
  return { kind: "event_busy", eventId: d.eventId, campaignId: d.campaignId };
}
