import { Router } from "express";
import { eq, and, desc, inArray, isNull, or, sql } from "drizzle-orm";
import { arrayContains } from "drizzle-orm/sql/expressions/conditions";
import { db } from "../db/index.js";
import { campaigns, campaignStatusTransitions } from "../db/schema.js";
import { serviceAuth, requireApiKey, AuthenticatedRequest } from "../middleware/auth.js";
import { validateBody, validateQuery } from "../middleware/validate.js";
import {
  CreateCampaignBody,
  UpdateCampaignBody,
  CampaignsFilterQuery,
  StartFundedPairBody,
} from "../schemas.js";
import { validateWorkflowInputs } from "../lib/workflows.js";
import { dispatchSelectedRun } from "../lib/selected-dispatch.js";
import { wakeScheduler } from "../lib/scheduler.js";
import { traceEvent } from "../lib/trace-event.js";
import {
  acquisitionChannelForFeature,
  campaignIdentityColumns,
  derivedCampaignName,
} from "../lib/campaign-identity.js";
import { paymentStartRefusal } from "../lib/payment-hold.js";
import { STOP_REASONS } from "../lib/stop-reason.js";
import {
  TRANSITION_SOURCES,
  campaignBirthTransition,
  signalCampaignBirth,
  setCampaignStatusWithStops,
  signalDisplacedStops,
  stopDisplacedWithHistory,
  type DbTransaction,
} from "../lib/campaign-status-history.js";
import type { StatusActor } from "../lib/mission-status-notification.js";
import { isSalesFamilyFeature, isServicePerformedFeature, salesMaxBudgetRefusal } from "../lib/sales-outreach-campaign.js";
import { resolveReactiveDefaultWorkflow, resolveStartablePair } from "../lib/startable-pair.js";
import {
  ProactiveCatalogueUnavailableError,
  isEntryLeg,
  proactiveCampaignsToStop,
  stoppedCampaignSummary,
} from "../lib/single-proactive.js";
import {
  fetchOfferCatalogueSalesPaths,
  fetchOfferSelectedSalesPaths,
  planReactiveDefaults,
} from "../lib/reactive-defaults.js";
import { fetchChannelCatalogue, type ChannelCatalogueRead } from "../lib/channel-operator-client.js";
import { SOURCE_LEG_KEY, isSourceOriginSlug } from "../lib/source-campaigns.js";
import { ensureDefaultSourceOnStart } from "../lib/source-campaign-store.js";
import { ReactiveDefaultsBody } from "../schemas.js";

const router = Router();

type CampaignRow = typeof campaigns.$inferSelect;

/** The person whose request this is, for the transition ledger and billing's signal. */
function personActor(req: AuthenticatedRequest): StatusActor {
  return { userId: req.userId, runId: req.runId, email: (req.headers["x-email"] as string | undefined) ?? null };
}

/**
 * ONE PROACTIVE CAMPAIGN ON PER OFFER (lib/single-proactive.ts): the `displace` a person's start
 * hands setCampaignStatus, so the other proactive campaign of the offer stops in the same
 * transaction as this one starts.
 */
async function displaceOtherProactive(tx: DbTransaction, started: CampaignRow): Promise<CampaignRow[]> {
  const toStop = await proactiveCampaignsToStop(tx, started);
  // The offer's first outreach campaign of a sourced channel is born with its default SOURCE
  // campaign ON, in the same transaction (lib/source-campaign-store.ts), so it finds leads exactly
  // as before sources were campaigns. An offer holding any source row is left alone.
  await ensureDefaultSourceOnStart(tx, started);
  return toStop;
}

/** Inside an insert's own transaction: stop the proactive campaigns the new one replaces. */
async function stopProactiveReplacedBy(tx: DbTransaction, inserted: CampaignRow): Promise<CampaignRow[]> {
  return stopDisplacedWithHistory(tx, inserted.orgId, await displaceOtherProactive(tx, inserted));
}

/** The one refusal a start can now meet: which campaigns to stop could not be read. 502, nothing written. */
function proactiveRefusal(error: unknown, res: import("express").Response): boolean {
  if (!(error instanceof ProactiveCatalogueUnavailableError)) return false;
  console.error(`[campaign-service] Start refused, ${error.message}`);
  res.status(502).json({ error: error.customerMessage, reason: error.reason });
  return true;
}

class ReactiveDefaultsUnavailableError extends Error {}

export interface ReactiveDefaultsResult {
  offerId: string;
  basis: "stated" | "roi_above_1";
  tickedCombinationKeys: string[];
  /** Born ON just now. */
  started: Array<{ id: string; name: string; featureSlug: string | null; legKey: string | null }>;
  /** Already ON: left as is. */
  alreadyOn: string[];
  /** Exists and is stopped (a person's off, or a payment hold): left OFF, never re-enabled. */
  keptOff: string[];
  /** A reactive pair nothing can run here, with the reason. */
  skipped: Array<{ legKey: string; featureSlug: string; reason: string }>;
}

/**
 * REACTIVE CAMPAIGNS ARE ON BY DEFAULT (lib/reactive-defaults.ts). Creates, ON, each reactive
 * (leg, channel) campaign a ticked sales path of the offer uses and that has NO row yet. Never
 * restarts a stopped one, never stops anything. Only ever called from a person's request.
 */
