import { and, arrayContains, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { campaigns } from "../db/schema.js";
import { fetchChannelCatalogue } from "./channel-operator-client.js";
import { toFunnelKey } from "./sales-funnel-vocabulary.js";
import { campaignFunding } from "./campaign-funding.js";
import { ensureCampaignRunId } from "./trigger-run.js";
import { resolveWorkflowSlugForTrigger } from "./features-workflow-projection-client.js";
import { executeCampaignWorkflow } from "./workflows.js";
import {
  hasLiveRunForBrandCohort,
  serializationCohort,
} from "./funnel-campaigns.js";
import { hasLiveRunForCampaign, STUCK_RUN_FRESHNESS_THRESHOLD_MS } from "./scheduler.js";

/**
 * A LEAD JUST REACHED A STEP — RUN THE CAMPAIGN THAT WAS BOUGHT TO TAKE THEM OUT OF IT, NOW.
 *
 * Everything this service schedules is on a clock: the tick claims what is due, `/end-run`
 * reschedules what just finished. Nothing anywhere could say "this happened, run the campaign
 * responsible for it" — so a prospect who says "yes, interested" waits for the next daily tick
 * before anyone answers them, which is the whole problem the leg they bought exists to solve.
 *
 * This is that entry point, and it is a LOOKUP over state this service already holds. A campaign
 * states the (org, brand, offer, funnel, channel) it belongs to and the single LEG it was bought
 * for; features-service publishes which leg leaves which step. Joining the two is the entire
 * resolution — no new column, table, vocabulary or accumulator, and no second scheduler.
 *
 * ── WHAT IS ASKED, AND OF WHOM ──────────────────────────────────────────────────────────────────
 *
 * The caller names the STEP a lead just reached. The leg OUT of that step is features-service's
 * statement, read off the public catalogue it already publishes (`GET /public/channels` ->
 * `legs[]`, each carrying `legKey`, `fromStep` and the funnels it is a leg of). The identifier is
 * joined VERBATIM against `campaigns.leg_key` and never split back into its two steps — the steps
 * ride beside it on that payload precisely so nobody parses it, and a well-formed `a_to_b` that no
 * catalogue names is still not a leg.
 *
 * A leg belongs to several funnels at once, which is why the funnel the caller names is part of the
 * question rather than derivable from it: `sales_interest -> meeting_booked` is a leg of more than
 * one chain, and only the customer's funding says which one they bought.
 *
 * ── FAIL LOUD ON THE SCOPE, NO-OP ON THE ANSWER ─────────────────────────────────────────────────
 *
 * A trigger that cannot RESOLVE its scope throws (`StepTriggerScopeError`): a step no catalogue
 * publishes, a funnel naming none of the four, a catalogue that cannot be read. None of those is a
 * quiet zero — they are a caller's mistake or an outage, and answering them with "nothing to do"
 * would make an unreachable feature indistinguishable from a brand that simply has no campaign for
 * this leg.
 *
 * The ANSWER, on the other hand, is very often nothing, and that is not a failure. Most brands buy
 * one leg of one funnel; a step nobody bought the leg out of, a campaign that is stopped, held for
 * money, already running, or operated by the customer's own team all return a NAMED skip the caller
 * can read. That is what makes "no campaign performs this" distinguishable from "something broke".
 *
 * ── THE GATE IS UNTOUCHED ───────────────────────────────────────────────────────────────────────
 *
 * Nothing here decides whether money may be spent. The dispatch is byte-identical to the
 * scheduler's — the same anchor run, the same greedy workflow pick, the same `/execute` — so the
 * run starts at `gate-check`, the first node of every DAG, and is refused there exactly as a
 * scheduled run would be. What IS checked first is the same pair of guards the scheduler applies
 * before dispatching, because both are correctness rather than pacing: never two runs of one
 * campaign, and never two runs of one brand COHORT (the outbound channels share a lead population
 * and a set of sending accounts, so a second concurrent run contacts the same people from the same
 * mailboxes). And the campaign must be FUNDED on the one shared definition (`campaignFunding`) —
 * fail-CLOSED, as everywhere else that decides whether to start spending: a reply must never make a
 * defunded campaign spend, and firing a run the gate is about to refuse could only burn it.
 */

/** Why a campaign this step resolves to was NOT run. Every one is an ordinary business state. */
export const STEP_TRIGGER_SKIPS = {
  /** Its channel is operated by the CUSTOMER's own team, so it has no DAG and never runs one. */
  NO_WORKFLOW: "no_workflow",
  /** The customer funds nothing for it — the same definition the turn planner holds it on. */
  UNFUNDED: "unfunded",
  /** A run of this campaign is already in flight. The event is already being answered. */
  RUN_IN_FLIGHT: "run_in_flight",
  /** A run of a campaign it shares leads and sending accounts with is in flight. */
  COHORT_RUN_IN_FLIGHT: "cohort_run_in_flight",
  /** The row states no brand, owner or feature, so no execution could be identified. */
  INCOMPLETE: "incomplete_campaign",
  /** The dispatch itself was refused. Named rather than thrown: the other campaigns still run. */
  DISPATCH_REFUSED: "dispatch_refused",
} as const;

export type StepTriggerSkipReason = (typeof STEP_TRIGGER_SKIPS)[keyof typeof STEP_TRIGGER_SKIPS];

export interface StepTriggerRequest {
  orgId: string;
  brandId: string;
  /** The OFFER the lead is on — brand-service's id, matched exactly and never inferred. */
  offerId: string;
  /** Any spelling the vocabulary accepts; canonicalized before anything is compared. */
  funnelKey: string;
  /** The step the lead just REACHED. features-service's step key, carried verbatim. */
  step: string;
}

export interface StepTriggerOutcome {
  /** The canonical funnel the request named. */
  funnelKey: string;
  step: string;
  /** The legs OUT of that step on that funnel, as features-service names them. */
  legKeys: string[];
  triggered: Array<{ campaignId: string; legKey: string | null; workflowSlug: string }>;
  skipped: Array<{
    campaignId: string;
    legKey: string | null;
    reason: StepTriggerSkipReason;
    detail: string;
  }>;
}

/**
 * The scope could not be resolved. NOT a no-op: the caller named something this fleet does not
 * publish, or features-service could not be asked at all.
 */
export class StepTriggerScopeError extends Error {
  readonly status: 400 | 502;
  constructor(message: string, status: 400 | 502) {
    super(message);
    this.name = "StepTriggerScopeError";
    this.status = status;
  }
}

export async function triggerCampaignsForStep(
  req: StepTriggerRequest,
): Promise<StepTriggerOutcome> {
  const funnelKey = toFunnelKey(req.funnelKey);
  if (!funnelKey) {
    throw new StepTriggerScopeError(
      `funnelKey ${JSON.stringify(req.funnelKey)} names no sales funnel`,
      400,
    );
  }

  const catalogue = await fetchChannelCatalogue();
  if (!catalogue.ok) {
    // Fail LOUD, unlike provisioning's read of the same catalogue. There the fallback is today's
    // behaviour; here there is no behaviour to fall back to — an unanswerable question must not be
    // returned as "nobody performs this leg".
    throw new StepTriggerScopeError(
      `the acquisition-channel catalogue could not be read: ${catalogue.detail}`,
      502,
    );
  }

  if (!catalogue.stepKeys.has(req.step)) {
    throw new StepTriggerScopeError(
      `step ${JSON.stringify(req.step)} is not a step features-service publishes`,
      400,
    );
  }

  // The legs OUT of this step, on the funnel the caller named. A terminal step legitimately has
  // none — a lead who became a paying client is at the end of the chain — and that is an ordinary
  // empty answer, not an error.
  const legKeys = catalogue.legs
    .filter((leg) => leg.fromStepKey === req.step)
    .filter((leg) => [...leg.funnelKeys].some((key) => toFunnelKey(key) === funnelKey))
    .map((leg) => leg.legKey);

  const outcome: StepTriggerOutcome = {
    funnelKey,
    step: req.step,
    legKeys,
    triggered: [],
    skipped: [],
  };
  if (legKeys.length === 0) return outcome;

  const wanted = new Set(legKeys);

  // Read the brand's live campaigns and select in memory. The population is a handful of rows per
  // brand, and the three words that identify the campaign (offer, funnel, leg) are compared under
  // the same canonicalization everything else in this service uses.
  const live = await db.query.campaigns.findMany({
    where: and(
      eq(campaigns.orgId, req.orgId),
      eq(campaigns.status, "ongoing"),
      arrayContains(campaigns.brandIds, [req.brandId]),
    ),
  });

  const responsible = live.filter(
    (c) =>
      // The offer is matched EXACTLY and never inferred. A campaign that states none is not the
      // campaign of the offer the caller named — the same reason nothing here derives an offer
      // from a funnel, a goal or a workflow.
      c.offerId === req.offerId &&
      toFunnelKey(c.funnelKey) === funnelKey &&
      c.legKey !== null &&
      wanted.has(c.legKey),
  );

  const now = new Date();
  const freshnessCutoff = new Date(now.getTime() - STUCK_RUN_FRESHNESS_THRESHOLD_MS);
  // A cohort this pass has already fired into is busy for the rest of it: the run it just started
  // is not visible to runs-service's "is one alive" read yet, and two campaigns of one cohort must
  // never run at once.
  const firedCohorts = new Set<string>();

  for (const campaign of responsible) {
    const skip = (reason: StepTriggerSkipReason, detail: string) =>
      outcome.skipped.push({ campaignId: campaign.id, legKey: campaign.legKey, reason, detail });

    // A campaign with no DAG is a channel the CUSTOMER operates: the work happens off-platform and
    // there is nothing here to execute. The absence of a workflow IS the statement.
    if (!campaign.workflowSlug) {
      skip(STEP_TRIGGER_SKIPS.NO_WORKFLOW, "this channel is operated by the customer's own team");
      continue;
    }

    const brandIds = campaign.brandIds ?? [];
    if (brandIds.length === 0 || !campaign.createdByUserId || !campaign.featureSlug) {
      skip(STEP_TRIGGER_SKIPS.INCOMPLETE, "the campaign states no brand, owner or feature");
      continue;
    }

    const funding = await campaignFunding(campaign, brandIds[0], { orgId: req.orgId });
    if (!funding.funded) {
      skip(STEP_TRIGGER_SKIPS.UNFUNDED, funding.reason);
      continue;
    }

    if (await hasLiveRunForCampaign(req.orgId, campaign.id, freshnessCutoff)) {
      skip(STEP_TRIGGER_SKIPS.RUN_IN_FLIGHT, "a run of this campaign is already in flight");
      continue;
    }

    const cohort = serializationCohort(campaign.featureSlug);
    if (
      firedCohorts.has(cohort) ||
      (await hasLiveRunForBrandCohort(req.orgId, brandIds[0], cohort, now))
    ) {
      skip(
        STEP_TRIGGER_SKIPS.COHORT_RUN_IN_FLIGHT,
        `a run of the brand's ${cohort} campaigns is already in flight`,
      );
      continue;
    }

    try {
      const brandIdCsv = brandIds.join(",");
      const runId = await ensureCampaignRunId(campaign);
      const workflowSlug = await resolveWorkflowSlugForTrigger({
        featureSlug: campaign.featureSlug,
        primaryBrandId: brandIds[0],
        identity: {
          orgId: req.orgId,
          userId: campaign.createdByUserId,
          runId,
          campaignId: campaign.id,
          brandId: brandIdCsv,
          workflowSlug: campaign.workflowSlug,
          featureSlug: campaign.featureSlug,
        },
        fallbackSlug: campaign.workflowSlug,
        funnelKey: campaign.funnelKey,
      });
      await executeCampaignWorkflow(workflowSlug, {
        campaignId: campaign.id,
        orgId: req.orgId,
        brandId: brandIdCsv,
        userId: campaign.createdByUserId,
        runId,
        featureSlug: campaign.featureSlug,
        activeGoalId: campaign.activeGoalId,
        brandProfileId: campaign.brandProfileId,
        audienceId: campaign.audienceId,
      });
      firedCohorts.add(cohort);
      outcome.triggered.push({
        campaignId: campaign.id,
        legKey: campaign.legKey,
        workflowSlug,
      });
      console.log(
        `[campaign-service] Campaign ${campaign.id} triggered on the step a lead reached (org ${req.orgId}, brand ${brandIds[0]}, step ${req.step})`,
      );
    } catch (err) {
      // One campaign's refused dispatch does not decide the others'. It is REPORTED, never
      // swallowed: a caller reading `triggered: []` must be able to tell an outage from a brand
      // that has no campaign for this leg.
      const detail = err instanceof Error ? err.message : String(err);
      console.error(
        `[campaign-service] Step trigger could not run campaign ${campaign.id} (org ${req.orgId}):`,
        err,
      );
      skip(STEP_TRIGGER_SKIPS.DISPATCH_REFUSED, detail);
    }
  }

  return outcome;
}
