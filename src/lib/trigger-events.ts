import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { campaigns, triggerEvents, type TriggerEvent } from "../db/schema.js";
import { fetchChannelCatalogue, type ChannelCatalogueRead } from "./channel-operator-client.js";
import { sameLeg } from "./leg-identity.js";
import { DELAY_DETECTOR_RECORDED_VIA, delayGuard, type LeadActivityCache } from "./delay-trigger-detector.js";
import {
  runCampaignsInScope,
  runStep,
  type StepTriggerOutcome,
  type StepTriggerRequest,
} from "./step-trigger.js";
import type { WorkflowTriggerInput } from "./workflows.js";

/**
 * THE TRIGGER EVENTS — ONE ROW PER OCCURRENCE, AND WHAT IT DID (owner 2026-10-09).
 *
 * Every leg a channel performs is PROACTIVE (it finds or contacts people on its own budget, ticked
 * by the scheduler, no trigger) or REACTIVE (it runs ON DEMAND, and exactly one TRIGGER asks for it:
 * a positive reply received, a lead requested, a meeting booked...). Three things, three homes:
 *  1. the trigger TYPES (the list, same for every client): features-service `GET /public/channels`
 *     `triggers[]`, each reactive leg naming one on `stepTransitions[].triggerId`;
 *  2. the trigger EVENTS (one per occurrence): THIS module, table `trigger_events`;
 *  3. ON/OFF: per campaign, `campaigns.status`, unchanged.
 *
 * Before this, `trigger-for-step` named a reason for every skip but RECORDED nothing, so nothing
 * could prove a trigger fires, or say why a reactive campaign did not run last Tuesday.
 *
 * ── THE WRITE CONTRACT (`POST /internal/trigger-events`) ────────────────────────────────────────
 *
 *  - The caller names a DECLARED `triggerId` (features-service's list). Unknown = 400
 *    `unknown_trigger`, nothing recorded. Catalogue unreadable = 502, nothing recorded.
 *  - Due NOW (no `dueAt`, or `dueAt` <= now): fired in the same call through the step route's own
 *    dispatch (`runCampaignsInScope`: same guards, same funding, same `/execute`).
 *  - Due LATER (a planned event, "meeting in 3h" due 3h before it): recorded `pending`, fired by the
 *    scheduler tick when due (`fireDueTriggerEvents`), same rules.
 *  - ALREADY PERFORMED (`performed`): the caller did the work in-process (lead-service serving a lead
 *    on `lead_requested`) and states what happened: `{outcome: "ran", campaignId}` or
 *    `{outcome: "skipped", reason, detail?}`. Recorded as is; nothing is dispatched here.
 *  - `idempotencyKey` (optional, unique per org): a retried call returns the first event, recorded
 *    once.
 *  The step route (`trigger-for-step`) records its call the same way, typed with the trigger whose
 *  `fromStep` is that step (none declared = recorded with no type), and answers exactly as before.
 *
 * ── THE OUTCOME ─────────────────────────────────────────────────────────────────────────────────
 *
 * `ran` when at least one campaign was dispatched (`ranCampaignIds`). Otherwise `skipped` with ONE
 * reason: the first campaign's named skip (`unfunded`, `run_in_flight`, ...; lib/step-trigger.ts),
 * else `campaign_off` (a campaign is bought for the leg and its customer turned it off), else
 * `no_campaign` (nobody bought it), else `no_leg` (no published leg answers this trigger). Every
 * per-campaign answer rides in `detail`.
 */

export const TRIGGER_EVENT_SKIPS = {
  /** A campaign is bought for the leg and is OFF (`stopped`): the customer's statement. */
  CAMPAIGN_OFF: "campaign_off",
  /** Nobody bought a campaign for the leg on this offer. */
  NO_CAMPAIGN: "no_campaign",
  /** No published leg answers this trigger or step. */
  NO_LEG: "no_leg",
  /** A planned event whose type features-service no longer declares when it fell due. */
  TRIGGER_NOT_DECLARED: "trigger_not_declared",
} as const;

