import { eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { campaigns, triggerEvents, type TriggerEvent } from "../db/schema.js";
import { waitsOnlyOnChannel } from "./channel-down-replay.js";

/**
 * A PROSPECT WAITING IS LOUD, NEVER A SILENT BACKOFF (HOTFIX ANCESTOR-1015).
 *
 * Prod 2026-10-14 20:00 UTC: a Meta Ads form reached Doc Dinners' reactive funnel. Its answering campaign's
 * runs were refused downstream, so the occurrence went back `pending` 109 times over 14 hours
 * (`failure_backoff`) and nobody was told: the one staff alert that existed (`campaign_failing`) is per
 * campaign per day, fired the day before, and says nothing about a person waiting.
 *
 * So an occurrence that carries a PERSON or an ITEM (somebody, or something they sent, is waiting for the
 * answer) and is still undelivered after `STUCK_OCCURRENCE_AFTER_MS` and `STUCK_OCCURRENCE_MIN_ATTEMPTS`
 * tries raises ONE staff alert: `POST /platform-send` eventType `trigger_occurrence_stuck`
 * (transactional-email-service owns the template, the staff list and a once-per-occurrence-ever dedup).
 *
 * NOT alerted: an occurrence held only because the CUSTOMER's money says so (`MONEY_HOLDS`: the funnel's cap
 * reached, not funded): that is their choice, the occurrence is owed and fires when room returns
 * (lib/trigger-person.ts `OWED_UNTIL_ROOM_SKIPS`). Every other hold (a failure backoff, a run in flight for
 * half an hour, a refused dispatch, an unreadable read) is a defect somebody must look at.
 *
 * Latched on the row (`detail.stuckAlertedAt`, atomic claim), released when the send fails so the next sweep
 * retries. Fail-SOFT: never changes what fires.
 */

export const STUCK_OCCURRENCE_EVENT = "trigger_occurrence_stuck";
/** How long an occurrence may wait for its answer before staff hear of it. */
export const STUCK_OCCURRENCE_AFTER_MS = 30 * 60_000;
/** Tried at least this often (a first `run_in_flight` retry two minutes later is normal pacing). */
export const STUCK_OCCURRENCE_MIN_ATTEMPTS = 3;
/** How often the sweep runs. */
export const STUCK_OCCURRENCE_RECHECK_MS = 10 * 60_000;
const SWEEP_LIMIT = 20;

/** Holds the CUSTOMER chose through their money: owed, never a defect. */
export const MONEY_HOLDS: ReadonlySet<string> = new Set(["sales_funnel_cap", "unfunded"]);

let lastSweepAt = 0;

/** Test hook: forget when the sweep last ran. */
export function resetStuckOccurrenceSweepClock(): void {
  lastSweepAt = 0;
}

/** The campaign holding an occurrence back and why, read off `last_error` (`<campaignId> <reason>, ...`). Pure. */
export function heldBackBy(lastError: string | null): { campaignId: string | null; reasons: string[] } {
  if (!lastError) return { campaignId: null, reasons: [] };
  const pairs = [...lastError.matchAll(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}) ([a-z_]+)/g)];
  return { campaignId: pairs[0]?.[1] ?? null, reasons: pairs.map((p) => p[2]) };
}

/**
 * Since when somebody has been waiting on an occurrence: its fact, or its recording when it was recorded later (a
 * composite occurrence replayed today for a fact of yesterday waited minutes, not a day: LEAD-EVENT-WHATSAPP-1027,
 * staff were told « waited since 2026-10-26 » about an occurrence recorded 15 minutes earlier). Pure.
 */
export function waitingSince(event: { occurredAt: Date; createdAt: Date }): Date {
  return event.occurredAt.getTime() >= event.createdAt.getTime() ? event.occurredAt : event.createdAt;
}

/** Whether an occurrence waits only on the customer's money (never alerted). Pure. */
export function waitsOnlyOnMoney(lastError: string | null): boolean {
  const { reasons } = heldBackBy(lastError);
  return reasons.length > 0 && reasons.every((r) => MONEY_HOLDS.has(r));
}

