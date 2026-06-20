import { Request, Response, NextFunction } from "express";

export interface AuthenticatedRequest extends Request {
  userId?: string;
  orgId?: string;
  runId?: string;
  campaignId?: string;
  brandIds?: string[];
  workflowSlug?: string;
  featureSlug?: string;
  activeGoalId?: string;
  brandProfileId?: string;
  audienceId?: string;
}

/** Parse the x-brand-id header as a comma-separated list of UUIDs. */
export function parseBrandIdHeader(raw: string | undefined): string[] {
  return String(raw ?? "").split(",").map(s => s.trim()).filter(Boolean);
}

/**
 * Service-to-service auth for internal calls (Railway private network)
 * Uses x-org-id header to identify org (client-service UUID)
 * Optionally uses x-user-id header to identify user (client-service UUID)
 */
export function serviceAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) {
  const orgId = req.headers["x-org-id"] as string;
  const userId = req.headers["x-user-id"] as string | undefined;
  const runId = req.headers["x-run-id"] as string | undefined;
  const featureSlug = req.headers["x-feature-slug"] as string | undefined;

  if (!orgId) {
    return res.status(400).json({ error: "x-org-id header required" });
  }

  req.orgId = orgId;
  if (userId) req.userId = userId;
  if (runId) req.runId = runId;
  if (featureSlug) req.featureSlug = featureSlug;

  next();
}

/**
 * Middleware to require org context
 */
export function requireOrg(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) {
  if (!req.orgId) {
    return res.status(400).json({ error: "Organization context required" });
  }
  next();
}

/**
 * Reads optional tracking headers injected by workflow-service:
 * x-org-id, x-user-id, x-run-id, x-campaign-id, x-brand-id,
 * x-workflow-slug, x-feature-slug.
 *
 * Does NOT overwrite values already set by serviceAuth.
 */
export function trackingHeaders(
  req: AuthenticatedRequest,
  _res: Response,
  next: NextFunction
) {
  const orgId = req.headers["x-org-id"] as string | undefined;
  const userId = req.headers["x-user-id"] as string | undefined;
  const runId = req.headers["x-run-id"] as string | undefined;
  const campaignId = req.headers["x-campaign-id"] as string | undefined;
  const brandIds = parseBrandIdHeader(req.headers["x-brand-id"] as string | undefined);
  const workflowSlug = req.headers["x-workflow-slug"] as string | undefined;
  const featureSlug = req.headers["x-feature-slug"] as string | undefined;
  const activeGoalId = req.headers["x-active-goal-id"] as string | undefined;
  const brandProfileId = req.headers["x-brand-profile-id"] as string | undefined;
  const audienceId = req.headers["x-audience-id"] as string | undefined;

  if (orgId && !req.orgId) req.orgId = orgId;
  if (userId && !req.userId) req.userId = userId;
  if (runId && !req.runId) req.runId = runId;
  if (campaignId) req.campaignId = campaignId;
  if (brandIds.length > 0) req.brandIds = brandIds;
  if (workflowSlug) req.workflowSlug = workflowSlug;
  if (featureSlug) req.featureSlug = featureSlug;
  if (activeGoalId) req.activeGoalId = activeGoalId;
  if (brandProfileId) req.brandProfileId = brandProfileId;
  if (audienceId) req.audienceId = audienceId;

  next();
}

/**
 * Require all pipeline headers (called by DAG nodes via workflow-service).
 * Workflow-service forwards all headers to every node — if any is missing,
 * it's a misconfiguration. Returns 400 with the list of missing headers.
 */
const REQUIRED_PIPELINE_HEADERS = [
  "x-org-id",
  "x-campaign-id",
  "x-user-id",
  "x-run-id",
  "x-workflow-slug",
  "x-feature-slug",
] as const;

export function requirePipelineHeaders(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  const missing = REQUIRED_PIPELINE_HEADERS.filter((h) => !req.headers[h]);
  if (missing.length > 0) {
    console.warn(`[campaign-service] 400 on ${req.path} — missing pipeline headers: ${missing.join(", ")}`);
    return res.status(400).json({
      error: `Missing required pipeline headers: ${missing.join(", ")}`,
    });
  }
  next();
}

/**
 * Middleware to verify CAMPAIGN_SERVICE_API_KEY for internal service-to-service calls
 * Checks x-api-key header against CAMPAIGN_SERVICE_API_KEY env var
 */
export function requireApiKey(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const apiKey = req.headers["x-api-key"] as string;
  const expectedKey = process.env.CAMPAIGN_SERVICE_API_KEY;

  if (!expectedKey) {
    console.error("[campaign-service] CAMPAIGN_SERVICE_API_KEY not configured");
    return res.status(500).json({ error: "API key not configured" });
  }

  if (!apiKey || apiKey !== expectedKey) {
    return res.status(401).json({ error: "Invalid or missing API key" });
  }

  next();
}
