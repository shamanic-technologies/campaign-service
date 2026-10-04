// Refill BEFORE telling the client their outreach ran out (refill-before-exhausted-email).
//
// distribute.you is done-for-you: when a campaign has contacted everyone in its audiences, finding
// the next people is OUR job. So the first thing that happens is not an email to the client but a
// refill: human-service (which owns audiences) creates NEW audiences for the brand from its
// existing target, steering away from what the brand already holds. The client is emailed only
// when that genuinely produced nobody new, and staff hear about it at the same moment.
//
// Everything the refill decides is human-service's, read from its deployed contract
// (`POST /internal/audience-refill?brandId=`), never reconstructed here:
//   - it only spends for an org billing says can be charged;
//   - at most one refill per brand per few days (a market that is really dry is not re-billed);
//   - spend is org-billed under a run it opens for the org (split LLM calls, Apollo builds);
//   - audiences are never edited: a new population is a new audience, born active.
//
// What campaign-service owns is WHEN to ask: once per exhaustion EPISODE (a has_audience = false
// period of campaign_audience_availability), claimed atomically, so the many /end-run calls that
// observe the same exhaustion ask once.
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { campaignAudienceAvailability, type Campaign } from "../db/schema.js";

/**
 * Claim this campaign's one refill attempt for its CURRENT exhaustion episode. True exactly once
 * per has_audience = false period; false when the period was already claimed, or when the campaign
 * is not in such a period at all (it has people: nothing to refill).
 */
export async function claimEpisodeRefill(campaignId: string): Promise<boolean> {
  const claimed = await db
    .update(campaignAudienceAvailability)
    .set({ refillAttemptedAt: sql`now()` })
    .where(
      and(
        eq(campaignAudienceAvailability.campaignId, campaignId),
        isNull(campaignAudienceAvailability.endedAt),
        eq(campaignAudienceAvailability.hasAudience, false),
        isNull(campaignAudienceAvailability.refillAttemptedAt),
      ),
    )
    .returning({ id: campaignAudienceAvailability.id });
  return claimed.length > 0;
}

export type RefillVerdict =
  | { refilled: true; created: number }
  /**
   * `outcome` is human-service's own skip reason verbatim (`cooldown`, `not_chargeable`, `failed`,
   * ...), or one of ours: `not_served_recently` (the brand is not in its scan), `busy` (a refill
   * kept running), `error` (the call itself failed).
   */
  | { refilled: false; outcome: string; detail: string | null };

interface RefillOutcome {
  orgId: string;
  brandId: string;
  action: "refilled" | "would_refill" | "skipped";
  reason: string | null;
  detail: string | null;
  created: unknown[];
}

/** How long one refill may take: a split is two LLM calls, ~15-30s; Apollo builds run after. */
const REFILL_TIMEOUT_MS = 5 * 60_000;
/** human-service answers 409 while another refill (its 6-hourly sweep, a serve-time one) runs. */
const BUSY_RETRIES = 3;
const BUSY_RETRY_DELAY_MS = 30_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Ask human-service to refill ONE brand's audiences now. Never throws: every failure is a verdict
 * (`refilled: false`) the caller acts on, so the client still hears and staff still hear.
 */