/** Alert staff once per stuck occurrence. Returns the occurrence ids alerted on. */
export async function alertStuckOccurrences(now: Date = new Date()): Promise<string[]> {
  if (now.getTime() - lastSweepAt < STUCK_OCCURRENCE_RECHECK_MS) return [];
  lastSweepAt = now.getTime();

  const waitingBefore = new Date(now.getTime() - STUCK_OCCURRENCE_AFTER_MS).toISOString();
  const candidates = await db
    .select()
    .from(triggerEvents)
    .where(sql`${triggerEvents.status} <> 'done'
      AND ${triggerEvents.attempts} >= ${STUCK_OCCURRENCE_MIN_ATTEMPTS}
      AND ${triggerEvents.lastError} IS NOT NULL
      AND greatest(${triggerEvents.occurredAt}, ${triggerEvents.createdAt}) <= ${waitingBefore}::timestamptz
      AND (${triggerEvents.detail} ? 'person' OR ${triggerEvents.detail} ? 'item')
      AND NOT (coalesce(${triggerEvents.detail}, '{}'::jsonb) ? 'stuckAlertedAt')`)
    .orderBy(triggerEvents.occurredAt)
    .limit(SWEEP_LIMIT);

  const alerted: string[] = [];
  for (const event of candidates) {
    // Waiting for the brand's channel to come back (lib/channel-down-replay.ts): the sender reported the outage
    // when it refused, and the occurrence is replayed by itself.
    if (waitsOnlyOnMoney(event.lastError) || waitsOnlyOnChannel(event.lastError)) continue;
    const claimed = await db
      .update(triggerEvents)
      .set({ detail: sql`coalesce(${triggerEvents.detail}, '{}'::jsonb) || jsonb_build_object('stuckAlertedAt', ${now.toISOString()}::text)` })
      .where(sql`${triggerEvents.id} = ${event.id} AND NOT (coalesce(${triggerEvents.detail}, '{}'::jsonb) ? 'stuckAlertedAt')`)
      .returning({ id: triggerEvents.id });
    if (claimed.length === 0) continue;

    if (await sendStuckOccurrenceAlert(event)) {
      alerted.push(event.id);
      continue;
    }
    await db
      .update(triggerEvents)
      .set({ detail: sql`${triggerEvents.detail} - 'stuckAlertedAt'` })
      .where(eq(triggerEvents.id, event.id));
  }
  return alerted;
}

async function sendStuckOccurrenceAlert(event: TriggerEvent): Promise<boolean> {
  const url = process.env.TRANSACTIONAL_EMAIL_SERVICE_URL;
  const apiKey = process.env.TRANSACTIONAL_EMAIL_SERVICE_API_KEY;
  if (!url || !apiKey) {
    console.error(`[campaign-service] Occurrence ${event.id} is stuck but TRANSACTIONAL_EMAIL_SERVICE_URL/API_KEY are not set: staff NOT alerted`);
    return false;
  }
  const { campaignId } = heldBackBy(event.lastError);
  const campaign = campaignId
    ? await db.query.campaigns.findFirst({ where: eq(campaigns.id, campaignId), columns: { name: true, createdByUserId: true } })
    : undefined;
  const detail = (event.detail ?? {}) as { person?: { email?: string | null; phone?: string | null; name?: string | null } };
  // A person known only by phone (REPLY-PHONE-ONLY-1015) is named by their number.
  const reach = detail.person?.email ?? detail.person?.phone ?? null;
  const prospect = reach
    ? `${detail.person?.name ? `${detail.person.name} ` : ""}<${reach}>`
    : undefined;
  const headers: Record<string, string> = { "Content-Type": "application/json", "x-api-key": apiKey, "x-org-id": event.orgId };
  if (campaign?.createdByUserId) headers["x-user-id"] = campaign.createdByUserId;
  try {
    const res = await fetch(`${url}/platform-send`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        eventType: STUCK_OCCURRENCE_EVENT,
        metadata: {
          occurrenceId: event.id,
          triggerId: event.triggerId ?? event.step ?? "none",
          campaignId: campaignId ?? event.requestedByCampaignId ?? "none",
          brandId: event.brandId,
          waitingSince: waitingSince(event).toISOString(),
          attempts: String(event.attempts),
          lastError: event.lastError!,
          ...(campaign?.name ? { campaignName: campaign.name } : {}),
          ...(prospect ? { prospect } : {}),
          whereToLook: `campaign_service: SELECT status, attempts, last_error, detail FROM trigger_events WHERE id='${event.id}';` +
            (campaignId ? ` SELECT created_at, event, level, detail FROM run_events WHERE campaign_id='${campaignId}' ORDER BY created_at DESC LIMIT 5;` : ""),
        },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(`[campaign-service] Occurrence ${event.id} stuck-alert refused: ${res.status} ${text.slice(0, 200)}; retried next sweep`);
      return false;
    }
    console.warn(
      `[campaign-service] Occurrence ${event.id} (trigger ${event.triggerId}) has waited since ${waitingSince(event).toISOString()} ` +
      `after ${event.attempts} attempts (${event.lastError}) — staff alerted`,
    );
    return true;
  } catch (err) {
    console.error(`[campaign-service] Occurrence ${event.id} stuck-alert failed; retried next sweep:`, err);
    return false;
  }
}
