import { Router } from "express";
import { eq, and, sql, or, ne, isNotNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { brandPauseTransitions, campaigns } from "../db/schema.js";
import { requireApiKey, requirePipelineHeaders, trackingHeaders, type AuthenticatedRequest } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import { createRun, listRuns, updateRun, type IdentityHeaders } from "@distribute/runs-client";
import { runGateChecks } from "../lib/gate-check.js";
import { EndRunBody, TransferBrandBody } from "../schemas.js";
import { wakeScheduler } from "../lib/scheduler.js";
import { traceEvent } from "../lib/trace-event.js";
import { fetchBrandRuntimeContext, type RuntimeGoal } from "../lib/brand-runtime-client.js";
import { markAudienceExhausted, getFreshExhaustedAudienceIds, hasExhaustedAudience, isExhaustionStopWarranted, NO_SERVEABLE_AUDIENCE_RECHECK_MS } from "../lib/audience-exhaustion.js";
import { maybeSendExtendAudienceEmail } from "../lib/transactional-email.js";
import { serveableAudienceIdsForCampaign } from "../lib/serveable-audience.js";
import { STOP_REASONS } from "../lib/stop-reason.js";
import {
  fetchWorkflowProjectionRows,
  fetchGoalArbitration,
  selectAudienceFromProjection,
  type ProjectionRow,
} from "../lib/features-workflow-projection-client.js";
import type { DownstreamIdentity } from "../lib/downstream-headers.js";

const router = Router();

// Backoff applied to a BLOCKED gate result that carries no scheduler decision
// (neither autoStopped nor a window nextRunAt). Guarantees the campaign is not
// re-claimed + re-fired on the very next scheduler tick.
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
      workflowSlug: req.workflowSlug || campaign.workflowSlug,
      featureSlug: req.featureSlug || campaign.featureSlug || undefined,
      status: campaign.status,
      maxBudgetDailyUsd: campaign.maxBudgetDailyUsd,
      maxBudgetWeeklyUsd: campaign.maxBudgetWeeklyUsd,
      maxBudgetMonthlyUsd: campaign.maxBudgetMonthlyUsd,
      maxBudgetTotalUsd: campaign.maxBudgetTotalUsd,
      dailyBudgetCents: campaign.dailyBudgetCents,
      funnelKey: campaign.funnelKey,
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
      traceEvent(req.runId, {
        service: "campaign-service",
        event: "gate-check-result",
        detail: `Gate check ${result.allowed ? "PASSED" : "BLOCKED"} for campaign ${campaignId}${result.reason ? ` — reason: ${result.reason}` : ""}${result.autoStopped ? " (auto-stopped)" : ""}`,
        level: result.allowed || benignBlock ? "info" : "warn",
        data: { campaignId, allowed: result.allowed, reason: result.reason, autoStopped: result.autoStopped },
      }, req.headers).catch(() => {});
    }

    if (!result.allowed) {
      // Invariant: every BLOCKED result must persist a scheduler decision — either
      // terminal (autoStopped) OR a future nextRunAt. A null here would let
      // claimStuckCampaigns re-claim the (ongoing, nextRunAt=null) campaign every tick
      // and re-fire the Windmill flow indefinitely. Window blocks carry their own
      // nextRunAt (reset boundary); any other no-decision block backs off explicitly.
      let nextRunAt = result.nextRunAt ?? null;
      if (!nextRunAt && !result.autoStopped) {
        nextRunAt = new Date(Date.now() + GATE_BLOCK_BACKOFF_MS);
      }
      if (nextRunAt) {
        await db.update(campaigns)
          .set({ nextRunAt, updatedAt: new Date() })
          .where(eq(campaigns.id, campaignId));
      }
    }

    res.json({
      allowed: result.allowed,
      ...(result.reason && { reason: result.reason }),
      ...(result.autoStopped && { autoStopped: result.autoStopped }),
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
    // so this read stays whatever the campaign sells.
    const brandRuntimeContext = await fetchBrandRuntimeContext(primaryBrandId, preRunIdentity);
    // What this run is PRICED on. A campaign that states its SALES FUNNEL is priced on that
    // funnel — the only word that separates a meeting bought with a positive reply from one
    // bought with a click onto the site. A campaign that states none sells through no sales
    // funnel (PR, hiring, VC, AI-visibility): those are still priced on the brand's goal, which
    // is the one place a goal survives, and are still arbitrated below.
    const funnelKey: string | null = campaign.funnelKey;
    let runtimeGoal: RuntimeGoal | null = funnelKey ? null : brandRuntimeContext.currentGoal;
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
    const excludedAudienceIds = await getFreshExhaustedAudienceIds(campaignId);
    let audienceId: string | null = null;
    try {
      // The GOAL is arbitrated by features-service, on the same evidence the trigger used and
      // by the same deterministic rule, so both legs land on the same goal without threading
      // anything through the DAG. Only for a campaign that states NO funnel — a stated funnel is
      // the customer's funding decision and is never arbitrated away.
      let projectionRows: ProjectionRow[] | null = null;
      if (!funnelKey) {
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
      projectionRows ??= await fetchWorkflowProjectionRows({
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
    const { success, stopCampaign } = req.body;

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
        detail: `Ending run for campaign ${campaignId} — success=${success}, stopCampaign=${stopCampaign}, status=${status}`,
        data: { campaignId, success, stopCampaign, status },
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
    // (fetch-lead.found == false). That is AUDIENCE-scoped exhaustion, NOT "the campaign is
    // done": the bandit narrows each run to one audience, so one audience running dry says
    // nothing about the campaign's other audiences. Reinterpret it — mark this audience
    // exhausted (24h TTL; the bandit then skips it) and auto-stop the campaign ONLY when it has
    // no serveable, non-exhausted audience left. Otherwise fall through to the normal reschedule
    // so the next tick re-draws from the remaining audiences.
    // Set when the campaign has nobody to contact and has served nothing: it is rescheduled
    // rather than stopped, but on the RECHECK cadence below instead of the run cadence — the
    // reason it cannot run does not move in eleven seconds.
    let waitingForAudience = false;

    if (stopCampaign === true) {
      try {
        const exhaustedAudienceId = req.audienceId;
        if (exhaustedAudienceId) {
          await markAudienceExhausted(campaignId, exhaustedAudienceId);
        } else {
          // No audience id means no audience RAN, so there is nothing to mark and no evidence
          // this campaign ever contacted anybody. Says what it decided rather than proceeding:
          // the stop below is gated on that evidence, so this run cannot end in a verdict about
          // work that never happened.
          // Expected business state, not a fault: log at info. It is paired with the waiting
          // line below and both now fire on the recheck cadence, not once per run.
          console.log(`[campaign-service] stopCampaign=true for campaign ${campaignId} with no x-audience-id — no audience ran, so nothing is marked exhausted and this run cannot conclude the campaign is exhausted`);
        }

        const campaign = await db.query.campaigns.findFirst({
          where: and(eq(campaigns.id, campaignId), eq(campaigns.orgId, orgId)),
        });
        // Only decide on a still-ongoing campaign with brands to serve. A serveable audience
        // remaining → keep going (fall through to reschedule); none → the real all-exhausted stop.
        const serveable =
          !!campaign && campaign.status === "ongoing" && !!campaign.brandIds?.length
            ? await hasServeableAudience(campaign, req)
            : false;

        // "Nothing left to serve" is ALSO true for a campaign that never had anything to serve,
        // so an empty remainder is not evidence of exhaustion — 0 of 0 reads as 100%. The
        // verdict rests on POSITIVE evidence that outreach actually ran out of people through
        // THIS campaign: an exhaustion mark, which is only ever written for a run that named a
        // real audience. Same definition the extend-audience email is gated on.
        //
        // Without that evidence the campaign is NOT stopped: it has a funded ceiling and nothing
        // to show for it, so it stays `ongoing` and falls through to the normal reschedule below
        // — the next tick looks at it again. Parking it on `audience_exhausted` would be sticky
        // (funding deliberately never resumes that reason), so a campaign that never worked
        // would sit on a funded channel forever, which is exactly what happened to the first
        // campaign the per-channel provisioner ever created (4769db14, 2026-08-20: stopped ten
        // seconds after birth having served nothing).
        const stopWarranted =
          !serveable &&
          isExhaustionStopWarranted({
            hasServeableAudience: serveable,
            hasEverExhaustedAnAudience: await hasExhaustedAudience(campaignId),
          });

        if (!serveable && !stopWarranted) {
          // Not stopped — and not re-fired in ten seconds either. "Nobody to contact" changes
          // when the customer's audiences change or when a never-run channel finally has
          // evidence, so the campaign WAITS on that timescale (the money cadence, not the turn
          // cadence). Rescheduling on the run cadence is what fired a workflow every eleven
          // seconds for campaigns 4769db14 and cb965e9d, each run unable to do anything.
          waitingForAudience = true;
          console.log(`[campaign-service] Campaign ${campaignId} has no serveable audience and has never exhausted one — it has served nothing, so it is NOT auto-stopped as ${STOP_REASONS.AUDIENCE_EXHAUSTED}; waiting ${NO_SERVEABLE_AUDIENCE_RECHECK_MS}ms for it to have somebody to contact`);
          // Falls through to the reschedule below, which uses the recheck cadence.
        } else if (!serveable) {
          // Fully contacted: every targeted audience is exhausted and the campaign is
          // being auto-stopped. Nudge the user to extend an audience so outreach can
          // resume. Fire-and-forget — never blocks or fails run finalization, and the
          // 1x/month-per-brand cap is enforced by transactional-email-service dedup.
          if (campaign) {
            void maybeSendExtendAudienceEmail(campaign, { runId: req.runId! });
          }
          await db.update(campaigns)
            // States WHY it stopped, and it is the ONE reason a campaign comes back by itself:
            // the customer was just asked to extend an audience, so their doing it has to be
            // enough to restart the campaign. Without the reason on the row, "resume the ones
            // that ran out of people" could not be told from "resume the ones a person stopped".
            .set({
              status: "stopped",
              stopReason: STOP_REASONS.AUDIENCE_EXHAUSTED,
              nextRunAt: null,
              updatedAt: new Date(),
            })
            .where(and(eq(campaigns.id, campaignId), eq(campaigns.orgId, orgId)));
          console.log(`[campaign-service] All targeted audiences exhausted — auto-stopped campaign ${campaignId} (stopReason=${STOP_REASONS.AUDIENCE_EXHAUSTED}; resumes on its own once the brand has a serveable audience again)`);
          return;
        }
        // Serveable audiences remain → do NOT stop; fall through to the reschedule below.
      } catch (err) {
        // Fail SAFE: a false stop is exactly the bug being fixed, so on ANY error in the
        // exhaustion handling do NOT stop the campaign — fall through to reschedule and retry.
        console.error(`[campaign-service] audience-exhaustion handling failed for campaign ${campaignId}, not stopping:`, err);
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
      const delayMs = waitingForAudience
        ? NO_SERVEABLE_AUDIENCE_RECHECK_MS
        : status === "failed"
          ? 60_000
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
      const disabledCampaigns = await tx
        .update(campaigns)
        // The org is gone. Stating it keeps these rows out of the resume sweep for good.
        .set({ status: "stopped", stopReason: STOP_REASONS.ORG_TEARDOWN, nextRunAt: null, updatedAt: new Date() })
        .where(and(
          eq(campaigns.orgId, orgId),
          or(
            ne(campaigns.status, "stopped"),
            isNotNull(campaigns.nextRunAt),
          ),
        ))
        .returning({ id: campaigns.id });

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

export default router;
