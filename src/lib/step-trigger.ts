import { isInFailureBackoff } from "./run-failure-backoff.js";
import { and, arrayContains, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { campaigns, type Campaign } from "../db/schema.js";
import { fetchChannelCatalogue, type ChannelCatalogueRead } from "./channel-operator-client.js";
import { sameLeg } from "./leg-identity.js";
import { campaignFunding } from "./campaign-funding.js";
import { isSalesFunnelUnit, orderForSharedPipes, pipeKey, salesFunnelUnitMoney, salesFunnelUnitRef, sharedSalesFunnelPipes } from "./sales-funnel-campaigns.js";
import { ensureCampaignRunId } from "./trigger-run.js";
import { getFreshExhaustedAudienceIds } from "./audience-exhaustion.js";
import { resolveSelectionForTrigger } from "./features-workflow-projection-client.js";
import { executeCampaignWorkflow, type WorkflowTriggerInput } from "./workflows.js";
import { replaceRetiredWorkflow } from "./retired-workflow.js";
import {
  hasLiveRunForBrandCohort,
  serializationCohort,
} from "./brand-turns.js";
import { hasLiveRunForCampaign, STUCK_RUN_FRESHNESS_THRESHOLD_MS } from "./scheduler.js";
import { globalSalesPotBlock } from "./global-sales-pot.js";
import { fetchBrandSalesBudget } from "./brand-sales-budget-client.js";
import { itemVerdict } from "./sales-items-pace.js";
import {
  eventConcernsPeople,
  scheduleNamedPersonDue,
  unitPeople,
  type NamedPerson,
} from "./sales-funnel-people.js";
import { fileSalesFunnelCampaignPeople, targetingOfSalesFunnelCampaigns } from "./sales-funnel-people-store.js";
import { eventConcernsGithubIssue } from "./github-issue-trigger.js";
import { oweEventPerson, type EventPerson } from "./trigger-person.js";

/**
 * A LEAD JUST REACHED A STEP — RUN THE CAMPAIGN THAT WAS BOUGHT TO TAKE THEM OUT OF IT, NOW.
 *
 * Everything this service schedules is on a clock: the tick claims what is due, `/end-run`
 * reschedules what just finished. Nothing anywhere could say "this happened, run the campaign
 * responsible for it" — so a prospect who says "yes, interested" waits for the next daily tick
 * before anyone answers them, which is the whole problem the leg they bought exists to solve.
 *
 * This is that entry point, and it is a LOOKUP over state this service already holds. A campaign
 * states the (org, brand, offer, channel) it belongs to and the single LEG it was bought
 * for; features-service publishes which leg leaves which step. Joining the two is the entire
 * resolution — no new column, table, vocabulary or accumulator, and no second scheduler.
 *
 * ── WHAT IS ASKED, AND OF WHOM ──────────────────────────────────────────────────────────────────
 *
 * The caller names the STEP a lead just reached. The leg OUT of that step is features-service's
 * statement, read off the public catalogue it already publishes (`GET /public/channels` ->
 * `legs[]`, each carrying `legKey` and `fromStep`). The identifier is
 * joined VERBATIM against `campaigns.leg_key` and never split back into its two steps — the steps
 * ride beside it on that payload precisely so nobody parses it, and a well-formed `a_to_b` that no
 * catalogue names is still not a leg.
 *
 * Every leg out of the step is in scope, and the campaign bought for it is matched on the (offer,
 * leg) it states. (`conversation` is the step key every customer-facing surface labels "sales
 * interest" — the label is not the token.)
 *
 * ── FAIL LOUD ON THE SCOPE, NO-OP ON THE ANSWER ─────────────────────────────────────────────────
 *
 * A trigger that cannot RESOLVE its scope throws (`StepTriggerScopeError`): a step no catalogue
 * publishes or a catalogue that cannot be read. None of those is a
 * quiet zero — they are a caller's mistake or an outage, and answering them with "nothing to do"
 * would make an unreachable feature indistinguishable from a brand that simply has no campaign for
 * this leg.
 *
 * The ANSWER, on the other hand, is very often nothing, and that is not a failure. Most brands buy
 * one leg; a step nobody bought the leg out of, a campaign that is stopped, held for
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
  /**
   * GLOBAL mode: the brand's ONE daily sales pot is spent (or cannot be judged). The lead is NOT
   * dropped: it stays due in lead-service's queue and the first run the pot can pay for works it.
   */
  GLOBAL_SALES_BUDGET_REACHED: "global_sales_budget_reached",
  /**
   * ITEMS mode: this campaign's own item budget allows nothing more today (or cannot be judged).
   * The lead is NOT dropped: it stays due and the first run the item can pay for works it.
   */
  ITEM_BUDGET_REACHED: "item_budget_reached",
  /** A run of a campaign it shares leads and sending accounts with is in flight. */
  COHORT_RUN_IN_FLIGHT: "cohort_run_in_flight",
  /** The row states no brand, owner or feature, so no execution could be identified. */
  INCOMPLETE: "incomplete_campaign",
  /** The dispatch itself was refused. Named rather than thrown: the other campaigns still run. */
  DISPATCH_REFUSED: "dispatch_refused",
  /**
   * The campaign has failed several runs in a row and is waiting out a widened retry interval
   * (src/lib/run-failure-backoff.ts). An event must not bypass the backoff; the lead is NOT
   * dropped: it stays due and the next scheduled run works it.
   */
  FAILURE_BACKOFF: "failure_backoff",
  /**
   * SALES FUNNELS (lib/sales-funnel-campaigns.ts): two funnels share this pipe (channel x leg), and
   * another live campaign on it already answered this event. One event is worked once.
   */
  PIPE_HANDLED_BY_ANOTHER_CAMPAIGN: "pipe_handled_by_another_campaign",
  /**
   * SALES FUNNELS: the unit's funnel cap is reached, or billing could not measure it (fail-closed).
   * Only a proactive pipe is ever held on it; the lead is not dropped.
   */
  SALES_FUNNEL_CAP: "sales_funnel_cap",
  /**
   * Every audience the grid lists for the campaign is freshly exhausted or outside its targeting
   * subset: a run would reach lead-service with nobody to serve, so none is dispatched.
   */
  NO_SERVEABLE_AUDIENCE: "no_serveable_audience",
  /** features-service states the campaign's play allows no workflow yet: nothing may run. */
  PLAY_ALLOWS_NO_WORKFLOW: "play_allows_no_workflow",
  /**
   * A campaign that NAMES its people (lib/sales-funnel-people.ts) and the event names a lead that is
   * not one of them: the event is about somebody else.
   */
  EVENT_NAMES_ANOTHER_PERSON: "event_names_another_person",
  /**
   * A campaign WAITING ON a GitHub issue (lib/github-issue-trigger.ts) and the event does not name that issue
   * reaching prod: it is not what the campaign waits for.
   */
  EVENT_NAMES_ANOTHER_ISSUE: "event_names_another_issue",
  /** A named person holds no row on this unit at lead-service yet (not filed), so nobody can be made due. */
  PERSON_NOT_FILED: "person_not_filed",
  /** A named person's address matches several rows on this unit at lead-service: who is owed is unclear. */
  AMBIGUOUS_PERSON: "ambiguous_person",
  /** lead-service could not record the named people's debt (unreachable, non-2xx): nothing dispatched. */
  FOLLOWUP_UNAVAILABLE: "followup_unavailable",
  /**
   * The event names a person by identity (lib/trigger-person.ts) the brand does not know yet at
   * lead-service (their CRM fact has not landed): nobody could be filed. The event is retried shortly.
   */
  PERSON_NOT_KNOWN: "person_not_known",
  /**
   * The event names a person the brand stated, and lead-service refused them for a protection a serve
   * applies (unsubscribed, hard-bounced, opt_out / do_not_contact on the human; reason in the detail).
   * Final: never retried, nobody contacted.
   */
  PERSON_SUPPRESSED: "person_suppressed",
} as const;

