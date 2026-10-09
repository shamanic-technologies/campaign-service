import { createHash } from "node:crypto";
import { and, eq, lte, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { campaigns, triggerEvents, triggerPollCursors, type Campaign, type TriggerEvent } from "../db/schema.js";
import { campaignFunding } from "./campaign-funding.js";
import { getChannelStatsBudget } from "./channel-spend.js";
import type { ChannelCatalogueRead } from "./channel-operator-client.js";
import {
  POLL_DETECTOR_RECORDED_VIA,
  detectableTriggers,
  liveScopesBehind,
  type DetectableTrigger,
  type ParamsRead,
  type TriggerScope,
} from "./delay-trigger-detector.js";
import { sameLeg } from "./leg-identity.js";
import { ensureCampaignRunId } from "./trigger-run.js";
import { meteredTregCall, TregInsufficientCreditError, type TregAnswer, type TregBilling, type TregCallRequest } from "./treg-meter.js";
import { fireClaimedEvent } from "./trigger-events.js";

/**
 * THE GENERIC `poll` DETECTOR (owner 2026-10-09): "each time a new item appears at this source, run
 * the leg". The trigger TYPE is features-service's declaration (`kind: "poll"`, `params: {source,
 * everyMinutes}`); the reads, the cursor and the events are this service's.
 *
 * ── THE SOURCE ──────────────────────────────────────────────────────────────────────────────────
 *
 * `params.source` is ONE treg call, written as JSON (features-service stores it as text):
 *   {"endpoint": "<treg endpoint id>", "method": "GET"|"POST" (default GET),
 *    "query": {..strings..}?, "body": {..}?,
 *    "items": "<dot path to the array of items in the answer; '' = the answer itself>",
 *    "itemId": "<dot path to an item's stable id>"?   (absent = a hash of the whole item),
 *    "maxMicro": <ceiling per call, micro-USD, 1..1000000>}
 * A source that does not parse is a LOUD named error once per process (`reportUndetectableTrigger`),
 * never polled on a guess.
 *
 * ── THE CADENCE, PER (trigger, org, brand, offer) WITH A LIVE CAMPAIGN ON A LEG NAMING IT ───────
 *
 * `trigger_poll_cursors` holds when each scope is next due (`everyMinutes` after the last claim,
 * claimed atomically so two ticks never poll one scope). Before every call the BUDGET is asked: the
 * scope's campaigns behind the trigger, oldest first, the first one FUNDED (lib/campaign-funding.ts,
 * fail-closed) whose spend today + the call's ceiling stays within its daily ceiling PAYS (the call
 * is metered on it, org-billed, lib/treg-meter.ts). None = `budget_held`, no call, next due as usual.
 *
 * ── THE CURSOR: AN ITEM IS NEVER FIRED TWICE ────────────────────────────────────────────────────
 *
 * Every item seen is ONE `trigger_events` row keyed `poll:<trigger>:<brand>:<offer>:<itemId>`
 * (unique per org), written BEFORE it is fired. The FIRST successful read of a scope is the
 * BASELINE: its items are recorded `skipped` / `poll_baseline` and fired never (they were there
 * before anyone watched: not new). After it, each item not seen yet is ONE event fired through the
 * step route's own dispatch (funding, in-flight guards, `/execute`), the item riding the inputs
 * (`trigger.item`). At most `POLL_MAX_ITEMS_PER_READ` new items are fired per read; the rest are
 * still unseen and fire on the next read.
 */

export const POLL_SKIPS = { BASELINE: "poll_baseline" } as const;
export const POLL_MAX_ITEMS_PER_READ = 50;
export const POLL_MAX_MICRO_CEILING = 1_000_000;
/** An item stored in the event row larger than this is replaced by its id (the run still gets it whole). */
const ITEM_DETAIL_MAX_BYTES = 8_000;

export interface PollSource {
  endpoint: string;
  method: "GET" | "POST";
  query?: Record<string, string>;
  body?: Record<string, unknown>;
  items: string;
  itemId?: string;
  maxMicro: number;
}

export interface PollParams {
  source: PollSource;
  everyMinutes: number;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Read a poll trigger's parameters. Pure. */
export function readPollParams(params: Record<string, unknown> | null | undefined): ParamsRead<PollParams> {
  if (!params) return { ok: false, error: "no params" };
  const everyMinutes = params.everyMinutes;
  if (typeof everyMinutes !== "number" || !Number.isInteger(everyMinutes) || everyMinutes < 5) {
    return { ok: false, error: "everyMinutes must be a whole number >= 5" };
  }
  let raw: unknown = params.source;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return { ok: false, error: "source must be a JSON treg call: {endpoint, method?, query?, body?, items, itemId?, maxMicro}" };
    }
  }
  if (!isRecord(raw)) return { ok: false, error: "source must be a JSON object" };
  const { endpoint, method = "GET", query, body, items, itemId, maxMicro } = raw;
  if (typeof endpoint !== "string" || !/^[A-Za-z0-9_.-]+$/.test(endpoint)) return { ok: false, error: "source.endpoint must be a treg endpoint id" };
  if (method !== "GET" && method !== "POST") return { ok: false, error: "source.method must be GET or POST" };
  if (query !== undefined && (!isRecord(query) || Object.values(query).some((v) => typeof v !== "string"))) {
    return { ok: false, error: "source.query must be an object of strings" };
  }
  if (body !== undefined && !isRecord(body)) return { ok: false, error: "source.body must be an object" };
  if (typeof items !== "string") return { ok: false, error: "source.items must be a dot path ('' = the answer itself)" };
  if (itemId !== undefined && (typeof itemId !== "string" || itemId.length === 0)) return { ok: false, error: "source.itemId must be a dot path" };
  if (typeof maxMicro !== "number" || !Number.isInteger(maxMicro) || maxMicro < 1 || maxMicro > POLL_MAX_MICRO_CEILING) {
    return { ok: false, error: `source.maxMicro must be a whole number of micro-USD in 1..${POLL_MAX_MICRO_CEILING}` };
  }
  return {
    ok: true,
    params: {
      everyMinutes,
      source: {
        endpoint,
        method,
        ...(query ? { query: query as Record<string, string> } : {}),
        ...(body ? { body: body as Record<string, unknown> } : {}),
        items,
        ...(itemId ? { itemId } : {}),
        maxMicro,
      },
    },
  };
}