export async function requestBrandAudienceRefill(
  orgId: string,
  brandId: string,
  opts: { busyRetryDelayMs?: number } = {},
): Promise<RefillVerdict> {
  const url = process.env.HUMAN_SERVICE_URL;
  const apiKey = process.env.HUMAN_SERVICE_API_KEY;
  if (!url || !apiKey) {
    return { refilled: false, outcome: "error", detail: "HUMAN_SERVICE_URL/API_KEY not set" };
  }
  const delayMs = opts.busyRetryDelayMs ?? BUSY_RETRY_DELAY_MS;
  try {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(
        `${url}/internal/audience-refill?brandId=${encodeURIComponent(brandId)}`,
        {
          method: "POST",
          headers: { "x-api-key": apiKey },
          signal: AbortSignal.timeout(REFILL_TIMEOUT_MS),
        },
      );
      if (res.status === 409) {
        if (attempt < BUSY_RETRIES) {
          await sleep(delayMs);
          continue;
        }
        return { refilled: false, outcome: "busy", detail: "human-service kept answering 409 (a refill already running)" };
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return { refilled: false, outcome: "error", detail: `human-service ${res.status} ${text.slice(0, 200)}` };
      }
      const body = (await res.json()) as { outcomes?: RefillOutcome[] };
      // Scoped to the ORG too: a brand can be claimed by several orgs.
      const mine = (body.outcomes ?? []).find((o) => o.brandId === brandId && o.orgId === orgId);
      if (!mine) {
        return { refilled: false, outcome: "not_served_recently", detail: "human-service did not scan this brand (no recent serves)" };
      }
      if (mine.action === "refilled" && mine.created.length > 0) {
        return { refilled: true, created: mine.created.length };
      }
      return { refilled: false, outcome: mine.reason ?? mine.action, detail: mine.detail };
    }
  } catch (err) {
    return { refilled: false, outcome: "error", detail: err instanceof Error ? err.message : String(err) };
  }
}

/** Staff event owned by transactional-email-service (staff list, template, dedup). */
export const AUDIENCE_REFILL_FAILED_EVENT = "audience_refill_failed";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Tell staff that a brand ran out of people and the automatic refill did not fix it, sent beside
 * the client's extend-audience email so a human can step in. Never throws; returns whether
 * transactional-email accepted it. A refusal is logged LOUDLY (the client email still goes).
 */
export async function notifyRefillFailed(ctx: {
  campaign: Pick<Campaign, "id" | "orgId" | "name" | "brandIds" | "featureSlug">;
  userId: string;
  runId: string;
  brandName: string | null;
  verdict: Extract<RefillVerdict, { refilled: false }>;
}): Promise<boolean> {
  const { campaign, verdict } = ctx;
  const url = process.env.TRANSACTIONAL_EMAIL_SERVICE_URL;
  const apiKey = process.env.TRANSACTIONAL_EMAIL_SERVICE_API_KEY;
  if (!url || !apiKey) {
    console.error(`[campaign-service] audience-refill staff alert for campaign ${campaign.id} not sent: TRANSACTIONAL_EMAIL_SERVICE_URL/API_KEY not set`);
    return false;
  }
  const brandId = campaign.brandIds?.[0] ?? "";
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
    "x-org-id": campaign.orgId,
    "x-user-id": ctx.userId,
    "x-run-id": ctx.runId,
    "x-campaign-id": campaign.id,
  };
  if (brandId) headers["x-brand-id"] = brandId;
  if (campaign.featureSlug) headers["x-feature-slug"] = campaign.featureSlug;
  try {
    const res = await fetch(`${url}/platform-send`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        eventType: AUDIENCE_REFILL_FAILED_EVENT,
        campaignId: campaign.id,
        ...(brandId ? { brandIds: [brandId] } : {}),
        metadata: {
          campaignId: campaign.id,
          campaignName: escapeHtml(campaign.name),
          brandId,
          brandName: ctx.brandName ? escapeHtml(ctx.brandName) : "",
          refillOutcome: verdict.outcome,
          refillDetail: verdict.detail ? escapeHtml(verdict.detail) : "",
          whereToLook: `human_service logs: grep "audience_refill.brand" for brand=${brandId}; campaign_service: SELECT * FROM campaign_audience_availability WHERE campaign_id='${campaign.id}' ORDER BY started_at DESC LIMIT 3;`,
        },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(`[campaign-service] audience-refill staff alert for campaign ${campaign.id} refused: transactional-email ${res.status} ${text.slice(0, 200)}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[campaign-service] audience-refill staff alert for campaign ${campaign.id} failed:`, err);
    return false;
  }
}
