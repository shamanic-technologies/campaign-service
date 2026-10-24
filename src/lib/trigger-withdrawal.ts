import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { triggerEvents, type TriggerEvent } from "../db/schema.js";
import { COMPOSITE_TRIGGER_RECORDED_VIA } from "./composite-trigger.js";
import { DELAY_DETECTOR_RECORDED_VIA, delayAnchorWithdrawn, isWithdrawnEventDetail } from "./delay-trigger-detector.js";

/**
 * A WITHDRAWN FACT NEVER SENDS (WITHDRAWN-FACT-CANCELS-1024, owner 2026-10-24). An occurrence stands for a fact a
 * caller stated (lead-service: "this person visited"). When the fact's owner withdraws it (crm-service sets aside a
 * mail scanner's "visit", `machine_visit`), every occurrence resting on it that has not RUN yet is cancelled, never
 * sent; one whose run already went out is left alone (what was written stays written).
 *
 *  - `withdrawTriggerEvent` (`POST /internal/trigger-events/{id}/withdraw`, the recording caller): marks the event
 *    `detail.withdrawnAt` and cancels it and every trigger made of it (`lead_event`) still waiting (`pending`):
 *    `done` / `skipped` / `fact_withdrawn`. A waiting event some campaign already ran for keeps `ran` with those
 *    campaigns and owes nothing more. One being fired right now (`firing`) is left to the fire path, which checks.
 *  - The fire path (lib/trigger-events.ts `fireClaimedEvent`) asks `eventStanding` before dispatching: a withdrawn
 *    event, or a composite whose member was withdrawn or whose `delay` member's anchor fact no longer holds
 *    (lib/delay-trigger-detector.ts `delayAnchorWithdrawn`), is skipped with that reason.
 *  - `settleWithdrawnScope` (`POST /internal/trigger-events/settle-withdrawn`): the same check over every waiting
 *    event of one (org, brand) at once, so a paused campaign's owed queue is clean before it is turned back on.
 */

export const FACT_WITHDRAWN = "fact_withdrawn";

export type Standing = { stands: true } | { stands: false; reason: string; detail: string };

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const detailOf = (e: Pick<TriggerEvent, "detail">): Record<string, unknown> =>
  e.detail && typeof e.detail === "object" && !Array.isArray(e.detail) ? (e.detail as Record<string, unknown>) : {};

/**
 * Does the fact an event stands for still hold? A withdrawn event does not; a composite occurrence holds while its
 * member does (a withdrawn member, or a `delay` member whose anchor fact was withdrawn, does not). THROWS when a
 * delay anchor cannot be read (the fire path retries).
 */
export async function eventStanding(event: TriggerEvent): Promise<Standing> {
  if (isWithdrawnEventDetail(event.detail)) {
    return { stands: false, reason: FACT_WITHDRAWN, detail: `withdrawn: ${String(detailOf(event).withdrawnReason ?? "by its caller")}` };
  }
  if (event.recordedVia !== COMPOSITE_TRIGGER_RECORDED_VIA) return { stands: true };
  const sourceId = detailOf(event).sourceEventId;
  if (typeof sourceId !== "string") return { stands: true };
  const [source] = await db.select().from(triggerEvents).where(eq(triggerEvents.id, sourceId)).limit(1);
  if (!source) return { stands: true };
  if (isWithdrawnEventDetail(source.detail)) {
    return { stands: false, reason: FACT_WITHDRAWN, detail: `member event ${source.id} (${source.triggerId}) was withdrawn` };
  }
  if (source.recordedVia === DELAY_DETECTOR_RECORDED_VIA) {
    const anchor = await delayAnchorWithdrawn(source);
    if (anchor) return { stands: false, reason: anchor.reason, detail: `member event ${source.id} (${source.triggerId}): ${anchor.detail}` };
  }
  return { stands: true };
}

/** Close one WAITING event that no longer stands. Returns what happened to it. */
async function closeWaiting(event: TriggerEvent, reason: string, detail: string, now: Date): Promise<"cancelled" | "kept_ran"> {
  const own = detailOf(event);
  const priorRan = strings(own.priorRanCampaignIds);
  const { retryCampaignIds: _r, ...rest } = own;
  await db
    .update(triggerEvents)
    .set({
      status: "done",
      outcome: priorRan.length > 0 ? "ran" : "skipped",
      skipReason: priorRan.length > 0 ? null : reason,
      ranCampaignIds: priorRan,
      detail: { ...rest, standingSkip: { reason, detail, at: now.toISOString() } },
      processedAt: now,
      claimedAt: null,
      lastError: null,
    })
    .where(and(eq(triggerEvents.id, event.id), eq(triggerEvents.status, "pending")));
  return priorRan.length > 0 ? "kept_ran" : "cancelled";
}

