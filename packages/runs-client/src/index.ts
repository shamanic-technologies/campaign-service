/**
 * HTTP client for runs-service
 * Centralized run tracking and cost management
 */

const RUNS_SERVICE_URL = process.env.RUNS_SERVICE_URL || "https://runs.distribute.you";
const RUNS_SERVICE_API_KEY = process.env.RUNS_SERVICE_API_KEY || "";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface Run {
  id: string;
  parentRunId: string | null;
  organizationId: string;
  userId: string | null;
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

/** Identity headers forwarded to runs-service on every request. */
export interface IdentityHeaders {
  orgId: string;
  userId?: string;
  runId?: string;
  campaignId?: string;
  brandId?: string;
  workflowSlug?: string;
  featureSlug?: string;
  /** Priority audience (human-service saved filter-set UUID) → x-audience-id header. */
  audienceId?: string;
}

export interface CreateRunParams {
  orgId: string;
  serviceName: string;
  taskName: string;
  userId?: string;
  brandId?: string;
  campaignId?: string;
  parentRunId?: string;
  workflowSlug?: string;
  featureSlug?: string;
  /** Priority audience (human-service saved filter-set UUID) → x-audience-id header. */
  audienceId?: string;
}

export interface ListRunsParams {
  orgId: string;
  userId?: string;
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
  orgId: string;
  campaignId?: string;
  brandId?: string;
  workflowSlug?: string;
  windows: BudgetWindow[];
}

export interface StatsBudgetResponse {
  windows: BudgetWindowResult[];
}

// ─── HTTP helpers ────────────────────────────────────────────────────────────

function buildIdentityHeaders(identity?: IdentityHeaders): Record<string, string> {
  const h: Record<string, string> = {};
  if (identity?.orgId) h["x-org-id"] = identity.orgId;
  if (identity?.userId) h["x-user-id"] = identity.userId;
  if (identity?.runId) h["x-run-id"] = identity.runId;
  if (identity?.campaignId) h["x-campaign-id"] = identity.campaignId;
  if (identity?.brandId) h["x-brand-id"] = identity.brandId;
  if (identity?.workflowSlug) h["x-workflow-slug"] = identity.workflowSlug;
  if (identity?.featureSlug) h["x-feature-slug"] = identity.featureSlug;
  if (identity?.audienceId) h["x-audience-id"] = identity.audienceId;
  return h;
}

async function runsRequest<T>(
  path: string,
  options: { method?: string; body?: unknown; identity?: IdentityHeaders } = {}
): Promise<T> {
  const { method = "GET", body, identity } = options;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-API-Key": RUNS_SERVICE_API_KEY,
    ...buildIdentityHeaders(identity),
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
 * orgId/userId are sent as x-org-id/x-user-id headers.
 * parentRunId is sent as x-run-id header.
 */
export async function createRun(params: CreateRunParams): Promise<Run> {
  const { orgId, userId, parentRunId, brandId, campaignId, workflowSlug, featureSlug, audienceId, ...body } = params;
  return runsRequest<Run>("/v1/runs", {
    method: "POST",
    body,
    identity: { orgId, userId, runId: parentRunId, brandId, campaignId, workflowSlug, featureSlug, audienceId },
  });
}

/**
 * Update run status (completed or failed).
 */
export async function updateRun(
  runId: string,
  status: "completed" | "failed",
  identity?: IdentityHeaders,
): Promise<Run> {
  return runsRequest<Run>(`/v1/runs/${runId}`, {
    method: "PATCH",
    body: { status },
    identity,
  });
}

/**
 * List runs with filters.
 * orgId is sent as x-org-id header (not query param).
 */
export async function listRuns(
  params: ListRunsParams
): Promise<{ runs: Run[]; limit: number; offset: number }> {
  const { orgId, ...rest } = params;
  const searchParams = new URLSearchParams();
  if (rest.userId) searchParams.set("userId", rest.userId);
  if (rest.brandId) searchParams.set("brandId", rest.brandId);
  if (rest.campaignId) searchParams.set("campaignId", rest.campaignId);
  if (rest.serviceName) searchParams.set("serviceName", rest.serviceName);
  if (rest.taskName) searchParams.set("taskName", rest.taskName);
  if (rest.status) searchParams.set("status", rest.status);
  if (rest.parentRunId) searchParams.set("parentRunId", rest.parentRunId);
  if (rest.startedAfter) searchParams.set("startedAfter", rest.startedAfter);
  if (rest.startedBefore) searchParams.set("startedBefore", rest.startedBefore);
  if (rest.limit) searchParams.set("limit", String(rest.limit));
  if (rest.offset) searchParams.set("offset", String(rest.offset));

  const qs = searchParams.toString();
  return runsRequest<{ runs: Run[]; limit: number; offset: number }>(
    qs ? `/v1/runs?${qs}` : "/v1/runs",
    { identity: { orgId } },
  );
}

/**
 * Get aggregated costs across temporal windows.
 * orgId is sent as x-org-id header (not in body).
 */
export async function getStatsBudget(params: StatsBudgetParams): Promise<StatsBudgetResponse> {
  const { orgId, ...body } = params;
  return runsRequest<StatsBudgetResponse>("/v1/stats/budget", {
    method: "POST",
    body,
    identity: { orgId },
  });
}
