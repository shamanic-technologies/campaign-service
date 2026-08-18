import { listRuns, updateRun, getStatsBudget, type Run, type BudgetWindow, type IdentityHeaders } from "@distribute/runs-client";
import { db } from "../db/index.js";
import { campaigns } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { isSalesOutreachFeature } from "./sales-outreach-campaign.js";
import { channelCeilingCents, fetchFunnelBudgets } from "./funnel-budget-client.js";
import { toFunnelKey } from "./sales-funnel-vocabulary.js";
import { STOP_REASONS } from "./stop-reason.js";

const STALE_THRESHOLD_MS = 3 * 60 * 60 * 1000; // 3 hours

// How many of the campaign's running rows the gate reads. The invariant is ONE run in flight per
// campaign, and a row only stays `running` until its DAG ends or block 1 marks it stale, so this
// is orders of magnitude above what a healthy campaign holds. It exists so an unbounded history
// can never be pulled again — not as a tuning knob. Rows come back newest-first, so if a campaign
// ever exceeded it the newest still block the tick (the guard stays correct) and the oldest are
// cleaned on a later pass once the newer ones finish.
const RUNNING_RUNS_LIMIT = 200;

// The sales-outreach feature family (every acquisition channel that sells a sales funnel) is
// paced by the brand daily budget (billing-service brand_daily_budgets) and held on brand pause.
// Every other feature is paced by the campaign's own budget windows and runs through a pause.
// See isSalesOutreachFeature (sales-outreach-campaign.ts) for membership.

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
  // EVERY feature except the sales feature, which is paced by the campaign's own daily budget
  // (dailyBudgetCents below) — falling back to the brand daily budget when unset.
  maxBudgetDailyUsd: string | null;
  maxBudgetWeeklyUsd: string | null;
  maxBudgetMonthlyUsd: string | null;
  maxBudgetTotalUsd: string | null;
  // Per-CAMPAIGN daily budget for the sales feature (CENTS). When set, the sales gate paces
  // THIS campaign on its OWN committed spend today vs this ceiling (two campaigns under one
  // brand pace independently). NULL = no own budget → fall back to the brand daily budget.
  dailyBudgetCents: number | null;
  // The sales funnel this campaign works (brand-service vocabulary), or null when the campaign
  // is not funnel-scoped. When set, the sales gate paces THIS campaign on THAT funnel's own
  // daily ceiling read from billing — so a brand funding two funnels has each worked up to its
  // own ceiling, and the brand's total for the day cannot exceed the sum.
  funnelKey: string | null;
  maxLeads: number | null;
}

export interface GateCheckResult {
  allowed: boolean;
  reason?: string;
  autoStopped?: boolean;
  nextRunAt?: Date;
}

type BrandDailyBudgetRead =
  | { ok: true; dailyBudgetCents: number | null }
  | { ok: false };

