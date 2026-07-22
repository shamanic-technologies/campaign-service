// Lifecycle email: nudge the user to extend an audience when a brand's outreach has
// fully contacted every lead in its active audiences (the sales loop has no next lead
// left to send). campaign-service is the SENDER/trigger, so it owns registering the
// template and firing the send; transactional-email-service owns templating, recipient
// resolution, and the 1x/month-per-brand deduplication.
//
// EVERYTHING here is fire-and-forget: it must NEVER block, delay, or fail the outreach
// loop / run finalization. Every path swallows its error (logged, not thrown).
import type { Campaign } from "../db/schema.js";
import { anyBrandPaused } from "./brand-pause.js";
import { SALES_OUTREACH_FEATURE_SLUG } from "./sales-outreach-campaign.js";

// eventType == template name. transactional-email-service maps a send's eventType to the
// template of the same name and applies its monthly-per-brand dedup to this eventType.
export const EXTEND_AUDIENCE_EVENT_TYPE = "audience_fully_contacted";

const DASHBOARD_URL = "https://dashboard.distribute.you";

// The template registered at boot via PUT /platform-templates (API-key only; no user
// session needed at cold start). Copy is user-facing: plain, no em-dash.
const EXTEND_AUDIENCE_TEMPLATE = {
  name: EXTEND_AUDIENCE_EVENT_TYPE,
  subject: "Your outreach is waiting on new leads",
  htmlBody: [
    "<p>Hi there,</p>",
    "<p>Your outreach has now contacted everyone in your current audiences, so sending has paused.</p>",
    "<p>Add or widen an audience and we'll pick sending back up automatically.</p>",
    '<p><a href="{{dashboardUrl}}">Extend an audience</a></p>',
  ].join("\n"),
  textBody: [
    "Hi there,",
    "",
    "Your outreach has now contacted everyone in your current audiences, so sending has paused.",
    "",
    "Add or widen an audience and we'll pick sending back up automatically.",
    "",
    "Extend an audience: {{dashboardUrl}}",
  ].join("\n"),
};

function transactionalEmailConfig(): { url: string; apiKey: string } | null {
  const url = process.env.TRANSACTIONAL_EMAIL_SERVICE_URL;
  const apiKey = process.env.TRANSACTIONAL_EMAIL_SERVICE_API_KEY;
  if (!url || !apiKey) return null;
  return { url, apiKey };
}

/**
 * Register the extend-audience template at boot. Idempotent upsert on the template
 * `name`. Uses PUT /platform-templates (x-api-key only) so no org/user session is
 * required at cold start. Fire-and-forget: a registration failure logs and is
 * swallowed so it never blocks boot or the request path.
 */
export async function registerExtendAudienceTemplate(): Promise<void> {
  const cfg = transactionalEmailConfig();
  if (!cfg) {
    console.warn(
      "[campaign-service] TRANSACTIONAL_EMAIL_SERVICE_URL/API_KEY not set — skipping extend-audience template registration",
    );
    return;
  }
  try {
    const res = await fetch(`${cfg.url}/platform-templates`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "x-api-key": cfg.apiKey },
      body: JSON.stringify({ templates: [EXTEND_AUDIENCE_TEMPLATE] }),
    });
    if (!res.ok) {
      console.error(`[campaign-service] extend-audience template registration failed: ${res.status}`);
    } else {
      console.log("[campaign-service] Registered extend-audience email template");
    }
  } catch (err) {
    console.error("[campaign-service] extend-audience template registration error:", err);
  }
}

/**
 * Read whether the org has auto-topup ON from billing-service. User-less internal read
 * (x-api-key only). Fail-SAFE: any error, non-2xx, 404, or missing field returns false
 * so we NEVER email an org we cannot confirm is set up to keep spending. Never throws.
 */
