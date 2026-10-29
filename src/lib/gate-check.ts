import { listRuns, updateRun, getStatsBudget, type Run, type BudgetWindow, type IdentityHeaders } from "@distribute/runs-client";
import { isSalesFamilyFeature } from "./sales-outreach-campaign.js";
import { RUN_LIVENESS_THRESHOLD_MS } from "./run-liveness.js";
import { salesFunnelUnitMoney, salesFunnelUnitRef } from "./sales-funnel-campaigns.js";
import { isPersonCarryingRun, personCarryingRunIds } from "./person-runs.js";

// THE definition of "a run is alive", shared with the scheduler's stuck sweep. It used to be three
// hours here against fifteen minutes there, and that gap is a full stop: the sweep re-fires a
// campaign whose run was orphaned while this block still reads that same row as running, so block 2
// refuses every one of those runs with "A run is already in progress" until the three hours are up.
// See run-liveness.ts for the prod incident.
const STALE_THRESHOLD_MS = RUN_LIVENESS_THRESHOLD_MS;

// How many of the campaign's running rows the gate reads. The invariant is ONE run in flight per
// campaign, and a row only stays `running` until its DAG ends or block 1 marks it stale, so this
// is orders of magnitude above what a healthy campaign holds. It exists so an unbounded history
// can never be pulled again — not as a tuning knob. Rows come back newest-first, so if a campaign
// ever exceeded it the newest still block the tick (the guard stays correct) and the oldest are
// cleaned on a later pass once the newer ones finish.
const RUNNING_RUNS_LIMIT = 200;

/**
 * The gate's refusal for a campaign that is not a SALES FUNNEL unit (owner 2026-10-14: one money
 * model, a campaign's money is its sales funnel's caps). Billing's per-campaign daily ceilings, the
 * campaign's own daily budget, items mode and the global pot are retired as money: never read here.
 */
export const NOT_A_SALES_FUNNEL_CAMPAIGN = "Not a sales funnel campaign";

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
  // Campaign budget windows, enforced only for a unit whose channel is outside the sales family.
  maxBudgetDailyUsd: string | null;
  maxBudgetWeeklyUsd: string | null;
  maxBudgetMonthlyUsd: string | null;
  maxBudgetTotalUsd: string | null;
  // The OFFER this campaign sells and the single LEG it was bought for — carried, never derived.
  offerId: string | null;
  legKey: string | null;
  // Set on a SALES FUNNEL unit (lib/sales-funnel-campaigns.ts): its money is its funnel's caps and
  // nothing else. Absent = not a unit = refused (NOT_A_SALES_FUNNEL_CAMPAIGN).
  salesFunnelCampaignId?: string | null;
  salesFunnelId?: string | null;
  maxLeads: number | null;
}

/**
 * What the credit pre-filter actually ANSWERED, as opposed to what the gate decided.
 *
 * `unreadable` is the fail-open path: billing could not be asked (unconfigured, non-2xx,
 * network throw) and the run was allowed anyway. It is reported so an incident can tell a
 * genuine authorization apart from a default-allow — the two used to be the same word.
 * Absent when the gate returned before block 3b ever ran.
 */
export type CreditCheckOutcome = "affordable" | "unaffordable" | "unreadable";