export const TRIGGER_EVENT_RECORDED_VIA = {
  STEP_ROUTE: "trigger_for_step",
  TRIGGER_ROUTE: "trigger_events",
  /** Planned by the generic `delay` detector (lib/delay-trigger-detector.ts). */
  DELAY_DETECTOR: "delay_detector",
  /** One new item seen by the generic `poll` detector (lib/poll-trigger-detector.ts). */
  POLL_DETECTOR: "poll_detector",
} as const;

const POLL_RECORDED_VIA = TRIGGER_EVENT_RECORDED_VIA.POLL_DETECTOR;

/** A failed fire of a due event is retried on this delay (catalogue outage, dispatch throw). */
export const TRIGGER_EVENT_RETRY_MS = 10 * 60_000;
/** A `firing` claim older than this is treated as orphaned (crash mid-fire) and re-claimed. */
export const TRIGGER_EVENT_CLAIM_STALE_MS = 15 * 60_000;
/** At most this many due events are fired per tick. */
export const TRIGGER_EVENT_BATCH = 50;

/** The caller named something that cannot be recorded. Nothing was written. */
export class TriggerEventError extends Error {
  readonly status: 400 | 502;
  readonly reason: string;
  constructor(message: string, status: 400 | 502, reason: string) {
    super(message);
    this.name = "TriggerEventError";
    this.status = status;
    this.reason = reason;
  }
}

type ScopeAnswer = Pick<StepTriggerOutcome, "triggered" | "skipped"> & {
  offCampaignIds: string[];
  legKeys: string[];
};

export interface EventVerdict {
  outcome: "ran" | "skipped";
  skipReason: string | null;
  ranCampaignIds: string[];
  detail: {
    legKeys: string[];
    triggered: StepTriggerOutcome["triggered"];
    skipped: StepTriggerOutcome["skipped"];
    offCampaignIds: string[];
  };
}

/** One outcome per event, from the per-campaign answers. Pure. */
export function eventVerdict(answer: ScopeAnswer): EventVerdict {
  const detail = {
    legKeys: answer.legKeys,
    triggered: answer.triggered,
    skipped: answer.skipped,
    offCampaignIds: answer.offCampaignIds,
  };
  if (answer.triggered.length > 0) {
    return { outcome: "ran", skipReason: null, ranCampaignIds: answer.triggered.map((t) => t.campaignId), detail };
  }
  const skipReason = answer.skipped[0]?.reason
    ?? (answer.offCampaignIds.length > 0 ? TRIGGER_EVENT_SKIPS.CAMPAIGN_OFF
      : answer.legKeys.length > 0 ? TRIGGER_EVENT_SKIPS.NO_CAMPAIGN
      : TRIGGER_EVENT_SKIPS.NO_LEG);
  return { outcome: "skipped", skipReason, ranCampaignIds: [], detail };
}

/**
 * Run the campaigns a TRIGGER asks for on (org, brand, offer): the ones bought for a (channel, leg)
 * whose reactive transition names this trigger id. Same dispatch as the step route.
 */
export async function fireTrigger(
  scope: { orgId: string; brandId: string; offerId: string },
  triggerId: string,
  catalogue: Extract<ChannelCatalogueRead, { ok: true }>,
  trigger?: WorkflowTriggerInput,
): Promise<ScopeAnswer> {
  const transitions = (catalogue.triggerTransitions ?? []).filter((t) => t.triggerId === triggerId);
  const legKeys = [...new Set(transitions.map((t) => t.legKey))];
  if (transitions.length === 0) return { triggered: [], skipped: [], offCampaignIds: [], legKeys };
  const run = await runCampaignsInScope(
    scope,
    (c) => transitions.some((t) => t.featureSlug === c.featureSlug && sameLeg(c.featureSlug, t.legKey, c.legKey)),
    `trigger ${triggerId}`,
    trigger,
  );
  return { ...run, legKeys };
}

// ── The step route ──────────────────────────────────────────────────────────────────────────────

