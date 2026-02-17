import { listRuns, updateRun, getRunsBatch, type Run } from "@mcpfactory/runs-client";
import { db } from "../db/index.js";
import { campaigns } from "../db/schema.js";
import { eq } from "drizzle-orm";

const APP_ID = "mcpfactory";
const STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes
const MAX_CONSECUTIVE_FAILURES = 3;

export interface GateCheckInput {
  campaignId: string;
  clerkOrgId: string;
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

  // Fetch all runs for this campaign
  const { runs } = await listRuns({
    clerkOrgId: campaign.clerkOrgId,
    appId: APP_ID,
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

  // Batch-fetch costs for completed/failed runs
  const finishedRuns = runs.filter((r: Run) => r.status === "completed" || r.status === "failed");
  const runsWithCosts = finishedRuns.length > 0
    ? await getRunsBatch(finishedRuns.map((r: Run) => r.id)).catch(() => new Map())
    : new Map();

  const budgetWindows: Array<{
    limit: string | null;
    since: Date | undefined;
    label: string;
    autoStop: boolean;
  }> = [
    { limit: campaign.maxBudgetDailyUsd, since: startOfToday(), label: "daily", autoStop: false },
    { limit: campaign.maxBudgetWeeklyUsd, since: daysAgo(7), label: "weekly", autoStop: false },
    { limit: campaign.maxBudgetMonthlyUsd, since: startOfMonth(), label: "monthly", autoStop: false },
    { limit: campaign.maxBudgetTotalUsd, since: undefined, label: "total", autoStop: true },
  ];

  for (const window of budgetWindows) {
    if (!window.limit) continue;
    const limitCents = parseFloat(window.limit) * 100;

    let totalCostCents = 0;
    for (const run of finishedRuns) {
      if (window.since && new Date(run.startedAt) < window.since) continue;
      const runWithCosts = runsWithCosts.get(run.id);
      if (runWithCosts) {
        totalCostCents += parseFloat(runWithCosts.totalCostInUsdCents) || 0;
      }
    }

    if (totalCostCents >= limitCents) {
      if (window.autoStop) {
        await autoStopCampaign(campaign.campaignId);
        return { allowed: false, reason: "Total budget exceeded", autoStopped: true };
      }
      return { allowed: false, reason: `${window.label} budget exceeded` };
    }
  }

  // 4. Volume check
  if (campaign.maxLeads != null) {
    let totalServed: number;
    try {
      const leadStats = await fetchLeadStats(campaign.clerkOrgId, campaign.campaignId, campaign.brandId);
      const completedCount = finishedRuns.filter((r: Run) => r.status === "completed").length;
      totalServed = Math.max(leadStats.totalServed, completedCount);
    } catch (err: unknown) {
      if (err instanceof Error && "status" in err && (err as { status: number }).status === 404) {
        totalServed = finishedRuns.filter((r: Run) => r.status === "completed").length;
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
  clerkOrgId: string,
  campaignId: string,
  brandId: string,
): Promise<{ totalServed: number }> {
  const url = process.env.LEAD_SERVICE_URL;
  const apiKey = process.env.LEAD_SERVICE_API_KEY;
  if (!url || !apiKey) throw new Error("Lead service not configured");

  const params = new URLSearchParams({ brandId, campaignId });
  const res = await fetch(`${url}/stats?${params}`, {
    headers: {
      "x-api-key": apiKey,
      "x-app-id": APP_ID,
      "x-org-id": clerkOrgId,
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
