import { Router } from "express";
import { eq, and, sql, or, ne, isNotNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { brandPauseTransitions, campaigns } from "../db/schema.js";
import { requireApiKey, requirePipelineHeaders, serviceAuth, trackingHeaders, type AuthenticatedRequest } from "../middleware/auth.js";
import { validateBody, validateQuery } from "../middleware/validate.js";
import { createRun, listRuns, updateRun, type IdentityHeaders } from "@distribute/runs-client";
import { runGateChecks } from "../lib/gate-check.js";
import { EarningHistoryBody, EarningHistoryQuery, EndRunBody, TransferBrandBody, TriggerForStepBody } from "../schemas.js";
import { wakeScheduler } from "../lib/scheduler.js";
import { traceEvent } from "../lib/trace-event.js";
import { fetchBrandRuntimeContext, type RuntimeGoal } from "../lib/brand-runtime-client.js";
import { markAudienceExhausted, resolveAudienceExhaustion, getFreshExhaustedAudienceIds, hasExhaustedAudience, NO_SERVEABLE_AUDIENCE_RECHECK_MS } from "../lib/audience-exhaustion.js";
import { recordAudienceAvailability } from "../lib/campaign-audience-availability.js";
import { stopOrgCampaignsWithHistory } from "../lib/campaign-status-history.js";
import { NO_WORK_RECHECK_MS } from "../lib/idle-run.js";
import { maybeSendExtendAudienceEmail } from "../lib/transactional-email.js";
import { serveableAudienceIdsForCampaign } from "../lib/serveable-audience.js";
import { STOP_REASONS } from "../lib/stop-reason.js";
import { triggerCampaignsForStep, StepTriggerScopeError } from "../lib/step-trigger.js";
import { resolvePredecessorCampaign, PredecessorScopeError } from "../lib/predecessor-campaign.js";
import { earningHistory, utcDaysBetween } from "../lib/earning-history.js";
import {
  fetchLegProjectionRows,
  fetchWorkflowProjectionRows,
  fetchGoalArbitration,
  selectAudienceFromProjection,
  type ProjectionRow,
} from "../lib/features-workflow-projection-client.js";
import type { DownstreamIdentity } from "../lib/downstream-headers.js";

const router = Router();

// Backoff applied to a BLOCKED gate result that carries no window nextRunAt of
// its own. Guarantees the campaign is not re-claimed + re-fired on the very next
// scheduler tick. A blocked gate NEVER stops a campaign — the condition that
// blocked it (out of credit, budget spent, lead cap) is a system condition, and
// only the customer changes a status — so every block ends in a re-check.
const GATE_BLOCK_BACKOFF_MS = 15 * 60_000; // 15 min

// Grace delay before a COMPLETED run becomes due for re-trigger.
//
// Why not 0: the campaign-service `/end-run` is fired by the ephemeral
// `campaign-service / <campaignId>` marker, which ends ~6s BEFORE the wrapping
// `workflow / execute-workflow` run (that run is tagged with the same campaignId).
// Setting nextRunAt=now + wakeScheduler() fired the next tick instantly, but the
// in-flight guard (scheduler.ts hasLiveRunForCampaign) still saw the tearing-down
// wrapper run as "alive" → skipped + rescheduled +60s. So an intended-instant
// re-run actually paid a flat ~60s idle tax EVERY lead (~110s/lead observed).
//
// A small grace lets the wrapper run finish before the re-run tick, so the guard
// sees no live run and re-fires cleanly (~40s/lead). If teardown ever exceeds the
// grace, the guard's +60s skip still applies — never worse than the old behavior.
// Does NOT touch the long-fill (cold-buffer up to ~755s) in-flight protection.
const RERUN_GRACE_MS = 10_000; // 10s

/**
 * POST /gate-check
 *
 * Checks whether a campaign is allowed to run a new iteration.
 * Validates brand daily budget pacing, legacy non-daily budget limits, volume limits,
 * and campaign status.
 *
 * Called as the first DAG node. Returns { allowed: true } to proceed
 * or { allowed: false, reason } to stop. The DAG uses stopAfterIf to
 * end the flow cleanly without triggering onError.
 *
 * Returns:
 *   200 — gate check result (allowed or blocked)
 *   400 — missing required headers
 *   404 — campaign not found
 *   500 — internal error
 */
router.post("/gate-check", requireApiKey, requirePipelineHeaders, trackingHeaders, async (req: AuthenticatedRequest, res) => {
  try {
    const campaignId = req.campaignId!;
    const orgId = req.orgId!;

    const campaign = await db.query.campaigns.findFirst({
      where: and(eq(campaigns.id, campaignId), eq(campaigns.orgId, orgId)),
    });
    if (!campaign) {
      console.warn(`[campaign-service] Campaign not found: ${campaignId}`);
      return res.status(404).json({ error: "Campaign not found" });
    }
    const resolvedBrandIds = (req.brandIds && req.brandIds.length > 0) ? req.brandIds : (campaign.brandIds ?? []);

    if (req.runId) {
      traceEvent(req.runId, {
        service: "campaign-service",
        event: "gate-check-start",
        detail: `Running gate checks for campaign ${campaignId} — status=${campaign.status}, brandIds=[${resolvedBrandIds.join(",")}]`,
        data: { campaignId, status: campaign.status, brandIds: resolvedBrandIds },
      }, req.headers).catch(() => {});
    }

    const result = await runGateChecks({
      campaignId,
      orgId,
      userId: req.userId,
      runId: req.runId,
      brandId: resolvedBrandIds.join(","),
      brandIds: resolvedBrandIds,
      workflowSlug: req.workflowSlug || campaign.workflowSlug || undefined,
      featureSlug: req.featureSlug || campaign.featureSlug || undefined,
      status: campaign.status,
      maxBudgetDailyUsd: campaign.maxBudgetDailyUsd,
      maxBudgetWeeklyUsd: campaign.maxBudgetWeeklyUsd,
      maxBudgetMonthlyUsd: campaign.maxBudgetMonthlyUsd,
      maxBudgetTotalUsd: campaign.maxBudgetTotalUsd,
      dailyBudgetCents: campaign.dailyBudgetCents,
      funnelKey: campaign.funnelKey,
      offerId: campaign.offerId,
      legKey: campaign.legKey,
      maxLeads: campaign.maxLeads,
    });

    if (req.runId) {
      // An out-of-credit org is a NORMAL, expected state (people run out of credit) —
      // not an anomaly to warn on. The campaign simply backs off and auto-resumes on
      // recharge. Trace it at info level, like a passing check, so it never surfaces as
      // a warning/error in logs. Genuine fail-closed blocks keep warn level.
      // A brand reaching its daily budget is the same class of expected business state
      // (pacing ceiling hit, not a fault) → also benign/info. A user-paused brand is likewise
      // an intentional, expected hold — not an anomaly.
      const benignBlock = result.reason === "Insufficient credits" ||
                          result.reason === "Brand daily budget reached" ||
                          result.reason === "Campaign daily budget reached" ||
                          // A funnel hitting its own ceiling — or the customer having funded it
                          // at zero — is an expected pacing outcome, not a fault.
                          result.reason === "Funnel daily budget reached" ||
                          result.reason === "Funnel not funded" ||
                          result.reason === "Brand paused";
      // A run allowed because billing could NOT be asked is a fail-OPEN anomaly, not an
      // authorization — exactly the class this service warns on. It rides the event that is
      // already emitted once per gate check, so it adds no log volume at all, and it is the
      // only way an incident can tell "the gate authorized" apart from "the gate defaulted".
      const creditUnreadable = result.creditCheck === "unreadable";
      traceEvent(req.runId, {
        service: "campaign-service",
        event: "gate-check-result",
        detail: `Gate check ${result.allowed ? "PASSED" : "BLOCKED"} for campaign ${campaignId}${result.reason ? ` — reason: ${result.reason}` : ""}${creditUnreadable ? ` — credit affordability NOT read (${result.creditCheckDetail}), allowed by fail-open` : ""}`,
        level: creditUnreadable ? "warn" : (result.allowed || benignBlock ? "info" : "warn"),
        data: {
          campaignId,
          allowed: result.allowed,
          reason: result.reason,
          creditCheck: result.creditCheck,
          creditCheckDetail: result.creditCheckDetail,
        },
      }, req.headers).catch(() => {});
    }

    if (!result.allowed) {
      // Invariant: every BLOCKED result persists a future nextRunAt. A null here would
      // let claimStuckCampaigns re-claim the (ongoing, nextRunAt=null) campaign every
      // tick and re-fire the Windmill flow indefinitely. Window blocks carry their own
      // nextRunAt (reset boundary); any other block backs off explicitly. There is no
      // terminal branch: a gate that cannot let a run through has said nothing about
      // whether the customer still wants this campaign.
      const nextRunAt = result.nextRunAt ?? new Date(Date.now() + GATE_BLOCK_BACKOFF_MS);
      await db.update(campaigns)
        .set({ nextRunAt, updatedAt: new Date() })
        .where(eq(campaigns.id, campaignId));
    }

    res.json({
      allowed: result.allowed,
      ...(result.reason && { reason: result.reason }),
    });
  } catch (error) {
    console.error("[campaign-service] Unhandled error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * POST /start-run
 *
 * Creates a run and returns campaign data for downstream DAG nodes
 * (brand-profile, fetch-lead, etc.).
 *
 * Gate checks are handled by the /gate-check DAG node upstream.
 *
 * Returns:
 *   200 — run started, campaign data returned
 *   400 — bad request (missing headers or brandIds)
 *   404 — campaign not found
 *   500 — internal error
 */
router.post("/start-run", requireApiKey, requirePipelineHeaders, trackingHeaders, async (req: AuthenticatedRequest, res) => {
  try {
    const campaignId = req.campaignId!;
    const orgId = req.orgId!;

    const campaign = await db.query.campaigns.findFirst({
      where: and(eq(campaigns.id, campaignId), eq(campaigns.orgId, orgId)),
    });
    if (!campaign) {
      console.warn(`[campaign-service] Campaign not found: ${campaignId} (orgId=${orgId})`);
      return res.status(404).json({ error: "Campaign not found" });
    }
    if (!campaign.brandIds || campaign.brandIds.length === 0) {
      console.warn(`[campaign-service] Campaign ${campaignId} has no brandIds`);
      return res.status(400).json({ error: "Campaign has no brandIds" });
    }

    // featureSlug comes exclusively from x-feature-slug header
    const featureSlug = req.featureSlug || undefined;

    if (req.runId) {
      traceEvent(req.runId, {
        service: "campaign-service",
        event: "start-run",
        detail: `Starting run for campaign ${campaignId} — brandIds=[${campaign.brandIds!.join(",")}], workflowSlug=${campaign.workflowSlug}, featureSlug=${featureSlug ?? "none"}`,
        data: { campaignId, brandIds: campaign.brandIds, workflowSlug: campaign.workflowSlug, featureSlug },
      }, req.headers).catch(() => {});
    }

    const parentRunId = req.runId;
    const brandIdCsv = campaign.brandIds!.join(",");
    const primaryBrandId = campaign.brandIds[0];
    const workflowSlug = req.workflowSlug || campaign.workflowSlug;
    if (!workflowSlug) {
      // A campaign whose channel the CUSTOMER operates runs no DAG, so nothing should ever have
      // reached this route for it — the scheduler never claims it and never triggers it. Fail
      // loud rather than minting a slug or starting a run nothing can execute.
      return res.status(400).json({
        error: `Campaign ${campaignId} states no workflow — its acquisition channel is operated by the customer, so it has no DAG to run`,
      });
    }

    // Re-decide the priority audience for THIS run with fresh cost data, BEFORE creating
    // the run row — so the chosen audience is stamped on campaign-service's own run AND
    // returned to workflow-service, which propagates it (x-audience-id) to every downstream
    // DAG node so the whole execution's costs are attributed to the audience.
    //
    // These two fetches run before the campaign-service run row exists, so they trace under
    // the parent (workflow/execute-workflow) run rather than this run.
    const preRunIdentity: DownstreamIdentity = {
      orgId,
      userId: req.userId!,
      runId: parentRunId!,
      campaignId,
      brandId: primaryBrandId,
      workflowSlug,
      featureSlug: featureSlug!,
    };
    // brand-service also answers the brand PROFILE, which the sending runtime needs downstream —
    // so this read stays whatever the campaign sells. The campaign's OFFER names whose confirmed
    // profile words the snapshot carries: a campaign sells exactly ONE offer, so naming it makes
    // the read answerable for a brand selling several (brand-service refuses the brand-scoped
    // read with 409 SEVERAL_OFFERS there — the offer-less population fails loud, never guessed).
    const brandRuntimeContext = await fetchBrandRuntimeContext(
      primaryBrandId,
      preRunIdentity,
      campaign.offerId,
    );
    // What this run is PRICED on. A campaign that states its SALES FUNNEL is priced on that
    // funnel — the only word that separates a meeting bought with a positive reply from one
    // bought with a click onto the site. A campaign that states none sells through no sales
    // funnel (PR, hiring, VC, AI-visibility): those are still priced on the brand's goal, which
    // is the one place a goal survives, and are still arbitrated below.
    // A campaign that states its LEG is priced on the leg and never reads its funnel (wave C1).
    const legKey: string | null = campaign.legKey;
    const funnelKey: string | null = legKey ? null : campaign.funnelKey;
    let runtimeGoal: RuntimeGoal | null = funnelKey || legKey ? null : brandRuntimeContext.currentGoal;
    // Cost-aware Thompson sampling over the chosen workflow's audiences, straight from
    // features-service /workflow-projection — which enumerates EVERY active audience of the
    // brand per dynasty (floored to brand/crossOrg when an audience never ran the workflow),
    // so those rows already ARE the brand's active-audience candidate set. The pick varies
    // run-to-run (exploration); its audienceId is stamped on this run AND returned to
    // workflow-service, which threads x-audience-id to every downstream node (lead-serve, …).
    // Skip audiences marked exhausted (served pool dry within the last 24h) — a run whose
    // audience returns no leads records it (see /end-run), so the bandit keeps serving the
    // campaign's OTHER audiences instead of re-picking a dry one.
    // Fail-soft: any features-service error → no audience chosen for this run (the run still
    // proceeds and reschedules); a selection optimization must never hard-fail a run.
    // THE AUDIENCE SUPPLIED ON THE EXECUTE CALL IS CONSUMED, NEVER RE-DRAWN.
    //
    // The trigger picks the (audience, workflow) CELL of features-service's grid: the audience
    // first, then the cheapest workflow WITHIN that audience's column. So the workflow now
    // running was chosen FOR this audience, and drawing a second one here would run it against a
    // different audience — which is the exact mismatch the cell pick exists to end (a workflow
    // cheapest on one audience running on the eleven it is worst on). workflow-service carries
    // the audience from the execute call through to this callback; when it carries one, this
    // route makes NO projection call at all.
    //
    // Nothing supplied → everything below is exactly what it was: the audience is picked here,
    // over this workflow's rows, with the same constraints.
    const suppliedAudienceId = req.audienceId ?? null;
    const excludedAudienceIds = suppliedAudienceId
      ? []
      : await getFreshExhaustedAudienceIds(campaignId);
    let audienceId: string | null = suppliedAudienceId;
    if (!suppliedAudienceId) {
      try {
        // The GOAL is arbitrated by features-service, on the same evidence the trigger used and
        // by the same deterministic rule, so both legs land on the same goal without threading
        // anything through the DAG. Only for a campaign that states NO funnel — a stated funnel is
        // the customer's funding decision and is never arbitrated away.
        let projectionRows: ProjectionRow[] | null = null;
        if (!funnelKey && !legKey) {
          const arbitration = await fetchGoalArbitration({
            featureSlug: featureSlug!,
            brandId: primaryBrandId,
            identity: preRunIdentity,
          });
          if (arbitration) {
            runtimeGoal = arbitration.goal;
            // Normally the elected workflow IS the one now running (the trigger elected it from
            // the same shared snapshot). If that snapshot rolled in between, the rows we were
            // handed describe a workflow that is NOT executing — re-read the rows for the one
            // that is, on the elected goal, rather than picking an audience for the wrong DAG.
            if (arbitration.workflowSlug === workflowSlug) projectionRows = arbitration.rows;
          }
        }
        // A LEG campaign picks its audience over the leg-keyed body — the same rows the trigger's
        // cell pick ranked on — and never over the funnel it may still carry.
        projectionRows ??= legKey
          ? await fetchLegProjectionRows({
              featureSlug: featureSlug!,
              brandId: primaryBrandId,
              legKey,
              campaignId,
              identity: preRunIdentity,
            })
          : await fetchWorkflowProjectionRows({
              featureSlug: featureSlug!,
              brandId: primaryBrandId,
              funnelKey,
              goal: runtimeGoal,
              identity: preRunIdentity,
            });
        audienceId = selectAudienceFromProjection(projectionRows, workflowSlug, {
          // Campaign v2: HARD targeting subset. When the campaign targets a subset of the
          // brand's audiences, the bandit may ONLY pick from it — the campaign never contacts
          // an audience it doesn't target. NULL/empty → target the brand's full active set.
          requiredAudienceIds: campaign.audienceIds ?? undefined,
          excludedAudienceIds,
        });
      } catch (err) {
        console.warn(
          `[campaign-service] audience selection failed for brand ${primaryBrandId}, proceeding without a chosen audience:`,
          err,
        );
      }
    }

    // Create run in runs-service (x-run-id from caller becomes parentRunId), stamping the
    // chosen audience so this run's own costs are attributed too.
    const run = await createRun({
      orgId,
      serviceName: "campaign-service",
      taskName: campaignId,
      campaignId,
      brandId: brandIdCsv,
      userId: campaign.createdByUserId || undefined,
      parentRunId: parentRunId || undefined,
      workflowSlug,
      featureSlug,
      audienceId: audienceId ?? undefined,
    });

    // Build searchParams from campaign featureInputs, then enrich with current runtime context.
    const featureInputs = campaign.featureInputs as Record<string, unknown> | null;
    // Note: the chosen audience is threaded downstream by AUDIENCE ID (x-audience-id, from the
    // top-level `audienceId` on this response) — lead-service resolves the audience's filters
    // from human-service by id and workflow-service reads only `audienceId`, so the full
    // audience object is NOT passed in searchParams (no downstream consumer reads it).
    const searchParams: Record<string, unknown> = {
      ...(featureInputs ?? {}),
      brandProfile: brandRuntimeContext.brandProfile,
      // Campaign v2: authoritative per-campaign config for the sending runtime. NULL means
      // inherit the brand (downstream falls back to the brand's services / destination).
      servicesOffered: campaign.servicesOffered ?? null,
      clickDestinationUrl: campaign.clickDestinationUrl ?? null,
    };

    if (req.runId) {
      traceEvent(req.runId, {
        service: "campaign-service",
        event: "run-created",
        detail: `Run created id=${run.id} for campaign ${campaignId} — parentRunId=${parentRunId ?? "none"}, audienceId=${audienceId ?? "none"}`,
        data: { runId: run.id, campaignId, parentRunId, audienceId },
      }, req.headers).catch(() => {});
    }

    // Return campaign data for downstream DAG nodes
    res.json({
      runId: run.id,
      campaignId,
      orgId,
      brandIds: campaign.brandIds,
      workflowSlug: campaign.workflowSlug,
      userId: campaign.createdByUserId ?? null,
      featureSlug: campaign.featureSlug ?? null,
      featureInputs: featureInputs ?? null,
      activeGoalId: campaign.activeGoalId ?? null,
      brandProfileId: campaign.brandProfileId ?? null,
      audienceId,
      // Campaign v2 own config — the campaign's raw own goal (null = paced on brand goal),
      // its targeted audience subset, its services, its click-destination.
      goal: campaign.goal ?? null,
      // The sales funnel this campaign works (null = not funnel-scoped). Exposed so the run's
      // downstream nodes and any reader can see which funnel's money this execution spends.
      funnelKey: campaign.funnelKey ?? null,
      // The offer this campaign sells (null = pre-offer campaign). A brand holding several
      // offers refuses brand-scoped reads (SEVERAL_OFFERS), so downstream nodes that read
      // brand-service (e.g. extract-fields) scope their call on this — never guessing one.
      offerId: campaign.offerId ?? null,
      audienceIds: campaign.audienceIds ?? null,
      servicesOffered: campaign.servicesOffered ?? null,
      clickDestinationUrl: campaign.clickDestinationUrl ?? null,
      searchParams,
    });
  } catch (error) {
    console.error("[campaign-service] Unhandled error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * Does the campaign still have at least one serveable, non-exhausted audience?
 *
 * Mirrors /start-run's bandit eligibility (active audiences ∩ the campaign's targeted subset)
 * but drops the workflow soft-filter — an audience serveable under ANY workflow keeps the
 * campaign alive — and excludes audiences currently marked exhausted. Returns true when the
 * bandit would find at least one audience to pick, false when every targeted audience is
 * exhausted (the only legitimate campaign-wide stop condition).
 *
 * Throws on a features/brand-service error so the caller can fail SAFE (never stop on an
 * infra hiccup — a false stop is the bug this whole change fixes).
 *
 * Deliberately does NOT arbitrate the goal, unlike /start-run. Audience MEMBERSHIP is
 * goal-independent — features-service enumerates every active audience of the brand per dynasty
 * whatever the goal, and the goal only changes the cost metric attached to each row — so asking
 * on the brand goal returns the same audience set. If that ever stopped holding, this guard
 * would see a SUPERSET of what the picker considers, which is the safe direction for a
 * fail-safe stop condition: it can only keep a campaign alive, never stop one wrongly.
 */
async function hasServeableAudience(
  campaign: typeof campaigns.$inferSelect,
  req: AuthenticatedRequest,
): Promise<boolean> {
  const primaryBrandId = campaign.brandIds![0];
  const featureSlug = req.featureSlug || campaign.featureSlug;
  if (!featureSlug) {
    // No feature slug to query the projection with → cannot prove exhaustion. Fail safe:
    // treat as still-serveable so we never stop the campaign on missing context.
    return true;
  }
  const identity: DownstreamIdentity = {
    orgId: campaign.orgId,
    userId: req.userId!,
    runId: req.runId!,
    campaignId: campaign.id,
    brandId: primaryBrandId,
    workflowSlug: req.workflowSlug || campaign.workflowSlug,
    featureSlug,
  };
  // Same definition the resume sweep reads. The two must agree: the leg that stops a campaign
  // for having nobody left and the leg that brings it back once it has somebody cannot each
  // carry their own idea of what "somebody" means.
  const ids = await serveableAudienceIdsForCampaign(campaign, featureSlug, identity);
  return ids.length > 0;
}

/**
 * POST /end-run
 *
 * Marks the running run as completed or failed, then re-triggers the
 * workflow if the campaign is still ongoing and stopCampaign is false.
 *
 * Body: { success: boolean, stopCampaign: boolean }
 *   - success: whether the run completed successfully
 *   - stopCampaign: whether to auto-stop the campaign (no more work to do)
 *
 * Does NOT require runId — finds the running run via runs-service.
 * This lets it handle both the happy path (email-send → end-run) and
 * the error path (onError → end-run-error) including cases where
 * no run was created (gate-check blocked).
 */
router.post("/end-run", requireApiKey, requirePipelineHeaders, trackingHeaders, validateBody(EndRunBody), async (req: AuthenticatedRequest, res) => {
  try {
    const campaignId = req.campaignId!;
    const orgId = req.orgId!;
    const { success, stopCampaign, noWorkAvailable } = req.body;

    const status = success === true ? "completed" : "failed";
    const identity: IdentityHeaders = {
      orgId,
      userId: req.userId,
      runId: req.runId,
      campaignId,
      brandId: req.brandIds?.join(","),
      workflowSlug: req.workflowSlug,
      featureSlug: req.featureSlug,
    };

    if (req.runId) {
      traceEvent(req.runId, {
        service: "campaign-service",
        event: "end-run",
        detail: `Ending run for campaign ${campaignId} — success=${success}, stopCampaign=${stopCampaign}, noWorkAvailable=${noWorkAvailable === true}, status=${status}`,
        data: { campaignId, success, stopCampaign, noWorkAvailable: noWorkAvailable === true, status },
      }, req.headers).catch(() => {});
    }

    // Finalize ONLY this caller's own run row, matched by parentRunId === req.runId.
    // Sibling parent runs (concurrent campaign runs from a stale schedule) are NOT touched —
    // each is responsible for ending its own row when its DAG terminates. The previous
    // "mark all running runs failed" behavior swept siblings and was the root cause of
    // the serial-invariant violation seen at lead-service.
    if (!req.runId) {
      console.warn(`[campaign-service] /end-run called without x-run-id for campaign ${campaignId} — cannot finalize a run row`);
    } else {
      try {
        const { runs } = await listRuns({
          orgId,
          serviceName: "campaign-service",
          taskName: campaignId,
          parentRunId: req.runId,
          status: "running",
          // Already narrow — one marker row per parent run — but every listRuns in this service
          // states a bound, so an unfiltered history read can never come back by accident.
          limit: 10,
        });
        for (const run of runs) {
          await updateRun(run.id, status, identity);
        }
      } catch (err) {
        console.error(`[campaign-service] Failed to update run for campaign ${campaignId}:`, err);
      }
    }

    // Respond immediately, then handle re-trigger asynchronously
    res.json({ status });

    // The DAG sends stopCampaign=true when THIS run's single served audience returned no leads
    // (fetch-lead.found == false). That is AUDIENCE-scoped: the bandit narrows each run to one
    // audience, so one audience running dry says nothing about the campaign's others. It is
    // reinterpreted — mark THIS audience exhausted (24h TTL; the bandit then skips it) — and it
    // never changes the campaign's status.
    //
    // "Everybody has been contacted" is a SYSTEM CONDITION, and a system condition never stops a
    // campaign: the customer said this campaign should run, and running out of people to contact
    // this hour is not them changing their mind. So the campaign stays exactly as they left it,
    // does not run this tick, and runs again on a later tick once the brand has somebody — which
    // is also why nothing has to bring it back: there is no stop to undo, and the resume sweep
    // that used to exist is gone. The customer is still EMAILED asking them to extend an audience
    // (a notification is not a status change).
    //
    // Set whenever the campaign has nobody to contact: it is rescheduled on the RECHECK cadence
    // rather than the run cadence — the reason it cannot run does not move in eleven seconds.
    let waitingForAudience = false;

    if (stopCampaign === true) {
      try {
        const exhaustedAudienceId = req.audienceId;
        if (exhaustedAudienceId) {
          await markAudienceExhausted(campaignId, exhaustedAudienceId);
        } else {
          // No audience id means no audience RAN, so there is nothing to mark. Expected business
          // state, not a fault: log at info.
          console.log(`[campaign-service] stopCampaign=true for campaign ${campaignId} with no x-audience-id — no audience ran, so nothing is marked exhausted`);
        }

        const campaign = await db.query.campaigns.findFirst({
          where: and(eq(campaigns.id, campaignId), eq(campaigns.orgId, orgId)),
        });
        // Only decide on a still-ongoing campaign with brands to serve. A serveable audience
        // remaining → keep going on the run cadence; none → wait on the audience cadence.
        const serveable =
          !!campaign && campaign.status === "ongoing" && !!campaign.brandIds?.length
            ? await hasServeableAudience(campaign, req)
            : false;

        // The verdict this run just computed, recorded rather than thrown away: it is the only
        // honest campaign-grain answer to "did it have an audience to work", and a consumer
        // replaying a past month cannot derive it from anything else. Fail-SOFT (the catch below
        // owns it) — history must never take down a run.
        if (campaign) {
          await recordAudienceAvailability(campaignId, orgId, serveable);
        }

        if (!serveable) {
          // Nobody to contact. Two shapes, one outcome — the campaign is NOT stopped either way:
          //
          //   - it has exhausted an audience before, i.e. outreach genuinely ran out of people:
          //     nudge the customer to extend an audience so it can resume. Fire-and-forget, never
          //     blocks run finalization, and the 1x/month-per-brand cap is transactional-email's.
          //   - it has never exhausted one, i.e. it has served nothing at all: "nothing left to
          //     serve" is equally true of a campaign that never had anything, so there is no
          //     claim to make and nobody to email. 0 of 0 is not 100%.
          //
          // Both wait on the same cadence, because both change when the customer's audiences
          // change — hours or days apart, not eleven seconds.
          const everExhausted = await hasExhaustedAudience(campaignId);
          if (everExhausted && campaign) {
            void maybeSendExtendAudienceEmail(campaign, { runId: req.runId! });
          }
          waitingForAudience = true;
          console.log(
            everExhausted
              ? `[campaign-service] Campaign ${campaignId} has contacted every targeted audience — it stays ongoing (only the customer stops a campaign) and re-checks in ${NO_SERVEABLE_AUDIENCE_RECHECK_MS}ms; the owner was asked to extend an audience`
              : `[campaign-service] Campaign ${campaignId} has no serveable audience and has never exhausted one — it has served nothing, so there is nothing to conclude; it stays ongoing and re-checks in ${NO_SERVEABLE_AUDIENCE_RECHECK_MS}ms`,
          );
        }
        // Falls through to the reschedule below, on the recheck cadence when nobody is serveable.
      } catch (err) {
        // Nothing here can change a status any more, so the only thing an error costs is the
        // exhaustion mark and the nudge email. Fall through to the reschedule and retry.
        console.error(`[campaign-service] audience-exhaustion handling failed for campaign ${campaignId}:`, err);
      }
    }

    // A run that did NOT report an empty audience served somebody, and that is the END the
    // exhaustion record was missing: an OBSERVED end, not an assumed one. It also settles the
    // campaign-grain verdict without a second question — a campaign that just contacted a person
    // had somebody to contact.
    //
    // Only for a run that actually did work: one that reported it had NOTHING TO DO saw nobody
    // owed an answer, which is a different fact, and a FAILED run says nothing trustworthy at all.
    if (stopCampaign !== true && status !== "failed" && noWorkAvailable !== true) {
      try {
        if (req.audienceId) {
          await resolveAudienceExhaustion(campaignId, req.audienceId);
        }
        await recordAudienceAvailability(campaignId, orgId, true);
      } catch (err) {
        console.error(`[campaign-service] audience-availability history failed for campaign ${campaignId}:`, err);
      }
    }

    // Schedule re-trigger via nextRunAt — the scheduler picks it up on the next tick.
    // This prevents exponential cascades when downstream services are down.
    try {
      const freshCampaign = await db.query.campaigns.findFirst({
        where: and(eq(campaigns.id, campaignId), eq(campaigns.orgId, orgId)),
      });
      if (freshCampaign?.status !== "ongoing") {
        return;
      }

      // Failed runs get a 60s backoff; completed runs re-run after a short grace
      // (RERUN_GRACE_MS) so the wrapping workflow run finishes teardown before the
      // re-run tick — otherwise the in-flight guard sees it alive and forces +60s.
      // A campaign waiting for somebody to contact waits on that reason's cadence — it is not
      // waiting its turn, and firing it sooner cannot change the answer.
      // Same argument, different reason: a run that reported it had NOTHING TO DO (nobody owed an
      // answer this minute) waits on the idle cadence rather than re-firing in ten seconds. A
      // FAILED run is not that case — it says nothing trustworthy about whether there was work —
      // so the failure backoff still wins.
      const idle = noWorkAvailable === true && status !== "failed";
      const delayMs = waitingForAudience
        ? NO_SERVEABLE_AUDIENCE_RECHECK_MS
        : status === "failed"
          ? 60_000
          : idle
            ? NO_WORK_RECHECK_MS
            : RERUN_GRACE_MS;
      const nextRunAt = new Date(Date.now() + delayMs);

      if (req.runId) {
        traceEvent(req.runId, {
          service: "campaign-service",
          event: "re-trigger-scheduled",
          detail: `Scheduled re-trigger for campaign ${campaignId} via nextRunAt=${nextRunAt.toISOString()} (delay=${delayMs}ms)`,
          data: { campaignId, nextRunAt: nextRunAt.toISOString(), delayMs },
        }, req.headers).catch(() => {});
      }

      await db.update(campaigns)
        .set({ nextRunAt, updatedAt: new Date() })
        .where(eq(campaigns.id, campaignId));

      // Re-run scheduled → wake the scheduler so it fires at (or near) nextRunAt
      // instead of waiting out the current idle sleep.
      wakeScheduler();

      if (waitingForAudience) {
        // The waiting line above already said what was decided and until when; repeating the
        // generic reschedule line under it is the third of the three lines that were filling
        // the logs.
      } else if (status === "failed") {
        console.warn(`[campaign-service] Run failed — rescheduled campaign ${campaignId} in ${delayMs}ms (nextRunAt=${nextRunAt.toISOString()})`);
      } else if (idle) {
        // Expected business state, not a fault, and it fires on the idle cadence rather than once
        // per run — which is the whole point of this branch.
        console.log(`[campaign-service] Run had nothing to do for campaign ${campaignId} — waiting ${delayMs}ms instead of the run cadence (nextRunAt=${nextRunAt.toISOString()}); an interested prospect still triggers it immediately`);
      } else {
        console.log(`[campaign-service] Set nextRunAt=${nextRunAt.toISOString()} for campaign ${campaignId} (status=${status})`);
      }
    } catch (err) {
      console.error(`[campaign-service] Failed to schedule re-trigger for campaign ${campaignId}:`, err);
    }
  } catch (error) {
    console.error("[campaign-service] Unhandled error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * POST /internal/transfer-brand
 *
 * Transfers all solo-brand campaigns from one org to another.
 * Solo-brand = brand_ids array contains exactly one element matching sourceBrandId.
 * Skips co-branding rows (multiple brand IDs).
 *
 * Two-step process:
 *   Step 1: UPDATE org_id WHERE brand_ids = [sourceBrandId] AND org_id = sourceOrgId
 *   Step 2 (when targetBrandId present): UPDATE brand_ids WHERE brand_ids = [sourceBrandId] (no org filter)
 *
 * Idempotent: re-running with same params is a no-op.
 */
router.post("/internal/transfer-brand", requireApiKey, validateBody(TransferBrandBody), async (req, res) => {
  try {
    const { sourceBrandId, sourceOrgId, targetOrgId, targetBrandId } = req.body;

    // Step 1: Move matching rows to target org
    const step1 = await db.execute(
      sql`WITH updated AS (
            UPDATE campaigns
            SET org_id = ${targetOrgId},
                updated_at = NOW()
            WHERE org_id = ${sourceOrgId}
              AND brand_ids = ARRAY[${sourceBrandId}]::text[]
            RETURNING id
          )
          SELECT count(*)::int AS cnt FROM updated`
    );

    const movedCount = Number((step1 as unknown as Array<{ cnt: number }>)[0]?.cnt ?? 0);

    // Step 2: Rewrite brand_ids (no org filter — catches all rows with sourceBrandId)
    let remappedCount = 0;
    if (targetBrandId) {
      const step2 = await db.execute(
        sql`WITH updated AS (
              UPDATE campaigns
              SET brand_ids = ARRAY[${targetBrandId}]::text[],
                  updated_at = NOW()
              WHERE brand_ids = ARRAY[${sourceBrandId}]::text[]
              RETURNING id
            )
            SELECT count(*)::int AS cnt FROM updated`
      );
      remappedCount = Number((step2 as unknown as Array<{ cnt: number }>)[0]?.cnt ?? 0);
    }

    const totalCount = Math.max(movedCount, remappedCount);

    console.log(`[campaign-service] transfer-brand: moved ${movedCount}, remapped ${remappedCount} campaigns (sourceBrandId=${sourceBrandId}, targetBrandId=${targetBrandId ?? "none"}, ${sourceOrgId} -> ${targetOrgId})`);

    res.json({
      updatedTables: [{ tableName: "campaigns", count: totalCount }],
    });
  } catch (error) {
    console.error("[campaign-service] transfer-brand error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * DELETE /internal/campaigns/by-org/:orgId
 *
 * Idempotent org teardown hook for client-service.
 * Stops any campaign scheduler/execution state owned by campaign-service for the
 * internal org UUID, without fanning out to other services.
 */
router.delete("/internal/campaigns/by-org/:orgId", requireApiKey, async (req, res) => {
  try {
    const { orgId } = req.params;
    const result = await db.transaction(async (tx) => {
      // The org is gone. Stating it keeps these rows out of the resume sweep for good — and, like
      // every other status change in this service, it leaves a trace: a month's run-rate must be
      // able to see the day an org's campaigns stopped earning.
      const disabledCampaigns = await stopOrgCampaignsWithHistory(
        tx,
        orgId,
        STOP_REASONS.ORG_TEARDOWN,
        and(
          eq(campaigns.orgId, orgId),
          or(
            ne(campaigns.status, "stopped"),
            isNotNull(campaigns.nextRunAt),
          ),
        ),
      );

      const deletedBrandPauseTransitions = await tx
        .delete(brandPauseTransitions)
        .where(eq(brandPauseTransitions.orgId, orgId))
        .returning({ id: brandPauseTransitions.id });

      return {
        disabledCampaignCount: disabledCampaigns.length,
        deletedBrandPauseTransitionCount: deletedBrandPauseTransitions.length,
      };
    });

    res.json({
      updatedTables: [
        { tableName: "campaigns", count: result.disabledCampaignCount },
        { tableName: "brand_pause_transitions", count: result.deletedBrandPauseTransitionCount },
      ],
    });
  } catch (error) {
    console.error("[campaign-service] org teardown error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * POST /internal/campaigns/trigger-for-step
 *
 * A lead just reached a step. Run the campaign bought for the leg OUT of it, now — instead of
 * waiting for that campaign's next tick. A prospect who says "yes, interested" and hears nothing
 * for a day is the whole problem the leg they bought exists to solve.
 *
 * The caller names the scope (brand, offer, funnel) and the step reached; the leg is
 * features-service's statement and the campaign is the one already stating that leg. See
 * `lib/step-trigger.ts` for why the scope fails LOUD while the answer is very often an ordinary,
 * named nothing — and for why the affordability gate is reached exactly as a scheduled run reaches
 * it, because the dispatch is the scheduler's own.
 *
 * Returns:
 *   200 — what was triggered and what was skipped, each skip naming its reason
 *   400 — no org, a malformed body, a funnel naming none of the four, a step nobody publishes
 *   401 — bad api key
 *   502 — the acquisition-channel catalogue could not be read
 *   500 — internal error
 */
router.post("/internal/campaigns/trigger-for-step", requireApiKey, serviceAuth, validateBody(TriggerForStepBody), async (req: AuthenticatedRequest, res) => {
  try {
    const { brandId, offerId, funnelKey, step } = req.body;
    const outcome = await triggerCampaignsForStep({
      orgId: req.orgId!,
      brandId,
      offerId,
      funnelKey,
      step,
    });
    res.json(outcome);
  } catch (error) {
    if (error instanceof StepTriggerScopeError) {
      console.warn(`[campaign-service] ${error.status} on /internal/campaigns/trigger-for-step — ${error.message}`);
      return res.status(error.status).json({ error: error.message });
    }
    console.error("[campaign-service] trigger-for-step error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * The most days one call may ask for. A year is a generous ceiling for "replay last month" and it
 * bounds the response: 500 campaigns x 400 days is already a large payload, and an unbounded range
 * is an unbounded one.
 */
const EARNING_HISTORY_MAX_DAYS = 400;

function earningRangeRefusal(from: string, to: string): string | null {
  const days = utcDaysBetween(from, to);
  if (days.length === 0) return `\`from\` (${from}) is after \`to\` (${to})`;
  if (days.length > EARNING_HISTORY_MAX_DAYS) {
    return `range spans ${days.length} days; at most ${EARNING_HISTORY_MAX_DAYS} may be asked for at once`;
  }
  return null;
}

/**
 * GET /internal/campaigns/:campaignId/earning-history?from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * Was this campaign EARNING on each day of the range — was the customer running it, and did it
 * have anybody to work — answered from RECORDED HISTORY rather than from current state.
 *
 * A day is a UTC calendar day, evaluated at its END (or at now, for a day still in progress): the
 * state a campaign finished the day in is the one a daily run-rate counts.
 *
 * `not_recorded` is a first-class answer and is never collapsed to "stopped". Nothing is
 * backfilled, so a day before this campaign's record begins says so — and `statusRecordedSince` /
 * `audienceRecordedSince` say when each axis started being answerable. The whole reason this
 * exists is that a month published as a guess came out negative; it is not this service's place to
 * invent a value it can then be quoted on.
 *
 * Returns:
 *   200 — one row per day
 *   400 — a malformed or oversized range
 *   401 — bad api key
 *   500 — internal error
 */
router.get(
  "/internal/campaigns/:campaignId/earning-history",
  requireApiKey,
  validateQuery(EarningHistoryQuery),
  async (req, res) => {
    try {
      const { campaignId } = req.params;
      const from = String(req.query.from);
      const to = String(req.query.to);
      const refusal = earningRangeRefusal(from, to);
      if (refusal) return res.status(400).json({ error: refusal });

      const [history] = await earningHistory([campaignId], from, to);
      res.json({ campaigns: history ? [history] : [] });
    } catch (error) {
      console.error("[campaign-service] earning-history error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

/**
 * POST /internal/campaigns/earning-history
 *
 * The same answer for many campaigns at once — the shape a consumer reconstructing a past month
 * actually needs. A per-campaign fan-out over a fleet is hundreds of round trips for a question
 * that is two bounded reads and an in-memory walk.
 *
 * Body: { campaignIds: string[], from: "YYYY-MM-DD", to: "YYYY-MM-DD" }
 *
 * A campaign id nothing is recorded for is still RETURNED, with every day `not_recorded` — an
 * absent row would be indistinguishable from a campaign that was not earning, which is the exact
 * conflation this endpoint exists to end.
 *
 * Returns:
 *   200 — one entry per requested campaign, in the order asked
 *   400 — a malformed or oversized range, or an empty / oversized id list
 *   401 — bad api key
 *   500 — internal error
 */
router.post(
  "/internal/campaigns/earning-history",
  requireApiKey,
  validateBody(EarningHistoryBody),
  async (req, res) => {
    try {
      const { campaignIds, from, to } = req.body as {
        campaignIds: string[];
        from: string;
        to: string;
      };
      const refusal = earningRangeRefusal(from, to);
      if (refusal) return res.status(400).json({ error: refusal });

      res.json({ campaigns: await earningHistory(campaignIds, from, to) });
    } catch (error) {
      console.error("[campaign-service] earning-history batch error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

/**
 * GET /internal/campaigns/:campaignId/predecessor
 *
 * WHICH CAMPAIGN RAN THE LEG THAT ENDS WHERE THIS ONE BEGINS — same org, same brand, same offer,
 * same funnel.
 *
 * A campaign bought for a leg that CONTINUES another needs to find what it is continuing: the
 * person, the thread and the record of what we owe them are filed under the campaign that ran the
 * previous leg. Only this service knows two campaigns are two legs of one journey, so only it can
 * answer. See `lib/predecessor-campaign.ts` for why an entry leg answers with a NAMED absence
 * rather than the closest-looking sibling, and why an unreadable catalogue is loud.
 *
 * Nothing is written and nothing about funding, gating, scheduling or triggering is touched.
 *
 * Returns:
 *   200 — the predecessor, or `predecessor: null` with `absence` naming why there is none
 *   401 — bad api key
 *   404 — no such campaign
 *   409 — the question cannot be answered: a leg features-service no longer publishes, or two
 *         live siblings both running the preceding leg for this offer
 *   502 — the acquisition-channel catalogue could not be read
 *   500 — internal error
 */
router.get("/internal/campaigns/:campaignId/predecessor", requireApiKey, async (req, res) => {
  try {
    res.json(await resolvePredecessorCampaign(req.params.campaignId));
  } catch (error) {
    if (error instanceof PredecessorScopeError) {
      console.warn(
        `[campaign-service] ${error.status} on /internal/campaigns/${req.params.campaignId}/predecessor — ${error.message}`,
      );
      return res.status(error.status).json({ error: error.message, reason: error.reason });
    }
    console.error("[campaign-service] predecessor lookup error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