/**
 * `trigger-for-step`, recorded. Same scope errors (thrown before anything is written), same answer;
 * the event row is written once the campaigns have been asked. A row that cannot be written is
 * logged at error and `eventId` is null: the dispatch already happened, and a 500 would make the
 * caller retry it.
 */
export async function triggerStepAndRecord(
  req: StepTriggerRequest & { leadId?: string },
): Promise<{ outcome: StepTriggerOutcome; eventId: string | null; triggerId: string | null }> {
  const run = await runStep(req);
  const verdict = eventVerdict({ ...run.outcome, offCampaignIds: run.offCampaignIds });
  const now = new Date();
  try {
    const [row] = await db.insert(triggerEvents).values({
      orgId: req.orgId,
      brandId: req.brandId,
      offerId: req.offerId,
      triggerId: run.triggerId,
      step: req.step,
      leadId: req.leadId ?? null,
      recordedVia: TRIGGER_EVENT_RECORDED_VIA.STEP_ROUTE,
      occurredAt: now,
      dueAt: now,
      status: "done",
      outcome: verdict.outcome,
      skipReason: verdict.skipReason,
      ranCampaignIds: verdict.ranCampaignIds,
      detail: verdict.detail,
      attempts: 1,
      claimedAt: now,
      processedAt: now,
    }).returning({ id: triggerEvents.id });
    return { outcome: run.outcome, eventId: row.id, triggerId: run.triggerId };
  } catch (err) {
    console.error(
      `[campaign-service] trigger event NOT recorded for step ${req.step} (org ${req.orgId}, brand ${req.brandId}, offer ${req.offerId}):`,
      err,
    );
    return { outcome: run.outcome, eventId: null, triggerId: run.triggerId };
  }
}

// ── The trigger route ───────────────────────────────────────────────────────────────────────────

export type PerformedStatement =
  | { outcome: "ran"; campaignId: string }
  | { outcome: "skipped"; reason: string; detail?: string };

export interface RecordTriggerEventInput {
  orgId: string;
  brandId: string;
  offerId: string;
  triggerId: string;
  leadId?: string;
  requestedByCampaignId?: string;
  idempotencyKey?: string;
  occurredAt?: Date;
  dueAt?: Date;
  performed?: PerformedStatement;
}

export interface RecordTriggerEventResult {
  event: TriggerEvent;
  /** True when `idempotencyKey` named an event already recorded: that event is returned, nothing new. */
  replayed: boolean;
}

async function findByIdempotencyKey(orgId: string, key: string): Promise<TriggerEvent | null> {
  const [row] = await db
    .select()
    .from(triggerEvents)
    .where(and(eq(triggerEvents.orgId, orgId), eq(triggerEvents.idempotencyKey, key)))
    .limit(1);
  return row ?? null;
}

