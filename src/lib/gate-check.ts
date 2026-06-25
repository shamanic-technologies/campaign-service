import { listRuns, updateRun, getStatsBudget, type Run, type BudgetWindow, type IdentityHeaders } from "@distribute/runs-client";
import { db } from "../db/index.js";
import { campaigns } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { anyBrandPaused } from "./brand-pause.js";

const STALE_THRESHOLD_MS = 3 * 60 * 60 * 1000; // 3 hours

// The ONE feature paced by the brand daily budget (billing-service brand_daily_budgets).
// Every other feature is paced by the campaign's own budget windows instead. Keep this byte-equal
// to the feature_slug.
const SALES_FEATURE_SLUG = "sales-cold-email-outreach";

export interface GateCheckInput {
  campaignId: string;
  orgId: string;
  userId?: string;
  runId?: string;
  brandId: string;
  brandIds: string[];
  workflowSlug?: string;
  featureSlug?: string;
  status: string;
  // Daily campaign cap. Enforced as a campaign-scoped runs window (resets at day rollover) for
  // EVERY feature except the sales feature, which is paced by the brand daily budget instead.
  maxBudgetDailyUsd: string | null;
  maxBudgetWeeklyUsd: string | null;
  maxBudgetMonthlyUsd: string | null;
  maxBudgetTotalUsd: string | null;
  maxLeads: number | null;
}

export interface GateCheckResult {
  allowed: boolean;
  reason?: string;
  autoStopped?: boolean;
  nextRunAt?: Date;
}

