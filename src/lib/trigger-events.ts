import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { campaigns, triggerEvents, type TriggerEvent, type TriggerEventDelivery } from "../db/schema.js";
import { fetchChannelCatalogue, type ChannelCatalogueRead } from "./channel-operator-client.js";
import { DELAY_DETECTOR_RECORDED_VIA, GITHUB_ISSUE_RECORDED_VIA, delayGuard, type LeadActivityCache } from "./delay-trigger-detector.js";
import {
  runCampaignsInScope,
  runStep,
  type StepTriggerOutcome,
  type StepTriggerRequest,
} from "./step-trigger.js";
import type { WorkflowTriggerInput } from "./workflows.js";
import {
  OWED_EVENT_RECHECK_MS,
  OWED_UNTIL_ROOM_SKIPS,
  PERSON_EVENT_RETRY_SKIPS,
  PERSON_NOT_KNOWN_RETRY_MS,
  PERSON_NOT_KNOWN_WAIT_MS,
  storedEventPerson,
  personLabel,
  type EventPerson,
} from "./trigger-person.js";
import { deliveriesByEvent, deliveryOf, eventCarries, recordDeliveries } from "./trigger-deliveries.js";
import { answersTrigger, doorRefusal, TRIGGER_NOT_CALLABLE } from "./sales-funnel-head-trigger.js";

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
 *  - Two doors, one write. The INTERNAL door (`POST /internal/trigger-events`, our own services:
 *    lead-service's `lead_requested`, the Copilot's `follow_up_due`...) takes every declared trigger.
 *    The PUBLIC door (`POST /internal/trigger-events/public`, what api-service's `POST /v1/trigger-events`
 *    pipes an outside caller to) refuses a trigger features-service serves `callable: false` (a
 *    condition we compute, or a request between our services) = 400 `trigger_not_callable`, nothing
 *    recorded; `callable` not served = accepted (lib/sales-funnel-head-trigger.ts). Detectors write their own rows.
 *  - Due NOW (no `dueAt`, or `dueAt` <= now): fired in the same call through the step route's own
 *    dispatch (`runCampaignsInScope`: same guards, same funding, same `/execute`).
 *  - Due LATER (a planned event, "meeting in 3h" due 3h before it): recorded `pending`, fired by the
 *    scheduler tick when due (`fireDueTriggerEvents`), same rules.
 *  - ALREADY PERFORMED (`performed`): the caller did the work in-process (lead-service serving a lead
 *    on `on_demand`) and states what happened: `{outcome: "ran", campaignId}` or
 *    `{outcome: "skipped", reason, detail?}`. Recorded as is; nothing is dispatched here.
 *  - `idempotencyKey` (optional, unique per org): a retried call returns the first event, recorded
 *    once.
 *  - `person` + `item` (optional, any trigger; lib/trigger-person.ts): the person the occurrence is
 *    about by IDENTITY (email, name, phone, CRM contact) and what they asked (any JSON). Kept on the row
 *    (`detail.person`, `detail.item`); each campaign reached files the person as a lead at lead-service,
 *    makes them due, and receives both on `/execute` `trigger`. A person the brand does not know YET
 *    keeps the event `pending` on a short retry, then `skipped` `person_not_known`. A campaign held
 *    for money or pacing (cap reached, unfunded, run in flight...) keeps it `pending` with no
 *    deadline until it can run, once (lib/trigger-person.ts `OWED_UNTIL_ROOM_SKIPS`).
 *  The step route (`trigger-for-step`) records its call the same way, typed with the trigger whose
 *  `fromStep` is that step (none declared = recorded with no type), and answers exactly as before.
 *
 * ── THE OUTCOME ─────────────────────────────────────────────────────────────────────────────────
 *
 * `ranLeads` (served): per campaign that ran, the lead its run carried (`trigger.leadId`: the person filed on
 * that campaign at lead-service), kept on `detail.ranLeads` across attempts (PUSHED-EVENT-LEAD-1014).
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
  /** A GitHub issue a funnel campaign waits on reached prod (lib/github-issue-trigger-detector.ts). */
  GITHUB_ISSUE_DETECTOR: "github_issue_detector",
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
  // A campaign the customer's own team operates (no workflow, by design) never names the outcome while
  // another campaign the event reached skipped for a reason of its own.
  const skipReason = (answer.skipped.find((s) => s.reason !== "no_workflow") ?? answer.skipped[0])?.reason
    ?? (answer.offCampaignIds.length > 0 ? TRIGGER_EVENT_SKIPS.CAMPAIGN_OFF
      : answer.legKeys.length > 0 ? TRIGGER_EVENT_SKIPS.NO_CAMPAIGN
      : TRIGGER_EVENT_SKIPS.NO_LEG);
  return { outcome: "skipped", skipReason, ranCampaignIds: [], detail };
}