export async function recordTriggerEvent(
  input: RecordTriggerEventInput,
  now: Date = new Date(),
): Promise<RecordTriggerEventResult> {
  const catalogue = await fetchChannelCatalogue();
  if (!catalogue.ok) {
    throw new TriggerEventError(
      `the acquisition-channel catalogue could not be read: ${catalogue.detail}`,
      502,
      "catalogue_unavailable",
    );
  }
  const type = catalogue.triggers?.get(input.triggerId);
  if (!type) {
    throw new TriggerEventError(
      `trigger ${JSON.stringify(input.triggerId)} is not a trigger type features-service declares`,
      400,
      "unknown_trigger",
    );
  }

  if (input.idempotencyKey) {
    const existing = await findByIdempotencyKey(input.orgId, input.idempotencyKey);
    if (existing) return { event: existing, replayed: true };
  }

  if (input.performed?.outcome === "ran") {
    const [owned] = await db
      .select({ id: campaigns.id })
      .from(campaigns)
      // `::text` on both: drizzle/0000 made campaigns.id/org_id uuid in some databases (CLAUDE.md),
      // and a caller's non-uuid id must be a named 400, not a cast error.
      .where(sql`${campaigns.id}::text = ${input.performed.campaignId} AND ${campaigns.orgId}::text = ${input.orgId}`)
      .limit(1);
    if (!owned) {
      throw new TriggerEventError(
        `campaign ${input.performed.campaignId} is not a campaign of org ${input.orgId}`,
        400,
        "unknown_campaign",
      );
    }
  }

  const occurredAt = input.occurredAt ?? now;
  const dueAt = input.dueAt ?? occurredAt;
  const planned = !input.performed && dueAt.getTime() > now.getTime();
  const base = {
    orgId: input.orgId,
    brandId: input.brandId,
    offerId: input.offerId,
    triggerId: type.id,
    step: type.fromStepKey,
    leadId: input.leadId ?? null,
    requestedByCampaignId: input.requestedByCampaignId ?? null,
    idempotencyKey: input.idempotencyKey ?? null,
    recordedVia: TRIGGER_EVENT_RECORDED_VIA.TRIGGER_ROUTE,
    occurredAt,
    dueAt,
  };

  let values: typeof triggerEvents.$inferInsert;
  if (input.performed) {
    const p = input.performed;
    values = {
      ...base,
      status: "done",
      outcome: p.outcome,
      skipReason: p.outcome === "skipped" ? p.reason : null,
      ranCampaignIds: p.outcome === "ran" ? [p.campaignId] : [],
      detail: p.outcome === "skipped" && p.detail ? { performedDetail: p.detail } : null,
      performedByCaller: true,
      processedAt: now,
    };
  } else if (planned) {
    values = { ...base, status: "pending" };
  } else {
    values = { ...base, status: "firing", claimedAt: now, attempts: 1 };
  }

  const inserted = await db.insert(triggerEvents).values(values).onConflictDoNothing().returning();
  if (inserted.length === 0) {
    // Lost an idempotency race to a concurrent call: that call's event is the one.
    const existing = input.idempotencyKey ? await findByIdempotencyKey(input.orgId, input.idempotencyKey) : null;
    if (!existing) throw new Error("trigger event insert wrote nothing and no idempotent twin exists");
    return { event: existing, replayed: true };
  }
  const event = inserted[0];
  if (event.status !== "firing") return { event, replayed: false };

  return { event: await fireClaimedEvent(event, catalogue, now), replayed: false };
}

/**
 * Fire one claimed event and write its outcome. A throw puts it back to `pending` on the retry delay.
 *
 * A DETECTOR-planned event (lib/delay-trigger-detector.ts, lib/poll-trigger-detector.ts) carries its
 * own context on the row (`detail`: the anchor, the item) which is kept beside the outcome, and rides
 * the `/execute` inputs as `trigger`. A `delay` event first asks whether anything happened to the
 * lead since the anchor (`delayGuard`): something did = a recorded skip, nothing dispatched.
 */