async function applyReactiveDefaults(
  scope: { orgId: string; brandId: string; offerId: string },
  req: AuthenticatedRequest,
  knownCatalogue?: ChannelCatalogueRead,
): Promise<ReactiveDefaultsResult> {
  const identity = { orgId: scope.orgId, userId: req.userId!, runId: req.runId!, brandId: scope.brandId };
  const [selected, paths, catalogue] = await Promise.all([
    fetchOfferSelectedSalesPaths(scope.offerId, scope.brandId, identity),
    fetchOfferCatalogueSalesPaths(scope.offerId, scope.brandId, identity),
    knownCatalogue ?? fetchChannelCatalogue(),
  ]);
  if (!selected.ok) throw new ReactiveDefaultsUnavailableError(`selected sales paths: ${selected.detail}`);
  if (!paths.ok) throw new ReactiveDefaultsUnavailableError(`sales paths: ${paths.detail}`);
  if (!catalogue.ok) throw new ReactiveDefaultsUnavailableError(`channel catalogue: ${catalogue.detail}`);

  const plan = planReactiveDefaults(selected.value, paths.value);
  const result: ReactiveDefaultsResult = {
    offerId: scope.offerId,
    basis: plan.basis,
    tickedCombinationKeys: plan.tickedCombinationKeys,
    started: [],
    alreadyOn: [],
    keptOff: [],
    skipped: [],
  };

  for (const pair of plan.pairs) {
    const acquisitionChannel = acquisitionChannelForFeature(pair.featureSlug)!;
    const findRow = () =>
      db.query.campaigns.findFirst({
        where: and(
          eq(campaigns.orgId, scope.orgId),
          eq(campaigns.brandId, scope.brandId),
          eq(campaigns.offerId, scope.offerId),
          eq(campaigns.legKey, pair.legKey),
          eq(campaigns.acquisitionChannel, acquisitionChannel),
        ),
        orderBy: [desc(sql`(${campaigns.status} = 'ongoing')`), desc(campaigns.createdAt)],
      });
    const existing = await findRow();
    if (existing) {
      (existing.status === "ongoing" ? result.alreadyOn : result.keptOff).push(existing.id);
      continue;
    }

    const workflow = await resolveReactiveDefaultWorkflow(pair.featureSlug, pair.legKey, identity, catalogue);
    if (!workflow.ok) {
      result.skipped.push({ legKey: pair.legKey, featureSlug: pair.featureSlug, reason: workflow.code });
      continue;
    }

    const now = new Date();
    try {
      const campaign = await db.transaction(async (tx) => {
        const [inserted] = await tx
          .insert(campaigns)
          .values({
            ...campaignIdentityColumns({ brandIds: [scope.brandId], featureSlug: pair.featureSlug }),
            orgId: scope.orgId,
            createdByUserId: req.userId ?? null,
            parentRunId: req.runId ?? null,
            name: derivedCampaignName(pair.featureSlug, scope.brandId, scope.offerId, pair.legKey),
            workflowSlug: workflow.workflowSlug,
            brandIds: [scope.brandId],
            featureSlug: pair.featureSlug,
            offerId: scope.offerId,
            legKey: pair.legKey,
            featureInputs: null,
            status: "ongoing",
            nextRunAt: workflow.workflowSlug ? now : null,
            updatedAt: now,
          })
          .returning();
        await tx
          .insert(campaignStatusTransitions)
          .values(campaignBirthTransition(inserted.id, scope.orgId, inserted.status, TRANSITION_SOURCES.REACTIVE_DEFAULT));
        return inserted;
      });
      signalCampaignBirth(campaign, personActor(req), TRANSITION_SOURCES.REACTIVE_DEFAULT);
      result.started.push({ id: campaign.id, name: campaign.name, featureSlug: campaign.featureSlug, legKey: campaign.legKey });
    } catch (error: any) {
      // Raced another person's request for the same pair: that campaign IS this pair's.
      if (error?.code === "23505") {
        const winner = await findRow();
        if (winner) {
          (winner.status === "ongoing" ? result.alreadyOn : result.keptOff).push(winner.id);
          continue;
        }
      }
      throw error;
    }
  }
  if (result.started.length > 0) wakeScheduler();
  return result;
}

/**
 * After a person turned a campaign ON: when it is the offer's PROACTIVE campaign, switch on the
 * reactive campaigns its ticked paths use. Fire-and-forget: the start's answer, status and latency
 * never depend on it; a failure is logged loud and the next person's act on the offer retries.
 */
function applyReactiveDefaultsAfterStart(started: CampaignRow, req: AuthenticatedRequest): void {
  if (!started.offerId || !started.legKey || !started.brandId || !req.userId || !req.runId) return;
  // A SOURCE campaign is not the offer's proactive campaign: turning one on switches nothing else on.
  if (isSourceOriginSlug(started.featureSlug)) return;
  const { offerId, legKey, brandId, orgId } = started;
  void (async () => {
    const catalogue = await fetchChannelCatalogue();
    if (!catalogue.ok) throw new ReactiveDefaultsUnavailableError(`channel catalogue: ${catalogue.detail}`);
    if (!isEntryLeg(catalogue, legKey)) return;
    const result = await applyReactiveDefaults({ orgId, brandId, offerId }, req, catalogue);
    if (result.started.length > 0) {
      console.log(
        `[campaign-service] Reactive defaults ON for offer ${offerId} after campaign ${started.id} started: ${result.started.map((c) => c.id).join(", ")}`,
      );
    }
  })().catch((err) => {
    console.error(`[campaign-service] Reactive defaults NOT applied for offer ${offerId} after campaign ${started.id} started:`, err);
  });
}

// === Scheduler routes (API-key authed, must be before :id routes) ===

/**
 * GET /campaigns/list - List all campaigns across all orgs (for scheduler)
 */