export async function runGateChecks(campaign: GateCheckInput): Promise<GateCheckResult> {
  // Campaign must be ongoing
  if (campaign.status !== "ongoing") {
    return { allowed: false, reason: "Campaign is not ongoing" };
  }

  const identity: IdentityHeaders = {
    orgId: campaign.orgId,
    userId: campaign.userId,
    runId: campaign.runId,
    campaignId: campaign.campaignId,
    brandId: campaign.brandId || undefined,
    workflowSlug: campaign.workflowSlug,
  };

  // The campaign's RUNNING rows — all this gate needs for stale cleanup (block 1) and the
  // one-run-at-a-time guard (block 2). Asking for the campaign's whole history instead was the
  // single most expensive query in the fleet: runs-service serves `runs` as a VIEW over its
  // event log, so every gate check replayed ~21k rows (workflow_context JSONB included) for a
  // campaign that only ever has one live run — and every new run made the next one dearer.
  // Filter + bound at the source; the lifetime count block 4 needs is read separately, and only
  // when a maxLeads cap actually exists.
  const { runs: runningRuns } = await listRuns({
    orgId: campaign.orgId,
    serviceName: "campaign-service",
    taskName: campaign.campaignId,
    status: "running",
    limit: RUNNING_RUNS_LIMIT,
  });

  // 1. Stale run cleanup — mark runs running > 30 min as failed
  const now = Date.now();
  for (const run of runningRuns) {
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
  if (runningRuns.some((r: Run) => r.status === "running")) {
    return { allowed: false, reason: "A run is already in progress" };
  }

  // 3. Campaign budget windows — enforced for EVERY feature EXCEPT the sales feature, which is
  // paced by the brand daily budget (block 3c below) instead. For non-sales campaigns the
  // campaign's own configured caps govern at their cadence: daily (today's spend, resets at day
  // rollover), weekly, monthly, and total (one-off — auto-stops the campaign when hit).
  const isSalesFeature = isSalesOutreachFeature(campaign.featureSlug);

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
        // ALL campaign budget windows — daily, weekly, monthly AND total — pace on COMMITTED
        // spend = actual + provisioned (totalCostInUsdCents). Same committed-pacing decision as
        // the per-brand daily cap (block 3c): count reserved follow-up-send holds so the enforced
        // ceiling matches the dashboard's committed "Budget spent today" and a campaign stops
        // committing new work above its configured cap.
        //
        // The TOTAL window (autoStop:true) now also uses committed, by product-owner decision.
        // TRADEOFF (accepted): for the non-terminal windows the worst-case-LLM-hold over-block
        // (a ~26¢ reservation reconciles to ~0.7¢ then cancels) only causes a ~15min pause that
        // self-heals; for the TOTAL window the same inflated holds can trigger the TERMINAL
        // autoStop, so a temporary committed spike near the lifetime cap can stop a campaign for
        // good before the holds settle. That stop is recoverable (re-activating the campaign
        // resumes it), and the owner has chosen committed-pacing for the total cap for full
        // coherence with the dashboard over avoiding that edge.
        // Pace on NET committed spend (post-usage-discount) — what the org actually
        // PAYS, not list price. A discounted org must be allowed to run until its NET
        // spend hits the budget; pacing on gross stops it at (1−discount)×budget of real
        // spend (a 50%-off campaign halted at half its budget). netTotalCostInUsdCents is
        // runs-service's frozen per-row net (COALESCE(net, gross) for pre-freeze rows).
        // Fallback to gross only if an older runs-service omits the net twin — safe: it
        // over-counts → stops earlier, never overspends.
        const spentCents = windowResult
          ? parseFloat(windowResult.netTotalCostInUsdCents ?? windowResult.totalCostInUsdCents) || 0
          : 0;

        if (spentCents >= limitCents) {
          if (budgetLimit.autoStop) {
            await autoStopCampaign(campaign.campaignId);
            return { allowed: false, reason: "Total budget exceeded", autoStopped: true };
          }
          return { allowed: false, reason: `${budgetLimit.label} budget exceeded`, nextRunAt: budgetLimit.nextRunAt };
        }
      }
    }
  }

  // 3c. Daily budget pacing — ONLY for the sales feature. Two paths:
  //
  //   (a) The campaign has its OWN daily budget (dailyBudgetCents != null): pace THIS campaign
  //       on its OWN committed spend today (runs-service, campaignId + featureSlug keyed) vs
  //       that ceiling. Two campaigns under one brand each carry their own budget → one hitting
  //       its cap does NOT stop the other. Not a terminal stop: no nextRunAt, so internal.ts
  //       backs it off ~15min; the day rollover resets today's spend and re-opens the cap.
  //
  //   (b) No own budget (dailyBudgetCents == null): fall back to the BRAND daily budget
  //       (billing-service brand_daily_budgets), paced on the brand's committed spend today
  //       (brandId + featureSlug keyed) — byte-identical to the pre-per-campaign behaviour, so
  //       anything unset behaves exactly as before. This is also why NO deploy backfill is
  //       needed: an existing running campaign keeps null and its EFFECTIVE ceiling is the
  //       brand's CURRENT number, live-read here (never a stale copied value).
  //
  // Units: dailyBudgetCents (campaign + brand) and runs *CostInUsdCents are BOTH cents →
  // compared directly (NO ×100, unlike the maxBudget*Usd columns above which are USD).
  //
  // Read fail-CLOSED on the brand path: if the brand cap cannot be read or parsed, block this
  // tick. This is spend control, not an optimization; treating an unreadable cap as "unbounded"
  // lets campaigns keep spending past a configured ceiling. Explicit billing dailyBudgetCents
  // :null (and a null campaign budget with a null brand budget) remain the only unbounded signals.
  if (isSalesFeature) {
    if (campaign.dailyBudgetCents !== null) {
      // (a) Campaign's OWN daily budget vs its OWN committed spend today.
      const campaignSpend = await getStatsBudget({
        orgId: campaign.orgId,
        campaignId: campaign.campaignId,
        featureSlug: campaign.featureSlug,
        windows: [{ label: "today", since: startOfToday().toISOString() }],
      });
      const today = campaignSpend.windows.find(w => w.label === "today");
      // Pace on NET committed spend (post-usage-discount) — the same committed + net decision as
      // the brand daily cap below and the campaign budget windows (block 3): count reserved
      // follow-up-send holds and judge the ceiling on what the org actually PAYS, falling back to
      // gross only if an older runs-service omits the net twin (safe: over-counts → stops earlier).
      const spentCents = today
        ? parseFloat(today.netTotalCostInUsdCents ?? today.totalCostInUsdCents) || 0
        : 0;
      if (spentCents >= campaign.dailyBudgetCents) {
        return { allowed: false, reason: "Campaign daily budget reached" };
      }
    } else if (campaign.funnelKey) {
      // (a2) The campaign works ONE sales funnel: pace it on THAT funnel's own daily ceiling
      // (billing-service brand_funnel_budgets), not on the brand-level total. The brand total
      // is still exactly the SUM of those ceilings, so a brand funding two funnels has both
      // worked, neither exceeds its own ceiling, and the day's total cannot exceed the sum.
      //
      // The funnel's spend today IS this campaign's spend today: one campaign per funnel, and
      // the cost ledger is already keyed on campaignId — no per-funnel spend figure is invented
      // here. Read once (campaign-scoped), then compared against each in-scope brand's ceiling.
      const campaignSpend = await getStatsBudget({
        orgId: campaign.orgId,
        campaignId: campaign.campaignId,
        featureSlug: campaign.featureSlug,
        windows: [{ label: "today", since: startOfToday().toISOString() }],
      });
      const today = campaignSpend.windows.find(w => w.label === "today");
      const spentCents = today
        ? parseFloat(today.netTotalCostInUsdCents ?? today.totalCostInUsdCents) || 0
        : 0;

      for (const brandId of campaign.brandIds) {
        const budgets = await fetchFunnelBudgets(brandId, identity);
        // Fail-CLOSED, same stance as the brand ceiling below: an unreadable cap must never be
        // read as "unbounded".
        if (!budgets.ok) {
          return { allowed: false, reason: "Funnel daily budget unavailable" };
        }
        // This brand funds NO funnel separately. Every campaign states the funnel it runs so no
        // consumer has to infer it from a goal — but for a brand with one pot that statement is
        // a LABEL, not a ceiling: the money is still the brand-level daily budget, and this
        // campaign paces on it exactly as it did before it stated a funnel. Nothing about how a
        // FUNDED funnel's ceiling is enforced changes.
        if (budgets.funnels.length === 0) {
          const blocked = await brandDailyBudgetBlock(campaign, identity, brandId);
          if (blocked) return blocked;
          continue;
        }
        // Both sides are canonicalised — billing still names these funnels the pre-rename way and
        // a campaign row written before migration 0043 does too, so comparing raw tokens would
        // find no ceiling for a funnel that is fully funded and block it as unfunded.
        const funnelKey = toFunnelKey(campaign.funnelKey);

        // (a2') A funnel can be worked through two ACQUISITION CHANNELS at once — the straight
        // sales pitch and the feedback-request pitch — and each is funded separately. So the
        // ceiling that binds this campaign is its own (funnel, channel) pair's whenever billing
        // states one, never the funnel total: pacing both campaigns on the total is exactly how
        // one offer spends the money the other was funded for. A funnel billing states no pair for
        // falls through to the funnel figure below, which is every brand funding one channel per
        // funnel — unchanged.
        if (funnelKey) {
          const pair = channelCeilingCents(budgets, funnelKey, campaign.featureSlug);
          if (pair.grain === "pair") {
            // Funded through OTHER channels but not this one, or funded at zero: a deliberate
            // customer decision, so never a fallback to the funnel or brand total.
            if (pair.cents === null || pair.cents <= 0) {
              return { allowed: false, reason: "Funnel not funded for this channel" };
            }
            if (spentCents >= pair.cents) {
              return { allowed: false, reason: "Funnel daily budget reached" };
            }
            continue;
          }
        }

        const ceilingCents = funnelKey
          ? budgets.funnels.find(f => f.funnelKey === funnelKey)?.dailyBudgetCents ?? null
          : null;
        // A funnel funded at zero — or no longer funded at all — is never run. That is a
        // deliberate customer decision, not a missing value, so it is not a fallback to the
        // brand total: falling back would let an unfunded funnel spend another funnel's money.
        if (ceilingCents === null || ceilingCents <= 0) {
          return { allowed: false, reason: "Funnel not funded" };
        }
        if (spentCents >= ceilingCents) {
          return { allowed: false, reason: "Funnel daily budget reached" };
        }
      }
    } else {
      // (b) Fall back to the per-brand daily budget. Multi-brand tick: blocked if ANY in-scope
      // brand has reached its ceiling (most campaigns are solo-brand).
      for (const brandId of campaign.brandIds) {
        const blocked = await brandDailyBudgetBlock(campaign, identity, brandId);
        if (blocked) return blocked;
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
    // The completed-run count is a LIFETIME total, and it is the fallback for totalServed — so
    // it cannot be bounded by a recency window without letting a campaign run past its cap
    // forever. It CAN be bounded by the cap itself: the only thing done with the number is
    // `>= campaign.maxLeads`, so asking for at most maxLeads rows answers that question exactly.
    // Fewer than maxLeads rows come back → the count is exact; exactly maxLeads come back → the
    // cap is reached whatever the true total is. Same decision, bounded by a configured number
    // (1–5 in every campaign that ever set one) instead of by the campaign's whole history.
    //
    // runs-service exposes no per-campaign run COUNT, so this is the cheapest honest read of a
    // lifetime total from here. A counting endpoint there would make it a single scalar — filed
    // as a feature request rather than reconstructed locally.
    const { runs: completedRuns } = await listRuns({
      orgId: campaign.orgId,
      serviceName: "campaign-service",
      taskName: campaign.campaignId,
      status: "completed",
      limit: campaign.maxLeads,
    });
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
    // States WHY, so the resume sweep can tell this apart from a campaign that ran out of people
    // to contact. A lead cap is a limit the campaign reached, not one it can grow out of: it
    // never comes back on its own.
    .set({ status: "stopped", stopReason: STOP_REASONS.MAX_LEADS_REACHED, updatedAt: new Date() })
    .where(eq(campaigns.id, campaignId));
  console.log(`[campaign-service] Auto-stopped campaign ${campaignId} (max leads reached)`);
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
 * Returns the ceiling in CENTS, or null when billing explicitly stores no cap.
 *
 * Fail-CLOSED by design: missing config, network error, non-2xx, or unparseable values
 * return ok:false so the caller blocks the tick instead of spending past an unreadable cap.
 *
 * Contract: GET /internal/brands/{brandId}/daily-budget (x-api-key) ->
 *   { brandId, dailyBudgetCents: string|null, updatedAt: string|null }
 */
async function getBrandDailyBudget(brandId: string, identity: IdentityHeaders): Promise<BrandDailyBudgetRead> {
  const url = process.env.BILLING_SERVICE_URL;
  const apiKey = process.env.BILLING_SERVICE_API_KEY;
  if (!url || !apiKey) {
    return { ok: false };
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
      return { ok: false };
    }
    const data = await res.json() as { dailyBudgetCents?: string | null };
    if (data.dailyBudgetCents === null || data.dailyBudgetCents === undefined) {
      return { ok: true, dailyBudgetCents: null };
    }
    const cents = parseFloat(data.dailyBudgetCents);
    if (!Number.isFinite(cents)) {
      return { ok: false };
    }
    return { ok: true, dailyBudgetCents: cents };
  } catch {
    return { ok: false };
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

/**
 * The per-brand daily budget check, for a campaign that is not paced on a ceiling of its own.
 *
 * Returns the blocking result, or null when this brand does not stop the tick. Fail-CLOSED on an
 * unreadable cap: spend control must never read "cannot tell" as "unbounded".
 */
async function brandDailyBudgetBlock(
  campaign: GateCheckInput,
  identity: IdentityHeaders,
  brandId: string,
): Promise<GateCheckResult | null> {
  const dailyBudget = await getBrandDailyBudget(brandId, identity);
  if (!dailyBudget.ok) {
    return { allowed: false, reason: "Brand daily budget unavailable" };
  }

  const dailyBudgetCents = dailyBudget.dailyBudgetCents;
  // A budget nobody ever stated is NOT "no cap this tick" — it is nothing funded, and a campaign
  // the customer funds nothing for does not run. Reading it as unbounded is exactly how two
  // brands that fund nothing at all kept sending against no ceiling while 27 brands that DID
  // state a zero were held by a flag nobody could write. Funding is what makes a campaign
  // eligible; its absence cannot be the thing that removes the limit.
  //
  // Only ever reached for a sales-outreach campaign (this whole block is `if (isSalesFeature)`),
  // so no other feature family is held by it.
  if (dailyBudgetCents === null) {
    return { allowed: false, reason: "Brand not funded" };
  }
  if (dailyBudgetCents <= 0) {
    return { allowed: false, reason: "Brand not funded" };
  }

  const brandSpend = await getStatsBudget({
    orgId: campaign.orgId,
    brandId,
    featureSlug: campaign.featureSlug,
    windows: [{ label: "today", since: startOfToday().toISOString() }],
  });
  const today = brandSpend.windows.find(w => w.label === "today");
  // Pace on COMMITTED spend = actual + provisioned (the window's totalCostInUsdCents).
  // This DELIBERATELY REVERSES #223 ("pace on actual, not actual+provisioned") FOR THIS
  // per-brand daily cap ONLY. #223's concern was real: a provisioned row can be a worst-case
  // affordability RESERVATION (an LLM call reserves ~26¢, reconciles to ~0.7¢, then cancels
  // the hold), so counting open holds could block on phantom spend for ~15min until the day
  // rolls over. The product owner has weighed that tradeoff and accepted it: in practice the
  // bulk of the committed-minus-actual gap is genuine instantly-account-email-sent holds for
  // already-scheduled follow-up sends (real future spend), and the dashboard already shows
  // the brand's "Budget spent today" as this same committed number. Pacing the cap on
  // committed makes the enforced ceiling match what the customer sees and stops a campaign
  // from committing NEW work above the daily budget while reserved follow-up holds sit
  // uncounted. The worst-case-LLM-hold over-block is the accepted cost of that alignment.
  // checkAffordability below stays the hard money gate (org credit balance); this is daily
  // pacing. NOTE: the campaign budget WINDOWS (block 3 above) — daily, weekly, monthly AND
  // total — now ALL pace on committed too, for full coherence with the dashboard.
  // NET committed (post-usage-discount): the brand daily budget is what the org PAYS,
  // so pace on the net twin, not gross list price. A 50%-discounted brand must be able
  // to run until net spend reaches the daily cap; pacing on gross stopped it at half.
  // The dashboard "Budget spent today" reads features-service /revenue with pricing=net
  // for the same reason, keeping the enforced ceiling coherent with what the customer sees.
  // Fallback to gross only if an older runs-service omits the net twin (safe: stops earlier).
  const spentCents = today
    ? parseFloat(today.netTotalCostInUsdCents ?? today.totalCostInUsdCents) || 0
    : 0;

  if (spentCents >= dailyBudgetCents) {
    return { allowed: false, reason: "Brand daily budget reached" };
  }

  return null;
}