function atPath(value: unknown, path: string): unknown {
  if (path === "") return value;
  let cur: unknown = value;
  for (const part of path.split(".")) {
    if (!isRecord(cur) && !Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** The items of an answer and each one's stable id. Throws when the answer has no item array. Pure. */
export function itemsOf(answer: unknown, source: Pick<PollSource, "items" | "itemId">): Array<{ id: string; item: unknown }> {
  const items = atPath(answer, source.items);
  if (!Array.isArray(items)) throw new Error(`the answer has no item array at ${JSON.stringify(source.items)}`);
  const out: Array<{ id: string; item: unknown }> = [];
  const seen = new Set<string>();
  for (const item of items) {
    let id: string;
    if (source.itemId) {
      const v = atPath(item, source.itemId);
      if (typeof v !== "string" && typeof v !== "number") continue; // an item with no id cannot be deduped: never fired
      id = String(v);
    } else {
      id = createHash("sha256").update(JSON.stringify(item)).digest("hex").slice(0, 32);
    }
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, item });
  }
  return out;
}

export function pollIdempotencyKey(triggerId: string, scope: TriggerScope, itemId: string): string {
  return `poll:${triggerId}:${scope.brandId}:${scope.offerId}:${itemId}`;
}

function itemDetail(id: string, item: unknown): Record<string, unknown> {
  const json = JSON.stringify(item) ?? "null";
  return json.length > ITEM_DETAIL_MAX_BYTES ? { itemId: id, itemTruncated: true } : { itemId: id, item };
}

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

export type PollOutcome = "not_due" | "budget_held" | "baseline" | "polled" | "source_failed" | "insufficient_credit";

export interface PollScopeResult {
  outcome: PollOutcome;
  fired: number;
  seen: number;
}

/** The scope's live campaigns on a leg the trigger names, oldest first. */
async function campaignsBehind(trigger: DetectableTrigger<PollParams>, scope: TriggerScope): Promise<Campaign[]> {
  const live = await db.query.campaigns.findMany({
    where: and(eq(campaigns.orgId, scope.orgId), eq(campaigns.status, "ongoing"), eq(campaigns.offerId, scope.offerId)),
    orderBy: campaigns.createdAt,
  });
  return live.filter((c) => {
    const brands = c.brandIds && c.brandIds.length > 0 ? c.brandIds : c.brandId ? [c.brandId] : [];
    return brands.includes(scope.brandId) && trigger.transitions.some((t) => t.featureSlug === c.featureSlug && sameLeg(c.featureSlug!, t.legKey, c.legKey));
  });
}

/** The campaign that pays for the next read: funded, and the call's ceiling fits under today's. */
export async function pollPayer(candidates: Campaign[], brandId: string, maxMicro: number): Promise<{ campaign: Campaign } | { held: string }> {
  const reasons: string[] = [];
  const callCents = maxMicro / 10_000;
  for (const c of candidates) {
    if (!c.createdByUserId || !c.featureSlug) {
      reasons.push(`${c.id}: no owner or feature`);
      continue;
    }
    const funding = await campaignFunding(c, brandId, { orgId: c.orgId });
    if (!funding.funded) {
      reasons.push(`${c.id}: ${funding.reason}`);
      continue;
    }
    const spend = await getChannelStatsBudget({
      orgId: c.orgId,
      campaignId: c.id,
      featureSlug: c.featureSlug,
      windows: [{ label: "today", since: startOfToday().toISOString() }],
    });
    const today = spend.windows.find((w) => w.label === "today");
    const spentCents = today ? parseFloat(today.netTotalCostInUsdCents ?? today.totalCostInUsdCents) || 0 : 0;
    if (spentCents + callCents > funding.ceilingCents) {
      reasons.push(`${c.id}: ${spentCents.toFixed(2)}c spent of ${funding.ceilingCents}c today`);
      continue;
    }
    return { campaign: c };
  }
  return { held: reasons.join("; ") || "no live campaign behind the trigger" };
}

export type TregCaller = (billing: TregBilling, req: TregCallRequest) => Promise<TregAnswer>;

/**
 * Poll one scope if it is due. Claims the scope atomically; reads the source on the paying
 * campaign; records the baseline or fires each new item. Throws only on a database failure.
 */
export async function pollScope(
  trigger: DetectableTrigger<PollParams>,
  scope: TriggerScope,
  catalogue: Extract<ChannelCatalogueRead, { ok: true }>,
  now: Date,
  callTreg: TregCaller = meteredTregCall,
): Promise<PollScopeResult> {
  const triggerId = trigger.type.id;
  await db
    .insert(triggerPollCursors)
    .values({ triggerId, ...scope, nextPollAt: now })
    .onConflictDoNothing();
  const nextPollAt = new Date(now.getTime() + trigger.params.everyMinutes * 60_000);
  const [cursor] = await db
    .update(triggerPollCursors)
    .set({ nextPollAt, lastPolledAt: now, polls: sql`${triggerPollCursors.polls} + 1` })
    .where(and(
      eq(triggerPollCursors.triggerId, triggerId),
      eq(triggerPollCursors.orgId, scope.orgId),
      eq(triggerPollCursors.brandId, scope.brandId),
      eq(triggerPollCursors.offerId, scope.offerId),
      lte(triggerPollCursors.nextPollAt, now),
    ))
    .returning();
  if (!cursor) return { outcome: "not_due", fired: 0, seen: 0 };

  const settle = (outcome: PollOutcome, error: string | null, extra: { baselineAt?: Date; itemsFired?: ReturnType<typeof sql> } = {}) =>
    db.update(triggerPollCursors).set({ lastOutcome: outcome, lastError: error, ...extra }).where(eq(triggerPollCursors.id, cursor.id));

  const source = trigger.params.source;
  const payer = await pollPayer(await campaignsBehind(trigger, scope), scope.brandId, source.maxMicro);
  if ("held" in payer) {
    await settle("budget_held", payer.held.slice(0, 500));
    return { outcome: "budget_held", fired: 0, seen: 0 };
  }
  const c = payer.campaign;

  let answer: TregAnswer;
  try {
    const parentRunId = await ensureCampaignRunId(c);
    answer = await callTreg(
      {
        orgId: c.orgId,
        userId: c.createdByUserId!,
        brandId: scope.brandId,
        campaignId: c.id,
        featureSlug: c.featureSlug!,
        parentRunId,
        description: `trigger ${triggerId}: read ${source.endpoint}`,
      },
      { endpoint: source.endpoint, method: source.method, query: source.query, body: source.body, maxMicro: source.maxMicro },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const outcome: PollOutcome = err instanceof TregInsufficientCreditError ? "insufficient_credit" : "source_failed";
    if (outcome === "source_failed") console.error(`[campaign-service] poll trigger ${triggerId} source read failed (org ${scope.orgId}, offer ${scope.offerId}):`, message);
    await settle(outcome, message.slice(0, 500));
    return { outcome, fired: 0, seen: 0 };
  }
  if (answer.status < 200 || answer.status >= 300) {
    const message = `treg ${source.endpoint} HTTP ${answer.status}: ${JSON.stringify(answer.body).slice(0, 300)}`;
    console.error(`[campaign-service] poll trigger ${triggerId} source read failed (org ${scope.orgId}, offer ${scope.offerId}): ${message}`);
    await settle("source_failed", message.slice(0, 500));
    return { outcome: "source_failed", fired: 0, seen: 0 };
  }

  let items: Array<{ id: string; item: unknown }>;
  try {
    items = itemsOf(answer.body, source);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[campaign-service] poll trigger ${triggerId} answer unreadable (org ${scope.orgId}, offer ${scope.offerId}): ${message}`);
    await settle("source_failed", message.slice(0, 500));
    return { outcome: "source_failed", fired: 0, seen: 0 };
  }

  const base = {
    orgId: scope.orgId,
    brandId: scope.brandId,
    offerId: scope.offerId,
    triggerId,
    step: trigger.type.fromStepKey,
    requestedByCampaignId: c.id,
    recordedVia: POLL_DETECTOR_RECORDED_VIA,
    occurredAt: now,
    dueAt: now,
  };

  if (!cursor.baselineAt) {
    if (items.length > 0) {
      await db.insert(triggerEvents).values(items.map(({ id, item }) => ({
        ...base,
        idempotencyKey: pollIdempotencyKey(triggerId, scope, id),
        status: "done",
        outcome: "skipped",
        skipReason: POLL_SKIPS.BASELINE,
        ranCampaignIds: [],
        detail: itemDetail(id, item),
        processedAt: now,
      }))).onConflictDoNothing();
    }
    await settle("baseline", null, { baselineAt: now });
    return { outcome: "baseline", fired: 0, seen: items.length };
  }

  let fired = 0;
  const claimed: Array<{ event: TriggerEvent; item: unknown }> = [];
  for (const { id, item } of items) {
    if (claimed.length >= POLL_MAX_ITEMS_PER_READ) break;
    const [event] = await db.insert(triggerEvents).values({
      ...base,
      idempotencyKey: pollIdempotencyKey(triggerId, scope, id),
      status: "firing",
      claimedAt: now,
      attempts: 1,
      detail: itemDetail(id, item),
    }).onConflictDoNothing().returning();
    if (event) claimed.push({ event, item });
  }
  for (const { event, item } of claimed) {
    const done = await fireClaimedEvent(event, catalogue, now, { item });
    if (done.status === "done") fired += 1;
  }
  await settle("polled", null, { itemsFired: sql`${triggerPollCursors.itemsFired} + ${claimed.length}` });
  return { outcome: "polled", fired, seen: items.length };
}

export interface PollTickSummary {
  triggers: number;
  scopes: number;
  polled: number;
  baseline: number;
  fired: number;
  held: number;
  failed: number;
}

/** One poll pass over every poll trigger a live campaign depends on. */
export async function pollDueTriggers(
  catalogue: Extract<ChannelCatalogueRead, { ok: true }>,
  now: Date = new Date(),
  callTreg: TregCaller = meteredTregCall,
): Promise<PollTickSummary> {
  const summary: PollTickSummary = { triggers: 0, scopes: 0, polled: 0, baseline: 0, fired: 0, held: 0, failed: 0 };
  for (const trigger of detectableTriggers(catalogue, "poll", readPollParams)) {
    summary.triggers += 1;
    for (const scope of await liveScopesBehind(trigger.transitions)) {
      summary.scopes += 1;
      const r = await pollScope(trigger, scope, catalogue, now, callTreg);
      if (r.outcome === "polled") summary.polled += 1;
      else if (r.outcome === "baseline") summary.baseline += 1;
      else if (r.outcome === "budget_held" || r.outcome === "insufficient_credit") summary.held += 1;
      else if (r.outcome === "source_failed") summary.failed += 1;
      summary.fired += r.fired;
    }
  }
  return summary;
}