export type StepTriggerSkipReason = (typeof STEP_TRIGGER_SKIPS)[keyof typeof STEP_TRIGGER_SKIPS];

export interface StepTriggerRequest {
  orgId: string;
  brandId: string;
  /** The OFFER the lead is on — brand-service's id, matched exactly and never inferred. */
  offerId: string;
  /** The step the lead just REACHED. features-service's step key, carried verbatim. */
  step: string;
  /** The lead who reached it, when the caller says (picks which campaign naming its people it concerns). */
  leadId?: string;
}

export interface StepTriggerOutcome {
  step: string;
  /** The legs OUT of that step, as features-service names them. */
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
  return (await runStep(req)).outcome;
}

/**
 * What a scope's pass did, plus what only the trigger-event record reads: the campaigns bought for
 * the matched legs that are OFF (`status = 'stopped'`), read only when no live one matched, so an
 * event can say "the campaign is off" rather than "nobody bought this leg". Never on the step
 * route's answer (its shape is unchanged).
 */
export interface ScopeRun<O> {
  outcome: O;
  offCampaignIds: string[];
}

/** The step route's pass, with the off-campaign read the event record needs. */
export async function runStep(
  req: StepTriggerRequest,
  catalogueRead?: ChannelCatalogueRead,
): Promise<ScopeRun<StepTriggerOutcome> & { triggerId: string | null }> {
  const catalogue = catalogueRead ?? await fetchChannelCatalogue();
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

  // The trigger type a lead reaching this step IS (features-service's `triggers[].fromStep`), for
  // the event record. None declared for the step = the event is recorded with no type.
  let triggerId: string | null = null;
  for (const t of catalogue.triggers?.values() ?? []) {
    if (t.fromStepKey === req.step) { triggerId = t.id; break; }
  }

  // The legs OUT of this step. A terminal step legitimately has none — a lead who became a paying client is at the end of the
  // chain — and that is an ordinary empty answer, not an error.
  const legKeys = catalogue.legs
    .filter((leg) => leg.fromStepKey === req.step)
    .map((leg) => leg.legKey);

  const outcome: StepTriggerOutcome = {
    step: req.step,
    legKeys,
    triggered: [],
    skipped: [],
  };
  if (legKeys.length === 0) return { outcome, offCampaignIds: [], triggerId };

  const run = await runCampaignsInScope(
    req,
    // Either outbound spelling names the same leg (lib/leg-identity.ts).
    (c) => legKeys.some((k) => sameLeg(c.featureSlug, k, c.legKey)),
    `step ${req.step}`,
    undefined,
    req.leadId,
  );
  outcome.triggered = run.triggered;
  outcome.skipped = run.skipped;
  return { outcome, offCampaignIds: run.offCampaignIds, triggerId };
}

