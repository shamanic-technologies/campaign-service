import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { campaigns, triggerEvents, triggerSilenceWatch, type Campaign } from "../db/schema.js";
import { fetchChannelCatalogue } from "./channel-operator-client.js";
import { sameLeg } from "./leg-identity.js";

/**
 * A TRIGGER THAT NEVER FIRES IS A BROKEN STEP, NOT A QUIET DAY (owner 2026-10-09).
 *
 * A reactive campaign runs only when its trigger asks (lib/trigger-events.ts). If the service that
 * should fire it stops calling (a deploy dropped the call, a webhook died), nothing errors anywhere:
 * the campaign simply never runs. So staff are told when a CODED trigger type (features-service
 * `triggers[].coded`) with at least one LIVE reactive campaign behind it has recorded no event for
 * `TRIGGER_SILENCE_MS` (3 days, owner-validated).
 *
 * Fleet-wide, per trigger TYPE: one brand without a reply for 3 days is a quiet brand; a type with
 * no occurrence across every live campaign is a pipeline that stopped.
 *
 * The silence is counted from the LATER of the last event and `watched_since` (when this service
 * first saw a live campaign behind the type, `trigger_silence_watch`), so a type is never called
 * silent for days nobody was recording or nobody depended on it. The watch row is dropped when no
 * live campaign depends on the type any more, and restarts from zero when one does again.
 *
 * Alert: `POST /platform-send` eventType `trigger_silent` (transactional-email-service owns the
 * template, the staff list and a per-trigger-day bound), latched here at most once per 24h per type
 * by an atomic claim, released when the send fails so the next sweep retries. It names a live
 * campaign's org and owner only because billing authorizes the send against a user. Nobody's own
 * action is reported: a silence is not an action.
 */

export const TRIGGER_SILENCE_MS = 3 * 24 * 60 * 60_000;
export const TRIGGER_SILENCE_REALERT_MS = 24 * 60 * 60_000;
/** How often the sweep runs. A 3-day window does not need a 10-minute cadence. */
export const TRIGGER_SILENCE_RECHECK_MS = 60 * 60_000;
export const TRIGGER_SILENT_EVENT = "trigger_silent";

let lastSweepAt = 0;

/** Test hook: forget when the sweep last ran. */
export function resetTriggerSilenceSweepClock(): void {
  lastSweepAt = 0;
}

export interface SilentTrigger {
  triggerId: string;
  label: string;
  firedBy: string;
  silentSince: Date;
  liveCampaigns: Campaign[];
}

/**
 * Watch every coded trigger type and alert on the silent ones. Returns the triggers alerted on.
 * Fail-SOFT: an unreadable catalogue is warned about and changes nothing.
 */