export interface GateCheckResult {
  allowed: boolean;
  reason?: string;
  // The figures behind a refusal, when the gate has them (today: the split budget parts).
  reasonDetail?: string;
  nextRunAt?: Date;
  creditCheck?: CreditCheckOutcome;
  // Why billing could not be read. Only set alongside `unreadable`.
  creditCheckDetail?: string;
}

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

  // 1. Stale run cleanup — finalize the campaign's orphaned runs (a DAG that died without ever
  // calling /end-run) so block 2 stops reading them as a live run.
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

  // 2. Running run check — only 1 run at a time per campaign, EXCEPT between runs that each carry ONE person
  // (lib/person-runs.ts): their exclusivity is that person, locked at dispatch, up to PERSON_RUNS_PER_CAMPAIGN_MAX
  // at once. Prod 2026-10-29 (ONE-AI-CONVERSES-1029-QUEUE): this block refused ~11 Lead event runs an hour per
  // campaign because another person's run was in flight; the refused DAG ended without /end-run, so each refusal
  // also held one of the 4 slots for the 15-min liveness window, and the queue drained at ~1 run at a time while
  // a person who had written to us waited hours.
  if (await blockedByAnotherRun(runningRuns, campaign.runId)) {
    return { allowed: false, reason: "A run is already in progress" };
  }

  // 2b. ONE money model (owner 2026-10-14): a campaign IS a sales funnel campaign, and what it may
  // spend is its sales funnel's caps (lib/sales-funnel-campaigns.ts), nothing else. A campaign that
  // is not a sales funnel unit has no money at all: refused by name, never paced on a retired
  // per-campaign ceiling, its own daily budget column or the brand total. Fail-CLOSED.
  if (!campaign.salesFunnelCampaignId) {
    return { allowed: false, reason: NOT_A_SALES_FUNNEL_CAMPAIGN };
  }
  const verdict = await salesFunnelUnitMoney(salesFunnelUnitRef({
    id: campaign.campaignId,
    orgId: campaign.orgId,
    brandId: campaign.brandIds[0] ?? (campaign.brandId || null),
    offerId: campaign.offerId,
    featureSlug: campaign.featureSlug ?? null,
    legKey: campaign.legKey,
    salesFunnelCampaignId: campaign.salesFunnelCampaignId,
    salesFunnelId: campaign.salesFunnelId ?? null,
  }));
  if (!verdict.run) {
    return { allowed: false, reason: verdict.reason, reasonDetail: verdict.detail, nextRunAt: verdict.nextRunAt };
  }

  // 3. Campaign budget windows — enforced for a unit whose channel is OUTSIDE the sales family (a
  // LinkedIn Posting pipe), on top of its funnel's caps, exactly as before: daily (today's spend,
  // resets at day rollover), weekly, monthly, and total.
  const isSalesFeature = isSalesFamilyFeature(campaign.featureSlug);

  if (!isSalesFeature) {
    const budgetLimits: Array<{ limit: string; label: string; nextRunAt?: Date }> = [];
    const windows: BudgetWindow[] = [];

    if (campaign.maxBudgetDailyUsd) {
      windows.push({ label: "daily", since: startOfToday().toISOString() });
      budgetLimits.push({ limit: campaign.maxBudgetDailyUsd, label: "daily", nextRunAt: nextDayStart() });
    }
    if (campaign.maxBudgetWeeklyUsd) {
      windows.push({ label: "weekly", since: daysAgo(7).toISOString() });
      budgetLimits.push({ limit: campaign.maxBudgetWeeklyUsd, label: "weekly", nextRunAt: nextWeekStart() });
    }
    if (campaign.maxBudgetMonthlyUsd) {
      windows.push({ label: "monthly", since: startOfMonth().toISOString() });
      budgetLimits.push({ limit: campaign.maxBudgetMonthlyUsd, label: "monthly", nextRunAt: nextMonthStart() });
    }
    if (campaign.maxBudgetTotalUsd) {
      windows.push({ label: "total" });
      budgetLimits.push({ limit: campaign.maxBudgetTotalUsd, label: "total" });
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
        // The TOTAL window uses committed too, by product-owner decision — and it is no longer
        // terminal, so the tradeoff that used to make that risky is gone: an inflated hold near
        // the lifetime cap now pauses the campaign until the holds settle instead of stopping it.
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
          // A configured ceiling reached is a SYSTEM CONDITION, and a system condition never
          // changes a campaign's status. The total window used to be terminal (`autoStop`); it
          // now blocks exactly like the daily, weekly and monthly ones — the campaign stays as the
          // customer left it, does not run this tick, and runs again on a later tick if the
          // condition has passed (a raised cap, a cancelled hold that settles below it).
          return { allowed: false, reason: `${budgetLimit.label} budget exceeded`, nextRunAt: budgetLimit.nextRunAt };
        }
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
  //
  // The fail-open ANSWER is carried out, because "billing said this org can pay" and
  // "billing could not be asked, so we let it through" are different facts that used to
  // reach the run trace as the same word (PASSED). During an incident that is the one
  // question worth answering about this gate, and the trace was unable to answer it.
  const credit = await readCreditAffordability(campaign.campaignId, identity);
  if (credit.readable && !credit.affordable) {
    return {
      allowed: false,
      reason: "Insufficient credits",
      nextRunAt: nextHalfHour(),
      creditCheck: "unaffordable",
    };
  }
  const creditCheck: CreditCheckOutcome = credit.readable ? "affordable" : "unreadable";
  const creditCheckDetail = credit.readable ? undefined : credit.detail;

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
        return { allowed: false, reason: "Lead stats unavailable (fail-closed)", creditCheck, creditCheckDetail };
      }
    }

    if (totalServed >= campaign.maxLeads) {
      // The lead cap is a system condition like any other: it blocks the RUN, never the campaign.
      // The customer raises the cap and the campaign runs again on a later tick, with nothing to
      // un-stop and no sweep to bring it back.
      return { allowed: false, reason: "Max leads reached", creditCheck, creditCheckDetail };
    }
  }

  return { allowed: true, creditCheck, creditCheckDetail };
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

