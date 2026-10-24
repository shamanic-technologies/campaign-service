import { and, eq, gt, inArray, isNotNull, isNull, ne, notInArray, or, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { campaigns, triggerEvents, type TriggerEvent } from "../db/schema.js";
import type { CatalogueTriggerTransition, CatalogueTriggerType, ChannelCatalogueRead } from "./channel-operator-client.js";
import { fetchOfferLeadActivity, type LeadActivityByLead } from "./lead-activity-client.js";
import { answersTrigger } from "./sales-funnel-head-trigger.js";
import { COMPOSITE_TRIGGER_RECORDED_VIA, compositesListing } from "./composite-trigger.js";
import { ON_DEMAND_TRIGGER_ID } from "./on-demand-mode.js";
import { fetchStepReachers, hasEverReachedStep } from "./step-reach-client.js";

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
 *  - for `lead_found`: an `on_demand` event (a sourcing pipe asked by the outreach run, owner 2026-10-11) or a
 *    `lead_requested` event (its name before 2026-10-11) that RAN for the lead (lead-service served the person).
 *
 * ── FIRE (the scheduler's due-event tick, `fireDueTriggerEvents`) ───────────────────────────────
 *
 * Before running anything, "NOTHING HAPPENED since the anchor" is checked at lead x OFFER grain,
 * any channel (`delayGuard`). Something happened = a recorded skip, nothing dispatched:
 *  - `lead_progressed`: any later event for the lead on the offer (another step, another trigger;
 *    a re-serve (`on_demand` / `lead_requested`) is not the lead doing anything), or a click measured after
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
 *
 * ── "FACT NOT FOLLOWED": `unlessStep` (owner 2026-10-14, FACT-NOT-FOLLOWED-1014) ─────────────────
 *
 * "A signup not followed by a paid client within 30 min", "a website visit not followed by a signup
 * within 30 min": params `{afterStep, minutes|days, unlessStep}`. Generic, any step pair, any brand.
 *  - ANCHORS are PEOPLE, read from lead-service (lib/step-reach-client.ts: who of the brand reached
 *    `afterStep`, when, by email; what a connector fact (auth, analytics, payments) means as a step is lead-service's).
 *    One `pending` event per person x trigger x offer, ever (key `delay:<trigger>:<offer>:<email>`),
 *    carrying `detail.person`: firing files the person at lead-service, makes them due and hands them
 *    to the run (lib/trigger-person.ts), exactly like a pushed person. A visitor with no email is never
 *    listed (cannot be written to). An anchor whose due time passed longer ago than the delay itself
 *    (capped at `DELAY_PLAN_LATE_MS`) is never planned: a connector backfill of old signups writes to
 *    nobody.
 *  - GUARD = the person has EVER reached `unlessStep` (lead-service, by email) = skip `step_reached`.
 *    Nothing else cancels it (a second visit is not a signup); opted-out / bounced people are refused
 *    by the filing itself (`person_suppressed`). Unreadable = retry, never fired on a guess.
 * Without `unlessStep` the trigger is the one above, byte-identical.
 */

export const DELAY_DETECTOR_RECORDED_VIA = "delay_detector";
export const POLL_DETECTOR_RECORDED_VIA = "poll_detector";
/** lib/github-issue-trigger.ts `GITHUB_ISSUE_DETECTOR_RECORDED_VIA` (kept literal here: that module imports this one's helpers). */
export const GITHUB_ISSUE_RECORDED_VIA = "github_issue_detector";
/**
 * Rows that are not an outside fact of their own (never an anchor, never "the lead progressed"); a composite occurrence
 * (`lead_event`, lib/composite-trigger.ts) re-states a fact already recorded.
 */
export const DETECTOR_RECORDED_VIA = [DELAY_DETECTOR_RECORDED_VIA, POLL_DETECTOR_RECORDED_VIA, GITHUB_ISSUE_RECORDED_VIA, COMPOSITE_TRIGGER_RECORDED_VIA] as const;

/** An anchor whose due time passed longer ago than this is never planned. */
export const DELAY_PLAN_LATE_MS = 2 * 24 * 60 * 60_000;

export const LEAD_FOUND_STEP = "lead_found";
export const LEAD_REQUESTED_TRIGGER_ID = "lead_requested";
/** The trigger a sourcing pipe answers since 2026-10-11 (features-service `channel-triggers.ts`): its ran event is a serve. */
export { ON_DEMAND_TRIGGER_ID };
/** Every trigger whose ran event is lead-service SERVING the lead: `on_demand`, and `lead_requested` (its history). */
export const LEAD_SERVE_TRIGGER_IDS: readonly string[] = [ON_DEMAND_TRIGGER_ID, LEAD_REQUESTED_TRIGGER_ID];

export const DELAY_SKIPS = {
  LEAD_REPLIED: "lead_replied",
  LEAD_PROGRESSED: "lead_progressed",
  LEAD_OPTED_OUT: "lead_opted_out",
  LEAD_UNREACHABLE: "lead_unreachable",
  LEAD_UNKNOWN: "lead_unknown",
  /** `unlessStep`: the person reached the step the trigger waits for ("still not Y" is false). */
  STEP_REACHED: "step_reached",
  /**
   * The fact the delay counts from was WITHDRAWN by its owner (a mail scanner's "visit" crm-service set aside,
   * WITHDRAWN-FACT-CANCELS-1024): the person no longer reaches the anchor step, so "X not followed by Y" never began.
   */
  ANCHOR_WITHDRAWN: "anchor_withdrawn",
} as const;

/** Whether an event was withdrawn by the caller that recorded it (`detail.withdrawnAt`, lib/trigger-withdrawal.ts). Pure. */
export function isWithdrawnEventDetail(detail: unknown): boolean {
  return !!detail && typeof detail === "object" && !Array.isArray(detail) && typeof (detail as Record<string, unknown>).withdrawnAt === "string";
}

/**
 * Does the fact a delay event counts from still hold? Null = it does. A person delay (`unlessStep`) re-asks
 * lead-service whether the person still reaches the anchor step (a withdrawn fact no longer does); a lead delay
 * checks its anchor event was not withdrawn. Throws when it cannot be told.
 */
export async function delayAnchorWithdrawn(event: TriggerEvent): Promise<DelayGuardVerdict | null> {
  const own = (event.detail ?? {}) as { unlessStep?: unknown; afterStep?: unknown; anchorEventId?: unknown; person?: { email?: unknown } };
  const afterStep = typeof own.afterStep === "string" && own.afterStep ? own.afterStep : event.step;
  if (typeof own.unlessStep === "string" && own.unlessStep) {
    const email = typeof own.person?.email === "string" ? own.person.email : null;
    if (!email || !afterStep) throw new Error(`delay event ${event.id} names no person or anchor step`);
    const stands = await hasEverReachedStep({ orgId: event.orgId, brandId: event.brandId, step: afterStep, email });
    return stands ? null : { reason: DELAY_SKIPS.ANCHOR_WITHDRAWN, detail: `the person no longer reaches ${afterStep}: its fact was withdrawn` };
  }
  if (typeof own.anchorEventId === "string") {
    const [anchor] = await db.select({ detail: triggerEvents.detail }).from(triggerEvents).where(eq(triggerEvents.id, own.anchorEventId)).limit(1);
    if (anchor && isWithdrawnEventDetail(anchor.detail)) {
      return { reason: DELAY_SKIPS.ANCHOR_WITHDRAWN, detail: `anchor event ${own.anchorEventId} was withdrawn` };
    }
  }
  return null;
}

export const DELAY_MIN_MINUTES = 5;

export interface DelayParams {
  afterStep: string;
  /** Exactly one of `days` / `minutes` is stated. */
  days?: number;
  minutes?: number;
  /** "Still not this step": the occurrence is cancelled when the person ever reached it. */
  unlessStep?: string;
}

/** The delay in ms. Pure. */
export function delayMsOf(params: DelayParams): number {
  return params.minutes !== undefined ? params.minutes * 60_000 : params.days! * 24 * 60 * 60_000;
}

/** Read a delay trigger's parameters. Null = not a delay this service can detect (said by the caller). */
export function parseDelayParams(params: Record<string, unknown> | null | undefined): DelayParams | null {
  if (!params) return null;
  const { afterStep, days, minutes, unlessStep } = params;
  if (typeof afterStep !== "string" || afterStep.length === 0) return null;
  if ((days === undefined) === (minutes === undefined)) return null;
  if (days !== undefined && (typeof days !== "number" || !Number.isInteger(days) || days < 1)) return null;
  if (minutes !== undefined && (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes < DELAY_MIN_MINUTES)) return null;
  if (unlessStep !== undefined && (typeof unlessStep !== "string" || unlessStep.length === 0 || unlessStep === afterStep)) return null;
  return {
    afterStep,
    ...(days !== undefined ? { days: days as number } : { minutes: minutes as number }),
    ...(unlessStep !== undefined ? { unlessStep: unlessStep as string } : {}),
  };
}

export interface DetectableTrigger<P> {
  type: CatalogueTriggerType;
  params: P;
  transitions: CatalogueTriggerTransition[];
  /**
   * The triggers made of this one (`lead_event`, lib/composite-trigger.ts) and their transitions: a campaign answering
   * one of them answers this trigger's occurrences too, so its scopes are watched. Optional (hand-built reads).
   */
  composites?: Array<{ type: { id: string }; transitions: CatalogueTriggerTransition[] }>;
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

/**
 * The triggers some ONGOING unit of a funnel headed by a trigger runs on (`campaigns.runs_on_trigger_id`,
 * lib/sales-funnel-head-trigger.ts). One read per detector pass.
 */
export async function liveHeadTriggerIds(): Promise<Set<string>> {
  const rows = await db
    .selectDistinct({ id: campaigns.runsOnTriggerId })
    .from(campaigns)
    .where(and(eq(campaigns.status, "ongoing"), isNotNull(campaigns.runsOnTriggerId)));
  return new Set(rows.flatMap((r) => (r.id ? [r.id] : [])));
}

/**
 * Every trigger of `kind` something answers (lib/sales-funnel-head-trigger.ts `answersTrigger`): a reactive leg names
 * it, or a live unit of a funnel headed by it runs on it (FUNNEL-HEAD-TRIGGER-1015), with its parsed parameters.
 */
export async function detectableTriggers<P>(
  catalogue: Extract<ChannelCatalogueRead, { ok: true }>,
  kind: "delay" | "poll" | "github_issue_in_prod",
  parse: (params: Record<string, unknown> | null | undefined) => ParamsRead<P>,
): Promise<DetectableTrigger<P>[]> {
  const out: DetectableTrigger<P>[] = [];
  const ofKind = [...(catalogue.triggers?.values() ?? [])].filter((type) => type.kind === kind);
  if (ofKind.length === 0) return out;
  const heads = await liveHeadTriggerIds();
  const transitionsOf = (id: string) => (catalogue.triggerTransitions ?? []).filter((t) => t.triggerId === id);
  for (const type of ofKind) {
    const transitions = transitionsOf(type.id);
    // A campaign answering a trigger made of this one (`lead_event`) answers this one's occurrences too.
    const composites = compositesListing(catalogue, type.id)
      .map((c) => ({ type: { id: c.id }, transitions: transitionsOf(c.id) }))
      .filter((c) => c.transitions.length > 0 || heads.has(c.type.id));
    if (transitions.length === 0 && !heads.has(type.id) && composites.length === 0) continue;
    const read = parse(type.params);
    if (!read.ok) {
      reportUndetectableTrigger(type, read.error);
      continue;
    }
    out.push({ type, params: read.params, transitions, ...(composites.length > 0 ? { composites } : {}) });
  }
  return out;
}

/** `parseDelayParams` as a detector read. */
export function readDelayParams(params: Record<string, unknown> | null | undefined): ParamsRead<DelayParams> {
  const parsed = parseDelayParams(params);
  return parsed
    ? { ok: true, params: parsed }
    : {
        ok: false,
        error: `params must be {afterStep: <step key>, days: <whole number >= 1> | minutes: <whole number >= ${DELAY_MIN_MINUTES}>, unlessStep?: <another step key>}`,
      };
}

export interface TriggerScope {
  orgId: string;
  brandId: string;
  offerId: string;
}

/** The (org, brand, offer) scopes with an ONGOING campaign answering the trigger (`answersTrigger`). */
export async function liveScopesBehind(trigger: {
  type: { id: string };
  transitions: readonly CatalogueTriggerTransition[];
  composites?: ReadonlyArray<{ type: { id: string }; transitions: readonly CatalogueTriggerTransition[] }>;
}): Promise<TriggerScope[]> {
  if (trigger.composites && trigger.composites.length > 0) {
    // This trigger's own scopes, and the scopes of every trigger made of it (lib/composite-trigger.ts).
    const all = await Promise.all([{ type: trigger.type, transitions: trigger.transitions }, ...trigger.composites].map((t) => liveScopesBehind(t)));
    const seen = new Map<string, TriggerScope>();
    for (const scope of all.flat()) seen.set(`${scope.orgId}|${scope.brandId}|${scope.offerId}`, scope);
    return [...seen.values()];
  }
  const { transitions } = trigger;
  const slugs = [...new Set(transitions.map((t) => t.featureSlug))];
  const live = await db
    .select({
      orgId: campaigns.orgId,
      brandId: campaigns.brandId,
      brandIds: campaigns.brandIds,
      offerId: campaigns.offerId,
      featureSlug: campaigns.featureSlug,
      legKey: campaigns.legKey,
      runsOnTriggerId: campaigns.runsOnTriggerId,
    })
    .from(campaigns)
    .where(and(
      eq(campaigns.status, "ongoing"),
      isNotNull(campaigns.offerId),
      isNotNull(campaigns.legKey),
      slugs.length > 0
        ? or(inArray(campaigns.featureSlug, slugs), eq(campaigns.runsOnTriggerId, trigger.type.id))
        : eq(campaigns.runsOnTriggerId, trigger.type.id),
    ));
  const seen = new Map<string, TriggerScope>();
  for (const c of live) {
    if (!answersTrigger(c, trigger.type.id, transitions)) continue;
    const brands = c.brandIds && c.brandIds.length > 0 ? c.brandIds : c.brandId ? [c.brandId] : [];
    for (const brandId of brands) {
      const scope = { orgId: c.orgId, brandId, offerId: c.offerId! };
      seen.set(`${scope.orgId}|${scope.brandId}|${scope.offerId}`, scope);
    }
  }
  return [...seen.values()];
}

/** `subject` = the lead id (a step anchor of ours) or the person's canonical email (`unlessStep`). */
export function delayIdempotencyKey(triggerId: string, offerId: string, subject: string): string {
  return `delay:${triggerId}:${offerId}:${subject}`;
}

/** The SQL predicate "this event says the lead reached `step`". */
function reachedStep(step: string) {
  const byStep = eq(triggerEvents.step, step);
  if (step !== LEAD_FOUND_STEP) return byStep;
  return or(
    byStep,
    and(inArray(triggerEvents.triggerId, [...LEAD_SERVE_TRIGGER_IDS]), eq(triggerEvents.outcome, "ran")),
  )!;
}

/** Plan one scope of one delay trigger. Returns how many events were planned (new rows). */
export async function planDelayScope(
  trigger: { id: string; params: DelayParams },
  scope: TriggerScope,
  now: Date,
): Promise<number> {
  if (trigger.params.unlessStep) return planPersonDelayScope(trigger, scope, now);
  const delayMs = delayMsOf(trigger.params);
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
        ...(trigger.params.minutes !== undefined ? { minutes: trigger.params.minutes } : {}),
      },
    };
  });
  const inserted = await db.insert(triggerEvents).values(rows).onConflictDoNothing().returning({ id: triggerEvents.id });
  return inserted.length;
}

