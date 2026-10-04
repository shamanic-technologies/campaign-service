/**
 * A campaign that fails every run backs off and is noticed (campaign-service#407).
 *
 * Before this, `/end-run` rescheduled a failed run on a flat 60s with no memory: a campaign
 * stuck on one poisoned upstream record retried 1,440 times a day, every attempt paid for a
 * real LLM completion before dying, and nobody heard about it until somebody counted.
 *
 * What this module owns, and nothing else:
 *   1. MEMORY: the campaign row carries its current failure streak (migration 0061). A failed
 *      run increments it, the first successful run resets it.
 *   2. BACKOFF: the delay before the next attempt widens with the streak, from the old 60s up to
 *      a ceiling, so a campaign that cannot succeed stops spending at the flat rate while one that
 *      CAN (upstream fixed) is back within one ceiling interval, by itself.
 *   3. SIGNAL: a readable state (`runHealthOf`) and ONE staff alert per failing episode.
 *
 * What it never does: change a status. A system condition never stops a campaign (CLAUDE.md
 * owner rule 3), and a false stop on a transient outage would be its own incident for a paying
 * customer. It never emails the customer either: the alert is a staff-only event.
 *
 * Thresholds, from prod `run_events` (`end-run`, 2026-09-04 → 2026-10-04, 28 campaigns, 13,013
 * failed runs, measured at the old flat 60s cadence):
 *   streak length  1: 1,235 · 2: 317 · 3: 128 · 4-5: 158 · 6-10: 92 · 11-20: 12 · 21-50: 22 · 51+: 36
 *   - 1,680 of 2,000 streaks (84%) end within 3 failures, i.e. a transient blip that recovers on
 *     its own in ~3 minutes. Those keep the old 60s cadence untouched (FAILURES_AT_BASE_CADENCE).
 *   - The longest streaks of the 6-10 class lasted at most 37 min; every streak that ran longer
 *     belongs to the 21+ classes, which are the real incidents (Shockwavecenters 3922c8e1: 527
 *     failures in a row over 610 min on 2026-10-04; LegistAI cb528e24: 113 + 108).
 *   - Doubling from 2 min after the 3rd failure reaches the 30 min ceiling at the 8th. Attempts
 *     land at t = 0, 1, 2, 3, 5, 9, 17, 33, 63, 93 ... min. A permanently failing campaign now
 *     costs ~48 attempts a day instead of 1,440, and is back to normal within 30 min of the
 *     upstream being fixed.
 *   - The alert fires at the 8th consecutive failure: ~33 min of uninterrupted failure, longer
 *     than every blip class observed, early enough that someone hears about it the same morning.
 *   - Prod streaks are broken by sporadic successes (3922c8e1 on 2026-09-30: four streaks of
 *     96-113 the same day). A success resets the BACKOFF (the campaign may well be fine), but the
 *     alert latch survives it for FAILING_ALERT_COOLDOWN_MS, so a flapping campaign mails staff at
 *     most once a day rather than once per streak.
 */