export async function runGateChecks(campaign: GateCheckInput): Promise<GateCheckResult> {
  // Campaign must be ongoing
  if (campaign.status !== "ongoing") {
    return { allowed: false, reason: "Campaign is not ongoing" };
  }

  // Brand pause — HOLD if ANY target brand is paused (same org). Defense-in-depth: the
  // scheduler already excludes paused-brand campaigns from its claim, but a run already in
  // flight when the brand was paused still reaches this gate. NOT a terminal stop — the
  // campaign stays 'ongoing'; internal.ts backs it off and the next un-pause resumes it.
  if (await anyBrandPaused(campaign.orgId, campaign.brandIds)) {
    return { allowed: false, reason: "Brand paused" };
  }

  const identity: IdentityHeaders = {
    orgId: campaign.orgId,
    userId: campaign.userId,
    runId: campaign.runId,
    campaignId: campaign.campaignId,
    brandId: campaign.brandId || undefined,
    workflowSlug: campaign.workflowSlug,
  };

  // Fetch all runs for this campaign (needed for stale cleanup, running check, consecutive failures)
  const { runs } = await listRuns({
    orgId: campaign.orgId,
    serviceName: "campaign-service",
    taskName: campaign.campaignId,
  });

  // 1. Stale run cleanup — mark runs running > 30 min as failed
  const now = Date.now();
  for (const run of runs) {
    if (run.status === "running" && (now - new Date(run.startedAt).getTime()) > STALE_THRESHOLD_MS) {
      try {
        await updateRun(run.id, "failed", identity);
        run.status = "failed"; // update in-memory
      } catch (err) {
        console.error(`[campaign-service] Failed to clean stale run ${run.id}:`, err);
      }
    }
  }

  // 2. Running run check — only 1 run at a time per campaign
  if (runs.some((r: Run) => r.status === "running")) {
    return { allowed: false, reason: "A run is already in progress" };
  }

  // 3. Campaign budget windows — enforced for EVERY feature EXCEPT the sales feature, which is
  // paced by the brand daily budget (block 3c below) instead. For non-sales campaigns the
  // campaign's own configured caps govern at their cadence: daily (today's spend, resets at day
  // rollover), weekly, monthly, and total (one-off — auto-stops the campaign when hit).
  const isSalesFeature = campaign.featureSlug === SALES_FEATURE_SLUG;

  if (!isSalesFeature) {
    const budgetLimits: Array<{ limit: string; label: string; autoStop: boolean; nextRunAt?: Date }> = [];
    const windows: BudgetWindow[] = [];

    if (campaign.maxBudgetDailyUsd) {
      windows.push({ label: "daily", since: startOfToday().toISOString() });
      budgetLimits.push({ limit: campaign.maxBudgetDailyUsd, label: "daily", autoStop: false, nextRunAt: nextDayStart() });
    }
    if (campaign.maxBudgetWeeklyUsd) {
      windows.push({ label: "weekly", since: daysAgo(7).toISOString() });
      budgetLimits.push({ limit: campaign.maxBudgetWeeklyUsd, label: "weekly", autoStop: false, nextRunAt: nextWeekStart() });
    }
    if (campaign.maxBudgetMonthlyUsd) {
      windows.push({ label: "monthly", since: startOfMonth().toISOString() });
      budgetLimits.push({ limit: campaign.maxBudgetMonthlyUsd, label: "monthly", autoStop: false, nextRunAt: nextMonthStart() });
    }
    if (campaign.maxBudgetTotalUsd) {
      windows.push({ label: "total" });
      budgetLimits.push({ limit: campaign.maxBudgetTotalUsd, label: "total", autoStop: true });
    }

    if (windows.length > 0) {
      // Single call to runs-service for all configured campaign budget windows.
      const budgetResult = await getStatsBudget({
        orgId: campaign.orgId,
        campaignId: campaign.campaignId,
        windows,
      });

      for (const budgetLimit of budgetLimits) {
        const limitCents = parseFloat(budgetLimit.limit) * 100;
        const windowResult = budgetResult.windows.find(w => w.label === budgetLimit.label);
        // Pace on ACTUAL (realized) spend, not actual+provisioned — same reasoning as the
        // per-brand daily cap below: worst-case provisioned reservations get cancelled to a
        // far smaller actual, so counting them would block on phantom spend.
        const actualCostCents = windowResult ? parseFloat(windowResult.actualCostInUsdCents) || 0 : 0;

        if (actualCostCents >= limitCents) {
          if (budgetLimit.autoStop) {
            await autoStopCampaign(campaign.campaignId);
            return { allowed: false, reason: "Total budget exceeded", autoStopped: true };
          }
          return { allowed: false, reason: `${budgetLimit.label} budget exceeded`, nextRunAt: budgetLimit.nextRunAt };
        }
      }
    }
  }

  // 3c. Per-brand daily budget pacing — ONLY for the sales feature.
  // billing-service stores + serves each brand's daily spend ceiling (cents); ENFORCEMENT
  // is ours. For each brand in scope, compare today's platform spend for THIS campaign's
  // feature (runs-service, brandId + featureSlug keyed) against that ceiling. A brand at/over
  // its ceiling pauses that feature loop for now — NOT a terminal stop: the block carries no
  // nextRunAt, so internal.ts backs it off ~15min and re-checks. Raising the ceiling re-enables
  // work on the next loop, and the day rollover naturally resets today's spend. An unset
  // ceiling (null) = unbounded (no cap).
  // Multi-brand tick: blocked if ANY in-scope brand has reached its ceiling (most campaigns
  // are solo-brand; per-brand downstream fan-out is out of scope here).
  //
  // Units: billing dailyBudgetCents and runs actualCostInUsdCents are BOTH cents → compared
  // directly (NO ×100, unlike the maxBudget*Usd columns above which are USD).
  //
  // Read fail-OPEN: getBrandDailyBudget returns null on any billing failure (→ no cap this
  // tick), mirroring the affordability pre-filter — a billing blip must never freeze the
  // fleet, and the org-credit affordability gate below stays the hard money gate.
  //
  // Scope: ONLY the sales feature. Non-sales features are paced by the campaign budget windows
  // (block 3 above) and are NEVER gated by the brand ceiling.
  if (isSalesFeature) {
    for (const brandId of campaign.brandIds) {
      const dailyBudgetCents = await getBrandDailyBudget(brandId, identity);
      if (dailyBudgetCents === null) continue; // unset/unreadable → no cap this tick

      const brandSpend = await getStatsBudget({
        orgId: campaign.orgId,
        brandId,
        featureSlug: campaign.featureSlug,
        windows: [{ label: "today", since: startOfToday().toISOString() }],
      });
      const today = brandSpend.windows.find(w => w.label === "today");
      // Pace on ACTUAL (realized) spend, NOT actual+provisioned. A provisioned row is a
      // worst-case affordability RESERVATION (~26¢/LLM call here) held only until the call
      // reconciles to its real cost (~0.7¢) + the hold is cancelled. Counting those open
      // worst-case holds made actual+provisioned cross the ceiling while real spend was far
      // under it — falsely blocking the campaign for ~15min (GATE_BLOCK_BACKOFF_MS) on every
      // re-check until the day rolled over. checkAffordability below stays the hard money
      // gate (org credit balance); this is just daily pacing, for which realized cost is right.
      const spentCents = today ? parseFloat(today.actualCostInUsdCents) || 0 : 0;

      if (spentCents >= dailyBudgetCents) {
        return { allowed: false, reason: "Brand daily budget reached" };
      }
    }
  }

  // 3b. Credit affordability check (fail-OPEN — deliberately differs from the budget
  // checks' fail-closed stance). A broke org's run is pre-filtered here so it stops
  // storming the per-minute Windmill flow + wasting Apollo enrichment before the LLM
  // step 402s. This is NOT a terminal stop: the campaign stays ongoing and backs off
  // via nextRunAt, so a recharge auto-resumes it on the next check (no manual restart,
  // no webhook). A billing blip must not freeze ALL campaigns, and chat-service's own
  // authorize remains the hard gate downstream — so any billing-call failure allows.
  const affordable = await checkAffordability(campaign.campaignId, identity);
  if (!affordable) {
    return { allowed: false, reason: "Insufficient credits", nextRunAt: nextHalfHour() };
  }

  // 4. Volume check
  if (campaign.maxLeads != null) {
    const completedRuns = runs.filter((r: Run) => r.status === "completed");
    let totalServed: number;
    try {
      const leadStats = await fetchLeadStats(campaign.orgId, campaign.campaignId, campaign.brandId, identity);
      totalServed = Math.max(leadStats.totalServed, completedRuns.length);
    } catch (err: unknown) {
      if (err instanceof Error && "status" in err && (err as { status: number }).status === 404) {
        totalServed = completedRuns.length;
      } else {
        return { allowed: false, reason: "Lead stats unavailable (fail-closed)" };
      }
    }

    if (totalServed >= campaign.maxLeads) {
      await autoStopCampaign(campaign.campaignId);
      return { allowed: false, reason: "Max leads reached", autoStopped: true };
    }
  }

  return { allowed: true };
}