/**
 * Run every LIVE campaign of (org, brand, offer) the matcher selects, with the scheduler's own
 * guards and dispatch. Shared by the step route and the trigger events (lib/trigger-events.ts):
 * a trigger id resolves to (channel, leg) pairs, a step to legs, and both run the campaigns
 * exactly the same way.
 */
export async function runCampaignsInScope(
  req: { orgId: string; brandId: string; offerId: string },
  matches: (c: Campaign) => boolean,
  label: string,
  /** The detector-fired event this dispatch answers (lib/trigger-detectors.ts); rides `/execute` inputs. */
  trigger?: WorkflowTriggerInput,
  /**
   * The lead the event NAMES when it is not a detector event (a reported trigger, a step reached).
   * Read only to pick which campaign naming its people the event concerns; never sent anywhere.
   */
  eventLeadId?: string | null,
  /**
   * The person the event names by IDENTITY (lib/trigger-person.ts): filed and made due on each campaign
   * it reaches, then riding `/execute` as `trigger.person` with the lead id lead-service filed them as.
   */
  person?: EventPerson | null,
): Promise<Pick<StepTriggerOutcome, "triggered" | "skipped"> & { offCampaignIds: string[] }> {
  const outcome: Pick<StepTriggerOutcome, "triggered" | "skipped"> = { triggered: [], skipped: [] };

  // Read the brand's live campaigns and select in memory. The population is a handful of rows per
  // brand, and a campaign is identified by (offer, leg, channel).
  const live = await db.query.campaigns.findMany({
    where: and(
      eq(campaigns.orgId, req.orgId),
      eq(campaigns.status, "ongoing"),
      arrayContains(campaigns.brandIds, [req.brandId]),
    ),
  });

  const matched = live.filter(
    (c) =>
      // The offer is matched EXACTLY and never inferred. A campaign that states none is not the
      // campaign of the offer the caller named — the same reason nothing here derives an offer
      // from a goal or a workflow.
      c.offerId === req.offerId &&
      c.legKey !== null &&
      matches(c),
  );
  // A pipe two SALES FUNNELS share has one live campaign per funnel; the oldest that can run answers
  // the event and the others are skipped (lib/sales-funnel-campaigns.ts). No shared pipe = the
  // original order, untouched.
  //
  // A campaign that NAMES its people (lib/sales-funnel-people.ts) is never rationed against another on
  // a shared pipe: it acts for different people. Read only when a funnel unit matched (pre-funnel
  // brands: no read, byte-identical).
  const unitParentIds = matched.flatMap((c) => (c.salesFunnelCampaignId ? [c.salesFunnelCampaignId] : []));
  const targeting = unitParentIds.length > 0 ? await targetingOfSalesFunnelCampaigns(unitParentIds) : new Map();
  const personal = matched.filter((c) => unitPeople(c, targeting));
  const pooled = matched.filter((c) => !unitPeople(c, targeting));
  const responsible = [...orderForSharedPipes(pooled), ...personal];
  const sharedPipes = sharedSalesFunnelPipes(pooled);
  const firedPipes = new Map<string, string>();

  let offCampaignIds: string[] = [];
  if (responsible.length === 0) {
    const stopped = await db.query.campaigns.findMany({
      where: and(
        eq(campaigns.orgId, req.orgId),
        eq(campaigns.status, "stopped"),
        arrayContains(campaigns.brandIds, [req.brandId]),
      ),
    });
    offCampaignIds = stopped
      .filter((c) => c.status === "stopped" && c.offerId === req.offerId && c.legKey !== null && matches(c))
      .map((c) => c.id);
  }

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

    const people = unitPeople(campaign, targeting);
    const namedLeadId = trigger?.leadId ?? eventLeadId ?? null;
    if (people && person && !people.some((p) => p.email === person.email)) {
      skip(STEP_TRIGGER_SKIPS.EVENT_NAMES_ANOTHER_PERSON, `the event names ${person.email}, not one of the people this campaign names`);
      continue;
    }
    if (people && !person && !eventConcernsPeople(people, namedLeadId)) {
      skip(STEP_TRIGGER_SKIPS.EVENT_NAMES_ANOTHER_PERSON, `the event names lead ${namedLeadId}, not one of the people this campaign names`);
      continue;
    }

    const waitsOn = campaign.salesFunnelCampaignId ? targeting.get(campaign.salesFunnelCampaignId)?.githubIssue ?? null : null;
    if (!eventConcernsGithubIssue(waitsOn, trigger?.item)) {
      skip(STEP_TRIGGER_SKIPS.EVENT_NAMES_ANOTHER_ISSUE, `this campaign waits on GitHub issue ${waitsOn} reaching prod; the event does not name it`);
      continue;
    }

    const pipe = !people && sharedPipes.has(pipeKey(campaign)) ? pipeKey(campaign) : null;
    const answeredBy = pipe ? firedPipes.get(pipe) : undefined;
    if (answeredBy) {
      skip(
        STEP_TRIGGER_SKIPS.PIPE_HANDLED_BY_ANOTHER_CAMPAIGN,
        `campaign ${answeredBy} (another sales funnel on the same pipe) answers this event`,
      );
      continue;
    }

    if (isInFailureBackoff(campaign, now)) {
      skip(
        STEP_TRIGGER_SKIPS.FAILURE_BACKOFF,
        `${campaign.consecutiveRunFailures} runs in a row failed; the lead stays due and the next scheduled run (${campaign.nextRunAt!.toISOString()}) works it`,
      );
      continue;
    }

    const moneyIdentity = { orgId: req.orgId, userId: campaign.createdByUserId, campaignId: campaign.id, brandId: brandIds[0] };
    // A SALES FUNNEL unit's money is its funnel's caps, and nothing else (lib/sales-funnel-campaigns.ts).
    const unitMoney = isSalesFunnelUnit(campaign) ? await salesFunnelUnitMoney(salesFunnelUnitRef(campaign), now) : null;
    if (unitMoney && !unitMoney.run) {
      skip(unitMoney.kind === "unfunded" ? STEP_TRIGGER_SKIPS.UNFUNDED : STEP_TRIGGER_SKIPS.SALES_FUNNEL_CAP, unitMoney.detail);
      continue;
    }
    const salesBudget = brandIds.length === 1 && !unitMoney ? await fetchBrandSalesBudget(brandIds[0], moneyIdentity) : null;
    if (unitMoney) {
      // Funded by its funnel: neither an item, a per-pipe ceiling nor the brand pot is its money.
    } else if (salesBudget?.ok && salesBudget.mode === "items") {
      // ITEMS mode: this campaign's item is its money, and nothing else (see sales-items.ts). A
      // step-triggered leg is reactive by definition: capped on its item's period, not paced.
      const verdict = await itemVerdict({
        campaign: {
          id: campaign.id,
          orgId: req.orgId,
          offerId: campaign.offerId,
          legKey: campaign.legKey,
          featureSlug: campaign.featureSlug,
          dailyBudgetCents: campaign.dailyBudgetCents,
        },
        brandId: brandIds[0],
        items: salesBudget.items,
        reactive: true,
        identity: moneyIdentity,
        now,
      });
      if (!verdict.run) {
        if (verdict.kind === "unfunded") skip(STEP_TRIGGER_SKIPS.UNFUNDED, verdict.detail);
        else {
          skip(
            STEP_TRIGGER_SKIPS.ITEM_BUDGET_REACHED,
            `${verdict.detail}; the lead stays due and is worked by the first run the item can pay for (next check ${verdict.nextRunAt.toISOString()})`,
          );
        }
        continue;
      }
    } else {
      const funding = await campaignFunding(campaign, brandIds[0], { orgId: req.orgId });
      if (!funding.funded) {
        skip(STEP_TRIGGER_SKIPS.UNFUNDED, funding.reason);
        continue;
      }
    }

    // Same pot gate-check binds on: firing a run it is about to refuse would only burn the run.
    // (Items mode answers null here: the brand has no pot.)
    const pot = unitMoney ? null : await globalSalesPotBlock(
      { orgId: req.orgId, brandId: brandIds[0], featureSlug: campaign.featureSlug, identity: moneyIdentity },
      now,
      salesBudget,
    );
    if (pot) {
      skip(
        STEP_TRIGGER_SKIPS.GLOBAL_SALES_BUDGET_REACHED,
        `${pot.detail}; the lead stays due and is worked by the first run the budget can pay for (next check ${pot.nextRunAt.toISOString()})`,
      );
      continue;
    }

    // A campaign naming its people: they are made DUE on this unit's own follow-up queue NOW, once its
    // money allows a run (a capped or unfunded campaign owes nobody anything). The debt is durable: a
    // dispatch skipped below (run or cohort in flight) leaves it for the unit's next run to claim.
    if (!person && people) {
      const owed = await makePeopleDue(campaign, people, now);
      if (!owed.ok) {
        skip(owed.code, owed.detail);
        continue;
      }
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

    // An event naming a person by identity: THAT person (and only them) is filed and made due here, only
    // once nothing holds the dispatch back, so the run carrying their item is the one that claims them
    // (a held event is retried as a whole: lib/trigger-events.ts).
    let campaignTrigger = trigger;
    if (person) {
      // The occurrence is the org naming this person for its own brand: lead-service's evidence.
      const statedBy = trigger ? { triggerEventId: trigger.eventId, triggerId: trigger.triggerId } : null;
      const owed = await oweEventPerson(campaign, person, now, statedBy);
      if (!owed.ok) {
        skip(owed.code, owed.detail);
        continue;
      }
      if (campaignTrigger) campaignTrigger = { ...campaignTrigger, leadId: owed.leadId, person };
    }

    try {
      const brandIdCsv = brandIds.join(",");
      const runId = await ensureCampaignRunId(campaign);
      // Same cell pick as the scheduled path — the audience first, then the cheapest workflow in
      // its column — so an event-triggered run lands on the same grid cell a due one would.
      const excludedAudienceIds = await getFreshExhaustedAudienceIds(campaign.id);
      const selection = await resolveSelectionForTrigger({
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
        // The LEG the campaign is bought for — what features-service's model rule is keyed on.
        // A campaign that states none is not selected: it runs its configured workflow, loudly.
        legKey: campaign.legKey,
        // Names the OFFER every brand-scoped read is priced on — a campaign sells exactly one.
        campaignId: campaign.id,
        requiredAudienceIds: campaign.audienceIds,
        excludedAudienceIds,
      });
      if (selection.playHold) {
        skip(STEP_TRIGGER_SKIPS.PLAY_ALLOWS_NO_WORKFLOW, selection.playHold.detail);
        continue;
      }
      if (selection.noServeableAudience) {
        skip(
          STEP_TRIGGER_SKIPS.NO_SERVEABLE_AUDIENCE,
          "every audience it may serve is exhausted for now, so a run would have nobody to contact",
        );
        continue;
      }
      let workflowSlug = selection.workflowSlug;
      const inputs = {
        campaignId: campaign.id,
        orgId: req.orgId,
        brandId: brandIdCsv,
        userId: campaign.createdByUserId,
        runId,
        featureSlug: campaign.featureSlug,
        activeGoalId: campaign.activeGoalId,
        brandProfileId: campaign.brandProfileId,
        audienceId: selection.audienceId ?? campaign.audienceId,
        ...(campaignTrigger ? { trigger: campaignTrigger } : {}),
      };
      try {
        await executeCampaignWorkflow(workflowSlug, inputs);
      } catch (err) {
        // A deprecated workflow (410) is replaced once and never asked for again — see retired-workflow.ts.
        const successor = await replaceRetiredWorkflow(err, {
          campaignId: campaign.id,
          storedSlug: campaign.workflowSlug,
          featureSlug: campaign.featureSlug,
          identity: { orgId: req.orgId, userId: campaign.createdByUserId, runId, brandId: brandIdCsv },
        });
        if (!successor) throw err;
        workflowSlug = successor;
        await executeCampaignWorkflow(workflowSlug, inputs);
      }
      firedCohorts.add(cohort);
      if (pipe) firedPipes.set(pipe, campaign.id);
      outcome.triggered.push({
        campaignId: campaign.id,
        legKey: campaign.legKey,
        workflowSlug,
      });
      console.log(
        `[campaign-service] Campaign ${campaign.id} triggered on the step a lead reached (org ${req.orgId}, brand ${brandIds[0]}, ${label})`,
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

  return { ...outcome, offCampaignIds };
}

/**
 * Make every named person of a unit due now (lib/sales-funnel-people.ts). At least one made due = ok
 * (a failed one is logged); none = the first failure, named.
 */
async function makePeopleDue(
  unit: Campaign,
  people: readonly NamedPerson[],
  now: Date,
): Promise<{ ok: true } | { ok: false; code: StepTriggerSkipReason; detail: string }> {
  let first: { code: StepTriggerSkipReason; detail: string } | null = null;
  let owed = 0;
  let refiled = false;
  for (const person of people) {
    let outcome = await scheduleNamedPersonDue({ orgId: unit.orgId, campaignId: unit.id, email: person.email, now });
    // Not filed on this unit yet (born before lead-service could file them): file now, then make due.
    if (!outcome.ok && outcome.code === "person_not_filed" && unit.salesFunnelCampaignId && !refiled) {
      refiled = true;
      await fileSalesFunnelCampaignPeople({
        salesFunnelCampaignId: unit.salesFunnelCampaignId,
        orgId: unit.orgId,
        people,
        units: [unit],
        userId: unit.createdByUserId,
        runId: unit.parentRunId,
      });
      outcome = await scheduleNamedPersonDue({ orgId: unit.orgId, campaignId: unit.id, email: person.email, now });
    }
    if (outcome.ok) {
      owed += 1;
      continue;
    }
    console.error(
      `[campaign-service] campaign ${unit.id}: named person ${person.email} not made due (${outcome.code}): ${outcome.detail}`,
    );
    first ??= { code: outcome.code, detail: `${person.email}: ${outcome.detail}` };
  }
  return owed > 0 || !first ? { ok: true } : { ok: false, ...first };
}