import { and, eq, gt, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { campaigns, type Campaign } from "../db/schema.js";

/** The retry delay for the first few failures of a streak: the cadence before this existed. */
export const FAILURE_RETRY_BASE_MS = 60_000;

/** Failures in a row retried at the base cadence before the interval starts widening. */
export const FAILURES_AT_BASE_CADENCE = 3;

/** The widest the retry interval ever gets: worst-case recovery time once upstream is fixed. */
export const FAILURE_RETRY_CEILING_MS = 30 * 60_000;

/** Consecutive failures at which the campaign reads as FAILING and staff are told. */
export const FAILING_ALERT_THRESHOLD = 8;

/** At most one staff alert per campaign per this window, across resets. */
export const FAILING_ALERT_COOLDOWN_MS = 24 * 60 * 60_000;

/**
 * A failure arriving this long after the previous one does not CONTINUE that streak: under the
 * backoff a streak's failures are at most one ceiling apart, so a longer gap means the campaign
 * was not retrying at all (stopped and restarted by a person, held unfunded, waiting on its daily
 * ceiling). Starting over keeps a stale count from putting a fresh run on the slowest cadence.
 */
export const FAILURE_STREAK_STALE_MS = 2 * FAILURE_RETRY_CEILING_MS;

/** The delay before the next attempt, after `consecutiveFailures` failed runs in a row. */
export function failureRetryDelayMs(consecutiveFailures: number): number {
  if (consecutiveFailures <= FAILURES_AT_BASE_CADENCE) return FAILURE_RETRY_BASE_MS;
  const widened = FAILURE_RETRY_BASE_MS * 2 ** (consecutiveFailures - FAILURES_AT_BASE_CADENCE);
  return Math.min(widened, FAILURE_RETRY_CEILING_MS);
}

/** "30 min", "2 min", "60 s": the interval as a person reads it. */
export function formatInterval(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  return `${Math.round(ms / 60_000)} min`;
}

export type RunHealthState = "healthy" | "retrying" | "failing";

export interface RunHealth {
  /**
   * healthy  — the last run succeeded (or none failed since).
   * retrying — the last run(s) failed, fewer than FAILING_ALERT_THRESHOLD in a row.
   * failing  — FAILING_ALERT_THRESHOLD or more failed runs in a row: staff were told.
   */
  state: RunHealthState;
  consecutiveFailures: number;
  failingSince: string | null;
  lastFailureAt: string | null;
  /** The delay applied after the latest failure; null when healthy. */
  retryIntervalMs: number | null;
  /** The last staff alert for this campaign (survives a reset; null = never alerted). */
  alertedAt: string | null;
}

type StreakColumns = Pick<
  Campaign,
  "consecutiveRunFailures" | "failingSince" | "lastRunFailureAt" | "failureAlertedAt"
>;

export function runHealthOf(row: StreakColumns): RunHealth {
  const n = row.consecutiveRunFailures ?? 0;
  return {
    state: n === 0 ? "healthy" : n >= FAILING_ALERT_THRESHOLD ? "failing" : "retrying",
    consecutiveFailures: n,
    failingSince: row.failingSince ? row.failingSince.toISOString() : null,
    lastFailureAt: row.lastRunFailureAt ? row.lastRunFailureAt.toISOString() : null,
    retryIntervalMs: n === 0 ? null : failureRetryDelayMs(n),
    alertedAt: row.failureAlertedAt ? row.failureAlertedAt.toISOString() : null,
  };
}

/**
 * Is this campaign waiting out a WIDENED retry interval right now? The step trigger reads it so
 * an event cannot bypass the backoff: a reactive lead is never dropped (it stays due in
 * lead-service's queue and the next scheduled run works it), so skipping costs nothing but the
 * failing run.
 */
export function isInFailureBackoff(
  row: Pick<Campaign, "consecutiveRunFailures" | "nextRunAt">,
  now: Date = new Date(),
): boolean {
  return (
    (row.consecutiveRunFailures ?? 0) > FAILURES_AT_BASE_CADENCE &&
    !!row.nextRunAt &&
    row.nextRunAt.getTime() > now.getTime()
  );
}

export interface RecordedFailure {
  consecutiveFailures: number;
  failingSince: Date;
  /** The delay before the next attempt, from the streak this failure lands in. */
  retryDelayMs: number;
  /**
   * This failure CLAIMED the episode's staff alert (atomic: exactly one concurrent `/end-run`
   * wins it). The caller sends, and calls `releaseFailingAlertClaim` if the send fails.
   */
  alertClaimedAt: Date | null;
}

/**
 * Record one failed run. One UPDATE: increments the streak (or starts a fresh one when the last
 * failure is stale), and claims the staff alert when the streak crosses the threshold and no alert
 * went out within the cooldown. Returns null when the campaign does not exist.
 */
export async function recordRunFailure(campaignId: string): Promise<RecordedFailure | null> {
  const staleSeconds = Math.round(FAILURE_STREAK_STALE_MS / 1000);
  const cooldownSeconds = Math.round(FAILING_ALERT_COOLDOWN_MS / 1000);
  // `fresh` = this failure continues the current streak. now() is the transaction timestamp, so
  // the SET and the RETURNING agree on it: `alert_claimed` is exactly "this statement wrote it".
  const continues = sql`(${campaigns.lastRunFailureAt} IS NOT NULL AND ${campaigns.lastRunFailureAt} > now() - (${staleSeconds}::int * interval '1 second') AND ${campaigns.consecutiveRunFailures} > 0)`;
  const nextCount = sql`(CASE WHEN ${continues} THEN ${campaigns.consecutiveRunFailures} + 1 ELSE 1 END)`;
  const rows = await db
    .update(campaigns)
    .set({
      consecutiveRunFailures: nextCount,
      failingSince: sql`(CASE WHEN ${continues} THEN coalesce(${campaigns.failingSince}, now()) ELSE now() END)`,
      lastRunFailureAt: sql`now()`,
      failureAlertedAt: sql`(CASE WHEN ${nextCount} >= ${FAILING_ALERT_THRESHOLD}
        AND (${campaigns.failureAlertedAt} IS NULL OR ${campaigns.failureAlertedAt} < now() - (${cooldownSeconds}::int * interval '1 second'))
        THEN now() ELSE ${campaigns.failureAlertedAt} END)`,
    })
    .where(eq(campaigns.id, campaignId))
    .returning({
      consecutiveFailures: campaigns.consecutiveRunFailures,
      failingSince: campaigns.failingSince,
      failureAlertedAt: campaigns.failureAlertedAt,
      alertClaimed: sql<boolean>`(${campaigns.failureAlertedAt} = now())`,
    });

  const row = rows[0];
  if (!row) return null;
  return {
    consecutiveFailures: row.consecutiveFailures,
    failingSince: row.failingSince ?? new Date(),
    retryDelayMs: failureRetryDelayMs(row.consecutiveFailures),
    alertClaimedAt: row.alertClaimed ? row.failureAlertedAt : null,
  };
}

/**
 * Record one successful run: the streak ends and the cadence is back to normal on the next run.
 * Writes nothing for a campaign that was not failing (the common case), so a healthy campaign
 * pays one indexed no-op UPDATE. The alert latch is NOT cleared (see the cooldown above).
 * Returns whether a streak was ended.
 */
export async function recordRunSuccess(campaignId: string): Promise<boolean> {
  const rows = await db
    .update(campaigns)
    .set({ consecutiveRunFailures: 0, failingSince: null })
    .where(and(eq(campaigns.id, campaignId), gt(campaigns.consecutiveRunFailures, 0)))
    .returning({ id: campaigns.id });
  return rows.length > 0;
}

/**
 * The alert could not be delivered: give the claim back so the next failure tries again, rather
 * than losing the whole episode to one refused request. Guarded on the exact claim, so a newer
 * claim is never undone.
 */
export async function releaseFailingAlertClaim(campaignId: string, claimedAt: Date): Promise<void> {
  await db
    .update(campaigns)
    .set({ failureAlertedAt: null })
    .where(and(
      eq(campaigns.id, campaignId),
      // Postgres keeps microseconds, a JS Date milliseconds: compare at the Date's precision.
      sql`date_trunc('milliseconds', ${campaigns.failureAlertedAt}) = ${claimedAt.toISOString()}::timestamptz`,
    ));
}

/** Staff event owned by transactional-email-service (staff list, template, per-campaign-day dedup). */
export const CAMPAIGN_FAILING_EVENT = "campaign_failing";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export interface FailingAlertContext {
  campaign: Pick<Campaign, "id" | "orgId" | "name" | "brandIds" | "featureSlug" | "createdByUserId">;
  failure: RecordedFailure;
  /** The run that just failed: a real run id, the parent of transactional-email's send run. */
  runId?: string;
  /**
   * The inbound request's acting user, used only when the campaign names no owner. A send with no
   * user is refused one hop down (billing authorizes the email against a user UUID), so a staff
   * alert from a machine caller must still state one: the campaign owner's, org-billed like any
   * side effect of the run.
   */
  userId?: string;
}

/**
 * Tell staff, once, that this campaign has been failing. Fire-and-forget: never throws, never
 * blocks run finalization. A refused or failed send releases the claim so the next failure retries.
 * Returns whether the alert was delivered (for tests and logs).
 */
export async function notifyFailingCampaign(ctx: FailingAlertContext): Promise<boolean> {
  const { campaign, failure } = ctx;
  const claimedAt = failure.alertClaimedAt;
  if (!claimedAt) return false;

  const url = process.env.TRANSACTIONAL_EMAIL_SERVICE_URL;
  const apiKey = process.env.TRANSACTIONAL_EMAIL_SERVICE_API_KEY;
  const release = async (why: string) => {
    console.error(`[campaign-service] campaign-failing alert for campaign ${campaign.id} not delivered (${why}); the next failure retries it`);
    try {
      await releaseFailingAlertClaim(campaign.id, claimedAt);
    } catch (err) {
      console.error(`[campaign-service] could not release the campaign-failing alert claim for ${campaign.id}:`, err);
    }
    return false;
  };
  if (!url || !apiKey) return release("TRANSACTIONAL_EMAIL_SERVICE_URL/API_KEY not set");

  const brandId = campaign.brandIds?.[0] ?? "";
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
    "x-org-id": campaign.orgId,
    "x-campaign-id": campaign.id,
  };
  if (ctx.runId) headers["x-run-id"] = ctx.runId;
  const userId = campaign.createdByUserId || ctx.userId;
  if (!userId) return release("the campaign names no owner and the run no user: the send would be refused");
  headers["x-user-id"] = userId;
  if (brandId) headers["x-brand-id"] = brandId;
  if (campaign.featureSlug) headers["x-feature-slug"] = campaign.featureSlug;

  try {
    const res = await fetch(`${url}/platform-send`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        eventType: CAMPAIGN_FAILING_EVENT,
        campaignId: campaign.id,
        ...(brandId ? { brandIds: [brandId] } : {}),
        metadata: {
          campaignId: campaign.id,
          campaignName: escapeHtml(campaign.name),
          consecutiveFailures: String(failure.consecutiveFailures),
          failingSince: failure.failingSince.toISOString(),
          retryInterval: formatInterval(failure.retryDelayMs),
          featureSlug: campaign.featureSlug ?? "",
          brandId,
          whereToLook: `runs_service: SELECT created_at, service, event, level, detail FROM run_events WHERE campaign_id='${campaign.id}' AND level IN ('warn','error') ORDER BY created_at DESC LIMIT 20;`,
        },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return release(`transactional-email ${res.status} ${text.slice(0, 200)}`);
    }
    console.warn(
      `[campaign-service] Campaign ${campaign.id} has failed ${failure.consecutiveFailures} runs in a row since ${failure.failingSince.toISOString()} — staff alerted; retrying every ${formatInterval(failure.retryDelayMs)}`,
    );
    return true;
  } catch (err) {
    return release(err instanceof Error ? err.message : String(err));
  }
}