async function autoStopCampaign(campaignId: string): Promise<void> {
  await db.update(campaigns)
    .set({ status: "stopped", updatedAt: new Date() })
    .where(eq(campaigns.id, campaignId));
  console.log(`[campaign-service] Auto-stopped campaign ${campaignId}`);
}

async function fetchLeadStats(
  orgId: string,
  campaignId: string,
  brandId: string,
  identity: IdentityHeaders,
): Promise<{ totalServed: number }> {
  const url = process.env.LEAD_SERVICE_URL;
  const apiKey = process.env.LEAD_SERVICE_API_KEY;
  if (!url || !apiKey) throw new Error("Lead service not configured");

  const headers: Record<string, string> = {
    "x-api-key": apiKey,
    "x-org-id": identity.orgId,
  };
  if (identity.userId) headers["x-user-id"] = identity.userId;
  if (identity.runId) headers["x-run-id"] = identity.runId;
  if (identity.campaignId) headers["x-campaign-id"] = identity.campaignId;
  if (identity.brandId) headers["x-brand-id"] = identity.brandId;
  if (identity.workflowSlug) headers["x-workflow-slug"] = identity.workflowSlug;

  const params = new URLSearchParams({ brandId, campaignId });
  const res = await fetch(`${url}/stats?${params}`, { headers });

  if (!res.ok) {
    const err = new Error(`Lead stats failed: ${res.status}`) as Error & { status: number };
    err.status = res.status;
    throw err;
  }

  const data = await res.json() as Record<string, unknown>;
  return { totalServed: (data.totalServed as number) || (data.served as number) || 0 };
}

/**
 * Pre-flight credit affordability check against billing-service.
 * Returns true (allow the run) unless billing explicitly reports affordable=false.
 *
 * Fail-OPEN by design: missing config, network error, or non-2xx all return true.
 * Credit affordability is a PRE-FILTER, not the final gate — chat-service's own
 * authorize is the hard gate. A billing outage must never freeze every campaign.
 */
