import { and, eq, gt, inArray, isNotNull, ne, notInArray, or, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { campaigns, triggerEvents, type TriggerEvent } from "../db/schema.js";
import type { CatalogueTriggerTransition, CatalogueTriggerType, ChannelCatalogueRead } from "./channel-operator-client.js";
import { fetchOfferLeadActivity, type LeadActivityByLead } from "./lead-activity-client.js";
import { sameLeg } from "./leg-identity.js";

/**
 * THE GENERIC `delay` DETECTOR (owner 2026-10-09): "N days after a lead reached step X, if nothing
 * happened, run the leg". The trigger TYPE is features-service's declaration (`/public/channels`
 * `triggers[]`, `kind: "delay"`, `params: {afterStep, days}`); the EVENTS, their due times and the
 * door that fires them are this service's (lib/trigger-events.ts).
 *
 * ── PLAN (every detector tick, lib/trigger-detectors.ts) ────────────────────────────────────────
 *
 * For each delay trigger that a published reactive leg names, and each (org, brand, offer) with an
 * ONGOING campaign on such a leg: every lead that REACHED `afterStep` there (an anchor, below) in the
 * last `days + DELAY_PLAN_LATE_MS` gets ONE `pending` event due `anchor + days` (idempotency key
 * `delay:<trigger>:<offer>:<lead>`: once per lead x trigger x offer, ever; the earliest anchor wins).
 * An anchor whose due time passed more than `DELAY_PLAN_LATE_MS` ago is never planned (a trigger
 * declared today does not fire on last month's leads). Planning writes no outcome and runs nothing.
 *
 * WHAT "REACHED afterStep" MEANS, from what this service records (`trigger_events`, any channel):
 *  - an event stating `step = afterStep` for the lead (the step route, an event trigger's from-step);
 *  - for `lead_found`: a `lead_requested` event that RAN for the lead (lead-service served the person).
 *
 * ── FIRE (the scheduler's due-event tick, `fireDueTriggerEvents`) ───────────────────────────────
 *
 * Before running anything, "NOTHING HAPPENED since the anchor" is checked at lead x OFFER grain,
 * any channel (`delayGuard`). Something happened = a recorded skip, nothing dispatched:
 *  - `lead_progressed`: any later event for the lead on the offer (another step, another trigger;
 *    a re-serve by `lead_requested` is not the lead doing anything), or a click measured after
 *    `lead_found`;
 *  - `lead_replied`: lead-service measured a reply (after `lead_found`: any reply), or the CRM dates
 *    a positive reply after the anchor;
 *  - `lead_opted_out` / `lead_unreachable`: an unsubscribe / a bounce on any of the person's rows;
 *  - `lead_unknown`: lead-service holds no row for the lead on the offer (nothing is sent to someone
 *    no evidence can be read for).
 * lead-service unreadable THROWS: the event goes back to `pending` on the 10-min retry, never fired
 * on a guess. Otherwise the leg's campaigns are run through the step route's own dispatch, the
 * event id + lead riding the `/execute` inputs (`trigger`).
 *
 * LIMIT, stated: lead-service's evidence is not dated except the CRM reply, so after an anchor LATER
 * than `lead_found` only our own later events and the dated CRM reply count (a reply that predates a
 * click anchor cannot be told from one after it, so neither is used).
 */

export const DELAY_DETECTOR_RECORDED_VIA = "delay_detector";
export const POLL_DETECTOR_RECORDED_VIA = "poll_detector";
export const DETECTOR_RECORDED_VIA = [DELAY_DETECTOR_RECORDED_VIA, POLL_DETECTOR_RECORDED_VIA] as const;

/** An anchor whose due time passed longer ago than this is never planned. */
export const DELAY_PLAN_LATE_MS = 2 * 24 * 60 * 60_000;

export const LEAD_FOUND_STEP = "lead_found";
export const LEAD_REQUESTED_TRIGGER_ID = "lead_requested";

export const DELAY_SKIPS = {
  LEAD_REPLIED: "lead_replied",
  LEAD_PROGRESSED: "lead_progressed",
  LEAD_OPTED_OUT: "lead_opted_out",
  LEAD_UNREACHABLE: "lead_unreachable",
  LEAD_UNKNOWN: "lead_unknown",
} as const;

export interface DelayParams {
  afterStep: string;
  days: number;
}

/** Read a delay trigger's parameters. Null = not a delay this service can detect (said by the caller). */
export function parseDelayParams(params: Record<string, unknown> | null | undefined): DelayParams | null {
  if (!params) return null;
  const { afterStep, days } = params;
  if (typeof afterStep !== "string" || afterStep.length === 0) return null;
  if (typeof days !== "number" || !Number.isInteger(days) || days < 1) return null;
  return { afterStep, days };
}

export interface DetectableTrigger<P> {
  type: CatalogueTriggerType;
  params: P;
  transitions: CatalogueTriggerTransition[];
}

const reportedBadParams = new Set<string>();

/** Report, once per process and trigger, a declared trigger whose parameters cannot be detected. */
export function reportUndetectableTrigger(t: CatalogueTriggerType, why: string): void {
  if (reportedBadParams.has(t.id)) return;
  reportedBadParams.add(t.id);
  console.error(
    `[campaign-service] trigger ${t.id} (kind ${t.kind}) cannot be detected: ${why}; params=${JSON.stringify(t.params ?? null).slice(0, 300)}`,
  );
}

export type ParamsRead<P> = { ok: true; params: P } | { ok: false; error: string };

/** Every trigger of `kind` a reactive leg names, with its parsed parameters. Pure but for the error report. */
export function detectableTriggers<P>(
  catalogue: Extract<ChannelCatalogueRead, { ok: true }>,
  kind: "delay" | "poll",
  parse: (params: Record<string, unknown> | null | undefined) => ParamsRead<P>,
): DetectableTrigger<P>[] {
  const out: DetectableTrigger<P>[] = [];
  for (const type of catalogue.triggers?.values() ?? []) {
    if (type.kind !== kind) continue;
    const transitions = (catalogue.triggerTransitions ?? []).filter((t) => t.triggerId === type.id);
    if (transitions.length === 0) continue;
    const read = parse(type.params);
    if (!read.ok) {
      reportUndetectableTrigger(type, read.error);
      continue;
    }
    out.push({ type, params: read.params, transitions });
  }
  return out;
}

/** `parseDelayParams` as a detector read. */
export function readDelayParams(params: Record<string, unknown> | null | undefined): ParamsRead<DelayParams> {
  const parsed = parseDelayParams(params);
  return parsed ? { ok: true, params: parsed } : { ok: false, error: "params must be {afterStep: <step key>, days: <whole number >= 1>}" };
}

export interface TriggerScope {
  orgId: string;
  brandId: string;
  offerId: string;
}

/** The (org, brand, offer) scopes with an ONGOING campaign on a leg the trigger names. */
export async function liveScopesBehind(transitions: readonly CatalogueTriggerTransition[]): Promise<TriggerScope[]> {
  const slugs = [...new Set(transitions.map((t) => t.featureSlug))];
  if (slugs.length === 0) return [];
  const live = await db
    .select({
      orgId: campaigns.orgId,
      brandId: campaigns.brandId,
      brandIds: campaigns.brandIds,
      offerId: campaigns.offerId,
      featureSlug: campaigns.featureSlug,
      legKey: campaigns.legKey,
    })
    .from(campaigns)
    .where(and(
      eq(campaigns.status, "ongoing"),
      isNotNull(campaigns.offerId),
      isNotNull(campaigns.legKey),
      inArray(campaigns.featureSlug, slugs),
    ));
  const seen = new Map<string, TriggerScope>();
  for (const c of live) {
    if (!transitions.some((t) => t.featureSlug === c.featureSlug && sameLeg(c.featureSlug!, t.legKey, c.legKey))) continue;
    const brands = c.brandIds && c.brandIds.length > 0 ? c.brandIds : c.brandId ? [c.brandId] : [];
    for (const brandId of brands) {
      const scope = { orgId: c.orgId, brandId, offerId: c.offerId! };
      seen.set(`${scope.orgId}|${scope.brandId}|${scope.offerId}`, scope);
    }
  }
  return [...seen.values()];
}

export function delayIdempotencyKey(triggerId: string, offerId: string, leadId: string): string {
  return `delay:${triggerId}:${offerId}:${leadId}`;
}

/** The SQL predicate "this event says the lead reached `step`". */
function reachedStep(step: string) {
  const byStep = eq(triggerEvents.step, step);
  if (step !== LEAD_FOUND_STEP) return byStep;
  return or(
    byStep,
    and(eq(triggerEvents.triggerId, LEAD_REQUESTED_TRIGGER_ID), eq(triggerEvents.outcome, "ran")),
  )!;
}

/** Plan one scope of one delay trigger. Returns how many events were planned (new rows). */
export async function planDelayScope(
  trigger: { id: string; params: DelayParams },
  scope: TriggerScope,
  now: Date,
): Promise<number> {
  const delayMs = trigger.params.days * 24 * 60 * 60_000;
  const windowStart = new Date(now.getTime() - delayMs - DELAY_PLAN_LATE_MS);
  const anchors = await db
    .selectDistinctOn([triggerEvents.leadId], {
      id: triggerEvents.id,
      leadId: triggerEvents.leadId,
      occurredAt: triggerEvents.occurredAt,
    })
    .from(triggerEvents)
    .where(and(
      eq(triggerEvents.orgId, scope.orgId),
      eq(triggerEvents.brandId, scope.brandId),
      eq(triggerEvents.offerId, scope.offerId),
      isNotNull(triggerEvents.leadId),
      notInArray(triggerEvents.recordedVia, [...DETECTOR_RECORDED_VIA]),
      gt(triggerEvents.occurredAt, windowStart),
      reachedStep(trigger.params.afterStep),
    ))
    .orderBy(triggerEvents.leadId, triggerEvents.occurredAt);
  if (anchors.length === 0) return 0;

  const rows = anchors.map((a) => {
    const dueAt = new Date(a.occurredAt.getTime() + delayMs);
    return {
      orgId: scope.orgId,
      brandId: scope.brandId,
      offerId: scope.offerId,
      triggerId: trigger.id,
      step: trigger.params.afterStep,
      leadId: a.leadId,
      idempotencyKey: delayIdempotencyKey(trigger.id, scope.offerId, a.leadId!),
      recordedVia: DELAY_DETECTOR_RECORDED_VIA,
      occurredAt: dueAt,
      dueAt,
      status: "pending",
      detail: {
        anchorEventId: a.id,
        anchorAt: a.occurredAt.toISOString(),
        afterStep: trigger.params.afterStep,
        days: trigger.params.days,
      },
    };
  });
  const inserted = await db.insert(triggerEvents).values(rows).onConflictDoNothing().returning({ id: triggerEvents.id });
  return inserted.length;
}

export interface DelayGuardVerdict {
  reason: (typeof DELAY_SKIPS)[keyof typeof DELAY_SKIPS];
  detail: string;
}

/** lead-service reads, one per (org, brand, offer), shared by every delay event of one fire batch. */
export type LeadActivityCache = Map<string, Promise<LeadActivityByLead>>;

interface DelayAnchor {
  anchorEventId: string | null;
  anchorAt: Date;
  afterStep: string;
}

function anchorOf(event: TriggerEvent): DelayAnchor {
  const d = (event.detail ?? {}) as { anchorEventId?: unknown; anchorAt?: unknown; afterStep?: unknown };
  const anchorAt = typeof d.anchorAt === "string" ? new Date(d.anchorAt) : null;
  if (!anchorAt || Number.isNaN(anchorAt.getTime())) {
    throw new Error(`delay event ${event.id} states no anchor time`);
  }
  return {
    anchorEventId: typeof d.anchorEventId === "string" ? d.anchorEventId : null,
    anchorAt,
    afterStep: typeof d.afterStep === "string" ? d.afterStep : event.step ?? "",
  };
}

/**
 * Did anything happen to the lead on the offer since it reached the step? Null = nothing: fire.
 * Throws when it cannot be told (lead-service unreadable, no lead on the event).
 */
export async function delayGuard(event: TriggerEvent, cache: LeadActivityCache = new Map()): Promise<DelayGuardVerdict | null> {
  if (!event.leadId) throw new Error(`delay event ${event.id} names no lead`);
  const anchor = anchorOf(event);

  const [later] = await db
    .select({ id: triggerEvents.id, triggerId: triggerEvents.triggerId, step: triggerEvents.step, occurredAt: triggerEvents.occurredAt })
    .from(triggerEvents)
    .where(and(
      eq(triggerEvents.orgId, event.orgId),
      eq(triggerEvents.brandId, event.brandId),
      eq(triggerEvents.offerId, event.offerId),
      eq(triggerEvents.leadId, event.leadId),
      gt(triggerEvents.occurredAt, anchor.anchorAt),
      ne(triggerEvents.id, event.id),
      notInArray(triggerEvents.recordedVia, [...DETECTOR_RECORDED_VIA]),
      sql`${triggerEvents.triggerId} IS DISTINCT FROM ${LEAD_REQUESTED_TRIGGER_ID}`,
      ...(anchor.anchorEventId ? [ne(triggerEvents.id, anchor.anchorEventId)] : []),
    ))
    .orderBy(triggerEvents.occurredAt)
    .limit(1);
  if (later) {
    return {
      reason: DELAY_SKIPS.LEAD_PROGRESSED,
      detail: `event ${later.id} (${later.triggerId ?? later.step ?? "unknown"}) at ${later.occurredAt.toISOString()}`,
    };
  }

  const key = `${event.orgId}|${event.brandId}|${event.offerId}`;
  let read = cache.get(key);
  if (!read) {
    read = fetchOfferLeadActivity({ orgId: event.orgId, brandId: event.brandId, offerId: event.offerId });
    cache.set(key, read);
    // A failed read is not kept: the next event of the batch asks again.
    read.catch(() => cache.delete(key));
  }
  const activity = (await read).get(event.leadId);
  if (!activity) return { reason: DELAY_SKIPS.LEAD_UNKNOWN, detail: "lead-service holds no row for this lead on the offer" };
  if (activity.unsubscribed) return { reason: DELAY_SKIPS.LEAD_OPTED_OUT, detail: "the person unsubscribed" };
  if (activity.bounced) return { reason: DELAY_SKIPS.LEAD_UNREACHABLE, detail: "an email to the person bounced" };
  if (activity.crmPositiveReplyAt && new Date(activity.crmPositiveReplyAt) > anchor.anchorAt) {
    return { reason: DELAY_SKIPS.LEAD_REPLIED, detail: `the CRM dates a positive reply at ${activity.crmPositiveReplyAt}` };
  }
  if (anchor.afterStep === LEAD_FOUND_STEP) {
    if (activity.replied) return { reason: DELAY_SKIPS.LEAD_REPLIED, detail: "lead-service measured a reply" };
    if (activity.clicked) return { reason: DELAY_SKIPS.LEAD_PROGRESSED, detail: "lead-service measured a click" };
  }
  return null;
}
