import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { triggerEvents, type TriggerEvent } from "../db/schema.js";
import type { CatalogueTriggerType, ChannelCatalogueRead } from "./channel-operator-client.js";
import { resolveTriggerType } from "./trigger-aliases.js";

/**
 * A TRIGGER MADE OF OTHER TRIGGERS (owner 2026-10-16, LEAD-EVENT-TRIGGER-1016: « je les veux tous, et c'est le channel
 * followup qui jugera s'il faut écrire ou pas »). features-service declares a trigger of kind `any_of` whose `params`
 * name its MEMBER triggers (first one: `lead_event` "Lead event" = every fact about a person: positive reply, website
 * visit, signup, paid client, the "not followed" conditions...; our own actions are not members). Every occurrence of
 * a member that HAPPENED is also ONE occurrence of each composite listing it, recorded here, generically (no list, no
 * id, no channel coded here):
 *  - same org / brand / offer / lead / person / item as the member's occurrence, `recordedVia` `composite_trigger`;
 *  - which fact it was: `detail.sourceTriggerId` + `detail.sourceEventId` (+ `detail.sourceStep`), served top-level
 *    `sourceTriggerId` on every event read, counted per fact on the summary (`bySourceTrigger`), and handed to the
 *    workflow on `/execute` `trigger.sourceTriggerId`, so a pipe's strategy can filter on it;
 *  - ONE per (composite, member occurrence), ever (idempotency key `composite:<composite>:<member event id>`), so a
 *    retried / redelivered / held-back member never records it twice;
 *  - fired at once through the same dispatch as any occurrence (lib/trigger-events.ts `fireClaimedEvent`): same
 *    guards, caps, funding, person filing, run-in-flight / cohort holds and redelivery. Three facts in a minute for one
 *    person are three occurrences; the second and third wait for the first run (`run_in_flight`), never in parallel.
 *  - fired IN THE BACKGROUND, never inside the member's request (LEAD-EVENT-ASYNC-1024: crm-service's `account_event`
 *    report waited 31 s while the Lead event campaign filed the person at lead-service, its client timed out at 30 s and
 *    every report paid a retry). The row is written `pending` due now BEFORE the member answers (never lost), then a
 *    per-scope (org, brand, offer) queue claims it (`pending` -> `firing`, atomic: if the scheduler tick's
 *    `fireDueTriggerEvents` claimed it first, the queue does nothing) and fires it. One queue per scope keeps facts
 *    reported one after another firing one after another (the `run_in_flight` rule above); a crash leaves the row
 *    `pending`, fired by the next tick.
 * "Happened" = the member's occurrence is fired (a planned one when it falls due), or recorded `performed`, or rung on
 * the step route; a `delay` condition cancelled by its guard (the person signed up after all) never happened. A
 * composite's own occurrence never feeds another composite. A member is named by its id or by an id merged into it
 * (`triggerAliases`). Detectors (`delay`, `poll`) watch a member trigger as soon as a live campaign answers a composite
 * listing it (`detectableTriggers` / `liveScopesBehind`).
 */

export const COMPOSITE_TRIGGER_KIND = "any_of";
export const COMPOSITE_TRIGGER_RECORDED_VIA = "composite_trigger";

/** The member trigger ids a composite declaration names (canonical), or null when the type is not a composite. Pure. */
export function compositeMembersOf(
  type: Pick<CatalogueTriggerType, "kind" | "params">,
  catalogue?: Parameters<typeof resolveTriggerType>[0],
): string[] | null {
  if (type.kind !== COMPOSITE_TRIGGER_KIND) return null;
  const raw = type.params?.memberTriggerIds;
  if (!Array.isArray(raw)) return [];
  const ids = raw.filter((v): v is string => typeof v === "string" && v.length > 0);
  return [...new Set(ids.map((id) => (catalogue ? resolveTriggerType(catalogue, id)?.id ?? id : id)))];
}

/** Every composite trigger listing `memberId` (itself never a composite). Pure. */
export function compositesListing(
  catalogue: Pick<Extract<ChannelCatalogueRead, { ok: true }>, "triggers" | "triggerAliases">,
  memberId: string,
): CatalogueTriggerType[] {
  const member = resolveTriggerType(catalogue, memberId);
  if (!member || member.kind === COMPOSITE_TRIGGER_KIND) return [];
  return [...(catalogue.triggers?.values() ?? [])].filter((t) => compositeMembersOf(t, catalogue)?.includes(member.id));
}