async function checkAffordability(campaignId: string, identity: IdentityHeaders): Promise<boolean> {
  const url = process.env.BILLING_SERVICE_URL;
  const apiKey = process.env.BILLING_SERVICE_API_KEY;
  // Silent fail-open. Every fail-open path below (missing config / non-2xx / throw) is
  // hit per gate check, i.e. per ~minute per campaign across every client — logging it
  // (even at info) spams the fleet for a deliberate pre-filter degradation. Billing's own
  // monitoring owns billing's health; chat-service authorize stays the hard gate downstream.
  if (!url || !apiKey) {
    return true;
  }

  const headers: Record<string, string> = {
    "x-api-key": apiKey,
    "x-org-id": identity.orgId,
  };
  if (identity.userId) headers["x-user-id"] = identity.userId;
  if (identity.runId) headers["x-run-id"] = identity.runId;
  if (identity.campaignId) headers["x-campaign-id"] = identity.campaignId;
  if (identity.brandId) headers["x-brand-id"] = identity.brandId;
  if (identity.workflowSlug) headers["x-workflow-slug"] = identity.workflowSlug;

  try {
    const res = await fetch(`${url}/internal/campaigns/${campaignId}/affordability`, { headers });
    if (!res.ok) {
      return true;
    }
    const data = await res.json() as { affordable?: boolean };
    // Only an explicit affordable=false blocks. Anything else (true, missing) allows.
    return data.affordable !== false;
  } catch {
    return true;
  }
}

/**
 * Read a brand's current daily spend ceiling from billing-service.
 * Returns the ceiling in CENTS, or null when unset (dailyBudgetCents: null) — null means
 * "no cap this tick" to the caller.
 *
 * Fail-OPEN by design: missing config, network error, non-2xx, or unparseable value all
 * return null (no cap), mirroring checkAffordability. The daily budget is a pacing ceiling,
 * not the hard money gate — a billing outage must never freeze every campaign, and org-credit
 * affordability remains the hard gate. Silent for the same per-tick-per-campaign reason: the
 * fail-open path fires every gate check across the fleet; logging it would spam the logs.
 *
 * Contract: GET /internal/brands/{brandId}/daily-budget (x-api-key) ->
 *   { brandId, dailyBudgetCents: string|null, updatedAt: string|null }
 */
async function getBrandDailyBudget(brandId: string, identity: IdentityHeaders): Promise<number | null> {
  const url = process.env.BILLING_SERVICE_URL;
  const apiKey = process.env.BILLING_SERVICE_API_KEY;
  if (!url || !apiKey) {
    return null;
  }

  const headers: Record<string, string> = {
    "x-api-key": apiKey,
    "x-org-id": identity.orgId,
    "x-brand-id": brandId,
  };
  if (identity.userId) headers["x-user-id"] = identity.userId;
  if (identity.runId) headers["x-run-id"] = identity.runId;
  if (identity.campaignId) headers["x-campaign-id"] = identity.campaignId;
  if (identity.workflowSlug) headers["x-workflow-slug"] = identity.workflowSlug;

  try {
    const res = await fetch(`${url}/internal/brands/${brandId}/daily-budget`, { headers });
    if (!res.ok) {
      return null;
    }
    const data = await res.json() as { dailyBudgetCents?: string | null };
    if (data.dailyBudgetCents === null || data.dailyBudgetCents === undefined) {
      return null;
    }
    const cents = parseFloat(data.dailyBudgetCents);
    return Number.isFinite(cents) ? cents : null;
  } catch {
    return null;
  }
}

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
}

// Backoff for the daily campaign-budget window: park until the next day rollover, when today's
// spend resets to zero and the cap re-opens.
export function nextDayStart(): Date {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(0, 0, 0, 0);
  return d;
}

function startOfMonth(): Date {
  const d = new Date();
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d;
}

// Backoff for the credit-affordability block. Short enough to resume promptly after a
// recharge, long enough not to defeat the scheduler's adaptive-tick Neon scale-to-zero.
export function nextHalfHour(): Date {
  return new Date(Date.now() + 30 * 60 * 1000);
}

export function nextWeekStart(): Date {
  const d = new Date();
  const dayOfWeek = d.getDay(); // 0=Sun, 1=Mon...
  const daysUntilMonday = dayOfWeek === 0 ? 1 : 8 - dayOfWeek;
  d.setDate(d.getDate() + daysUntilMonday);
  d.setHours(0, 0, 0, 0);
  return d;
}

export function nextMonthStart(): Date {
  const d = new Date();
  d.setMonth(d.getMonth() + 1);
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d;
}