export async function alertSilentTriggers(now: Date = new Date()): Promise<SilentTrigger[]> {
  if (now.getTime() - lastSweepAt < TRIGGER_SILENCE_RECHECK_MS) return [];
  lastSweepAt = now.getTime();

  const catalogue = await fetchChannelCatalogue();
  if (!catalogue.ok) {
    console.warn(`[campaign-service] Trigger silence sweep skipped: catalogue unreadable (${catalogue.detail})`);
    return [];
  }
  const types = [...(catalogue.triggers?.values() ?? [])].filter((t) => t.coded);
  if (types.length === 0) return [];

  const live = await db.query.campaigns.findMany({ where: eq(campaigns.status, "ongoing") });

  const alerted: SilentTrigger[] = [];
  for (const type of types) {
    const transitions = (catalogue.triggerTransitions ?? []).filter((t) => t.triggerId === type.id);
    const behind = live.filter(
      (c) =>
        c.legKey !== null &&
        transitions.some((t) => t.featureSlug === c.featureSlug && sameLeg(c.featureSlug, t.legKey, c.legKey)),
    );
    if (behind.length === 0) {
      await db.delete(triggerSilenceWatch).where(eq(triggerSilenceWatch.triggerId, type.id));
      continue;
    }

    await db.insert(triggerSilenceWatch).values({ triggerId: type.id, watchedSince: now }).onConflictDoNothing();
    const [watch] = await db.select().from(triggerSilenceWatch).where(eq(triggerSilenceWatch.triggerId, type.id));
    const [last] = await db
      .select({ at: sql<string | null>`max(${triggerEvents.occurredAt})` })
      .from(triggerEvents)
      .where(eq(triggerEvents.triggerId, type.id));
    const lastEventAt = last?.at ? new Date(last.at) : null;
    const silentSince = lastEventAt && lastEventAt > watch.watchedSince ? lastEventAt : watch.watchedSince;
    if (now.getTime() - silentSince.getTime() < TRIGGER_SILENCE_MS) continue;

    // Atomic claim: at most one alert per type per 24h, whatever runs concurrently.
    const realertBefore = new Date(now.getTime() - TRIGGER_SILENCE_REALERT_MS);
    const claimed = await db
      .update(triggerSilenceWatch)
      .set({ lastAlertedAt: now })
      .where(and(
        eq(triggerSilenceWatch.triggerId, type.id),
        or(isNull(triggerSilenceWatch.lastAlertedAt), lt(triggerSilenceWatch.lastAlertedAt, realertBefore)),
      ))
      .returning({ triggerId: triggerSilenceWatch.triggerId });
    if (claimed.length === 0) continue;

    const silent: SilentTrigger = {
      triggerId: type.id,
      label: type.label,
      firedBy: type.firedBy,
      silentSince,
      liveCampaigns: behind,
    };
    const sent = await sendSilentTriggerAlert(silent, now);
    if (!sent) {
      await db
        .update(triggerSilenceWatch)
        .set({ lastAlertedAt: watch.lastAlertedAt })
        .where(eq(triggerSilenceWatch.triggerId, type.id));
      continue;
    }
    alerted.push(silent);
  }

  // Types no longer declared or no longer coded are not watched.
  const coded = types.map((t) => t.id);
  await db.delete(triggerSilenceWatch).where(sql`${triggerSilenceWatch.triggerId} NOT IN (${sql.join(coded.map((id) => sql`${id}`), sql`, `)})`);
  return alerted;
}

async function sendSilentTriggerAlert(silent: SilentTrigger, now: Date): Promise<boolean> {
  const url = process.env.TRANSACTIONAL_EMAIL_SERVICE_URL;
  const apiKey = process.env.TRANSACTIONAL_EMAIL_SERVICE_API_KEY;
  if (!url || !apiKey) {
    console.error(`[campaign-service] Trigger ${silent.triggerId} is silent but TRANSACTIONAL_EMAIL_SERVICE_URL/API_KEY are not set: staff NOT alerted`);
    return false;
  }
  // The send is authorized against a user: the owner of the oldest live campaign behind the type.
  const anchor = [...silent.liveCampaigns]
    .filter((c) => c.createdByUserId)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0];
  if (!anchor?.createdByUserId) {
    console.error(`[campaign-service] Trigger ${silent.triggerId} is silent but no live campaign behind it names an owner: staff NOT alerted`);
    return false;
  }
  const silentDays = ((now.getTime() - silent.silentSince.getTime()) / 86_400_000).toFixed(1);
  try {
    const res = await fetch(`${url}/platform-send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "x-org-id": anchor.orgId,
        "x-user-id": anchor.createdByUserId,
      },
      body: JSON.stringify({
        eventType: TRIGGER_SILENT_EVENT,
        metadata: {
          triggerId: silent.triggerId,
          triggerLabel: silent.label,
          silentSince: silent.silentSince.toISOString(),
          silentDays,
          liveCampaignCount: String(silent.liveCampaigns.length),
          firedBy: silent.firedBy,
          whereToLook: `campaign_service: SELECT occurred_at, org_id, brand_id, offer_id, outcome, skip_reason FROM trigger_events WHERE trigger_id='${silent.triggerId}' ORDER BY occurred_at DESC LIMIT 20;`,
        },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(`[campaign-service] Trigger ${silent.triggerId} silent-alert refused: ${res.status} ${text.slice(0, 200)}; retried next sweep`);
      return false;
    }
    console.warn(
      `[campaign-service] Trigger ${silent.triggerId} has recorded no event since ${silent.silentSince.toISOString()} ` +
      `(${silentDays} days) with ${silent.liveCampaigns.length} live campaign(s) behind it — staff alerted`,
    );
    return true;
  } catch (err) {
    console.error(`[campaign-service] Trigger ${silent.triggerId} silent-alert failed; retried next sweep:`, err);
    return false;
  }
}
