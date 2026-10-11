import { Router } from "express";
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { campaigns, salesFunnelCampaigns, type SalesFunnelCampaign } from "../db/schema.js";
import { serviceAuth, requireApiKey, type AuthenticatedRequest } from "../middleware/auth.js";
import { validateBody, validateQuery } from "../middleware/validate.js";
import {
  CreateSalesFunnelCampaignBody,
  SalesFunnelCampaignsQuery,
  UpdateSalesFunnelCampaignBody,
} from "../schemas.js";
import { paymentStartRefusal } from "../lib/payment-hold.js";
import { STOP_REASONS } from "../lib/stop-reason.js";
import {
  insertSalesFunnelCampaignWithUnits,
  setSalesFunnelCampaignStatus,
  type OnUnitStarted,
} from "../lib/campaign-status-history.js";
import { resolveSalesFunnelPlan, sourcingPipeWorkflow } from "../lib/startable-pair.js";
import { acquisitionChannelForFeature, derivedCampaignName } from "../lib/campaign-identity.js";
import { ensureSourcesOnStart } from "../lib/source-campaign-store.js";
import { serializeSalesFunnelCampaign } from "../lib/sales-funnel-campaigns.js";
import { wakeScheduler } from "../lib/scheduler.js";
import { convertToSalesFunnelCampaigns } from "../lib/sales-funnel-conversion.js";
import { completeSalesFunnelUnits } from "../lib/sales-funnel-unit-completion.js";
import { runLeadSourcingSwitch } from "../lib/sales-funnel-lead-sourcing-switch.js";
import { canonicalEmail, namedPeople, peopleKeyOf } from "../lib/sales-funnel-people.js";

/**
 * SALES FUNNEL CAMPAIGNS (owner 2026-10-10, lib/sales-funnel-campaigns.ts).
 *
 * A campaign is brand x offer x SALES FUNNEL; it owns one unit (a `campaigns` row) per pipe of the
 * funnel, and the units run independently, exactly as campaigns always have. Run, pause and stop
 * exist ONLY here, at the funnel: a unit's own status is refused on PATCH /campaigns/:id.
 */
const router = Router();

type CampaignRow = typeof campaigns.$inferSelect;

/** What a person's start brings with a unit: the offer's lead sources (lib/source-campaign-store.ts). */
const ensureUnitSources: OnUnitStarted = async (tx, unit) => {
  await ensureSourcesOnStart(tx, unit);
};

async function unitsOf(parentIds: string[], orgId: string): Promise<Map<string, CampaignRow[]>> {
  const byParent = new Map<string, CampaignRow[]>(parentIds.map((id) => [id, []]));
  if (parentIds.length === 0) return byParent;
  const rows = await db
    .select()
    .from(campaigns)
    .where(and(eq(campaigns.orgId, orgId), inArray(campaigns.salesFunnelCampaignId, parentIds)))
    .orderBy(asc(campaigns.createdAt), asc(campaigns.id));
  for (const row of rows) byParent.get(row.salesFunnelCampaignId!)?.push(row);
  return byParent;
}

function missingPersonHeaders(req: AuthenticatedRequest): string[] {
  return [!req.userId ? "x-user-id" : null, !req.runId ? "x-run-id" : null].filter((h): h is string => !!h);
}

/**
 * POST /sales-funnel-campaigns — launch a sales funnel as ONE campaign (a person's act, or the
 * agent acting for one). `status` is REQUIRED: "stopped" creates it switched off.
 *
 * A funnel campaign that EXISTS is never created again (owner rule 2): the identity's row is handed
 * back whatever its status, started when the caller asked for "ongoing", untouched otherwise.
 */
