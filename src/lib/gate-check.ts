import { listRuns, updateRun, getStatsBudget, type Run, type BudgetWindow } from "@mcpfactory/runs-client";
import { db } from "../db/index.js";
import { campaigns } from "../db/schema.js";
import { eq } from "drizzle-orm";

const STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes
const MAX_CONSECUTIVE_FAILURES = 3;

export interface GateCheckInput {
  campaignId: string;
  orgId: string;
  appId: string;
  brandId: string;
  status: string;
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
}

export async function runGateChecks(campaign: GateCheckInput): Promise<GateCheckResult> {
  // Campaign must be ongoing
  if (campaign.status !== "ongoing") {
    return { allowed: false, reason: "Campaign is not ongoing" };
  }

  // Fetch all runs for this campaign (needed for stale cleanup, running check, consecutive failures)
  const { runs } = await listRuns({
    orgId: campaign.orgId,
    appId: campaign.appId,
    serviceName: "campaign-service",
    taskName: campaign.campaignId,
  });

  // 1. Stale run cleanup — mark runs running > 30 min as failed
  const now = Date.now();
  for (const run of runs) {
    if (run.status === "running" && (now - new Date(run.startedAt).getTime()) > STALE_THRESHOLD_MS) {
      try {
        await updateRun(run.id, "failed");
        run.status = "failed"; // update in-memory
      } catch (err) {
        console.error(`[Gate Check] Failed to clean stale run ${run.id}:`, err);
      }
    }
  }

  // 2. Running run check — only 1 run at a time per campaign
  if (runs.some((r: Run) => r.status === "running")) {
    return { allowed: false, reason: "A run is already in progress" };
  }

  // 3. Budget check (fail-closed: no budget defined = blocked)
  const hasAnyBudget = campaign.maxBudgetDailyUsd || campaign.maxBudgetWeeklyUsd ||
                       campaign.maxBudgetMonthlyUsd || campaign.maxBudgetTotalUsd;
  if (!hasAnyBudget) {
    return { allowed: false, reason: "No budget defined (fail-closed)" };
  }

  // Build windows for configured budgets only
  const budgetLimits: Array<{ limit: string; label: string; autoStop: boolean }> = [];
  const windows: BudgetWindow[] = [];

  if (campaign.maxBudgetDailyUsd) {
    windows.push({ label: "daily", since: startOfToday().toISOString() });
    budgetLimits.push({ limit: campaign.maxBudgetDailyUsd, label: "daily", autoStop: false });
  }
  if (campaign.maxBudgetWeeklyUsd) {
    windows.push({ label: "weekly", since: daysAgo(7).toISOString() });
    budgetLimits.push({ limit: campaign.maxBudgetWeeklyUsd, label: "weekly", autoStop: false });
  }
  if (campaign.maxBudgetMonthlyUsd) {
    windows.push({ label: "monthly", since: startOfMonth().toISOString() });
    budgetLimits.push({ limit: campaign.maxBudgetMonthlyUsd, label: "monthly", autoStop: false });
  }
  if (campaign.maxBudgetTotalUsd) {
    windows.push({ label: "total" });
    budgetLimits.push({ limit: campaign.maxBudgetTotalUsd, label: "total", autoStop: true });
  }

  // Single call to runs-service for all budget windows
  const budgetResult = await getStatsBudget({
    orgId: campaign.orgId,
    appId: campaign.appId,
    campaignId: campaign.campaignId,
    windows,
  });

  for (const budgetLimit of budgetLimits) {
    const limitCents = parseFloat(budgetLimit.limit) * 100;
    const windowResult = budgetResult.windows.find(w => w.label === budgetLimit.label);
    const totalCostCents = windowResult ? parseFloat(windowResult.totalCostInUsdCents) || 0 : 0;

    if (totalCostCents >= limitCents) {
      if (budgetLimit.autoStop) {
        await autoStopCampaign(campaign.campaignId);
        return { allowed: false, reason: "Total budget exceeded", autoStopped: true };
      }
      return { allowed: false, reason: `${budgetLimit.label} budget exceeded` };
    }
  }

  // 4. Volume check
  if (campaign.maxLeads != null) {
    const completedRuns = runs.filter((r: Run) => r.status === "completed");
    let totalServed: number;
    try {
      const leadStats = await fetchLeadStats(campaign.orgId, campaign.campaignId, campaign.brandId, campaign.appId);
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

  // 5. Consecutive failures check
  const sortedRuns = [...runs].sort((a, b) =>
    new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
  );
  let consecutiveFailures = 0;
  for (const run of sortedRuns) {
    if (run.status === "failed") consecutiveFailures++;
    else break;
  }
  if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    await autoStopCampaign(campaign.campaignId);
    return { allowed: false, reason: `${MAX_CONSECUTIVE_FAILURES} consecutive failures`, autoStopped: true };
  }

  return { allowed: true };
}

async function autoStopCampaign(campaignId: string): Promise<void> {
  await db.update(campaigns)
    .set({ status: "stopped", updatedAt: new Date() })
    .where(eq(campaigns.id, campaignId));
  console.log(`[Campaign Service] Auto-stopped campaign ${campaignId}`);
}

async function fetchLeadStats(
  orgId: string,
  campaignId: string,
  brandId: string,
  appId: string,
): Promise<{ totalServed: number }> {
  const url = process.env.LEAD_SERVICE_URL;
  const apiKey = process.env.LEAD_SERVICE_API_KEY;
  if (!url || !apiKey) throw new Error("Lead service not configured");

  const params = new URLSearchParams({ brandId, campaignId });
  const res = await fetch(`${url}/stats?${params}`, {
    headers: {
      "x-api-key": apiKey,
      "x-app-id": appId,
      "x-org-id": orgId,
    },
  });

  if (!res.ok) {
    const err = new Error(`Lead stats failed: ${res.status}`) as Error & { status: number };
    err.status = res.status;
    throw err;
  }

  const data = await res.json() as Record<string, unknown>;
  return { totalServed: (data.totalServed as number) || (data.served as number) || 0 };
}

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
}

function startOfMonth(): Date {
  const d = new Date();
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d;
}