export async function fireClaimedEvent(
  event: TriggerEvent,
  catalogue: Extract<ChannelCatalogueRead, { ok: true }>,
  now: Date,
  context: { item?: unknown; leadActivity?: LeadActivityCache } = {},
): Promise<TriggerEvent> {
  try {
    let verdict: EventVerdict;
    const skipped = (skipReason: string, extra: Record<string, unknown> = {}): EventVerdict => ({
      outcome: "skipped",
      skipReason,
      ranCampaignIds: [],
      detail: { legKeys: [], triggered: [], skipped: [], offCampaignIds: [], ...extra },
    });
    const detected = event.recordedVia === DELAY_DETECTOR_RECORDED_VIA || event.recordedVia === POLL_RECORDED_VIA;
    if (!event.triggerId || !catalogue.triggers?.has(event.triggerId)) {
      verdict = skipped(TRIGGER_EVENT_SKIPS.TRIGGER_NOT_DECLARED);
    } else {
      const guard = event.recordedVia === DELAY_DETECTOR_RECORDED_VIA
        ? await delayGuard(event, context.leadActivity)
        : null;
      if (guard) {
        verdict = skipped(guard.reason, { guardDetail: guard.detail });
      } else {
        const trigger: WorkflowTriggerInput | undefined = detected
          ? { eventId: event.id, triggerId: event.triggerId, leadId: event.leadId, item: context.item ?? null }
          : undefined;
        verdict = eventVerdict(await fireTrigger(event, event.triggerId, catalogue, trigger));
      }
    }
    const own = event.detail && typeof event.detail === "object" && !Array.isArray(event.detail)
      ? (event.detail as Record<string, unknown>)
      : null;
    if (own) verdict = { ...verdict, detail: { ...own, ...verdict.detail } as EventVerdict["detail"] };
    const [done] = await db
      .update(triggerEvents)
      .set({
        status: "done",
        outcome: verdict.outcome,
        skipReason: verdict.skipReason,
        ranCampaignIds: verdict.ranCampaignIds,
        detail: verdict.detail,
        processedAt: new Date(),
        lastError: null,
      })
      .where(eq(triggerEvents.id, event.id))
      .returning();
    return done;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[campaign-service] trigger event ${event.id} (${event.triggerId}) could not be fired, retrying in 10 min:`, err);
    const [back] = await db
      .update(triggerEvents)
      .set({
        status: "pending",
        dueAt: new Date(now.getTime() + TRIGGER_EVENT_RETRY_MS),
        claimedAt: null,
        lastError: message.slice(0, 500),
      })
      .where(eq(triggerEvents.id, event.id))
      .returning();
    return back;
  }
}

// ── The tick ────────────────────────────────────────────────────────────────────────────────────

/**
 * Fire every event that has fallen due (and re-claim one orphaned mid-fire), with the same On/Off
 * and funding rules as an immediate one. Atomic claim (`FOR UPDATE SKIP LOCKED`), so two ticks
 * never fire one event. Returns how many were fired. A catalogue outage puts the claimed batch back
 * on the retry delay.
 */
export async function fireDueTriggerEvents(now: Date = new Date()): Promise<number> {
  const staleBefore = new Date(now.getTime() - TRIGGER_EVENT_CLAIM_STALE_MS);
  const claimed = await db
    .update(triggerEvents)
    .set({ status: "firing", claimedAt: now, attempts: sql`${triggerEvents.attempts} + 1` })
    .where(sql`${triggerEvents.id} IN (
      SELECT id FROM trigger_events
      WHERE (status = 'pending' AND due_at <= ${now.toISOString()}::timestamptz)
         OR (status = 'firing' AND claimed_at < ${staleBefore.toISOString()}::timestamptz)
      ORDER BY due_at
      LIMIT ${TRIGGER_EVENT_BATCH}
      FOR UPDATE SKIP LOCKED
    )`)
    .returning();
  if (claimed.length === 0) return 0;

  const catalogue = await fetchChannelCatalogue();
  if (!catalogue.ok) {
    console.error(`[campaign-service] ${claimed.length} due trigger event(s) not fired: catalogue unreadable (${catalogue.detail}); retrying in 10 min`);
    for (const event of claimed) {
      await db
        .update(triggerEvents)
        .set({
          status: "pending",
          dueAt: new Date(now.getTime() + TRIGGER_EVENT_RETRY_MS),
          claimedAt: null,
          lastError: `catalogue unreadable: ${catalogue.detail}`.slice(0, 500),
        })
        .where(eq(triggerEvents.id, event.id));
    }
    return 0;
  }

  let fired = 0;
  const leadActivity: LeadActivityCache = new Map();
  for (const event of claimed) {
    const done = await fireClaimedEvent(event, catalogue, now, { leadActivity });
    if (done.status === "done") fired += 1;
  }
  return fired;
}

/** When the next pending event falls due, so the scheduler never sleeps past it. */
export async function nextPendingTriggerDueAt(): Promise<Date | null> {
  const [row] = await db
    .select({ dueAt: triggerEvents.dueAt })
    .from(triggerEvents)
    .where(eq(triggerEvents.status, "pending"))
    .orderBy(triggerEvents.dueAt)
    .limit(1);
  return row?.dueAt ?? null;
}

// ── The reads ───────────────────────────────────────────────────────────────────────────────────

export interface OfferTriggerScope {
  orgId: string;
  brandId: string;
  offerId: string;
  from: Date;
  to: Date;
}

export interface TriggerSummaryRow {
  triggerId: string | null;
  /** Occurrences in the window (every status). */
  events: number;
  ran: number;
  skipped: number;
  /** Recorded, not fired yet (due later, or being fired). */
  pending: number;
  skippedByReason: Array<{ reason: string; count: number }>;
  lastOccurredAt: string | null;
}

/** Per trigger, over `[from, to]` on `occurred_at`: how many occurred, ran, were skipped (by reason). */
export async function summarizeOfferTriggerEvents(scope: OfferTriggerScope): Promise<TriggerSummaryRow[]> {
  const rows = await db
    .select({
      triggerId: triggerEvents.triggerId,
      status: triggerEvents.status,
      outcome: triggerEvents.outcome,
      skipReason: triggerEvents.skipReason,
      count: sql<number>`count(*)::int`,
      last: sql<string | null>`max(${triggerEvents.occurredAt})`,
    })
    .from(triggerEvents)
    .where(and(
      eq(triggerEvents.orgId, scope.orgId),
      eq(triggerEvents.brandId, scope.brandId),
      eq(triggerEvents.offerId, scope.offerId),
      gte(triggerEvents.occurredAt, scope.from),
      lte(triggerEvents.occurredAt, scope.to),
    ))
    .groupBy(triggerEvents.triggerId, triggerEvents.status, triggerEvents.outcome, triggerEvents.skipReason);

  const byTrigger = new Map<string | null, TriggerSummaryRow>();
  for (const r of rows) {
    let s = byTrigger.get(r.triggerId);
    if (!s) {
      s = { triggerId: r.triggerId, events: 0, ran: 0, skipped: 0, pending: 0, skippedByReason: [], lastOccurredAt: null };
      byTrigger.set(r.triggerId, s);
    }
    const n = Number(r.count);
    s.events += n;
    if (r.status !== "done") s.pending += n;
    else if (r.outcome === "ran") s.ran += n;
    else {
      s.skipped += n;
      const reason = r.skipReason ?? "unknown";
      const entry = s.skippedByReason.find((e) => e.reason === reason);
      if (entry) entry.count += n;
      else s.skippedByReason.push({ reason, count: n });
    }
    const last = r.last ? new Date(r.last).toISOString() : null;
    if (last && (!s.lastOccurredAt || last > s.lastOccurredAt)) s.lastOccurredAt = last;
  }
  const out = [...byTrigger.values()];
  for (const s of out) s.skippedByReason.sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
  return out.sort((a, b) => (a.triggerId ?? "~").localeCompare(b.triggerId ?? "~"));
}

/** The latest events of an offer, newest first. */
export async function listOfferTriggerEvents(
  scope: Omit<OfferTriggerScope, "from" | "to"> & { limit: number },
): Promise<TriggerEvent[]> {
  return db
    .select()
    .from(triggerEvents)
    .where(and(
      eq(triggerEvents.orgId, scope.orgId),
      eq(triggerEvents.brandId, scope.brandId),
      eq(triggerEvents.offerId, scope.offerId),
    ))
    .orderBy(desc(triggerEvents.occurredAt))
    .limit(scope.limit);
}

/** The wire shape of one event. */
export function serializeTriggerEvent(e: TriggerEvent) {
  return {
    id: e.id,
    triggerId: e.triggerId,
    step: e.step,
    orgId: e.orgId,
    brandId: e.brandId,
    offerId: e.offerId,
    leadId: e.leadId,
    requestedByCampaignId: e.requestedByCampaignId,
    recordedVia: e.recordedVia,
    occurredAt: e.occurredAt.toISOString(),
    dueAt: e.dueAt.toISOString(),
    status: e.status,
    outcome: e.outcome,
    skipReason: e.skipReason,
    ranCampaignIds: e.ranCampaignIds ?? [],
    performedByCaller: e.performedByCaller,
    processedAt: e.processedAt ? e.processedAt.toISOString() : null,
    detail: e.detail ?? null,
  };
}
