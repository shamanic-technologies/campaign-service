import { adoptSalesFunnelUnitWorkflows, repairSalesFunnelUnitLegWorkflows } from "../lib/sales-funnel-unit-workflows.js";
import { Router } from "express";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { campaigns, salesFunnelCampaigns, type SalesFunnelCampaign } from "../db/schema.js";
import { serviceAuth, requireApiKey, type AuthenticatedRequest } from "../middleware/auth.js";
import { validateBody, validateQuery } from "../middleware/validate.js";
import { refuseRetiredEngineOutcomes } from "../lib/retired-engine-outcomes.js";
import { refuseRetiredInstruction } from "../lib/retired-instruction.js";
import {
  CreateSalesFunnelCampaignBody,
  SalesFunnelCampaignsQuery,
  UpdateSalesFunnelCampaignBody,
} from "../schemas.js";
import { paymentStartRefusal } from "../lib/payment-hold.js";
import { STOP_REASONS } from "../lib/stop-reason.js";
import {
  insertSalesFunnelCampaignWithUnits,
  insertSalesFunnelUnits,
  setSalesFunnelCampaignStatus,
  type OnUnitStarted,
  type SalesFunnelUnitBirth,
} from "../lib/campaign-status-history.js";
import { resolveSalesFunnelPlan, sourcingPipeWorkflow } from "../lib/startable-pair.js";
import { acquisitionChannelForFeature, derivedCampaignName } from "../lib/campaign-identity.js";
import { ensureSourcesOnStart } from "../lib/source-campaign-store.js";
import { serializeSalesFunnelCampaign } from "../lib/sales-funnel-campaigns.js";
import { wakeScheduler } from "../lib/scheduler.js";
import { sameLeg } from "../lib/leg-identity.js";
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
import { SALES_FUNNEL_CAMPAIGN_FIELD_LABELS, describeChanges, reportCampaignAction } from "../lib/account-activity.js";
import { backfillSalesFunnelCampaignTargets, checkTargetStep } from "../lib/sales-funnel-target.js";
import { EngineStateUnreadableError, engineUnitWorkflowSlug, liveEngineFor } from "../lib/engine-dispatch.js";
import { isTargetOnlyCampaign, targetOnlyUnitBirth } from "../lib/target-only-campaign.js";
import { dryRunPlans, readPlanChanges, readPlanFollowing, runPlanCheckFor, runPlanFollowerPass, runSwitchOffFor } from "../lib/sales-funnel-plan.js";

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
 * The stated edits of a funnel campaign's own words (lib/sales-funnel-target.ts): target, brief, followsPlan. Only
 * what the caller STATES moves; a brief that changes is dated + attributed (a judge re-judges after it).
 */