export function compositeIdempotencyKey(compositeId: string, sourceEventId: string): string {
  return `composite:${compositeId}:${sourceEventId}`;
}

/** The fact a composite occurrence stands for (`detail.sourceTriggerId`), or null. Pure. */
export function eventSourceTriggerId(detail: unknown): string | null {
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) return null;
  const v = (detail as Record<string, unknown>).sourceTriggerId;
  return typeof v === "string" ? v : null;
}

type Fire = (event: TriggerEvent) => Promise<TriggerEvent>;

/** One chain per (org, brand, offer): composite occurrences of one scope fire one after another, in recording order. */
const scopeQueues = new Map<string, Promise<void>>();

function enqueueFire(row: TriggerEvent, fire: Fire): void {
  const key = `${row.orgId}|${row.brandId}|${row.offerId}`;
  const run = async () => {
    const [claimed] = await db
      .update(triggerEvents)
      .set({ status: "firing", claimedAt: new Date(), attempts: sql`${triggerEvents.attempts} + 1` })
      .where(and(eq(triggerEvents.id, row.id), eq(triggerEvents.status, "pending")))
      .returning();
    // Claimed by the scheduler tick in the meantime: it fires it.
    if (claimed) await fire(claimed);
  };
  const next = (scopeQueues.get(key) ?? Promise.resolve())
    .then(run)
    .catch((err) => {
      console.error(`[campaign-service] composite occurrence ${row.id} (${row.triggerId}) not fired in the background, the scheduler tick retries it:`, err);
    });
  scopeQueues.set(key, next);
  void next.then(() => {
    if (scopeQueues.get(key) === next) scopeQueues.delete(key);
  });
}

/** Resolves once every composite occurrence queued so far has fired (tests; never awaited on a request). */
export async function settleCompositeFires(): Promise<void> {
  while (scopeQueues.size > 0) await Promise.all([...scopeQueues.values()]);
}

/**
 * Record one occurrence of every composite listing the member occurrence `source` names, and queue its fire (through
 * `fire`, in the background: the caller never waits for it). NEVER throws: the member has already been dispatched, and
 * a throw in its fire path would put it back and dispatch it twice. Returns the composite occurrences written now,
 * `pending` (none when they already exist).
 */
export async function recordCompositeOccurrences(
  source: TriggerEvent,
  catalogue: Extract<ChannelCatalogueRead, { ok: true }>,
  fire: Fire,
  now: Date = new Date(),
): Promise<TriggerEvent[]> {
  if (source.recordedVia === COMPOSITE_TRIGGER_RECORDED_VIA || !source.triggerId) return [];
  const composites = compositesListing(catalogue, source.triggerId);
  if (composites.length === 0) return [];
  const own = source.detail && typeof source.detail === "object" && !Array.isArray(source.detail)
    ? (source.detail as Record<string, unknown>)
    : {};
  const out: TriggerEvent[] = [];
  for (const composite of composites) {
    try {
      const [row] = await db.insert(triggerEvents).values({
        orgId: source.orgId,
        brandId: source.brandId,
        offerId: source.offerId,
        triggerId: composite.id,
        step: composite.fromStepKey,
        leadId: source.leadId,
        idempotencyKey: compositeIdempotencyKey(composite.id, source.id),
        recordedVia: COMPOSITE_TRIGGER_RECORDED_VIA,
        occurredAt: source.occurredAt,
        dueAt: now,
        status: "pending",
        detail: {
          sourceTriggerId: source.triggerId,
          sourceEventId: source.id,
          sourceStep: source.step,
          ...(own.person ? { person: own.person } : {}),
          ...("item" in own ? { item: own.item } : {}),
        },
      }).onConflictDoNothing().returning();
      if (!row) continue;
      out.push(row);
      enqueueFire(row, fire);
    } catch (err) {
      console.error(
        `[campaign-service] trigger event ${source.id} (${source.triggerId}): its ${composite.id} occurrence could not be recorded:`,
        err,
      );
    }
  }
  return out;
}