router.get("/campaigns/list", requireApiKey, async (_req, res) => {
  try {
    const allCampaigns = await db
      .select()
      .from(campaigns)
      .orderBy(campaigns.createdAt);

    res.json({ campaigns: allCampaigns });
  } catch (error) {
    console.error("[campaign-service] List all campaigns error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// === User routes (service-auth) ===

/**
 * GET /campaigns - List all campaigns for org
 *
 * Supports filtering by brandId, status, workflowSlug, featureSlug, and an optional limit.
 *
 * `status` takes the vocabulary the column actually stores — `ongoing` or `stopped`. Anything
 * else is a 400 from CampaignsFilterQuery: a caller who asks for "running" gets told so, rather
 * than the whole list back with their filter quietly dropped.
 *
 * `limit` is absent for every existing consumer, and absent means every match, unchanged. When
 * a caller states one, the response carries `hasMore` so a truncated list reads as truncated.
 */
router.get("/campaigns", requireApiKey, serviceAuth, validateQuery(CampaignsFilterQuery), async (req: AuthenticatedRequest, res) => {
  try {
    const {
      brandId, status, workflowSlug, featureSlug, offerId, legKey, limit,
    } = CampaignsFilterQuery.parse(req.query);

    const conditions = [eq(campaigns.orgId, req.orgId!)];

    if (brandId) conditions.push(arrayContains(campaigns.brandIds, [brandId]));
    if (status) conditions.push(eq(campaigns.status, status));
    if (workflowSlug) conditions.push(eq(campaigns.workflowSlug, workflowSlug));
    if (featureSlug) conditions.push(eq(campaigns.featureSlug, featureSlug));
    // Together with featureSlug (the channel) these find a campaign by (offer, leg, channel) —
    // what a campaign IS.
    if (offerId) conditions.push(eq(campaigns.offerId, offerId));
    if (legKey) conditions.push(eq(campaigns.legKey, legKey));

    const query = db
      .select()
      .from(campaigns)
      .where(and(...conditions))
      .orderBy(desc(campaigns.createdAt));

    // One row past the cap tells us whether there is a next page without a second count query.
    const rows = limit === undefined ? await query : await query.limit(limit + 1);

    if (limit === undefined) {
      return res.json({ campaigns: rows });
    }

    res.json({ campaigns: rows.slice(0, limit), hasMore: rows.length > limit });
  } catch (error) {
    console.error("[campaign-service] List campaigns error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /campaigns/:id - Get a specific campaign
 */
router.get("/campaigns/:id", requireApiKey, serviceAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { id } = req.params;

    const campaign = await db.query.campaigns.findFirst({
      where: and(
        eq(campaigns.id, id),
        eq(campaigns.orgId, req.orgId!)
      ),
    });

    if (!campaign) {
      console.warn(`[campaign-service] GET /campaigns/:id 404 — id=${id}, x-org-id=${req.orgId}`);
      return res.status(404).json({ error: "Campaign not found" });
    }

    res.json({ campaign });
  } catch (error) {
    console.error("[campaign-service] Get campaign error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * POST /campaigns - Create a new campaign
 */
router.post("/campaigns", requireApiKey, serviceAuth, validateBody(CreateCampaignBody), async (req: AuthenticatedRequest, res) => {
  try {
    const {
      name,
      workflowSlug,
      brandIds,
      featureSlug: bodyFeatureSlug,
      featureInputs,
      activeGoalId,
      brandProfileId,
      audienceId,
      offerId,
      legKey,
      audienceIds,
      servicesOffered,
      clickDestinationUrl,
      maxBudgetDailyUsd,
      maxBudgetWeeklyUsd,
      maxBudgetMonthlyUsd,
      maxBudgetTotalUsd,
      dailyBudgetCents,
      maxLeads,
      startDate,
      endDate,
      notifyFrequency,
      notifyChannel,
      notifyDestination,
    } = req.body;

    // featureSlug comes exclusively from x-feature-slug header
    const resolvedFeatureSlug = req.featureSlug || "";

    // A sales campaign IS (offer, leg, channel): it states the offer it sells and the leg it is
    // bought for, at birth, because that is what billing funds it at. Nothing is inferred — a sales
    // campaign stating neither is a row no ceiling can ever be matched to, so this is a hard 400.
    if (isSalesFamilyFeature(resolvedFeatureSlug) && (!offerId || !legKey)) {
      return res.status(400).json({
        error: `Cannot create a ${resolvedFeatureSlug} campaign without stating the offer it sells ` +
          `and the leg it is bought for — offerId and legKey are required`,
      });
    }

    // A SOURCE campaign (lib/source-campaigns.ts) is turned on through ONE path:
    // POST /campaigns/start-funded-pair {brandId, offerId, featureSlug: <origin>, legKey:
    // "start_to_lead_found"} (first On creates it), then PATCH /campaigns/:id status=stop|activate.
    if (isSourceOriginSlug(resolvedFeatureSlug)) {
      return res.status(400).json({
        error: `A ${resolvedFeatureSlug} campaign is a lead source: turn it on with ` +
          `POST /campaigns/start-funded-pair (featureSlug + offerId + legKey "${SOURCE_LEG_KEY}").`,
        reason: "source_campaign_via_start_pair",
      });
    }

    // A sales campaign paces on billing's ceiling, never on a column of its own — see
    // salesMaxBudgetRefusal. Refused at the door so no new inert value can appear.
    const createMaxBudgetRefusal = salesMaxBudgetRefusal(resolvedFeatureSlug, req.body);
    if (createMaxBudgetRefusal) {
      return res.status(400).json({ error: createMaxBudgetRefusal });
    }

    // WHICH workflow a campaign is born on. A channel another service performs on an event
    // (ai-instant-call) has NO workflow by design: one stated for it is refused, never stored, and
    // its campaign is never scheduled or dispatched. Every other channel must state one.
    const servicePerformed = isServicePerformedFeature(resolvedFeatureSlug);
    if (servicePerformed && workflowSlug) {
      return res.status(400).json({
        error: `A ${resolvedFeatureSlug} campaign has no workflow: another service performs it when ` +
          `a lead reaches its step. Omit workflowSlug.`,
        reason: "workflow_not_applicable",
      });
    }
    if (!servicePerformed && !workflowSlug) {
      return res.status(400).json({ error: "workflowSlug is required", reason: "workflow_required" });
    }
    const storedWorkflowSlug: string | null = servicePerformed ? null : workflowSlug;

    // Validate all required workflow fields BEFORE creating the campaign
    const brandIdCsv = (brandIds as string[]).join(",");
    const preCheckInputs = {
      campaignId: "pending",  // will be assigned after insert
      orgId: req.orgId!,
      brandId: brandIdCsv || "",
      userId: req.userId || "",
      runId: req.runId || "",
      featureSlug: resolvedFeatureSlug,
    };
    const missing = validateWorkflowInputs(preCheckInputs);
    // campaignId is always "pending" here — exclude it from the check
    const actualMissing = missing.filter((f) => f !== "campaignId");
    if (actualMissing.length > 0) {
      const headerMap: Record<string, string> = {
        userId: "x-user-id", runId: "x-run-id", brandId: "x-brand-id",
        featureSlug: "x-feature-slug", orgId: "x-org-id",
      };
      const missingHeaders = actualMissing.map((f) => headerMap[f] || f);
      return res.status(400).json({
        error: `Cannot create campaign — missing required headers for workflow execution: ${missingHeaders.join(", ")}`,
      });
    }

    if (req.runId) {
      traceEvent(req.runId, {
        service: "campaign-service",
        event: "create-campaign",
        detail: `Creating campaign "${name}" — workflowSlug=${workflowSlug}, brandIds=[${brandIds}], featureSlug=${resolvedFeatureSlug}`,
        data: { name, workflowSlug, brandIds, featureSlug: resolvedFeatureSlug },
      }, req.headers).catch(() => {});
    }

    // A campaign is unique on (org, brand, offer, leg, acquisition channel). The WORKFLOW is not
    // part of that identity: a campaign changes workflow whenever selection picks a better one, and
    // it is not replaced by a new campaign each time it does. Creating one per workflow is what grew
    // a single brand 137 rows — one per workflow version — each holding a slice of a history nobody
    // could read as one campaign. So a create that names an identity already alive UPDATES that
    // campaign to the requested workflow and configuration and hands it back.
    // Every path through this route ends with a campaign ONGOING, so an org whose card billing
    // cannot charge is refused before anything is matched or written (lib/payment-hold.ts).
    const createRefusal = await paymentStartRefusal(req.orgId!);
    if (createRefusal) return res.status(createRefusal.status).json(createRefusal.body);

    const identity = campaignIdentityColumns({ brandIds, featureSlug: resolvedFeatureSlug });
    // The OFFER is part of the identity: a customer funds their money per offer, so two offers
    // worked through one (channel, leg) are two ceilings and must be able to be two
    // campaigns — a create stating a different offer is a NEW campaign, not a restatement of the
    // live one. It is matched in two steps so that widening can only ever LOOSEN: the campaign of
    // THIS offer wins, and only when there is none does an offer-LESS incumbent match, which is
    // exactly what happened before this field was part of the key (and which is how such a campaign
    // learns the offer it sells from a caller that now states one).
    //
    // AND the row is matched WHATEVER ITS STATUS. A campaign the customer stopped is still their
    // campaign for this identity: creating a second one beside it is how a brand ended up with two
    // identical live campaigns, and how a deliberately-stopped campaign was left invisible while a
    // twin spent its money. `uniq_campaigns_org_brand_offer_leg_channel` is partial on `ongoing`, so
    // Postgres cannot police that on its own and never will — production carries 663 stopped rows
    // sharing 33 identities from before this was one campaign, and history is never rewritten. So
    // the guard is HERE, and the index stays the backstop for the live case.
    //
    // A create matching a STOPPED row is the customer launching it: this route is only ever a
    // person's explicit act (onboarding launch, the dashboard), so it hands the campaign back
    // ongoing and due. That is the one thing allowed to move a status.
    const findIncumbent = (matchOffer: boolean) =>
      db.query.campaigns.findFirst({
        where: and(
          eq(campaigns.orgId, req.orgId!),
          eq(campaigns.brandId, identity.brandId!),
          eq(campaigns.acquisitionChannel, identity.acquisitionChannel!),
          // The LEG it is bought for. A campaign bought for one leg is not the campaign
          // bought for another, so a create stating a different leg is a NEW campaign rather
          // than a restatement of the live one — which is the only way a brand can work one
          // channel for two legs at once. A create that states NO leg matches the leg-less row
          // exactly as it did before the field existed.
          legKey ? eq(campaigns.legKey, legKey) : isNull(campaigns.legKey),
          matchOffer && offerId ? eq(campaigns.offerId, offerId) : undefined,
          matchOffer ? undefined : isNull(campaigns.offerId),
        ),
        // The LIVE campaign of the identity wins over a stopped one whatever their dates; among
        // stopped rows the most recent is the one the customer last worked with.
        orderBy: [desc(sql`(${campaigns.status} = 'ongoing')`), desc(campaigns.createdAt)],
      });
    const hasIdentity = !!identity.brandId && !!identity.acquisitionChannel;
    let incumbent: Awaited<ReturnType<typeof findIncumbent>> | null = null;
    if (hasIdentity) {
      incumbent = (await findIncumbent(true)) ?? null;
      if (!incumbent && offerId) incumbent = (await findIncumbent(false)) ?? null;
    }

    if (incumbent) {
      // Only what the caller actually sent moves. The NAME is deliberately left alone: it is the
      // campaign's own label (and unique per org), not a restatement of which workflow is running.
      // This create IS the customer starting the campaign — the onboarding launch and the
      // dashboard are the only callers, and both are a person pressing a button. A campaign they
      // had stopped comes back here and NOWHERE else: no sweep, no ceiling, no condition. It goes
      // through setCampaignStatus because every status change leaves a trace, in the same
      // transaction as the change itself.
      const { campaign: restarted, stopped } = await setCampaignStatusWithStops({
        campaignId: incumbent.id,
        orgId: req.orgId!,
        fromStatus: incumbent.status,
        toStatus: "ongoing",
        reason: null,
        source: TRANSITION_SOURCES.CREATE_RESTART,
        actor: personActor(req),
        displace: displaceOtherProactive,
        fields: {
          workflowSlug: storedWorkflowSlug,
          // A workflow-less campaign is never due: nothing schedules it.
          nextRunAt: storedWorkflowSlug ? new Date() : null,
          ...(featureInputs !== undefined ? { featureInputs } : {}),
          ...(activeGoalId !== undefined ? { activeGoalId } : {}),
          ...(brandProfileId !== undefined ? { brandProfileId } : {}),
          ...(audienceId !== undefined ? { audienceId } : {}),
          // An incumbent campaign learns which offer it sells from a caller that now states one.
          // Only when the caller actually sent it: a create that says nothing about the offer
          // must not blank the one already on the row.
          ...(offerId !== undefined ? { offerId } : {}),
          // Same rule for the leg it is bought for: an incumbent learns it from a caller that now
          // states one, and a create saying nothing about the leg must not blank the row's.
          ...(legKey !== undefined ? { legKey } : {}),
          ...(audienceIds !== undefined ? { audienceIds } : {}),
          ...(servicesOffered !== undefined ? { servicesOffered } : {}),
          ...(clickDestinationUrl !== undefined ? { clickDestinationUrl } : {}),
          ...(maxBudgetDailyUsd !== undefined ? { maxBudgetDailyUsd } : {}),
          ...(maxBudgetWeeklyUsd !== undefined ? { maxBudgetWeeklyUsd } : {}),
          ...(maxBudgetMonthlyUsd !== undefined ? { maxBudgetMonthlyUsd } : {}),
          ...(maxBudgetTotalUsd !== undefined ? { maxBudgetTotalUsd } : {}),
          ...(dailyBudgetCents !== undefined ? { dailyBudgetCents } : {}),
          ...(maxLeads !== undefined ? { maxLeads } : {}),
          ...(startDate !== undefined ? { startDate } : {}),
          ...(endDate !== undefined ? { endDate } : {}),
          ...(notifyFrequency !== undefined ? { notifyFrequency } : {}),
          ...(notifyChannel !== undefined ? { notifyChannel } : {}),
          ...(notifyDestination !== undefined ? { notifyDestination } : {}),
        },
      });
      const updated = restarted!;

      if (req.runId) {
        traceEvent(req.runId, {
          service: "campaign-service",
          event: "campaign-workflow-changed",
          detail: `Campaign ${updated.id} already runs this (brand, offer, leg, channel) — switched its workflow to "${workflowSlug}" instead of creating a second campaign`,
          data: { campaignId: updated.id, workflowSlug, brandId: identity.brandId, acquisitionChannel: identity.acquisitionChannel },
        }, req.headers).catch(() => {});
      }

      // Every campaign created or updated through this route states a workflow (the request
      // schema requires one), so this is the ordinary path. The guard is what keeps a
      // workflow-less row — a channel the customer operates, provisioned with no DAG — from ever
      // being handed to workflow-service.
      // The stored slug is the selector's FALLBACK, never what runs by fiat: the leg's model rule
      // binds this run exactly as it binds a scheduled one (see dispatchSelectedRun).
      if (updated.workflowSlug) dispatchSelectedRun(
        { ...updated, workflowSlug: updated.workflowSlug, featureSlug: updated.featureSlug! },
        { orgId: req.orgId!, userId: req.userId!, runId: req.runId! },
      ).catch((err) => {
        console.error(`[campaign-service] Failed to trigger workflow for campaign ${updated.id}:`, err);
      });

      applyReactiveDefaultsAfterStart(updated, req);
      wakeScheduler();
      return res.status(200).json({ campaign: updated, stoppedCampaigns: stopped.map(stoppedCampaignSummary) });
    }

    // The campaign and its BIRTH are written together. A status that lands without a trace is a
    // day nobody can ever replay, and it is invisible — nothing errors, no test goes red — so the
    // two are one transaction rather than a convention.
    let stoppedOnCreate: CampaignRow[] = [];
    const campaign = await db.transaction(async (tx) => {
      const [inserted] = await tx
      .insert(campaigns)
      .values({
        ...identity,
        orgId: req.orgId!,
        createdByUserId: req.userId ?? null,
        parentRunId: req.runId ?? null,
        name,
        workflowSlug: storedWorkflowSlug,
        brandIds,
        featureSlug: resolvedFeatureSlug,
        featureInputs,
        activeGoalId: activeGoalId ?? null,
        brandProfileId: brandProfileId ?? null,
        audienceId: audienceId ?? null,
        // The offer this campaign sells, as STATED by its creator. Absent → NULL; nothing is
        // inferred from the goal or the workflow.
        offerId: offerId ?? null,
        // The single LEG this campaign is bought for, as STATED by its creator — verbatim, in
        // features-service's vocabulary. Absent → NULL; nothing is inferred from the channel or
        // the workflow.
        legKey: legKey ?? null,
        audienceIds: audienceIds ?? null,
        servicesOffered: servicesOffered ?? null,
        clickDestinationUrl: clickDestinationUrl ?? null,
        maxBudgetDailyUsd,
        maxBudgetWeeklyUsd,
        maxBudgetMonthlyUsd,
        maxBudgetTotalUsd,
        dailyBudgetCents: dailyBudgetCents ?? null,
        maxLeads,
        startDate,
        endDate,
        notifyFrequency,
        notifyChannel,
        notifyDestination,
        status: "ongoing",
      })
      .returning();

      await tx
        .insert(campaignStatusTransitions)
        .values(campaignBirthTransition(inserted.id, req.orgId!, inserted.status));

      stoppedOnCreate = await stopProactiveReplacedBy(tx, inserted);
      return inserted;
    });
    signalDisplacedStops(stoppedOnCreate, personActor(req));

    if (req.runId) {
      traceEvent(req.runId, {
        service: "campaign-service",
        event: "campaign-created",
        detail: `Campaign created id=${campaign.id}, triggering workflow "${campaign.workflowSlug}"`,
        data: { campaignId: campaign.id, workflowSlug: campaign.workflowSlug },
      }, req.headers).catch(() => {});
    }

    // Trigger first workflow execution (fire-and-forget). The first run goes through the same
    // selection as every later one — the stored slug is only the fallback (see
    // dispatchSelectedRun), so a workflow the leg's rule excludes never runs even once.
    if (campaign.workflowSlug) dispatchSelectedRun(
      { ...campaign, workflowSlug: campaign.workflowSlug, featureSlug: campaign.featureSlug! },
      { orgId: req.orgId!, userId: req.userId!, runId: req.runId! },
    ).catch((err) => {
      console.error(`[campaign-service] Failed to trigger initial workflow for campaign ${campaign.id}:`, err);
    });

    // A person created it ongoing: billing hears it like a restart (fire-and-forget).
    signalCampaignBirth(campaign, personActor(req));
    applyReactiveDefaultsAfterStart(campaign, req);

    // New ongoing campaign → wake the scheduler so it resumes monitoring from idle.
    wakeScheduler();

    res.status(201).json({ campaign, stoppedCampaigns: stoppedOnCreate.map(stoppedCampaignSummary) });
  } catch (error: any) {
    if (proactiveRefusal(error, res)) return;
    const constraint = error?.constraint ?? error?.constraint_name;
    if (error?.code === "23505" && constraint === "uniq_campaigns_org_name") {
      return res.status(409).json({ error: "A campaign with this name already exists in your organization" });
    }
    // Two creates raced the same identity. The loser does not get a second campaign for it — the
    // one that won IS this identity's campaign, so hand that one back rather than an error.
    if (error?.code === "23505" && constraint === "uniq_campaigns_org_brand_offer_leg_channel") {
      const winner = await db.query.campaigns.findFirst({
        where: and(
          eq(campaigns.orgId, req.orgId!),
          eq(campaigns.status, "ongoing"),
          eq(campaigns.brandId, (req.body.brandIds as string[])[0]),
          eq(campaigns.acquisitionChannel, acquisitionChannelForFeature(req.featureSlug)!),
          // The leg is part of the identity that collided, so it is part of finding the winner —
          // otherwise the loser is handed back a campaign bought for a different leg.
          req.body.legKey ? eq(campaigns.legKey, req.body.legKey) : isNull(campaigns.legKey),
          // The offer is part of the identity that collided too, for the same reason: otherwise the
          // loser is handed back a campaign selling a different offer, on different money.
          req.body.offerId ? eq(campaigns.offerId, req.body.offerId) : isNull(campaigns.offerId),
        ),
        orderBy: [campaigns.createdAt],
      });
      if (winner) return res.status(200).json({ campaign: winner, stoppedCampaigns: [] });
    }
    console.error("[campaign-service] Create campaign error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});


/**
 * Fire this campaign's first run, the same way every other person-pressed-start does.
 *
 * Fire-and-forget: the customer's answer is the campaign, not the run. The guard on the slug is
 * what keeps a workflow-less row — a channel the CUSTOMER operates, which has no DAG on purpose —
 * from ever being handed to workflow-service.
 */
function dispatchFirstRun(
  campaign: typeof campaigns.$inferSelect,
  req: AuthenticatedRequest,
): void {
  if (!campaign.workflowSlug) return;
  dispatchSelectedRun(
    { ...campaign, workflowSlug: campaign.workflowSlug, featureSlug: campaign.featureSlug! },
    { orgId: req.orgId!, userId: req.userId!, runId: req.runId! },
  ).catch((err) => {
    console.error(`[campaign-service] Failed to trigger first run for campaign ${campaign.id}:`, err);
  });
}

/**
 * POST /campaigns/start-funded-pair — the CUSTOMER starts the campaign for a pair they fund.
 *
 * Money starts nothing, and this does not change that: a funded ceiling still provisions no
 * campaign on its own, there is still no sweep, and nothing here runs unless a person pressed a
 * button. What this closes is the other half of that decision — until now the only two things that
 * brought a campaign into being were onboarding's terminal launch and the staff console, so a
 * customer who funded a channel AFTER signup got a ceiling, no campaign, and no way to ask for one.
 *
 * The caller states only what their own screen knows: which brand, which offer, which leg, which
 * acquisition channel. It cannot state the other three and must not be asked to:
 *
 *   - the WORKFLOW is this service's choice (re-picked every run by the greedy rotation), and a
 *     slug resolved in a browser would go stale the moment the catalogue moves;
 *   - the NAME is derivable from the identity;
 *   - the MONEY is billing's, per (offer x leg x channel), and is already set. That is
 *     what "funded" means, and a per-campaign ceiling here would be a second representation of it.
 *     The body is `.strict()`, so a caller reaching for any of the three is told no.
 *
 * A pair that cannot be started is REFUSED in a sentence a person can read, because the dashboard
 * renders it verbatim — "nothing can run that channel yet", "you haven't funded it", "this channel
 * doesn't perform that step" are three different answers and a customer is owed the right one.
 *
 * A pair that ALREADY has a campaign never gets a second one: the incumbent of the identity is
 * matched whatever its status, exactly as `POST /campaigns` matches it and for the same reason
 * (`uniq_campaigns_org_brand_offer_leg_channel` is partial on `ongoing` and can never police the
 * stopped rows). A live one is handed back untouched; a stopped one is started, because that IS
 * what the person just asked for.
 */
router.post("/campaigns/start-funded-pair", requireApiKey, serviceAuth, validateBody(StartFundedPairBody), async (req: AuthenticatedRequest, res) => {
  try {
    const { brandId, offerId: bodyOfferId, featureSlug, legKey: bodyLegKey } =
      StartFundedPairBody.parse(req.body);
    const offerId = bodyOfferId ?? null;

    // workflow-service REFUSES a read that does not state a full identity, whatever the caller is
    // doing, so the two headers it needs are required here rather than discovered downstream. The
    // run id is the customer request's own — one runs-service can resolve — never a minted uuid.
    if (!req.userId || !req.runId) {
      const missing = [!req.userId ? "x-user-id" : null, !req.runId ? "x-run-id" : null].filter(Boolean);
      return res.status(400).json({
        error: `Cannot start a campaign — missing required headers: ${missing.join(", ")}`,
      });
    }
    const identity = { orgId: req.orgId!, userId: req.userId, runId: req.runId, brandId };

    // A pair of an org whose card billing cannot charge is never started (lib/payment-hold.ts).
    const startRefusal = await paymentStartRefusal(req.orgId!);
    if (startRefusal) return res.status(startRefusal.status).json(startRefusal.body);

    const resolved = await resolveStartablePair(
      { brandId, offerId, featureSlug, legKey: bodyLegKey ?? null },
      identity,
    );
    if (!resolved.ok) {
      const { status, code, message } = resolved.refusal;
      console.warn(
        `[campaign-service] Not starting funded pair — org=${req.orgId} brand=${brandId} ` +
        `leg=${bodyLegKey ?? "none"} channel=${featureSlug} offer=${offerId ?? "none"}: ${code}`,
      );
      return res.status(status).json({ error: message, reason: code });
    }
    const { legKey, ceilingCents, workflowSlug } = resolved.pair;

    const identityColumns = campaignIdentityColumns({ brandIds: [brandId], featureSlug });
    const acquisitionChannel = identityColumns.acquisitionChannel!;

    // Every campaign this identity has ever had, live or stopped, whose offer and leg this start
    // could be about: the ones that NAME them, and the ones that state none (a campaign that
    // predates either field is still this pair's campaign, and learns the value here rather than
    // being twinned by a second row doing the same job).
    const siblings = await db.query.campaigns.findMany({
      where: and(
        eq(campaigns.orgId, req.orgId!),
        eq(campaigns.brandId, brandId),
        eq(campaigns.acquisitionChannel, acquisitionChannel),
        // The campaign that NAMES this (offer, leg) is this pair's campaign.
        eq(campaigns.offerId, offerId!),
        eq(campaigns.legKey, legKey),
      ),
    });

    // An exact statement outranks a silent one, a live campaign outranks a stopped one, and the
    // most recent stopped row is the one the customer last worked with.
    const rank = (c: typeof siblings[number]) =>
      (c.offerId === offerId ? 8 : 0)
      + (c.legKey === legKey ? 4 : 0)
      + (c.status === "ongoing" ? 2 : 0);
    const incumbent = siblings.sort((a, b) => {
      const byRank = rank(b) - rank(a);
      if (byRank !== 0) return byRank;
      return (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0);
    })[0] ?? null;

    // What an incumbent LEARNS from a caller that now states it. Only ever filled in: a value
    // already on the row is never overwritten, and nothing is stamped that the caller did not say.
    const learned: Record<string, unknown> = {};
    if (offerId && !incumbent?.offerId) learned.offerId = offerId;
    if (legKey && !incumbent?.legKey) learned.legKey = legKey;

    if (incumbent && incumbent.status === "ongoing") {
      // Already running. There is nothing to start and there is certainly not a second campaign to
      // create — the customer's screen simply had not caught up. The person still said "this one",
      // so the offer's OTHER proactive campaign stops (lib/single-proactive.ts).
      let stopped: CampaignRow[] = [];
      const campaign = await db.transaction(async (tx) => {
        const row = Object.keys(learned).length > 0
          ? (await tx.update(campaigns)
              .set({ ...learned, updatedAt: new Date() })
              .where(eq(campaigns.id, incumbent.id))
              .returning())[0]!
          : incumbent;
        stopped = await stopProactiveReplacedBy(tx, row);
        return row;
      });
      signalDisplacedStops(stopped, personActor(req));
      return res.status(200).json({
        campaign, started: false, alreadyRunning: true, ceilingCents, stoppedCampaigns: stopped.map(stoppedCampaignSummary),
      });
    }

    if (incumbent) {
      // A campaign the customer stopped, started again because they just asked for it. This is the
      // one thing allowed to move a status, and it goes through setCampaignStatus so the change and
      // its trace land in one transaction.
      const restarted = await setCampaignStatusWithStops({
        campaignId: incumbent.id,
        orgId: req.orgId!,
        fromStatus: incumbent.status,
        toStatus: "ongoing",
        reason: null,
        source: TRANSITION_SOURCES.START_FUNDED_PAIR,
        actor: personActor(req),
        displace: displaceOtherProactive,
        fields: { ...learned, workflowSlug, nextRunAt: new Date() },
      });
      const campaign = restarted.campaign!;

      dispatchFirstRun(campaign, req);
      applyReactiveDefaultsAfterStart(campaign, req);
      wakeScheduler();
      return res.status(200).json({
        campaign, started: true, alreadyRunning: false, ceilingCents,
        stoppedCampaigns: restarted.stopped.map(stoppedCampaignSummary),
      });
    }

    const now = new Date();
    let stoppedOnBirth: CampaignRow[] = [];
    const campaign = await db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(campaigns)
        .values({
          ...identityColumns,
          orgId: req.orgId!,
          createdByUserId: req.userId ?? null,
          parentRunId: req.runId ?? null,
          name: derivedCampaignName(featureSlug, brandId, offerId, legKey),
          workflowSlug,
          brandIds: [brandId],
          featureSlug,
          offerId,
          legKey,
          featureInputs: null,
          status: "ongoing",
          // A campaign with no DAG is a channel the CUSTOMER operates: it is never claimed, never
          // triggered and never spends, and `next_run_at IS NULL` is its permanent resting state.
          nextRunAt: workflowSlug ? now : null,
          updatedAt: now,
        })
        .returning();

      await tx
        .insert(campaignStatusTransitions)
        .values(campaignBirthTransition(inserted.id, req.orgId!, inserted.status));

      stoppedOnBirth = await stopProactiveReplacedBy(tx, inserted);
      return inserted;
    });

    signalCampaignBirth(campaign, personActor(req));
    signalDisplacedStops(stoppedOnBirth, personActor(req));
    dispatchFirstRun(campaign, req);
    applyReactiveDefaultsAfterStart(campaign, req);
    wakeScheduler();
    return res.status(201).json({
      campaign, started: true, alreadyRunning: false, ceilingCents, stoppedCampaigns: stoppedOnBirth.map(stoppedCampaignSummary),
    });
  } catch (error: any) {
    if (proactiveRefusal(error, res)) return;
    const constraint = error?.constraint ?? error?.constraint_name;
    // Two starts raced the same pair. The loser does not get a second campaign for it — whoever
    // won IS this identity's campaign, so hand that one back rather than an error.
    if (error?.code === "23505"
      && (constraint === "uniq_campaigns_org_name" || constraint === "uniq_campaigns_org_brand_offer_leg_channel")) {
      const winner = await db.query.campaigns.findFirst({
        where: and(
          eq(campaigns.orgId, req.orgId!),
          eq(campaigns.status, "ongoing"),
          eq(campaigns.brandId, req.body.brandId),
          eq(campaigns.acquisitionChannel, acquisitionChannelForFeature(req.body.featureSlug)!),
          // The offer and the leg are part of the identity that collided, so they are part of
          // finding the winner — otherwise the loser is handed a campaign selling a different
          // proposition on different money.
          eq(campaigns.legKey, req.body.legKey),
          eq(campaigns.offerId, req.body.offerId),
        ),
        orderBy: [campaigns.createdAt],
      });
      if (winner) return res.status(200).json({ campaign: winner, started: false, alreadyRunning: true, stoppedCampaigns: [] });
    }
    console.error("[campaign-service] Start funded pair error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * POST /offers/:offerId/reactive-defaults — a PERSON saved the offer's sales paths: switch ON
 * every reactive campaign a ticked path uses that has no campaign yet (lib/reactive-defaults.ts).
 * A stopped one stays stopped; nothing is stopped. Same payment-hold refusal as every start.
 */
router.post("/offers/:offerId/reactive-defaults", requireApiKey, serviceAuth, validateBody(ReactiveDefaultsBody), async (req: AuthenticatedRequest, res) => {
  try {
    const { brandId } = ReactiveDefaultsBody.parse(req.body);
    const { offerId } = req.params;
    if (!req.userId || !req.runId) {
      const missing = [!req.userId ? "x-user-id" : null, !req.runId ? "x-run-id" : null].filter(Boolean);
      return res.status(400).json({ error: `Cannot switch on reactive campaigns — missing required headers: ${missing.join(", ")}` });
    }
    const refusal = await paymentStartRefusal(req.orgId!);
    if (refusal) return res.status(refusal.status).json(refusal.body);
    return res.status(200).json(await applyReactiveDefaults({ orgId: req.orgId!, brandId, offerId }, req));
  } catch (error) {
    if (error instanceof ReactiveDefaultsUnavailableError) {
      console.error(`[campaign-service] Reactive defaults unavailable: ${error.message}`);
      return res.status(502).json({
        error: "We couldn't read this offer's sales paths just now. Please try again in a minute.",
        reason: "sales_paths_unavailable",
      });
    }
    console.error("[campaign-service] Reactive defaults error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * PATCH /campaigns/:id - Update a campaign (including status: "active" | "stopped")
 */
router.patch("/campaigns/:id", requireApiKey, serviceAuth, validateBody(UpdateCampaignBody), async (req: AuthenticatedRequest, res) => {
  try {
    const { id } = req.params;

    const existing = await db.query.campaigns.findFirst({
      where: and(
        eq(campaigns.id, id),
        eq(campaigns.orgId, req.orgId!)
      ),
    });

    if (!existing) {
      return res.status(404).json({ error: "Campaign not found" });
    }

    // Same refusal as the create leg, against the feature this update LEAVES the campaign on
    // (the body's when it restates one, the row's otherwise).
    const updateMaxBudgetRefusal = salesMaxBudgetRefusal(
      req.body.featureSlug ?? existing.featureSlug,
      req.body,
    );
    if (updateMaxBudgetRefusal) {
      return res.status(400).json({ error: updateMaxBudgetRefusal });
    }

    // Validate required workflow fields BEFORE activating
    if (req.body.status === "activate") {
      const preActivateInputs = {
        campaignId: id,
        orgId: req.orgId!,
        brandId: (existing.brandIds ?? []).join(",") || "",
        userId: req.userId || "",
        runId: req.runId || "",
        featureSlug: req.featureSlug || "",
      };
      const missingActivate = validateWorkflowInputs(preActivateInputs);
      if (missingActivate.length > 0) {
        const headerMap: Record<string, string> = {
          userId: "x-user-id", runId: "x-run-id", brandId: "x-brand-id",
          featureSlug: "x-feature-slug", orgId: "x-org-id", campaignId: "campaignId",
        };
        const missingHeaders = missingActivate.map((f) => headerMap[f] || f);
        return res.status(400).json({
          error: `Cannot activate campaign — missing required headers for workflow execution: ${missingHeaders.join(", ")}`,
        });
      }
    }

    // Starting a campaign of an org whose card billing cannot charge is refused, whatever stopped
    // it — a campaign stopped by hand is just as unfunded (lib/payment-hold.ts).
    if (req.body.status === "activate") {
      const activateRefusal = await paymentStartRefusal(req.orgId!);
      if (activateRefusal) return res.status(activateRefusal.status).json(activateRefusal.body);
    }

    if (req.runId) {
      traceEvent(req.runId, {
        service: "campaign-service",
        event: "update-campaign",
        detail: `Updating campaign ${id} — fields: ${Object.keys(req.body).join(", ")}`,
        data: { campaignId: id, fields: Object.keys(req.body) },
      }, req.headers).catch(() => {});
    }

    const statusMap: Record<string, string> = { activate: "ongoing", stop: "stopped" };
    const { status: requestedStatus, ...bodyFields } = req.body as Record<string, unknown> & {
      status?: string;
    };

    let updated;
    let stoppedByActivation: CampaignRow[] | null = null;
    if (requestedStatus) {
      // A person stopping a campaign is a decision, and it says so on the row: `manual` is the
      // customer's own statement. Activating clears the reason — the stop it described is over.
      // The change and its trace are written in ONE transaction, in the one place that can.
      // Turning one ON stops the offer's other proactive campaign in the same transaction
      // (lib/single-proactive.ts); stopping one stops nothing else.
      const written = await setCampaignStatusWithStops({
        campaignId: id,
        orgId: req.orgId!,
        fromStatus: existing.status,
        toStatus: statusMap[requestedStatus] ?? requestedStatus,
        reason: requestedStatus === "stop" ? STOP_REASONS.MANUAL : null,
        source: TRANSITION_SOURCES.PATCH,
        actor: personActor(req),
        fields: bodyFields,
        ...(requestedStatus === "activate" ? { displace: displaceOtherProactive } : {}),
      });
      updated = written.campaign!;
      if (requestedStatus === "activate") stoppedByActivation = written.stopped;
    } else {
      [updated] = await db
        .update(campaigns)
        .set({ ...bodyFields, updatedAt: new Date() })
        .where(eq(campaigns.id, id))
        .returning();
    }

    // Trigger workflow on activation
    if (req.body.status === "activate") {
      // A campaign whose channel the customer operates carries no workflow: activating it makes
      // it ongoing (a live scope for their own work) and triggers nothing, because there is
      // nothing to trigger. Otherwise the activation run is SELECTED like every other run — the
      // stored slug is only the fallback (see dispatchSelectedRun).
      if (updated.workflowSlug) dispatchSelectedRun(
        { ...updated, workflowSlug: updated.workflowSlug, featureSlug: req.featureSlug! },
        { orgId: req.orgId!, userId: req.userId!, runId: req.runId! },
      ).catch((err) => {
        console.error(`[campaign-service] Failed to trigger workflow for campaign ${id}:`, err);
      });
      applyReactiveDefaultsAfterStart(updated, req);
      // Campaign just activated (status → ongoing) → wake the scheduler from idle.
      wakeScheduler();
    }

    res.json({
      campaign: updated,
      ...(stoppedByActivation ? { stoppedCampaigns: stoppedByActivation.map(stoppedCampaignSummary) } : {}),
    });
  } catch (error: any) {
    if (proactiveRefusal(error, res)) return;
    const updateConstraint = error?.constraint ?? error?.constraint_name;
    if (error?.code === "23505" && updateConstraint === "uniq_campaigns_org_name") {
      return res.status(409).json({ error: "A campaign with this name already exists in your organization" });
    }
    // Restating the leg or the offer can move a campaign onto an identity another live campaign
    // already holds.
    // That is a real conflict and it says so, rather than surfacing as an internal error.
    if (error?.code === "23505" && updateConstraint === "uniq_campaigns_org_brand_offer_leg_channel") {
      return res.status(409).json({
        error: "Another live campaign already runs this (brand, offer, leg, acquisition channel)",
      });
    }
    console.error("[campaign-service] Update campaign error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * DELETE /campaigns/:id - Delete a campaign
 */
router.delete("/campaigns/:id", requireApiKey, serviceAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { id } = req.params;

    const result = await db
      .delete(campaigns)
      .where(and(
        eq(campaigns.id, id),
        eq(campaigns.orgId, req.orgId!)
      ))
      .returning();

    if (result.length === 0) {
      return res.status(404).json({ error: "Campaign not found" });
    }

    res.json({ message: "Campaign deleted successfully" });
  } catch (error) {
    console.error("[campaign-service] Delete campaign error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