function statedEdits(
  current: SalesFunnelCampaign,
  stated: { target?: string; brief?: string | null; followsPlan?: boolean },
  userId: string | undefined,
): Partial<typeof salesFunnelCampaigns.$inferInsert> {
  const edits: Partial<typeof salesFunnelCampaigns.$inferInsert> = {};
  // The customer's switch (lib/sales-funnel-plan.ts): follow the plan, or keep the funnel it runs now, fixed.
  if (stated.followsPlan !== undefined && stated.followsPlan !== current.followsPlan) edits.followsPlan = stated.followsPlan;
  if (stated.target !== undefined && stated.target !== current.target) edits.target = stated.target;
  const brief = stated.brief;
  if (brief !== undefined && brief !== current.brief) {
    edits.brief = brief;
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

/**
 * The client's ONE activity report for this request on a funnel campaign (lib/account-activity.ts): its status
 * move if any, else its edits. Never awaited.
 */
function reportSalesFunnelCampaignAction(
  req: AuthenticatedRequest,
  before: SalesFunnelCampaign | null,
  after: SalesFunnelCampaign,
  moved: boolean,
): void {
  reportCampaignAction(
    { orgId: req.orgId!, userId: req.userId, email: (req.headers["x-email"] as string | undefined) ?? null },
    { id: after.id, name: after.salesFunnelName, brandId: after.brandId },
    before === null ? { fromStatus: null, toStatus: after.status } : moved ? { fromStatus: before.status, toStatus: after.status } : null,
    before === null ? [] : describeChanges(before, after, SALES_FUNNEL_CAMPAIGN_FIELD_LABELS),
    after.updatedAt,
  );
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
  refuseRetiredEngineOutcomes,
  refuseRetiredInstruction,
  validateBody(CreateSalesFunnelCampaignBody),
  async (req: AuthenticatedRequest, res) => {
    try {
      const { brandId, offerId, salesFunnelId: statedFunnelId, status, people: namedInput, githubIssue: issueInput, target, brief, followsPlan } =
        CreateSalesFunnelCampaignBody.parse(req.body);
      // MIGRATE-1105 S8 (lib/target-only-campaign.ts): no sales funnel = the campaign is its TARGET alone, made by that
      // outcome's Engine. It follows no plan and only prospects (one unit from Start), so it names nobody and waits on
      // no issue. Its funnel id reads its target (billing's caps and its identity are keyed on it).
      const targetOnly = statedFunnelId === undefined;
      if (targetOnly) {
        const refuse = (reason: string, error: string) => res.status(400).json({ error, reason });
        if (target === undefined) return refuse("target_required", "State the outcome this campaign targets (target), or the sales funnel it runs (salesFunnelId).");
        if (followsPlan === true) return refuse("follows_plan_needs_sales_funnel", "A campaign follows a plan only on a sales funnel: state salesFunnelId, or omit followsPlan.");
        if (namedInput) return refuse("people_need_reactive_funnel", "A campaign that names its people only answers triggers, but a campaign on its target alone finds new people.");
        if (issueInput) return refuse("github_issue_needs_github_trigger", "A campaign on its target alone never runs when a GitHub issue reaches production, so it would never run.");
      }
      const salesFunnelId = statedFunnelId ?? target!;
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
      const incumbentBefore = incumbent ?? null;
      // Handed back with the target and brief the caller states now (absent = untouched).
      const wasFollowing = incumbent?.followsPlan ?? false;
      if (incumbent) incumbent = await applyEdits(incumbent, statedEdits(incumbent, { target, brief, followsPlan }, req.userId));
      // Told to stop following its plan: back on its own funnel at once (lib/sales-funnel-plan.ts `switchOffPlan`).
      if (incumbent && wasFollowing && followsPlan === false) {
        await runSwitchOffFor(incumbent.id);
        incumbent = (await findIncumbent()) ?? incumbent;
      }
      // A campaign told to follow its plan (or started while it does) is checked against it at once.
      if (incumbent?.followsPlan && (followsPlan === true || status === "ongoing")) void runPlanCheckFor(incumbent.id);
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
          reportSalesFunnelCampaignAction(req, incumbentBefore, started!.salesFunnelCampaign, true);
          const named = await fileNamedPeopleOf(started!.salesFunnelCampaign, started!.units, req);
          return res.status(200).json({
            salesFunnelCampaign: serializeSalesFunnelCampaign(named.row, started!.units),
            created: false,
            started: true,
            ...(named.filing ? { filing: named.filing } : {}),
          });
        }
        const units = (await unitsOf([incumbent.id], orgId)).get(incumbent.id)!;
        reportSalesFunnelCampaignAction(req, incumbentBefore, incumbent, false);
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

      const id = randomUUID();
      const idTag = id.slice(0, 8);
      // What the campaign is born with: its name, its units and what it starts from.
      let birth: {
        salesFunnelName: string;
        target: string | null;
        mode: "proactive" | "reactive" | null;
        triggerId: string | null;
        units: SalesFunnelUnitBirth[];
      };
      if (targetOnly) {
        // Its Engine must make the target for this org, or nothing would ever run it: refused by name, nothing written.
        let engine;
        try {
          engine = await liveEngineFor({ featureSlug: null, legKey: null, workflowSlug: engineUnitWorkflowSlug(salesFunnelId) }, orgId);
        } catch (err) {
          if (!(err instanceof EngineStateUnreadableError)) throw err;
          return res.status(502).json({ error: "We couldn't tell what makes this outcome just now. Please try again in a minute.", reason: "engine_state_unavailable" });
        }
        if (!engine) {
          console.warn(`[campaign-service] Not launching target ${salesFunnelId} — org=${orgId} brand=${brandId}: its Engine does not run this org's campaigns`);
          return res.status(409).json({ error: `Nothing makes "${salesFunnelId}" for this organization yet, so this campaign can't be launched.`, reason: "engine_not_live" });
        }
        // The catalogue serves step keys only (no label): the target names the campaign.
        birth = {
          salesFunnelName: salesFunnelId,
          target: salesFunnelId,
          mode: "proactive",
          triggerId: null,
          units: [targetOnlyUnitBirth(salesFunnelId, `${salesFunnelId} ${idTag}`)],
        };
      } else {
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

        birth = {
          salesFunnelName: plan.salesFunnelName,
          // The outcome it targets: stated, else the funnel's last step (lib/sales-funnel-target.ts).
          target: target ?? plan.shape?.target ?? null,
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
        };
      }

      let born;
      try {
        born = await insertSalesFunnelCampaignWithUnits({
          id,
          orgId,
          brandId,
          offerId,
          salesFunnelId,
          salesFunnelName: birth.salesFunnelName,
          status,
          createdByUserId: req.userId!,
          parentRunId: req.runId!,
          people,
          peopleKey,
          githubIssue,
          target: birth.target,
          brief: brief ?? null,
          briefUpdatedByUserId: req.userId!,
          mode: birth.mode,
          triggerId: birth.triggerId,
          followsPlan: followsPlan ?? false,
          units: birth.units,
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
        `[campaign-service] Sales funnel campaign ${born.salesFunnelCampaign.id} (${birth.salesFunnelName}) born ${status} — org=${orgId} brand=${brandId} offer=${offerId}, units ${born.units.map((u) => u.id).join(", ")}`,
      );
      if (status === "ongoing") wakeScheduler();
      reportSalesFunnelCampaignAction(req, null, born.salesFunnelCampaign, true);
      if (followsPlan && status === "ongoing") void runPlanCheckFor(born.salesFunnelCampaign.id);
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
  refuseRetiredEngineOutcomes,
  refuseRetiredInstruction,
  validateBody(UpdateSalesFunnelCampaignBody),
  async (req: AuthenticatedRequest, res) => {
    try {
      const { status, target, brief, followsPlan } = UpdateSalesFunnelCampaignBody.parse(req.body);
      const orgId = req.orgId!;
      const existing = await db.query.salesFunnelCampaigns.findFirst({
        where: and(eq(salesFunnelCampaigns.id, req.params.id), eq(salesFunnelCampaigns.orgId, orgId)),
      });
      if (!existing) return res.status(404).json({ error: "Sales funnel campaign not found" });
      // A campaign launched on its target alone (lib/target-only-campaign.ts): its one unit IS its target's Engine, so the
      // target never moves, and it has no sales funnel to follow a plan on.
      if (isTargetOnlyCampaign(existing)) {
        if (target !== undefined && target !== existing.target) {
          return res.status(409).json({
            error: `This campaign is made by the Engine of "${existing.target}", so its target can't change. Launch a new campaign on the other target.`,
            reason: "target_fixed",
          });
        }
        if (followsPlan === true) {
          return res.status(400).json({ error: "A campaign follows a plan only on a sales funnel.", reason: "follows_plan_needs_sales_funnel" });
        }
      }
      if (target !== undefined) {
        const check = await checkTargetStep(target);
        if (!check.ok) return res.status(check.status).json(check.body);
      }
      const edits = statedEdits(existing, { target, brief, followsPlan }, req.userId);
      // Turned to follow its plan, or started while it does: checked against its plan at once (after the write).
      const checkPlanNow = (followsPlan === true && !existing.followsPlan) || (status === "activate" && (followsPlan ?? existing.followsPlan));
      // Turned OFF: back on its own funnel at once, before answering (lib/sales-funnel-plan.ts `switchOffPlan`).
      const switchedOff = followsPlan === false && existing.followsPlan;
      const backHome = async (row: SalesFunnelCampaign): Promise<SalesFunnelCampaign> => {
        if (!switchedOff) return row;
        await runSwitchOffFor(row.id);
        return (await db.query.salesFunnelCampaigns.findFirst({ where: eq(salesFunnelCampaigns.id, row.id) })) ?? row;
      };

      // Rewrite (or clear) its brief (read by every run at /start-run, so the next message follows the new
      // words), restate its target. Status untouched unless stated too.
      if (status === undefined) {
        const reworded = await backHome(await applyEdits(existing, edits));
        reportSalesFunnelCampaignAction(req, existing, reworded, false);
        if (checkPlanNow) void runPlanCheckFor(reworded.id);
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
      const parent = await backHome(await applyEdits(written.salesFunnelCampaign, edits));
      reportSalesFunnelCampaignAction(req, existing, parent, true);
      if (status === "activate") wakeScheduler();
      if (checkPlanNow) void runPlanCheckFor(parent.id);
      const units = switchedOff ? (await unitsOf([parent.id], orgId)).get(parent.id)! : written.units;
      res.json({ salesFunnelCampaign: serializeSalesFunnelCampaign(parent, units) });
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
 * POST /sales-funnel-campaigns/:id/entries {salesFunnelId} — the campaign takes ANOTHER ENTRY (MIGRATE-1105 S6, owner
 * 2026-11-08: one campaign per offer does everything, its own leads' form fills and callbacks included). A campaign
 * starts from Start or a trigger; this adds the line a TRIGGER heads (`trigger:<id>+…`, e.g. a Lead event) to the same
 * campaign: its units are born INTO it, in its status, on its offer, each running on that trigger only
 * (`runsOnTriggerId`), so the trigger's events of THIS campaign's offer are answered inside it, on its own money and
 * brief. Idempotent: a pipe the campaign already runs is never born twice. A line that no trigger heads is refused (it
 * would prospect a second time). Stopping the separate campaign that answered the same events is the caller's next
 * act (one answer per lead).
 */
router.post("/sales-funnel-campaigns/:id/entries", requireApiKey, serviceAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const orgId = req.orgId!;
    const salesFunnelId = typeof req.body?.salesFunnelId === "string" ? req.body.salesFunnelId.trim() : "";
    if (!salesFunnelId) return res.status(400).json({ error: "salesFunnelId is required", reason: "sales_funnel_id_required" });
    const parent = await db.query.salesFunnelCampaigns.findFirst({
      where: and(eq(salesFunnelCampaigns.id, req.params.id), eq(salesFunnelCampaigns.orgId, orgId)),
    });
    if (!parent) return res.status(404).json({ error: "Sales funnel campaign not found" });
    const resolved = await resolveSalesFunnelPlan(salesFunnelId, {
      orgId,
      userId: req.userId!,
      runId: req.runId!,
      brandId: parent.brandId,
      offerId: parent.offerId,
    });
    if (!resolved.ok) {
      const { status: httpStatus, code, message } = resolved.refusal;
      return res.status(httpStatus).json({ error: message, reason: code });
    }
    const { plan } = resolved;
    const entering = plan.units.filter((u) => u.runsOnTriggerId);
    if (entering.length === 0 || plan.units.some((u) => !u.runsOnTriggerId && u.mode !== "reactive" && u.workflowSlug)) {
      return res.status(400).json({
        error: "An entry is a line a trigger starts (its people's events); this line also finds new people, so it is not an entry.",
        reason: "entry_needs_trigger_line",
      });
    }
    const existing = (await unitsOf([parent.id], orgId)).get(parent.id)!;
    const idTag = parent.id.slice(0, 8);
    const births = entering
      .filter((u) => !existing.some((e) => e.featureSlug === u.featureSlug && e.legKey !== null && sameLeg(u.featureSlug, e.legKey, u.legKey)))
      .map((u) => ({
        featureSlug: u.featureSlug,
        legKey: u.legKey,
        workflowSlug: u.workflowSlug,
        runsOnTriggerId: u.runsOnTriggerId,
        acquisitionChannel: acquisitionChannelForFeature(u.featureSlug)!,
        name: `${parent.salesFunnelName} ${idTag} - ${derivedCampaignName(u.featureSlug, parent.brandId, parent.offerId, u.legKey)}`,
      }));
    const born = births.length === 0
      ? []
      : await db.transaction(async (tx) => {
          const units = await insertSalesFunnelUnits(tx, parent, births);
          if (parent.status === "ongoing") for (const unit of units) await ensureUnitSources(tx, unit);
          return units;
        });
    if (born.length > 0 && parent.status === "ongoing") wakeScheduler();
    console.log(`[campaign-service] Campaign ${parent.id} takes the entry ${salesFunnelId}: ${born.length} unit(s) born (${born.map((u) => u.id).join(", ") || "already there"})`);
    const units = (await unitsOf([parent.id], orgId)).get(parent.id)!;
    res.status(born.length > 0 ? 201 : 200).json({ salesFunnelCampaign: serializeSalesFunnelCampaign(parent, units), bornUnitIds: born.map((u) => u.id) });
  } catch (error) {
    console.error("[campaign-service] Campaign entry error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/** GET /sales-funnel-campaigns/:id/plan-changes — every plan change applied to it (lib/sales-funnel-plan.ts), newest first. */
router.get("/sales-funnel-campaigns/:id/plan-changes", requireApiKey, serviceAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const parent = await db.query.salesFunnelCampaigns.findFirst({
      where: and(eq(salesFunnelCampaigns.id, req.params.id), eq(salesFunnelCampaigns.orgId, req.orgId!)),
    });
    if (!parent) return res.status(404).json({ error: "Sales funnel campaign not found" });
    res.json({
      salesFunnelCampaignId: parent.id,
      followsPlan: parent.followsPlan,
      salesFunnelId: parent.salesFunnelId,
      runningSalesFunnelId: parent.runningSalesFunnelId ?? parent.salesFunnelId,
      planCheck: parent.planCheck ?? null,
      changes: await readPlanChanges(parent.id),
    });
  } catch (error) {
    console.error("[campaign-service] Plan changes read error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * POST /internal/sales-funnel-campaigns/plan-check {orgId, brandId?, salesFunnelCampaignId?, apply?} — staff.
 * `apply` false (default) = a DRY RUN for every ongoing funnel campaign of the scope, followed or not: what following
 * its plan WOULD do (pipes before/after, each unit, the verdict), nothing written. `apply: true` = one plan follower
 * pass now (every campaign following its plan, fleet-wide).
 */
router.post("/internal/sales-funnel-campaigns/plan-check", requireApiKey, async (req, res) => {
  try {
    const body = z
      .object({ orgId: z.string().min(1).optional(), brandId: z.string().optional(), salesFunnelCampaignId: z.string().optional(), apply: z.boolean().optional() })
      .parse(req.body ?? {});
    if (body.apply) {
      const pass = await runPlanFollowerPass();
      return res.json({ apply: true, pass });
    }
    if (!body.orgId) return res.status(400).json({ error: "orgId is required for a dry run" });
    const campaignsChecked = await dryRunPlans({ orgId: body.orgId, brandId: body.brandId, salesFunnelCampaignId: body.salesFunnelCampaignId });
    res.json({ apply: false, campaigns: campaignsChecked });
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ error: error.issues.map((i) => i.message).join("; ") });
    console.error("[campaign-service] Plan check error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /internal/ops/plan-following?days= — the dashboard v2 Monitoring card of the plan follower: red when a campaign
 * following its plan cannot follow it (no plan, unreadable, not runnable, outside its caps, apply failed) or the
 * follower stopped checking. Never an email.
 */
router.get("/internal/ops/plan-following", requireApiKey, async (req, res) => {
  const days = req.query.days === undefined ? 30 : Number(req.query.days);
  if (!Number.isInteger(days) || days < 1 || days > 90) return res.status(400).json({ error: "days must be an integer from 1 to 90" });
  try {
    res.json(await readPlanFollowing(days));
  } catch (error) {
    console.error("[campaign-service] Plan following read error:", error);
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