export interface WithdrawAnswer {
  eventId: string;
  /** What happened to the event itself. */
  event: "cancelled" | "kept_ran" | "already_done" | "firing";
  /** The triggers made of it (`lead_event`): cancelled, kept (some campaign already ran), already done, being fired. */
  composites: { cancelled: number; keptRan: number; alreadyDone: number; firing: number };
}

/** Withdraw one event (its caller withdrew the fact). Null = no such event in the org. */
export async function withdrawTriggerEvent(input: { orgId: string; eventId: string; reason: string }, now: Date = new Date()): Promise<WithdrawAnswer | null> {
  const [event] = await db
    .select()
    .from(triggerEvents)
    .where(and(eq(triggerEvents.id, input.eventId), eq(triggerEvents.orgId, input.orgId)))
    .limit(1);
  if (!event) return null;
  const marked = { ...detailOf(event), withdrawnAt: now.toISOString(), withdrawnReason: input.reason };
  await db.update(triggerEvents).set({ detail: marked }).where(eq(triggerEvents.id, event.id));
  const self: TriggerEvent = { ...event, detail: marked };
  const why = `withdrawn: ${input.reason}`;
  const outcome: WithdrawAnswer["event"] =
    event.status === "pending" ? await closeWaiting(self, FACT_WITHDRAWN, why, now) : event.status === "firing" ? "firing" : "already_done";

  const children = await db
    .select()
    .from(triggerEvents)
    .where(and(
      eq(triggerEvents.orgId, input.orgId),
      eq(triggerEvents.recordedVia, COMPOSITE_TRIGGER_RECORDED_VIA),
      sql`${triggerEvents.detail}->>'sourceEventId' = ${event.id}`,
    ));
  const composites = { cancelled: 0, keptRan: 0, alreadyDone: 0, firing: 0 };
  for (const child of children) {
    if (child.status === "pending") {
      const r = await closeWaiting(child, FACT_WITHDRAWN, `member event ${event.id} ${why}`, now);
      if (r === "cancelled") composites.cancelled++;
      else composites.keptRan++;
    } else if (child.status === "firing") composites.firing++;
    else composites.alreadyDone++;
  }
  console.log(
    `[campaign-service] trigger event ${event.id} (${event.triggerId}) withdrawn (${input.reason}): itself ${outcome}; composites ${JSON.stringify(composites)}`,
  );
  return { eventId: event.id, event: outcome, composites };
}

/** Every WAITING event of one (org, brand) checked with `eventStanding`; those that no longer stand are closed. */
export async function settleWithdrawnScope(input: { orgId: string; brandId: string }, now: Date = new Date()): Promise<{
  checked: number;
  cancelled: number;
  keptRan: number;
  byReason: Record<string, number>;
  unreadable: number;
}> {
  const waiting = await db
    .select()
    .from(triggerEvents)
    .where(and(
      eq(triggerEvents.orgId, input.orgId),
      eq(triggerEvents.brandId, input.brandId),
      eq(triggerEvents.status, "pending"),
      inArray(triggerEvents.recordedVia, [COMPOSITE_TRIGGER_RECORDED_VIA, DELAY_DETECTOR_RECORDED_VIA]),
    ));
  const out = { checked: 0, cancelled: 0, keptRan: 0, byReason: {} as Record<string, number>, unreadable: 0 };
  for (const event of waiting) {
    out.checked++;
    let standing: Standing;
    try {
      standing = event.recordedVia === DELAY_DETECTOR_RECORDED_VIA
        ? await delayAnchorWithdrawn(event).then((v): Standing => (v ? { stands: false, reason: v.reason, detail: v.detail } : { stands: true }))
        : await eventStanding(event);
    } catch (err) {
      out.unreadable++;
      console.error(`[campaign-service] settle-withdrawn: event ${event.id} could not be checked, left waiting:`, err);
      continue;
    }
    if (standing.stands) continue;
    const r = await closeWaiting(event, standing.reason, standing.detail, now);
    if (r === "cancelled") out.cancelled++;
    else out.keptRan++;
    out.byReason[standing.reason] = (out.byReason[standing.reason] ?? 0) + 1;
  }
  console.log(`[campaign-service] settle-withdrawn org=${input.orgId} brand=${input.brandId}: ${JSON.stringify(out)}`);
  return out;
}
