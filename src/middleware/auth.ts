import { Request, Response, NextFunction } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { users, orgs } from "../db/schema.js";

// Re-export users for serviceAuth to use
export { users };

export interface AuthenticatedRequest extends Request {
  userId?: string;
  orgId?: string;
  externalUserId?: string;
  externalOrgId?: string;
}

/**
 * Service-to-service auth for internal calls (Railway private network)
 * Uses x-org-id header to identify org (client-service UUID)
 * Optionally uses x-user-id header to identify user (client-service UUID)
 */
export async function serviceAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) {
  try {
    const externalOrgId = req.headers["x-org-id"] as string;
    const externalUserId = req.headers["x-user-id"] as string | undefined;

    if (!externalOrgId) {
      return res.status(400).json({ error: "x-org-id header required" });
    }

    // Find or create org
    let org = await db.query.orgs.findFirst({
      where: eq(orgs.externalOrgId, externalOrgId),
    });

    if (!org) {
      const [newOrg] = await db
        .insert(orgs)
        .values({ externalOrgId })
        .returning();
      org = newOrg;
    }

    req.orgId = org.id;
    req.externalOrgId = externalOrgId;

    // Handle optional user context
    if (externalUserId) {
      let user = await db.query.users.findFirst({
        where: eq(users.externalUserId, externalUserId),
      });

      if (!user) {
        const [newUser] = await db
          .insert(users)
          .values({ externalUserId })
          .returning();
        user = newUser;
      }

      req.userId = user.id;
      req.externalUserId = externalUserId;
    }

    next();
  } catch (error) {
    console.error("[Campaign Service] Service auth error:", error);
    return res.status(401).json({ error: "Service authentication failed" });
  }
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
