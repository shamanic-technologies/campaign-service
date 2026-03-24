import { Request, Response, NextFunction } from "express";

export interface AuthenticatedRequest extends Request {
  userId?: string;
  orgId?: string;
  runId?: string;
  campaignId?: string;
  brandId?: string;
  workflowName?: string;
  featureSlug?: string;
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

  if (!orgId) {
    return res.status(400).json({ error: "x-org-id header required" });
  }

  req.orgId = orgId;
  if (userId) {
    req.userId = userId;
  }
  if (runId) {
    req.runId = runId;
  }

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
 * x-campaign-id, x-brand-id, x-workflow-name
 */
export function trackingHeaders(
  req: AuthenticatedRequest,
  _res: Response,
  next: NextFunction
) {
  const campaignId = req.headers["x-campaign-id"] as string | undefined;
  const brandId = req.headers["x-brand-id"] as string | undefined;
  const workflowName = req.headers["x-workflow-name"] as string | undefined;
  const featureSlug = req.headers["x-feature-slug"] as string | undefined;

  if (campaignId) req.campaignId = campaignId;
  if (brandId) req.brandId = brandId;
  if (workflowName) req.workflowName = workflowName;
  if (featureSlug) req.featureSlug = featureSlug;

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
    console.error("[Campaign Service] CAMPAIGN_SERVICE_API_KEY not configured");
    return res.status(500).json({ error: "API key not configured" });
  }

  if (!apiKey || apiKey !== expectedKey) {
    return res.status(401).json({ error: "Invalid or missing API key" });
  }

  next();
}