router.post(
  "/sales-funnel-campaigns",
  requireApiKey,
  serviceAuth,
  validateBody(CreateSalesFunnelCampaignBody),
  async (req: AuthenticatedRequest, res) => {
    try {
      const { brandId, offerId, salesFunnelId, status, people: namedInput, instruction } =
        CreateSalesFunnelCampaignBody.parse(req.body);
      // A campaign that NAMES its people (lib/sales-funnel-people.ts): its people are part of its identity.
      const people = namedInput ? namedPeople(namedInput) : null;
      const peopleKey = peopleKeyOf(people);
      const missing = missingPersonHeaders(req);
      if (missing.length > 0) {
        return res.status(400).json({ error: `Cannot launch a sales funnel — missing required headers: ${missing.join(", ")}` });
      }
      const orgId = req.orgId!;

      const findIncumbent = () =>
        db.query.salesFunnelCampaigns.findFirst({
          where: and(
            eq(salesFunnelCampaigns.orgId, orgId),
            eq(salesFunnelCampaigns.brandId, brandId),
            eq(salesFunnelCampaigns.offerId, offerId),
            eq(salesFunnelCampaigns.salesFunnelId, salesFunnelId),
            eq(salesFunnelCampaigns.peopleKey, peopleKey),
          ),
        });

      let incumbent = await findIncumbent();
      // Handed back with the instruction the caller states now (a stated instruction is the caller's
      // words for what its runs should say; absent = untouched).
      if (incumbent && instruction !== undefined && instruction !== incumbent.instruction) {
        [incumbent] = await db
          .update(salesFunnelCampaigns)
          .set({ instruction, updatedAt: new Date() })
          .where(eq(salesFunnelCampaigns.id, incumbent.id))
          .returning();
      }
      if (incumbent) {
        if (status === "ongoing" && incumbent.status !== "ongoing") {
          const refusal = await paymentStartRefusal(orgId);
          if (refusal) return res.status(refusal.status).json(refusal.body);
          const started = await setSalesFunnelCampaignStatus({
            salesFunnelCampaignId: incumbent.id,
            orgId,
            toStatus: "ongoing",
            reason: null,
            onUnitStarted: ensureUnitSources,
          });
          wakeScheduler();
          return res.status(200).json({
            salesFunnelCampaign: serializeSalesFunnelCampaign(started!.salesFunnelCampaign, started!.units),
            created: false,
            started: true,
          });
        }
        const units = (await unitsOf([incumbent.id], orgId)).get(incumbent.id)!;
        return res.status(200).json({
          salesFunnelCampaign: serializeSalesFunnelCampaign(incumbent, units),
          created: false,
          started: false,
        });
      }

      // Every launch that ends ONGOING meets the payment hold first, like every start.
      if (status === "ongoing") {
        const refusal = await paymentStartRefusal(orgId);
        if (refusal) return res.status(refusal.status).json(refusal.body);
      }

      const resolved = await resolveSalesFunnelPlan(salesFunnelId, {
        orgId,
        userId: req.userId!,
        runId: req.runId!,
        brandId,
      });
      if (!resolved.ok) {
        const { status: httpStatus, code, message } = resolved.refusal;
        console.warn(
          `[campaign-service] Not launching sales funnel ${salesFunnelId} — org=${orgId} brand=${brandId} offer=${offerId}: ${code}`,
        );
        return res.status(httpStatus).json({ error: message, reason: code });
      }
      const { plan } = resolved;
      // A campaign naming its people only ANSWERS events for them: a pipe that prospects (an entry or
      // sourcing pipe) would act on strangers, so such a funnel is refused, naming the pipe.
      if (people) {
        const prospecting = plan.units.filter((u) => u.mode !== "reactive");
        if (prospecting.length > 0) {
          return res.status(400).json({
            error: `A campaign that names its people only answers triggers, but this sales funnel also finds new people (${prospecting.map((u) => u.pipeId).join(", ")}).`,
            reason: "people_need_reactive_funnel",
          });
        }
      }

      const id = randomUUID();
      const idTag = id.slice(0, 8);
      let born;
      try {
        born = await insertSalesFunnelCampaignWithUnits({
          id,
          orgId,
          brandId,
          offerId,
          salesFunnelId,
          salesFunnelName: plan.salesFunnelName,
          status,
          createdByUserId: req.userId!,
          parentRunId: req.runId!,
          people,
          peopleKey,
          instruction: instruction ?? null,
          units: plan.units.map((u) => ({
            featureSlug: u.featureSlug,
            legKey: u.legKey,
            workflowSlug: u.workflowSlug,
            acquisitionChannel: acquisitionChannelForFeature(u.featureSlug)!,
            // Names are unique per org; the funnel campaign's id keeps two funnels sharing a pipe apart.
            name: `${plan.salesFunnelName} ${idTag} - ${derivedCampaignName(u.featureSlug, brandId, offerId, u.legKey)}`,
          })),
          onUnitStarted: ensureUnitSources,
        });
      } catch (error: any) {
        // Two launches raced the same identity: the winner IS this funnel campaign.
        const constraint = error?.constraint ?? error?.constraint_name;
        if (error?.code === "23505" && constraint === "uniq_sales_funnel_campaigns_identity") {
          const winner = await findIncumbent();
          if (winner) {
            const units = (await unitsOf([winner.id], orgId)).get(winner.id)!;
            return res.status(200).json({
              salesFunnelCampaign: serializeSalesFunnelCampaign(winner, units),
              created: false,
              started: false,
            });
          }
        }
        throw error;
      }

      console.log(
        `[campaign-service] Sales funnel campaign ${born.salesFunnelCampaign.id} (${plan.salesFunnelName}) born ${status} — org=${orgId} brand=${brandId} offer=${offerId}, units ${born.units.map((u) => u.id).join(", ")}`,
      );
      if (status === "ongoing") wakeScheduler();
      return res.status(201).json({
        salesFunnelCampaign: serializeSalesFunnelCampaign(born.salesFunnelCampaign, born.units),
        created: true,
        started: status === "ongoing",
      });
    } catch (error) {
      console.error("[campaign-service] Launch sales funnel error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

/** GET /sales-funnel-campaigns — the org's funnel campaigns, each with its units. */
router.get(
  "/sales-funnel-campaigns",
  requireApiKey,
  serviceAuth,
  validateQuery(SalesFunnelCampaignsQuery),
  async (req: AuthenticatedRequest, res) => {
    try {
      const { brandId, offerId, salesFunnelId, status, personEmail } = SalesFunnelCampaignsQuery.parse(req.query);
      const orgId = req.orgId!;
      const conditions = [eq(salesFunnelCampaigns.orgId, orgId)];
      if (personEmail) {
        conditions.push(
          sql`${salesFunnelCampaigns.people} @> ${JSON.stringify([{ email: canonicalEmail(personEmail) }])}::jsonb`,
        );
      }
      if (brandId) conditions.push(eq(salesFunnelCampaigns.brandId, brandId));
      if (offerId) conditions.push(eq(salesFunnelCampaigns.offerId, offerId));
      if (salesFunnelId) conditions.push(eq(salesFunnelCampaigns.salesFunnelId, salesFunnelId));
      if (status) conditions.push(eq(salesFunnelCampaigns.status, status));
      const rows: SalesFunnelCampaign[] = await db
        .select()
        .from(salesFunnelCampaigns)
        .where(and(...conditions))
        .orderBy(desc(salesFunnelCampaigns.createdAt));
      const units = await unitsOf(rows.map((r) => r.id), orgId);
      res.json({ salesFunnelCampaigns: rows.map((r) => serializeSalesFunnelCampaign(r, units.get(r.id)!)) });
    } catch (error) {
      console.error("[campaign-service] List sales funnel campaigns error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

/** GET /sales-funnel-campaigns/:id — one funnel campaign with its units. */
router.get("/sales-funnel-campaigns/:id", requireApiKey, serviceAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const orgId = req.orgId!;
    const parent = await db.query.salesFunnelCampaigns.findFirst({
      where: and(eq(salesFunnelCampaigns.id, req.params.id), eq(salesFunnelCampaigns.orgId, orgId)),
    });
    if (!parent) return res.status(404).json({ error: "Sales funnel campaign not found" });
    const units = (await unitsOf([parent.id], orgId)).get(parent.id)!;
    res.json({ salesFunnelCampaign: serializeSalesFunnelCampaign(parent, units) });
  } catch (error) {
    console.error("[campaign-service] Get sales funnel campaign error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * PATCH /sales-funnel-campaigns/:id {status: activate|stop} — run or pause the WHOLE funnel. Every
 * unit moves with it in one transaction. Stopping stops NEW first touches only: follow-ups of leads
 * already contacted keep going out (the sending side's rule, unchanged).
 */
router.patch(
  "/sales-funnel-campaigns/:id",
  requireApiKey,
  serviceAuth,
  validateBody(UpdateSalesFunnelCampaignBody),
  async (req: AuthenticatedRequest, res) => {
    try {
      const { status, instruction } = UpdateSalesFunnelCampaignBody.parse(req.body);
      const orgId = req.orgId!;
      const existing = await db.query.salesFunnelCampaigns.findFirst({
        where: and(eq(salesFunnelCampaigns.id, req.params.id), eq(salesFunnelCampaigns.orgId, orgId)),
      });
      if (!existing) return res.status(404).json({ error: "Sales funnel campaign not found" });

      // Reword (or clear) the instruction its runs carry. Read by every run at /start-run, so the next
      // message follows the new words. Status untouched unless stated too.
      if (status === undefined) {
        const [reworded] = await db
          .update(salesFunnelCampaigns)
          .set({ instruction: instruction ?? null, updatedAt: new Date() })
          .where(and(eq(salesFunnelCampaigns.id, existing.id), eq(salesFunnelCampaigns.orgId, orgId)))
          .returning();
        const units = (await unitsOf([reworded.id], orgId)).get(reworded.id)!;
        return res.json({ salesFunnelCampaign: serializeSalesFunnelCampaign(reworded, units) });
      }

      if (status === "activate") {
        const missing = missingPersonHeaders(req);
        if (missing.length > 0) {
          return res.status(400).json({ error: `Cannot run a sales funnel — missing required headers: ${missing.join(", ")}` });
        }
        const refusal = await paymentStartRefusal(orgId);
        if (refusal) return res.status(refusal.status).json(refusal.body);
      }

      const written = await setSalesFunnelCampaignStatus({
        salesFunnelCampaignId: existing.id,
        orgId,
        toStatus: status === "activate" ? "ongoing" : "stopped",
        reason: status === "stop" ? STOP_REASONS.MANUAL : null,
        ...(status === "activate" ? { onUnitStarted: ensureUnitSources } : {}),
      });
      if (!written) return res.status(404).json({ error: "Sales funnel campaign not found" });
      let parent = written.salesFunnelCampaign;
      if (instruction !== undefined) {
        [parent] = await db
          .update(salesFunnelCampaigns)
          .set({ instruction: instruction ?? null, updatedAt: new Date() })
          .where(and(eq(salesFunnelCampaigns.id, existing.id), eq(salesFunnelCampaigns.orgId, orgId)))
          .returning();
      }
      if (status === "activate") wakeScheduler();
      res.json({ salesFunnelCampaign: serializeSalesFunnelCampaign(parent, written.units) });
    } catch (error) {
      console.error("[campaign-service] Update sales funnel campaign error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

/**
 * POST /internal/sales-funnel-campaigns/convert {apply?, orgId?} — turn the live (leg x channel)
 * campaigns into sales funnel campaigns (owner GO 2026-10-10, lib/sales-funnel-conversion.ts). Dry
 * run unless `apply: true`; idempotent (a row already a unit is not a candidate). `x-email` (the
 * person who ordered it) rides billing's writes so staff budget emails know whose act it was.
 */
router.post("/internal/sales-funnel-campaigns/convert", requireApiKey, async (req, res) => {
  try {
    const apply = req.body?.apply === true;
    const orgId = typeof req.body?.orgId === "string" ? req.body.orgId : undefined;
    const brandId = typeof req.body?.brandId === "string" ? req.body.brandId : undefined;
    const actingEmail = (req.headers["x-email"] as string | undefined) ?? null;
    res.json(await convertToSalesFunnelCampaigns({
      apply, orgId, brandId, actingEmail,
      includeUnfundedReactive: req.body?.includeUnfundedReactive === true,
      allowOfferLessCeilings: req.body?.allowOfferLessCeilings === true,
    }));
  } catch (error) {
    console.error("[campaign-service] Sales funnel conversion error:", error);
    res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

/**
 * POST /internal/sales-funnel-campaigns/lead-sourcing-switch {apply?, orgId?} — the owner's Lead Sourcing switch
 * (2026-10-11, lib/lead-sourcing-switch.ts): a funnel campaign running several sources gets ONE Lead Sourcing unit
 * (the old source units stopped, same transaction); a single-source one stored under a legacy id is re-spelled to
 * name its source; every ON source unit takes its pipe's workflow. Dry run unless `apply: true`; idempotent.
 * Requires a REAL staff identity (x-org-id, x-user-id, x-run-id): the workflow read is workflow-service's.
 */
router.post("/internal/sales-funnel-campaigns/lead-sourcing-switch", requireApiKey, async (req, res) => {
  const orgId = req.headers["x-org-id"];
  const userId = req.headers["x-user-id"];
  const runId = req.headers["x-run-id"];
  if (typeof orgId !== "string" || typeof userId !== "string" || typeof runId !== "string" || !orgId || !userId || !runId) {
    return res.status(400).json({ error: "x-org-id, x-user-id and x-run-id are required (a real staff run): the workflow read is workflow-service's" });
  }
  try {
    const identity = { orgId, userId, runId };
    const result = await runLeadSourcingSwitch({
      apply: req.body?.apply === true,
      orgId: typeof req.body?.orgId === "string" ? req.body.orgId : undefined,
      workflowOf: (slug) => sourcingPipeWorkflow(slug, identity),
    });
    res.json(result);
  } catch (error) {
    console.error("[campaign-service] Lead Sourcing switch error:", error);
    res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

/**
 * POST /internal/sales-funnel-campaigns/complete-units {apply?, orgId?} — give every funnel campaign
 * a unit on each "Your team" leg of its funnel (owner 2026-10-11: a funnel never has a leg without
 * a channel; lib/sales-funnel-unit-completion.ts). Dry run unless `apply: true`; idempotent. Lists
 * what it cannot fix (a platform pipe without a unit, a catalogue leg naming no channel).
 */
router.post("/internal/sales-funnel-campaigns/complete-units", requireApiKey, async (req, res) => {
  try {
    const apply = req.body?.apply === true;
    const orgId = typeof req.body?.orgId === "string" ? req.body.orgId : undefined;
    res.json(await completeSalesFunnelUnits({ apply, orgId }));
  } catch (error) {
    console.error("[campaign-service] Sales funnel unit completion error:", error);
    res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

export default router;