/** How late an anchor may be planned: never later than the delay itself, at most `DELAY_PLAN_LATE_MS`. Pure. */
export function personDelayLateMs(params: DelayParams): number {
  return Math.min(DELAY_PLAN_LATE_MS, delayMsOf(params));
}

/** Plan one scope of a "fact not followed" trigger (`unlessStep`): anchors are PEOPLE, read from lead-service. */
async function planPersonDelayScope(
  trigger: { id: string; params: DelayParams },
  scope: TriggerScope,
  now: Date,
): Promise<number> {
  const delayMs = delayMsOf(trigger.params);
  const windowStart = new Date(now.getTime() - delayMs - personDelayLateMs(trigger.params));
  const reachers = await fetchStepReachers({
    orgId: scope.orgId,
    brandId: scope.brandId,
    step: trigger.params.afterStep,
    since: windowStart,
  });
  if (reachers.length === 0) return 0;

  const rows = reachers.map((p) => {
    const dueAt = new Date(p.reachedAt.getTime() + delayMs);
    return {
      orgId: scope.orgId,
      brandId: scope.brandId,
      offerId: scope.offerId,
      triggerId: trigger.id,
      step: trigger.params.afterStep,
      leadId: null,
      idempotencyKey: delayIdempotencyKey(trigger.id, scope.offerId, p.email),
      recordedVia: DELAY_DETECTOR_RECORDED_VIA,
      occurredAt: dueAt,
      dueAt,
      status: "pending",
      detail: {
        anchorAt: p.reachedAt.toISOString(),
        afterStep: trigger.params.afterStep,
        unlessStep: trigger.params.unlessStep,
        ...(trigger.params.days !== undefined ? { days: trigger.params.days } : { minutes: trigger.params.minutes }),
        person: { email: p.email, name: p.name, phone: p.phone, crmContact: null },
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
  const withdrawn = await delayAnchorWithdrawn(event);
  if (withdrawn) return withdrawn;
  const own = (event.detail ?? {}) as { unlessStep?: unknown; person?: { email?: unknown } };
  if (typeof own.unlessStep === "string" && own.unlessStep) {
    const email = typeof own.person?.email === "string" ? own.person.email : null;
    if (!email) throw new Error(`delay event ${event.id} waits on step ${own.unlessStep} but names no person`);
    const reached = await hasEverReachedStep({ orgId: event.orgId, brandId: event.brandId, step: own.unlessStep, email });
    return reached
      ? { reason: DELAY_SKIPS.STEP_REACHED, detail: `the person reached ${own.unlessStep}` }
      : null;
  }
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
      or(isNull(triggerEvents.triggerId), notInArray(triggerEvents.triggerId, [...LEAD_SERVE_TRIGGER_IDS])),
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