type CreditAffordabilityRead =
  | { readable: true; affordable: boolean }
  | { readable: false; detail: string };

/**
 * Pre-flight credit affordability read against billing-service.
 *
 * Fail-OPEN by design: missing config, network error, non-2xx and an unparseable body all
 * come back `readable: false`, and the caller allows the run on every one of them. Credit
 * affordability is a PRE-FILTER, not the final gate — chat-service's own authorize is the
 * hard gate. A billing outage must never freeze every campaign.
 *
 * The one thing that changed is that the caller can now tell "billing said yes" from
 * "billing could not be asked". Both still run; only one of them is an authorization.
 */
async function readCreditAffordability(
  campaignId: string,
  identity: IdentityHeaders,
): Promise<CreditAffordabilityRead> {
  const url = process.env.BILLING_SERVICE_URL;
  const apiKey = process.env.BILLING_SERVICE_API_KEY;
  // Fail-open, and the reason travels with the answer. Nothing is logged here: every path
  // below is hit per gate check, i.e. per campaign per tick across every client, so a console
  // line would spam the fleet. The outcome rides the gate-check-result trace event that is
  // already emitted once per gate check — no new event, no new volume, and an incident can
  // finally read whether the gate authorized or merely could not ask.
  if (!url || !apiKey) {
    return { readable: false, detail: "billing not configured" };
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
      return { readable: false, detail: `billing responded ${res.status}` };
    }
    const data = await res.json() as { affordable?: boolean };
    // An answer with no `affordable` field is not an answer — billing served something this
    // service does not understand, so it is a read failure, not an authorization. The run is
    // still allowed (same fail-open behaviour as before), it is just no longer reported as a
    // billing authorization that never happened.
    if (typeof data.affordable !== "boolean") {
      return { readable: false, detail: "billing answered without an affordable field" };
    }
    return { readable: true, affordable: data.affordable };
  } catch (err) {
    return { readable: false, detail: err instanceof Error ? err.message : "billing call threw" };
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
 * Whether a running row of the campaign blocks this run (block 2). Rows of runs that carry ONE person never block a
 * run that itself carries one person; anything else (a population run on either side, an unreadable lookup) blocks
 * exactly as before.
 */
export async function blockedByAnotherRun(runningRuns: readonly Run[], runId: string | undefined): Promise<boolean> {
  const live = runningRuns.filter((r) => r.status === "running");
  if (live.length === 0) return false;
  if (!runId) return true;
  try {
    const parents = [...new Set(live.map((r) => r.parentRunId).filter((id): id is string => !!id && id !== runId))];
    const personRuns = await personCarryingRunIds(parents);
    const others = live.filter((r) => !(r.parentRunId && r.parentRunId !== runId && personRuns.has(r.parentRunId)));
    if (others.length > 0) return true;
    return !(await isPersonCarryingRun(runId));
  } catch (err) {
    console.error(`[campaign-service] gate-check could not read which running runs carry one person (run ${runId}); one run at a time applies:`, err);
    return true;
  }
}
