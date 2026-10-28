import { adoptSalesFunnelUnitWorkflows, repairSalesFunnelUnitLegWorkflows } from "../lib/sales-funnel-unit-workflows.js";
import { Router } from "express";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
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
import { completeSalesFunnelUnits } from "../lib/sales-funnel-unit-completion.js";
import { runLeadSourcingSwitch } from "../lib/sales-funnel-lead-sourcing-switch.js";
import { runSalesFunnelNameRepair } from "../lib/sales-funnel-name.js";
import { canonicalEmail, namedPeople, peopleKeyOf, storedPeople } from "../lib/sales-funnel-people.js";
import { fileSalesFunnelCampaignPeople, type FilingReport } from "../lib/sales-funnel-people-store.js";
import { GITHUB_ISSUE_IN_PROD_KIND, githubIssueKey, parseGithubIssue } from "../lib/github-issue-trigger.js";
import { fetchChannelCatalogue } from "../lib/channel-operator-client.js";
import { answersTrigger } from "../lib/sales-funnel-head-trigger.js";
import { notifySalesFunnelCampaignPrecompute } from "../lib/sales-funnel-campaign-precompute.js";
import { deleteSalesFunnelCampaign } from "../lib/sales-funnel-campaign-delete.js";
import { pgErrorOf } from "../lib/pg-error.js";
import { backfillSalesFunnelCampaignTargets, checkTargetStep } from "../lib/sales-funnel-target.js";

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

/**
 * The stated edits of a funnel campaign's own words (lib/sales-funnel-target.ts): instruction, target, brief. Only
 * what the caller STATES moves; a brief that changes is dated + attributed (a judge re-judges after it).
 */
function statedEdits(
  current: SalesFunnelCampaign,
  stated: { instruction?: string | null; target?: string; brief?: string | null },
  userId: string | undefined,
): Partial<typeof salesFunnelCampaigns.$inferInsert> {
  const edits: Partial<typeof salesFunnelCampaigns.$inferInsert> = {};
  if (stated.instruction !== undefined && stated.instruction !== current.instruction) edits.instruction = stated.instruction;
  if (stated.target !== undefined && stated.target !== current.target) edits.target = stated.target;
  if (stated.brief !== undefined && stated.brief !== current.brief) {
    edits.brief = stated.brief;
    edits.briefUpdatedAt = new Date();
    edits.briefUpdatedByUserId = userId ?? null;
  }
  return edits;
}

async function applyEdits(row: SalesFunnelCampaign, edits: Partial<typeof salesFunnelCampaigns.$inferInsert>): Promise<SalesFunnelCampaign> {
  if (Object.keys(edits).length === 0) return row;
  const [written] = await db
    .update(salesFunnelCampaigns)
    .set({ ...edits, updatedAt: new Date() })
    .where(and(eq(salesFunnelCampaigns.id, row.id), eq(salesFunnelCampaigns.orgId, row.orgId)))
    .returning();
  return written;
}

function missingPersonHeaders(req: AuthenticatedRequest): string[] {
  return [!req.userId ? "x-user-id" : null, !req.runId ? "x-run-id" : null].filter((h): h is string => !!h);
}

/**
 * A campaign that NAMES its people files each one as a lead of its brand on every unit (lead-service), and
 * keeps the lead ids (lib/sales-funnel-people.ts). Idempotent; only asked while somebody is not filed yet.
 * The row handed back carries the lead ids; `filing` says, per person and unit, what lead-service answered.
 */