/**
 * Run the campaigns a TRIGGER asks for on (org, brand, offer): the ones bought for a (channel, leg)
 * whose reactive transition names this trigger id, and the units of a funnel HEADED by it that run on
 * it (`campaigns.runs_on_trigger_id`, lib/sales-funnel-head-trigger.ts). Same dispatch as the step route.
 */
export async function fireTrigger(
  scope: { orgId: string; brandId: string; offerId: string },
  triggerId: string,
  catalogue: Extract<ChannelCatalogueRead, { ok: true }>,
  trigger?: WorkflowTriggerInput,
  /** The lead a non-detector event names (lib/sales-funnel-people.ts): who the event is about. */
  eventLeadId?: string | null,
  /** The event is for ONE sales funnel campaign's units only (a github issue it waits on). */
  onlySalesFunnelCampaignId?: string | null,
  /** The person the event names by identity (lib/trigger-person.ts). */
  person?: EventPerson | null,
  /** A retry of a person event: only these campaigns (the ones held back last time) are asked again. */
  onlyCampaignIds?: readonly string[] | null,
): Promise<ScopeAnswer> {
  const transitions = (catalogue.triggerTransitions ?? []).filter((t) => t.triggerId === triggerId);
  const legKeys = [...new Set(transitions.map((t) => t.legKey))];
  const run = await runCampaignsInScope(
    scope,
    (c) =>
      (!onlySalesFunnelCampaignId || c.salesFunnelCampaignId === onlySalesFunnelCampaignId) &&
      (!onlyCampaignIds || onlyCampaignIds.includes(c.id)) &&
      // A pipe naming this trigger, or a unit of a funnel headed by it (FUNNEL-HEAD-TRIGGER-1015).
      answersTrigger(c, triggerId, transitions),
    `trigger ${triggerId}`,
    trigger,
    eventLeadId,
    person,
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
  /** The person the occurrence is about, by identity (lib/trigger-person.ts). */
  person?: EventPerson;
  /** What the occurrence carries (a form's name and answers...), opaque JSON handed to the workflow. */
  item?: unknown;
  /**
   * Which door it came through: `public` = an outside caller (api-service `POST /v1/trigger-events`), refused a
   * non-callable trigger; `internal` (default) = one of our services, every declared trigger, as before.
   */
  door?: "public" | "internal";
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
  // The public door (owner 2026-10-15): a trigger no outside caller may fire is refused there, never internally.
  const refused = input.door === "public" ? doorRefusal(type) : null;
  if (refused) throw new TriggerEventError(refused, 400, TRIGGER_NOT_CALLABLE);

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
    // Kept on the row so a planned event and a retry fire with them (fireClaimedEvent reads `detail`).
    ...(input.person || input.item !== undefined
      ? { detail: { ...(input.person ? { person: input.person } : {}), ...(input.item !== undefined ? { item: input.item } : {}) } }
      : {}),
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
      detail: {
        ...((base as { detail?: Record<string, unknown> }).detail ?? {}),
        ...(p.outcome === "skipped" && p.detail ? { performedDetail: p.detail } : {}),
      },
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
    const detected = event.recordedVia === DELAY_DETECTOR_RECORDED_VIA || event.recordedVia === POLL_RECORDED_VIA
      || event.recordedVia === GITHUB_ISSUE_RECORDED_VIA;
    const own = event.detail && typeof event.detail === "object" && !Array.isArray(event.detail)
      ? (event.detail as Record<string, unknown>)
      : null;
    // A detector event that states its item / funnel campaign on the row (the github issue detector) is
    // fired with them on a retry too, when the caller's context is gone.
    const item = context.item ?? own?.item ?? null;
    const onlySalesFunnelCampaignId = event.recordedVia === GITHUB_ISSUE_RECORDED_VIA && typeof own?.salesFunnelCampaignId === "string"
      ? own.salesFunnelCampaignId
      : null;
    // A reported event naming a person by identity / carrying an item (lib/trigger-person.ts).
    const person = storedEventPerson(own?.person);
    const carries = person !== null || (own !== null && "item" in own);
    // An occurrence carrying a person or an item is owed until a run that carried it did its work
    // (lib/trigger-deliveries.ts): each run dispatched for it is recorded, and `/end-run` redelivers it.
    const delivers = eventCarries(own);
    // A retried (held back) or redelivered event re-asks ONLY the campaigns named; the ones that already
    // ran are kept and never dispatched twice.
    const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
    const retryCampaignIds = delivers && Array.isArray(own?.retryCampaignIds) ? strings(own?.retryCampaignIds) : null;
    const priorRanCampaignIds = delivers ? strings(own?.priorRanCampaignIds) : [];
    if (!event.triggerId || !catalogue.triggers?.has(event.triggerId)) {
      verdict = skipped(TRIGGER_EVENT_SKIPS.TRIGGER_NOT_DECLARED);
    } else {
      const guard = event.recordedVia === DELAY_DETECTOR_RECORDED_VIA
        ? await delayGuard(event, context.leadActivity)
        : null;
      if (guard) {
        verdict = skipped(guard.reason, { guardDetail: guard.detail });
      } else {
        const trigger: WorkflowTriggerInput | undefined = detected || carries
          ? { eventId: event.id, triggerId: event.triggerId, leadId: event.leadId, item, ...(person ? { person } : {}) }
          : undefined;
        verdict = eventVerdict(
          await fireTrigger(event, event.triggerId, catalogue, trigger, event.leadId, onlySalesFunnelCampaignId, person, retryCampaignIds),
        );
        if (delivers && verdict.detail.triggered.length > 0) {
          // Already dispatched: a failure to record must never put the event back (it would dispatch twice).
          try {
            await recordDeliveries(event.id, verdict.detail.triggered);
          } catch (err) {
            console.error(`[campaign-service] trigger event ${event.id}: the runs just dispatched could not be recorded, a failure of them will not redeliver it:`, err);
          }
        }
      }
    }
    // Campaigns that ran on an earlier attempt still count.
    const ranCampaignIds = [...new Set([...priorRanCampaignIds, ...verdict.ranCampaignIds])];
    if (ranCampaignIds.length > 0) verdict = { ...verdict, outcome: "ran", skipReason: null, ranCampaignIds };
    // The lead each campaign's run carried, kept across attempts (a retry's `triggered` names only its own runs).
    const ranLeads = mergeRanLeads(own?.ranLeads, verdict.detail.triggered);
    if (own) {
      const { retryCampaignIds: _r, priorRanCampaignIds: _p, ranLeads: _l, ...rest } = own;
      verdict = { ...verdict, detail: { ...rest, ...verdict.detail } as EventVerdict["detail"] };
    }
    if (ranLeads.length > 0) verdict = { ...verdict, detail: { ...verdict.detail, ranLeads } as EventVerdict["detail"] };
    // ANY campaign held back for a passing reason: the event tries again for those campaigns only, so each
    // gets its own run carrying the person and item. Money / pacing (cap reached, unfunded, a run in flight,
    // a failure backoff: `OWED_UNTIL_ROOM_SKIPS`) is owed with NO deadline, every 2 min while the event is
    // young then every `OWED_EVENT_RECHECK_MS`, until the campaign can run (NEVER-NO-FOLLOWUP-1014). A person
    // not known to the brand yet is retried only while young. Young = since it FELL DUE (a future-dated
    // occurrence is young at its date, not at its recording) or was last redelivered.
    const redeliveredAt = typeof own?.redeliveredAt === "string" ? Date.parse(own.redeliveredAt) : NaN;
    const storedFellDueAt = typeof own?.fellDueAt === "string" ? Date.parse(own.fellDueAt) : NaN;
    const fellDueAt = Number.isFinite(storedFellDueAt) ? storedFellDueAt : event.dueAt.getTime();
    const youngSince = Math.max(event.occurredAt.getTime(), fellDueAt, Number.isFinite(redeliveredAt) ? redeliveredAt : 0);
    const young = now.getTime() - youngSince < PERSON_NOT_KNOWN_WAIT_MS;
    const heldBack = delivers
      ? verdict.detail.skipped.filter((sk) => OWED_UNTIL_ROOM_SKIPS.has(sk.reason) || (young && PERSON_EVENT_RETRY_SKIPS.has(sk.reason)))
      : [];
    if (heldBack.length > 0) {
      const retryMs = young ? PERSON_NOT_KNOWN_RETRY_MS : OWED_EVENT_RECHECK_MS;
      const [back] = await db
        .update(triggerEvents)
        .set({
          status: "pending",
          dueAt: new Date(now.getTime() + retryMs),
          claimedAt: null,
          detail: {
            ...verdict.detail,
            retryCampaignIds: heldBack.map((sk) => sk.campaignId),
            priorRanCampaignIds: ranCampaignIds,
            fellDueAt: new Date(fellDueAt).toISOString(),
          },
          lastError: `${heldBack.map((sk) => `${sk.campaignId} ${sk.reason}`).join(", ")}${person ? `: ${personLabel(person)}` : ""}, retried in ${retryMs / 60_000} min`.slice(0, 500),
        })
        .where(eq(triggerEvents.id, event.id))
        .returning();
      return back;
    }
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

/** One entry per campaign: the lead its run carried. Pure. */
export interface RanLead {
  campaignId: string;
  leadId: string;
}

/**
 * Stored `ranLeads` (earlier attempts) + this attempt's `triggered` runs that carried a lead; a campaign's
 * latest run wins. Pure.
 */
export function mergeRanLeads(stored: unknown, triggered: ReadonlyArray<{ campaignId: string; leadId?: string }>): RanLead[] {
  const byCampaign = new Map<string, string>();
  const take = (v: unknown) => {
    if (!v || typeof v !== "object") return;
    const { campaignId, leadId } = v as Record<string, unknown>;
    if (typeof campaignId === "string" && typeof leadId === "string" && leadId) byCampaign.set(campaignId, leadId);
  };
  if (Array.isArray(stored)) stored.forEach(take);
  triggered.forEach(take);
  return [...byCampaign].map(([campaignId, leadId]) => ({ campaignId, leadId }));
}

/**
 * What `ranLeads` serves: the lead per campaign that RAN, a still-pending event's earlier runs included
 * (`detail.priorRanCampaignIds`); a campaign given up (lib/trigger-deliveries.ts) has left both lists.
 */
export function eventRanLeads(e: Pick<TriggerEvent, "detail" | "ranCampaignIds">): RanLead[] {
  const own = e.detail && typeof e.detail === "object" && !Array.isArray(e.detail) ? (e.detail as Record<string, unknown>) : {};
  const triggered = Array.isArray(own.triggered) ? (own.triggered as Array<{ campaignId: string; leadId?: string }>) : [];
  const prior = Array.isArray(own.priorRanCampaignIds) ? own.priorRanCampaignIds.filter((x): x is string => typeof x === "string") : [];
  const ran = new Set([...(e.ranCampaignIds ?? []), ...prior]);
  return mergeRanLeads(own.ranLeads, triggered).filter((l) => ran.has(l.campaignId));
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

/**
 * The FIRST event of one trigger about one person on an offer, whichever door or caller recorded it (an outside
 * caller's push, lead-service's outcome detector, a detector here), or null. The person is matched by the event's
 * lead (`lead_id`) OR the identity it carries (`detail.person`: email case-folded, phone as stored). Lets a caller
 * about to ring an outcome trigger see that the same occurrence already reached the door (one fire per person,
 * every caller alike). A read.
 */
export async function firstTriggerEventForPerson(scope: {
  orgId: string;
  brandId: string;
  offerId: string;
  triggerId: string;
  leadId?: string;
  email?: string;
  phone?: string;
}): Promise<TriggerEvent | null> {
  const who = [
    scope.leadId ? sql`${triggerEvents.leadId} = ${scope.leadId}` : null,
    scope.email ? sql`lower(${triggerEvents.detail}->'person'->>'email') = ${scope.email.trim().toLowerCase()}` : null,
    scope.phone ? sql`${triggerEvents.detail}->'person'->>'phone' = ${scope.phone.trim()}` : null,
  ].filter((c): c is NonNullable<typeof c> => c !== null);
  if (who.length === 0) return null;
  const [row] = await db
    .select()
    .from(triggerEvents)
    .where(and(
      eq(triggerEvents.orgId, scope.orgId),
      eq(triggerEvents.brandId, scope.brandId),
      eq(triggerEvents.offerId, scope.offerId),
      eq(triggerEvents.triggerId, scope.triggerId),
      sql`(${sql.join(who, sql` OR `)})`,
    ))
    .orderBy(triggerEvents.occurredAt, triggerEvents.createdAt)
    .limit(1);
  return row ?? null;
}

/** The wire shape of several events, each with its `delivery` (one read of their delivery rows). */
export async function serializeTriggerEvents(events: TriggerEvent[]) {
  const byEvent = await deliveriesByEvent(events.filter((e) => eventCarries(e.detail)).map((e) => e.id));
  return events.map((e) => serializeTriggerEvent(e, byEvent.get(e.id) ?? []));
}

/** The wire shape of one event, given its delivery rows. */
export function serializeTriggerEvent(e: TriggerEvent, deliveries: ReadonlyArray<TriggerEventDelivery> = []) {
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
    ranLeads: eventRanLeads(e),
    delivery: deliveryOf(e, deliveries),
    performedByCaller: e.performedByCaller,
    processedAt: e.processedAt ? e.processedAt.toISOString() : null,
    detail: e.detail ?? null,
  };
}

/**
 * FLEET (every org): for ONE trigger, how many events RAN each campaign, with the first and last time. What a pipe
 * answering that trigger produced, per unit: for `on_demand` a ran event IS a lead found by the sourcing unit that
 * served it (lead-service records it on the serve), so features-service measures a sourcing pipe on it. A read.
 */
export async function triggerRanCounts(triggerId: string): Promise<{
  recordedSince: string | null;
  counts: Array<{ campaignId: string; ran: number; firstAt: string; lastAt: string }>;
}> {
  const [rows, [first]] = await Promise.all([
    db.execute<{ campaign_id: string; ran: string | number; first_at: Date | string; last_at: Date | string }>(sql`
      SELECT c.campaign_id, count(*) AS ran, min(e.occurred_at) AS first_at, max(e.occurred_at) AS last_at
      FROM "trigger_events" e, unnest(e.ran_campaign_ids) AS c(campaign_id)
      WHERE e.trigger_id = ${triggerId} AND e.outcome = 'ran'
      GROUP BY c.campaign_id
      ORDER BY c.campaign_id`),
    db
      .select({ at: sql<string | null>`min(${triggerEvents.occurredAt})` })
      .from(triggerEvents)
      .where(eq(triggerEvents.triggerId, triggerId)),
  ]);
  const iso = (v: Date | string) => new Date(v).toISOString();
  type Row = { campaign_id: string; ran: string | number; first_at: Date | string; last_at: Date | string };
  const list = Array.from(rows as unknown as Iterable<Row>);
  return {
    recordedSince: first?.at ? iso(first.at) : null,
    counts: list.map((r) => ({
      campaignId: r.campaign_id,
      ran: Number(r.ran),
      firstAt: iso(r.first_at),
      lastAt: iso(r.last_at),
    })),
  };
}
