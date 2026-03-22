import { Router } from "express";
import { eq, and, count } from "drizzle-orm";
import { db } from "../db/index.js";
import { campaigns, discoveredOutlets, discoveredJournalists } from "../db/schema.js";
import { requireApiKey, serviceAuth, type AuthenticatedRequest } from "../middleware/auth.js";
import { validateBody, validateQuery } from "../middleware/validate.js";
import {
  CreateDiscoveredOutletsBody,
  CreateDiscoveredJournalistsBody,
  PaginationQuery,
} from "../schemas.js";

const router = Router();

// === Discovered Outlets ===

/**
 * POST /campaigns/:id/discovered-outlets
 * Called by workflow-service to store discovery results
 */
router.post(
  "/campaigns/:id/discovered-outlets",
  requireApiKey,
  serviceAuth,
  validateBody(CreateDiscoveredOutletsBody),
  async (req: AuthenticatedRequest, res) => {
    try {
      const { id } = req.params;
      const { outlets } = req.body;

      const campaign = await db.query.campaigns.findFirst({
        where: and(eq(campaigns.id, id), eq(campaigns.orgId, req.orgId!)),
      });
      if (!campaign) {
        return res.status(404).json({ error: "Campaign not found" });
      }

      const inserted = await db
        .insert(discoveredOutlets)
        .values(
          outlets.map((o: typeof outlets[number]) => ({
            campaignId: id,
            name: o.name,
            type: o.type ?? null,
            url: o.url ?? null,
            domainRating: o.domainRating != null ? String(o.domainRating) : null,
            monthlyTraffic: o.monthlyTraffic ?? null,
            topics: o.topics ?? [],
            country: o.country ?? null,
            language: o.language ?? null,
            contactEmail: o.contactEmail ?? null,
            notes: o.notes ?? null,
          }))
        )
        .returning();

      res.status(201).json({ outlets: inserted.map(formatOutlet) });
    } catch (error) {
      console.error("[Discovery] Create outlets error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

/**
 * GET /campaigns/:id/discovered-outlets
 * Returns paginated list of discovered outlets for a campaign
 */
router.get(
  "/campaigns/:id/discovered-outlets",
  requireApiKey,
  serviceAuth,
  validateQuery(PaginationQuery),
  async (req: AuthenticatedRequest, res) => {
    try {
      const { id } = req.params;
      const { limit, offset } = PaginationQuery.parse(req.query);

      const campaign = await db.query.campaigns.findFirst({
        where: and(eq(campaigns.id, id), eq(campaigns.orgId, req.orgId!)),
      });
      if (!campaign) {
        return res.status(404).json({ error: "Campaign not found" });
      }

      const [rows, [{ total }]] = await Promise.all([
        db
          .select()
          .from(discoveredOutlets)
          .where(eq(discoveredOutlets.campaignId, id))
          .limit(limit)
          .offset(offset)
          .orderBy(discoveredOutlets.createdAt),
        db
          .select({ total: count() })
          .from(discoveredOutlets)
          .where(eq(discoveredOutlets.campaignId, id)),
      ]);

      res.json({
        outlets: rows.map(formatOutlet),
        pagination: { total, limit, offset },
      });
    } catch (error) {
      console.error("[Discovery] List outlets error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// === Discovered Journalists ===

/**
 * POST /campaigns/:id/discovered-journalists
 * Called by workflow-service to store discovery results
 */
router.post(
  "/campaigns/:id/discovered-journalists",
  requireApiKey,
  serviceAuth,
  validateBody(CreateDiscoveredJournalistsBody),
  async (req: AuthenticatedRequest, res) => {
    try {
      const { id } = req.params;
      const { journalists } = req.body;

      const campaign = await db.query.campaigns.findFirst({
        where: and(eq(campaigns.id, id), eq(campaigns.orgId, req.orgId!)),
      });
      if (!campaign) {
        return res.status(404).json({ error: "Campaign not found" });
      }

      const inserted = await db
        .insert(discoveredJournalists)
        .values(
          journalists.map((j: typeof journalists[number]) => ({
            campaignId: id,
            firstName: j.firstName ?? null,
            lastName: j.lastName ?? null,
            email: j.email ?? null,
            outletName: j.outletName ?? null,
            title: j.title ?? null,
            beat: j.beat ?? null,
            linkedinUrl: j.linkedinUrl ?? null,
            twitterHandle: j.twitterHandle ?? null,
            location: j.location ?? null,
            domainRating: j.domainRating != null ? String(j.domainRating) : null,
            notes: j.notes ?? null,
          }))
        )
        .returning();

      res.status(201).json({ journalists: inserted.map(formatJournalist) });
    } catch (error) {
      console.error("[Discovery] Create journalists error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

/**
 * GET /campaigns/:id/discovered-journalists
 * Returns paginated list of discovered journalists for a campaign
 */
router.get(
  "/campaigns/:id/discovered-journalists",
  requireApiKey,
  serviceAuth,
  validateQuery(PaginationQuery),
  async (req: AuthenticatedRequest, res) => {
    try {
      const { id } = req.params;
      const { limit, offset } = PaginationQuery.parse(req.query);

      const campaign = await db.query.campaigns.findFirst({
        where: and(eq(campaigns.id, id), eq(campaigns.orgId, req.orgId!)),
      });
      if (!campaign) {
        return res.status(404).json({ error: "Campaign not found" });
      }

      const [rows, [{ total }]] = await Promise.all([
        db
          .select()
          .from(discoveredJournalists)
          .where(eq(discoveredJournalists.campaignId, id))
          .limit(limit)
          .offset(offset)
          .orderBy(discoveredJournalists.createdAt),
        db
          .select({ total: count() })
          .from(discoveredJournalists)
          .where(eq(discoveredJournalists.campaignId, id)),
      ]);

      res.json({
        journalists: rows.map(formatJournalist),
        pagination: { total, limit, offset },
      });
    } catch (error) {
      console.error("[Discovery] List journalists error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// === Formatters ===

function formatOutlet(row: typeof discoveredOutlets.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    url: row.url,
    domainRating: row.domainRating ? parseFloat(row.domainRating) : null,
    monthlyTraffic: row.monthlyTraffic,
    topics: row.topics,
    country: row.country,
    language: row.language,
    contactEmail: row.contactEmail,
    notes: row.notes,
    createdAt: row.createdAt.toISOString(),
  };
}

function formatJournalist(row: typeof discoveredJournalists.$inferSelect) {
  return {
    id: row.id,
    firstName: row.firstName,
    lastName: row.lastName,
    email: row.email,
    outletName: row.outletName,
    title: row.title,
    beat: row.beat,
    linkedinUrl: row.linkedinUrl,
    twitterHandle: row.twitterHandle,
    location: row.location,
    domainRating: row.domainRating ? parseFloat(row.domainRating) : null,
    notes: row.notes,
    createdAt: row.createdAt.toISOString(),
  };
}

export default router;