async function fileNamedPeopleOf(
  row: SalesFunnelCampaign,
  units: CampaignRow[],
  req: AuthenticatedRequest,
): Promise<{ row: SalesFunnelCampaign; filing: FilingReport[] | undefined }> {
  const people = storedPeople(row.people);
  if (!people || people.every((p) => p.leadId)) return { row, filing: undefined };
  const filed = await fileSalesFunnelCampaignPeople({
    salesFunnelCampaignId: row.id,
    orgId: row.orgId,
    people,
    units,
    userId: req.userId ?? row.createdByUserId,
    runId: req.runId ?? row.parentRunId,
  });
  return { row: { ...row, people: filed.people }, filing: filed.filing };
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
      const { brandId, offerId, salesFunnelId, status, people: namedInput, instruction, githubIssue: issueInput, target, brief } =
        CreateSalesFunnelCampaignBody.parse(req.body);
      // The GitHub issue it waits on (lib/github-issue-trigger.ts): part of its identity too.
      const issueRef = issueInput ? parseGithubIssue(issueInput) : null;
      if (issueInput && !issueRef) {
        return res.status(400).json({ error: "githubIssue must name a repository (owner/name) and an issue number.", reason: "invalid_github_issue" });
      }
      const githubIssue = issueRef ? githubIssueKey(issueRef) : null;
      // A campaign that NAMES its people (lib/sales-funnel-people.ts): its people are part of its identity.
      const people = namedInput ? namedPeople(namedInput) : null;
      const peopleKey = peopleKeyOf(people);
      const missing = missingPersonHeaders(req);
      if (missing.length > 0) {
        return res.status(400).json({ error: `Cannot launch a sales funnel — missing required headers: ${missing.join(", ")}` });
      }
      const orgId = req.orgId!;
      // A stated target is a step of the catalogue (features-service's vocabulary), else refused by name.
      if (target !== undefined) {
        const check = await checkTargetStep(target);
        if (!check.ok) return res.status(check.status).json(check.body);
      }

      const findIncumbent = () =>
        db.query.salesFunnelCampaigns.findFirst({
          where: and(
            eq(salesFunnelCampaigns.orgId, orgId),
            eq(salesFunnelCampaigns.brandId, brandId),
            eq(salesFunnelCampaigns.offerId, offerId),
            eq(salesFunnelCampaigns.salesFunnelId, salesFunnelId),
            eq(salesFunnelCampaigns.peopleKey, peopleKey),
            githubIssue ? eq(salesFunnelCampaigns.githubIssue, githubIssue) : isNull(salesFunnelCampaigns.githubIssue),
          ),
        });

      let incumbent = await findIncumbent();
      // Handed back with the instruction, target and brief the caller states now (absent = untouched).
      if (incumbent) incumbent = await applyEdits(incumbent, statedEdits(incumbent, { instruction, target, brief }, req.userId));
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
          const named = await fileNamedPeopleOf(started!.salesFunnelCampaign, started!.units, req);
          return res.status(200).json({
            salesFunnelCampaign: serializeSalesFunnelCampaign(named.row, started!.units),
            created: false,
            started: true,
            ...(named.filing ? { filing: named.filing } : {}),
          });
        }
        const units = (await unitsOf([incumbent.id], orgId)).get(incumbent.id)!;
        const named = await fileNamedPeopleOf(incumbent, units, req);
        return res.status(200).json({
          salesFunnelCampaign: serializeSalesFunnelCampaign(named.row, units),
          created: false,
          started: false,
          ...(named.filing ? { filing: named.filing } : {}),
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
        offerId,
      });
      if (!resolved.ok) {
        const { status: httpStatus, code, message, missingSteps, offerSteps, pipeId, notRunnableReason, notRunnableDetail } = resolved.refusal;
        console.warn(
          `[campaign-service] Not launching sales funnel ${salesFunnelId} — org=${orgId} brand=${brandId} offer=${offerId}: ${code}`,
        );
        return res.status(httpStatus).json({
          error: message,
          reason: code,
          ...(missingSteps ? { missingSteps, offerSteps } : {}),
          ...(code === "play_allows_no_workflow" ? { pipeId, notRunnableReason, notRunnableDetail } : {}),
        });
      }
      const { plan } = resolved;
      // A campaign naming its people only ANSWERS events for them: a pipe that prospects (an entry or
      // sourcing pipe) would act on strangers, so such a funnel is refused, naming the pipe.
      if (people) {
        // A unit running on its funnel's head trigger (lib/sales-funnel-head-trigger.ts) only answers that trigger's people.
        const prospecting = plan.units.filter((u) => u.mode !== "reactive" && !u.runsOnTriggerId);
        if (prospecting.length > 0) {
          return res.status(400).json({
            error: `A campaign that names its people only answers triggers, but this sales funnel also finds new people (${prospecting.map((u) => u.pipeId).join(", ")}).`,
            reason: "people_need_reactive_funnel",
          });
        }
      }

      // A campaign waiting on a GitHub issue must own a pipe a `github_issue_in_prod` trigger fires, or it would
      // wait forever: refused, nothing written.
      if (githubIssue) {
        const catalogue = await fetchChannelCatalogue();
        if (!catalogue.ok) {
          return res.status(502).json({ error: "The channel catalogue could not be read. Try again.", reason: "catalogue_unavailable" });
        }
        const issueTriggers = new Set(
          [...(catalogue.triggers?.values() ?? [])].filter((t) => t.kind === GITHUB_ISSUE_IN_PROD_KIND).map((t) => t.id),
        );
        // A pipe a github trigger names, or a unit of a funnel headed by one (lib/sales-funnel-head-trigger.ts).
        const answers = plan.units.some((u) =>
          [...issueTriggers].some((id) => answersTrigger(u, id, catalogue.triggerTransitions ?? [])),
        );
        if (!answers) {
          return res.status(400).json({
            error: "This sales funnel has no step that runs when a GitHub issue reaches production, so it would never run.",
            reason: "github_issue_needs_github_trigger",
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
          githubIssue,
          // The outcome it targets: stated, else the funnel's last step (lib/sales-funnel-target.ts).
          target: target ?? plan.shape?.target ?? null,
          brief: brief ?? null,
          briefUpdatedByUserId: req.userId!,
          mode: plan.shape?.mode ?? null,
          triggerId: plan.shape?.triggerId ?? null,
          units: plan.units.map((u) => ({
            featureSlug: u.featureSlug,
            legKey: u.legKey,
            workflowSlug: u.workflowSlug,
            runsOnTriggerId: u.runsOnTriggerId,
            acquisitionChannel: acquisitionChannelForFeature(u.featureSlug)!,
            // Names are unique per org; the funnel campaign's id keeps two funnels sharing a pipe apart.
            name: `${plan.salesFunnelName} ${idTag} - ${derivedCampaignName(u.featureSlug, brandId, offerId, u.legKey)}`,
          })),
          onUnitStarted: ensureUnitSources,
        });
      } catch (error: any) {
        // Two launches raced the same identity: the winner IS this funnel campaign.
        const pg = pgErrorOf(error);
        const constraint = pg.constraint ?? pg.constraint_name;
        if (pg.code === "23505" && constraint === "uniq_sales_funnel_campaigns_identity") {
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
      // features-service computes the brand's Campaigns rows now, before anyone reads them. Never awaited.
      void notifySalesFunnelCampaignPrecompute({
        salesFunnelCampaignId: born.salesFunnelCampaign.id,
        orgId,
        brandId,
        offerId,
        userId: req.userId!,
        runId: req.runId!,
      });
      const named = await fileNamedPeopleOf(born.salesFunnelCampaign, born.units, req);
      return res.status(201).json({
        salesFunnelCampaign: serializeSalesFunnelCampaign(named.row, born.units),
        created: true,
        started: status === "ongoing",
        ...(named.filing ? { filing: named.filing } : {}),
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
      const { status, instruction, target, brief } = UpdateSalesFunnelCampaignBody.parse(req.body);
      const orgId = req.orgId!;
      const existing = await db.query.salesFunnelCampaigns.findFirst({
        where: and(eq(salesFunnelCampaigns.id, req.params.id), eq(salesFunnelCampaigns.orgId, orgId)),
      });
      if (!existing) return res.status(404).json({ error: "Sales funnel campaign not found" });
      if (target !== undefined) {
        const check = await checkTargetStep(target);
        if (!check.ok) return res.status(check.status).json(check.body);
      }
      const edits = statedEdits(existing, { instruction, target, brief }, req.userId);

      // Reword (or clear) the instruction its runs carry (read by every run at /start-run, so the next message
      // follows the new words), restate its target, rewrite its brief. Status untouched unless stated too.
      if (status === undefined) {
        const reworded = await applyEdits(existing, edits);
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
      const parent = await applyEdits(written.salesFunnelCampaign, edits);
      if (status === "activate") wakeScheduler();
      res.json({ salesFunnelCampaign: serializeSalesFunnelCampaign(parent, written.units) });
    } catch (error) {
      console.error("[campaign-service] Update sales funnel campaign error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

/**
 * DELETE /sales-funnel-campaigns/:id — remove a funnel campaign created by mistake, with its units
 * (lib/sales-funnel-campaign-delete.ts). Only a STOPPED campaign that NEVER RAN: one that ran keeps its
 * history (409 sales_funnel_campaign_has_history), a running one must be stopped first (409
 * sales_funnel_campaign_ongoing). Scoped to the caller's org (another org's id = 404).
 */
router.delete("/sales-funnel-campaigns/:id", requireApiKey, serviceAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const orgId = req.orgId!;
    const parent = await db.query.salesFunnelCampaigns.findFirst({
      where: and(eq(salesFunnelCampaigns.id, req.params.id), eq(salesFunnelCampaigns.orgId, orgId)),
    });
    if (!parent) return res.status(404).json({ error: "Sales funnel campaign not found" });
    const units = (await unitsOf([parent.id], orgId)).get(parent.id)!;
    const outcome = await deleteSalesFunnelCampaign({ parent, units, userId: req.userId, runId: req.runId });
    if ("notFound" in outcome) return res.status(404).json({ error: "Sales funnel campaign not found" });
    if (!outcome.deleted) return res.status(outcome.refusal.status).json(outcome.refusal.body);
    const userId = req.userId ?? parent.createdByUserId;
    const runId = req.runId ?? parent.parentRunId;
    if (userId && runId) {
      void notifySalesFunnelCampaignPrecompute({
        salesFunnelCampaignId: parent.id,
        orgId,
        brandId: parent.brandId,
        offerId: parent.offerId,
        userId,
        runId,
      });
    }
    res.json({ deleted: true, salesFunnelCampaignId: parent.id, unitIds: outcome.unitIds });
  } catch (error) {
    console.error("[campaign-service] Delete sales funnel campaign error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * POST /internal/sales-funnel-campaigns/target-backfill {apply?} — every funnel campaign missing its target (the
 * funnel's last step), mode or head trigger gets them from features-service (lib/sales-funnel-target.ts). Dry run
 * unless `apply: true`; idempotent; never overwrites a stated target. Also run at boot. Answers the count per target
 * and every campaign it could not fill, with the reason.
 */
router.post("/internal/sales-funnel-campaigns/target-backfill", requireApiKey, async (req, res) => {
  try {
    const apply = z.object({ apply: z.boolean().optional() }).parse(req.body ?? {}).apply === true;
    res.json(await backfillSalesFunnelCampaignTargets({ apply }));
  } catch (error) {
    console.error("[campaign-service] Target backfill error:", error);
    res.status(500).json({ error: "Internal server error" });
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
 * POST /internal/sales-funnel-campaigns/name-repair {apply?, orgId?, retiredFunnelNames?} — a funnel campaign whose
 * stored name differs from the name features-service serves for its id (a legacy id: the id it resolves to) takes
 * that name, on the row and its units' prefix (lib/sales-funnel-name.ts). A funnel id the catalogue answers 404 takes
 * its `retiredFunnelNames[salesFunnelId]` entry, else is skipped; unreadable funnels are skipped. Dry run unless
 * `apply: true`; idempotent; no status, funnel id or billing write.
 */
const RetiredFunnelNames = z.record(z.string().min(1), z.string().trim().min(1).max(60));

router.post("/internal/sales-funnel-campaigns/name-repair", requireApiKey, async (req, res) => {
  const retired = RetiredFunnelNames.optional().safeParse(req.body?.retiredFunnelNames);
  if (!retired.success) {
    res.status(400).json({ error: "retiredFunnelNames must map a sales funnel id to a name (1-60 chars)", details: retired.error.issues });
    return;
  }
  try {
    res.json(await runSalesFunnelNameRepair({
      apply: req.body?.apply === true,
      orgId: typeof req.body?.orgId === "string" ? req.body.orgId : undefined,
      retiredFunnelNames: retired.data,
    }));
  } catch (error) {
    console.error("[campaign-service] Sales funnel name repair error:", error);
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

/**
 * POST /internal/sales-funnel-campaigns/adopt-workflows {apply?, orgId?} + a REAL staff x-org-id/x-user-id/x-run-id —
 * every PLATFORM unit born with no workflow (AI Instant Call, before AIC-COMMON-1015) takes the workflow a launch
 * would give its pipe today (lib/sales-funnel-unit-workflows.ts). Dry run unless `apply: true`; idempotent; status
 * never touched.
 */
router.post("/internal/sales-funnel-campaigns/adopt-workflows", requireApiKey, async (req, res) => {
  const orgId = req.headers["x-org-id"];
  const userId = req.headers["x-user-id"];
  const runId = req.headers["x-run-id"];
  if (typeof orgId !== "string" || typeof userId !== "string" || typeof runId !== "string" || !orgId || !userId || !runId) {
    return res.status(400).json({ error: "x-org-id, x-user-id and x-run-id are required (a real staff run): the workflow read is workflow-service's" });
  }
  try {
    res.json(await adoptSalesFunnelUnitWorkflows({
      apply: req.body?.apply === true,
      orgId: typeof req.body?.orgId === "string" ? req.body.orgId : undefined,
      identity: { orgId, userId, runId },
    }));
  } catch (error) {
    console.error("[campaign-service] Sales funnel unit workflow adoption error:", error);
    res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

/**
 * POST /internal/sales-funnel-campaigns/leg-workflow-repair {apply?, orgId?} + a REAL staff x-org-id/x-user-id/x-run-id
 * (CAMPAIGN-FALLBACK-WORKFLOW-LEG-1015) — every platform unit whose stored workflow features-service does not assign
 * to its leg (or its play rules out) takes the seed a launch gives its pipe today
 * (lib/sales-funnel-unit-workflows.ts `repairSalesFunnelUnitLegWorkflows`). Dry run unless `apply: true`;
 * idempotent; status and `next_run_at` never touched.
 */
router.post("/internal/sales-funnel-campaigns/leg-workflow-repair", requireApiKey, async (req, res) => {
  const orgId = req.headers["x-org-id"];
  const userId = req.headers["x-user-id"];
  const runId = req.headers["x-run-id"];
  if (typeof orgId !== "string" || typeof userId !== "string" || typeof runId !== "string" || !orgId || !userId || !runId) {
    return res.status(400).json({ error: "x-org-id, x-user-id and x-run-id are required (a real staff run): the workflow reads are workflow-service's and features-service's" });
  }
  try {
    res.json(await repairSalesFunnelUnitLegWorkflows({
      apply: req.body?.apply === true,
      orgId: typeof req.body?.orgId === "string" ? req.body.orgId : undefined,
      identity: { orgId, userId, runId },
    }));
  } catch (error) {
    console.error("[campaign-service] Sales funnel unit leg workflow repair error:", error);
    res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

export default router;
