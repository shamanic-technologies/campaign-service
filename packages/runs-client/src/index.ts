/**
 * HTTP client for runs-service
 * Centralized run tracking and cost management
 */

const RUNS_SERVICE_URL = process.env.RUNS_SERVICE_URL || "https://runs.mcpfactory.org";
const RUNS_SERVICE_API_KEY = process.env.RUNS_SERVICE_API_KEY || "";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface Run {
  id: string;
  parentRunId: string | null;
  organizationId: string;
  userId: string | null;
  appId: string;
  brandId: string | null;
  campaignId: string | null;
  serviceName: string;
  taskName: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateRunParams {
  clerkOrgId: string;
  appId: string;
  serviceName: string;
  taskName: string;
  clerkUserId?: string;
  brandId?: string;
  campaignId?: string;
  parentRunId?: string;
  workflowName?: string;
}

export interface ListRunsParams {
  clerkOrgId: string;
  clerkUserId?: string;
  appId?: string;
  brandId?: string;
  campaignId?: string;
  serviceName?: string;
  taskName?: string;
  status?: string;
  parentRunId?: string;
  startedAfter?: string;
  startedBefore?: string;
  limit?: number;
  offset?: number;
}

export interface BudgetWindow {
  label: string;
  since?: string;
}

export interface BudgetWindowResult {
  label: string;
  totalCostInUsdCents: string;
  actualCostInUsdCents: string;
  provisionedCostInUsdCents: string;
}

export interface StatsBudgetParams {
  clerkOrgId: string;
  appId: string;
  campaignId?: string;
  brandId?: string;
  workflowName?: string;
  windows: BudgetWindow[];
}

export interface StatsBudgetResponse {
  windows: BudgetWindowResult[];
}

// ─── HTTP helpers ────────────────────────────────────────────────────────────

async function runsRequest<T>(
  path: string,
  options: { method?: string; body?: unknown } = {}
): Promise<T> {
  const { method = "GET", body } = options;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-API-Key": RUNS_SERVICE_API_KEY,
  };

  const response = await fetch(`${RUNS_SERVICE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`runs-service ${method} ${path} failed: ${response.status} - ${errorText}`);
  }

  return response.json() as Promise<T>;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Create a new run in runs-service.
 */
export async function createRun(params: CreateRunParams): Promise<Run> {
  return runsRequest<Run>("/v1/runs", {
    method: "POST",
    body: params,
  });
}

/**
 * Update run status (completed or failed).
 */
export async function updateRun(
  runId: string,
  status: "completed" | "failed"
): Promise<Run> {
  return runsRequest<Run>(`/v1/runs/${runId}`, {
    method: "PATCH",
    body: { status },
  });
}

/**
 * List runs with filters.
 */
export async function listRuns(
  params: ListRunsParams
): Promise<{ runs: Run[]; limit: number; offset: number }> {
  const searchParams = new URLSearchParams();
  searchParams.set("clerkOrgId", params.clerkOrgId);
  if (params.clerkUserId) searchParams.set("clerkUserId", params.clerkUserId);
  if (params.appId) searchParams.set("appId", params.appId);
  if (params.brandId) searchParams.set("brandId", params.brandId);
  if (params.campaignId) searchParams.set("campaignId", params.campaignId);
  if (params.serviceName) searchParams.set("serviceName", params.serviceName);
  if (params.taskName) searchParams.set("taskName", params.taskName);
  if (params.status) searchParams.set("status", params.status);
  if (params.parentRunId) searchParams.set("parentRunId", params.parentRunId);
  if (params.startedAfter) searchParams.set("startedAfter", params.startedAfter);
  if (params.startedBefore) searchParams.set("startedBefore", params.startedBefore);
  if (params.limit) searchParams.set("limit", String(params.limit));
  if (params.offset) searchParams.set("offset", String(params.offset));

  return runsRequest<{ runs: Run[]; limit: number; offset: number }>(
    `/v1/runs?${searchParams.toString()}`
  );
}

/**
 * Get aggregated costs across temporal windows.
 * Used for budget checks — returns actual + provisioned costs per window.
 */
export async function getStatsBudget(params: StatsBudgetParams): Promise<StatsBudgetResponse> {
  return runsRequest<StatsBudgetResponse>("/v1/stats/budget", {
    method: "POST",
    body: params,
  });
}