async function readAutoTopupEnabled(orgId: string): Promise<boolean> {
  const url = process.env.BILLING_SERVICE_URL;
  const apiKey = process.env.BILLING_SERVICE_API_KEY;
  if (!url || !apiKey) return false;
  try {
    const res = await fetch(`${url}/internal/accounts/by-org/${orgId}/balance`, {
      headers: { "x-api-key": apiKey },
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { has_auto_topup?: boolean };
    return data.has_auto_topup === true;
  } catch {
    return false;
  }
}

/**
 * Read a brand's daily budget (cents) from billing-service. Service-to-service read.
 * Fail-SAFE: any error / non-2xx / unparseable returns null (treated as no budget).
 * Never throws.
 */
async function readBrandDailyBudgetCents(orgId: string, brandId: string): Promise<number | null> {
  const url = process.env.BILLING_SERVICE_URL;
  const apiKey = process.env.BILLING_SERVICE_API_KEY;
  if (!url || !apiKey) return null;
  try {
    const res = await fetch(`${url}/internal/brands/${brandId}/daily-budget`, {
      headers: { "x-api-key": apiKey, "x-org-id": orgId, "x-brand-id": brandId },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { dailyBudgetCents?: string | null };
    if (data.dailyBudgetCents === null || data.dailyBudgetCents === undefined) return null;
    const cents = parseFloat(data.dailyBudgetCents);
    return Number.isFinite(cents) ? cents : null;
  } catch {
    return null;
  }
}

/**
 * Does the campaign have a positive daily budget configured? The campaign's OWN daily
 * budget (dailyBudgetCents) takes precedence; when unset, fall back to ANY targeted
 * brand's daily budget (mirrors the sales gate-check resolution). Fail-safe → false.
 */
async function hasPositiveDailyBudget(campaign: Campaign): Promise<boolean> {
  if (campaign.dailyBudgetCents !== null && campaign.dailyBudgetCents !== undefined) {
    return campaign.dailyBudgetCents > 0;
  }
  const brandIds = campaign.brandIds ?? [];
  for (const brandId of brandIds) {
    const cents = await readBrandDailyBudgetCents(campaign.orgId, brandId);
    if (cents !== null && cents > 0) return true;
  }
  return false;
}

/**
 * POST the extend-audience lifecycle email. Recipient is resolved by transactional-email
 * from x-user-id (the campaign's createdByUserId → client-service). Dedup (1x/month per
 * brand) is enforced downstream by the eventType's monthly-per-brand strategy, so a
 * duplicate simply returns { sent: false, reason: "duplicate" }. Never throws.
 */
async function sendExtendAudienceEmail(campaign: Campaign, userId: string, runId: string): Promise<void> {
  const cfg = transactionalEmailConfig();
  if (!cfg) return;
  const brandIds = campaign.brandIds ?? [];
  try {
    const res = await fetch(`${cfg.url}/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": cfg.apiKey,
        "x-org-id": campaign.orgId,
        "x-user-id": userId,
        "x-run-id": runId,
        "x-campaign-id": campaign.id,
        "x-brand-id": brandIds.join(","),
        ...(campaign.featureSlug ? { "x-feature-slug": campaign.featureSlug } : {}),
      },
      body: JSON.stringify({
        eventType: EXTEND_AUDIENCE_EVENT_TYPE,
        brandIds,
        campaignId: campaign.id,
        metadata: { dashboardUrl: DASHBOARD_URL },
      }),
    });
    if (!res.ok) {
      console.error(`[campaign-service] extend-audience email send failed for campaign ${campaign.id}: ${res.status}`);
    }
  } catch (err) {
    console.error(`[campaign-service] extend-audience email send error for campaign ${campaign.id}:`, err);
  }
}

/**
 * Fire-and-forget: when a brand's outreach is fully contacted (all targeted audiences
 * exhausted, the campaign is being auto-stopped), email the user to extend an audience.
 *
 * Sends ONLY when EVERY condition holds:
 *   - sales-cold-email-outreach feature (the audience/extend concept applies)
 *   - the campaign has an owning user (createdByUserId) to resolve as recipient
 *   - the brand is ACTIVE (not paused)
 *   - a daily budget is configured (> 0)
 *   - the org has auto-topup ON
 *
 * The 1x/month-per-brand cap is enforced by transactional-email-service dedup, not here.
 * Any error is logged and swallowed — this must never affect run finalization.
 */
export async function maybeSendExtendAudienceEmail(campaign: Campaign, opts: { runId?: string }): Promise<void> {
  try {
    if (campaign.featureSlug !== SALES_OUTREACH_FEATURE_SLUG) return;

    const userId = campaign.createdByUserId;
    if (!userId) return;

    const brandIds = campaign.brandIds ?? [];
    if (brandIds.length === 0) return;

    if (await anyBrandPaused(campaign.orgId, brandIds)) return;
    if (!(await hasPositiveDailyBudget(campaign))) return;
    if (!(await readAutoTopupEnabled(campaign.orgId))) return;

    const runId = opts.runId ?? crypto.randomUUID();
    await sendExtendAudienceEmail(campaign, userId, runId);
  } catch (err) {
    console.error(`[campaign-service] maybeSendExtendAudienceEmail failed for campaign ${campaign.id}:`, err);
  }
}
