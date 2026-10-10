import { publishedSpelling, storedLegKey } from "./leg-identity.js";
import type { IdentityHeaders } from "@distribute/runs-client";
import { fetchChannelCatalogue, type ChannelCatalogueRead } from "./channel-operator-client.js";
import { fetchCampaignBudgets, type CampaignBudgetsRead } from "./campaign-budget-client.js";
import { fundingFromBudgets } from "./campaign-funding.js";
import { isSalesFamilyFeature, isServicePerformedFeature } from "./sales-outreach-campaign.js";
import { fetchStartableWorkflowSlug } from "./startable-workflow-client.js";
import { SOURCE_LEG_KEY, isLiveSourceOrigin, isSourceOriginSlug } from "./source-campaigns.js";
import { fetchPipe, fetchSalesFunnel } from "./sales-funnel-catalogue-client.js";

/**
 * CAN THE CUSTOMER START THE CAMPAIGN FOR THIS FUNDED (OFFER, LEG, CHANNEL), AND WHAT WOULD IT BE?
 *
 * Funding states a ceiling and creates nothing — money starts nothing. This is the other half: a
 * way for the CUSTOMER to say "start it". Their screen knows four things (brand, offer, leg,
 * acquisition channel) and cannot know the other three:
 *
 *   - the WORKFLOW is this service's choice, re-picked every run, and a slug frozen in a browser
 *     goes stale the moment the catalogue moves;
 *   - the NAME is derivable from the identity;
 *   - the MONEY is billing's, per (offer x leg x channel), and is already set. That is what
 *     "funded" means, and accepting a per-campaign ceiling here would be a second representation
 *     of one fact.
 *
 * So this resolves those three from what is already stated elsewhere, and REFUSES — in a sentence
 * a person can read — when it cannot be started.
 *
 * NOTHING HERE DECIDES THAT A CAMPAIGN SHOULD EXIST. It answers a question a person asked. No
 * sweep, tick, cadence or ceiling reaches it, and it never runs unless somebody pressed a button.
 */

/** A refusal a dashboard renders VERBATIM to the customer, plus a code it can branch on. */
export interface StartRefusal {
  /** HTTP status the route answers with. */
  status: number;
  /** Machine-readable, for a consumer that wants to branch rather than render. */
  code:
    | "leg_required"
    | "channel_not_paced_here"
    | "unknown_channel"
    | "leg_not_performed"
    | "not_funded"
    | "no_workflow"
    | "catalogue_unavailable"
    | "billing_unavailable"
    | "workflow_unavailable";
  /** Customer-facing English. The dashboard shows this and nothing else. */
  message: string;
}

export interface StartablePair {
  /** The single LEG this campaign is bought for, as the customer stated it. */
  legKey: string;
  /**
   * The ceiling billing states for this campaign, by the one shared funding definition. null for a
   * SOURCE campaign: it runs nothing itself, so no ceiling is read to start it (its sourcing spend is
   * paced inside the outreach campaign it feeds, lib/channel-spend.ts).
   */
  ceilingCents: number | null;
  /**
   * The DAG this campaign is born on, or null for a channel the CUSTOMER operates: there is no
   * workflow for work a human performs off-platform, and the absence IS the statement.
   */
  workflowSlug: string | null;
}

export type StartablePairRead =
  | { ok: true; pair: StartablePair }
  | { ok: false; refusal: StartRefusal };

export interface StartPairRequest {
  brandId: string;
  /** brand-service's offer UUID, as stated by the customer's own screen. */
  offerId?: string | null;
  /** The acquisition channel — a features-service feature slug. */
  featureSlug: string;
  /** The single LEG to start — features-service's identifier, never parsed. */
  legKey?: string | null;
}

/**
 * Resolve everything a start needs, or say why it cannot happen.
 *
 * The reads are the ones this service already makes: features-service's PUBLIC channel catalogue
 * (the ONE place that says which legs a channel performs), billing's per-campaign ceilings, and
 * workflow-service's active workflows for the channel. Nothing new is stored, cached or summed.
 */
export async function resolveStartablePair(
  input: StartPairRequest,
  identity: IdentityHeaders & { userId: string; runId: string },
  deps: {
    catalogue?: () => Promise<ChannelCatalogueRead>;
    budgets?: (brandId: string) => Promise<CampaignBudgetsRead>;
    workflow?: typeof fetchStartableWorkflowSlug;
  } = {},
): Promise<StartablePairRead> {
  const readCatalogue = deps.catalogue ?? fetchChannelCatalogue;
  const readBudgets = deps.budgets ?? ((brandId: string) => fetchCampaignBudgets(brandId, identity));
  const readWorkflow = deps.workflow ?? fetchStartableWorkflowSlug;

  if (!input.offerId || !input.legKey) {
    return refuse(
      400,
      "leg_required",
      "Tell us which offer and which step this channel should work, so we know which budget it runs on.",
    );
  }
  // Either outbound spelling of the leg is the same identity; the one STORED is this service's
  // (lib/leg-identity.ts), so a pair started under the new spelling finds and writes the same row.
  const legKey = storedLegKey(input.featureSlug, input.legKey);

  // A SOURCE campaign (lib/source-campaigns.ts): the origin's On/Off for the offer. It has no
  // workflow (lead-service finds the leads inside the outreach campaign's run) and is keyed on the
  // one leg features-service states for every origin; the catalogue publishes no such leg, so it is
  // not asked. No funding read: nothing runs under it on its own.
  if (isSourceOriginSlug(input.featureSlug)) {
    if (!isLiveSourceOrigin(input.featureSlug)) {
      return refuse(400, "unknown_channel", "This lead source is no longer available, so it can't be turned on.");
    }
    if (legKey !== SOURCE_LEG_KEY) {
      return refuse(400, "leg_not_performed", "A lead source only finds leads: start it on its lead-found step.");
    }
    return { ok: true, pair: { legKey, ceilingCents: null, workflowSlug: null } };
  }

  // Membership in the sales family is a MONEY statement: it says this campaign's ceiling is
  // billing's, read live on every plan. A channel outside it is paced on a per-campaign budget
  // column instead, and starting one from a billing ceiling would produce a campaign running a DAG
  // against a ceiling nothing enforces.
  if (!isSalesFamilyFeature(input.featureSlug)) {
    return refuse(
      400,
      "channel_not_paced_here",
      `We can't start a campaign for "${input.featureSlug}" from a funded budget yet.`,
    );
  }

  const catalogue = await readCatalogue();
  if (!catalogue.ok) {
    return refuse(
      502,
      "catalogue_unavailable",
      "We couldn't check what this channel does just now. Please try again in a minute.",
    );
  }

  const performed = catalogue.legsBySlug.get(input.featureSlug);
  if (!performed) {
    return refuse(
      400,
      "unknown_channel",
      `We don't recognise the acquisition channel "${input.featureSlug}".`,
    );
  }
  // The leg must be one this channel performs (features-service's statement, joined verbatim).
  if (publishedSpelling(input.featureSlug, performed, legKey) === null) {
    return refuse(400, "leg_not_performed", "This channel doesn't perform that step.");
  }

  const budgets = await readBudgets(input.brandId);
  if (!budgets.ok) {
    return refuse(
      502,
      "billing_unavailable",
      "We couldn't read this brand's budget just now. Please try again in a minute.",
    );
  }
  const verdict = fundingFromBudgets(
    { featureSlug: input.featureSlug, offerId: input.offerId, legKey },
    budgets,
  );
  if (!verdict.funded) return refuse(409, "not_funded", NOT_FUNDED_MESSAGE);

  // A channel the CUSTOMER operates has NO workflow, and that absence is the statement rather than
  // a gap: the work is performed by a human off-platform, and the campaign exists so their work has
  // a budget line, a scope for stats and something they can pause.
  // Same for a channel ANOTHER SERVICE performs on an event (ai-instant-call): no DAG runs it,
  // so none is looked up and none is required.
  const operator = catalogue.operatorBySlug.get(input.featureSlug) ?? "platform";
  if (operator === "customer" || isServicePerformedFeature(input.featureSlug)) {
    return { ok: true, pair: { legKey, ceilingCents: verdict.ceilingCents, workflowSlug: null } };
  }

  const workflow = await readWorkflow(input.featureSlug, identity);
  if (!workflow.ok) {
    return refuse(
      502,
      "workflow_unavailable",
      "We couldn't work out how to run this channel just now. Please try again in a minute.",
    );
  }
  if (workflow.workflowSlug === null) {
    return refuse(
      409,
      "no_workflow",
      "Nothing can run this channel yet, so there is nothing to start.",
    );
  }

  return {
    ok: true,
    pair: { legKey, ceilingCents: verdict.ceilingCents, workflowSlug: workflow.workflowSlug },
  };
}

const NOT_FUNDED_MESSAGE =
  "You haven't funded this channel for that offer and step. Set its daily budget, then start it.";

function refuse(
  status: number,
  code: StartRefusal["code"],
  message: string,
): { ok: false; refusal: StartRefusal } {
  return { ok: false, refusal: { status, code, message } };
}

/**
 * WHICH DAG A REACTIVE CAMPAIGN THAT IS ON BY DEFAULT IS BORN ON (owner 2026-10-05, see
 * lib/reactive-defaults.ts). Asked only while a PERSON acts on the offer (starting its proactive
 * campaign, saving its sales paths), never by a tick, which is why it lives here beside the other
 * person-start read.
 *
 * Same checks as `resolveStartablePair` except FUNDING: a reactive campaign is on by default, and
 * whether it may spend stays the funding hold's question on every run (unfunded = held, never
 * spends). Returns the same refusal codes so the answer can say why a pair was skipped.
 */
export async function resolveReactiveDefaultWorkflow(
  featureSlug: string,
  legKey: string,
  identity: IdentityHeaders & { userId: string; runId: string },
  catalogue: Extract<ChannelCatalogueRead, { ok: true }>,
  deps: { workflow?: typeof fetchStartableWorkflowSlug } = {},
): Promise<{ ok: true; workflowSlug: string | null } | { ok: false; code: StartRefusal["code"] }> {
  if (!isSalesFamilyFeature(featureSlug)) return { ok: false, code: "channel_not_paced_here" };
  const performed = catalogue.legsBySlug.get(featureSlug);
  if (!performed) return { ok: false, code: "unknown_channel" };
  if (publishedSpelling(featureSlug, performed, legKey) === null) return { ok: false, code: "leg_not_performed" };
  if (
    (catalogue.operatorBySlug.get(featureSlug) ?? "platform") === "customer" ||
    isServicePerformedFeature(featureSlug)
  ) {
    return { ok: true, workflowSlug: null };
  }
  const workflow = await (deps.workflow ?? fetchStartableWorkflowSlug)(featureSlug, identity);
  if (!workflow.ok) return { ok: false, code: "workflow_unavailable" };
  if (workflow.workflowSlug === null) return { ok: false, code: "no_workflow" };
  return { ok: true, workflowSlug: workflow.workflowSlug };
}

// === Sales funnel campaigns (owner 2026-10-10, lib/sales-funnel-campaigns.ts) ===

/** One pipe of the funnel, resolved for a unit to be born on it. */
export interface SalesFunnelUnitPlan {
  /** features-service's pipe id (`<channel slug>|<leg key>`), carried verbatim. */
  pipeId: string;
  featureSlug: string;
  /** The leg in this service's STORED spelling (lib/leg-identity.ts). */
  legKey: string;
  mode: "proactive" | "reactive";
  /** The DAG the unit is born on, or null (customer-operated / service-performed channel). */
  workflowSlug: string | null;
}

export interface SalesFunnelPlan {
  salesFunnelId: string;
  salesFunnelName: string;
  units: SalesFunnelUnitPlan[];
}

/** A refusal to launch a funnel, rendered VERBATIM by the caller (an agent or the dashboard). */
export interface SalesFunnelRefusal {
  status: 400 | 409 | 502;
  code:
    | "unknown_sales_funnel"
    | "no_pipe"
    | "pipe_not_runnable"
    | "no_workflow"
    | "catalogue_unavailable"
    | "workflow_unavailable";
  message: string;
}

/**
 * WHAT A SALES FUNNEL CAMPAIGN IS MADE OF: one unit per pipe the funnel names (features-service's
 * statement, read live), each with the DAG it is born on (the same per-pipe resolution a reactive
 * default uses: sales family, leg performed by the channel, workflow-service's live dynasty; NO
 * funding read, because the funnel's money is billing's funnel caps and they gate every run).
 *
 * Fail LOUD on anything that would leave a pipe of the funnel silently unrun: a pipe this service
 * cannot run refuses the WHOLE launch, naming the pipe, rather than a funnel short of a pipe.
 * Making the funnel COHERENT (a proactive pipe feeding the reactive one) is the agent's job, not
 * this one (owner 2026-10-10): pipes are run independently, as campaigns always have been.
 */
export async function resolveSalesFunnelPlan(
  salesFunnelId: string,
  identity: IdentityHeaders & { userId: string; runId: string },
  deps: {
    salesFunnel?: typeof fetchSalesFunnel;
    pipe?: typeof fetchPipe;
    catalogue?: () => Promise<ChannelCatalogueRead>;
    workflow?: typeof fetchStartableWorkflowSlug;
  } = {},
): Promise<{ ok: true; plan: SalesFunnelPlan } | { ok: false; refusal: SalesFunnelRefusal }> {
  const refuseLaunch = (status: SalesFunnelRefusal["status"], code: SalesFunnelRefusal["code"], message: string) =>
    ({ ok: false as const, refusal: { status, code, message } });
  const unavailable = () =>
    refuseLaunch(502, "catalogue_unavailable", "We couldn't read this sales funnel just now. Please try again in a minute.");

  const read = await (deps.salesFunnel ?? fetchSalesFunnel)(salesFunnelId);
  if (!read.ok) {
    if (read.notFound) return refuseLaunch(400, "unknown_sales_funnel", "We don't know this sales funnel.");
    console.error(`[campaign-service] Sales funnel ${salesFunnelId} unreadable: ${read.detail}`);
    return unavailable();
  }
  if (read.value.pipeIds.length === 0) {
    return refuseLaunch(400, "no_pipe", `The sales funnel "${read.value.name}" has no step we run, so there is nothing to launch.`);
  }

  const catalogue = await (deps.catalogue ?? fetchChannelCatalogue)();
  if (!catalogue.ok) {
    console.error(`[campaign-service] Sales funnel ${salesFunnelId}: channel catalogue unreadable: ${catalogue.detail}`);
    return unavailable();
  }

  const units: SalesFunnelUnitPlan[] = [];
  for (const pipeId of read.value.pipeIds) {
    const pipe = await (deps.pipe ?? fetchPipe)(pipeId);
    if (!pipe.ok) {
      console.error(`[campaign-service] Sales funnel ${salesFunnelId}: pipe ${pipeId} unreadable: ${pipe.detail}`);
      if (pipe.notFound) {
        return refuseLaunch(400, "pipe_not_runnable", `The sales funnel "${read.value.name}" names a step we don't know (${pipeId}).`);
      }
      return unavailable();
    }
    const { channelSlug, legKey, mode, name } = pipe.value;
    // A SOURCING pipe (Start → Lead found, worked by a lead-source ORIGIN): its unit is a source
    // campaign of the funnel (lib/source-campaigns.ts) — no workflow, never scheduled; lead-service
    // finds the leads inside the outreach run and files them under the running source. While it is
    // ON its origin is ON for the offer. A funnel with no sourcing pipe still gets its leads: a
    // person's start of its entry pipe brings the offer's default source (ensureSourcesOnStart).
    if (isSourceOriginSlug(channelSlug)) {
      if (!isLiveSourceOrigin(channelSlug) || storedLegKey(channelSlug, legKey) !== SOURCE_LEG_KEY) {
        return refuseLaunch(400, "pipe_not_runnable", `We can't run the lead source "${name ?? pipeId}" of this sales funnel.`);
      }
      units.push({ pipeId, featureSlug: channelSlug, legKey: SOURCE_LEG_KEY, mode, workflowSlug: null });
      continue;
    }
    const workflow = await resolveReactiveDefaultWorkflow(channelSlug, legKey, identity, catalogue, { workflow: deps.workflow });
    if (!workflow.ok) {
      const label = name ?? pipeId;
      if (workflow.code === "workflow_unavailable") {
        return refuseLaunch(502, "workflow_unavailable", "We couldn't work out how to run this sales funnel just now. Please try again in a minute.");
      }
      if (workflow.code === "no_workflow") {
        return refuseLaunch(409, "no_workflow", `Nothing can run the step "${label}" of this sales funnel yet, so it can't be launched.`);
      }
      return refuseLaunch(400, "pipe_not_runnable", `We can't run the step "${label}" of this sales funnel (${workflow.code}).`);
    }
    units.push({
      pipeId,
      featureSlug: channelSlug,
      legKey: storedLegKey(channelSlug, legKey),
      mode,
      workflowSlug: workflow.workflowSlug,
    });
  }

  return { ok: true, plan: { salesFunnelId: read.value.id, salesFunnelName: read.value.name, units } };
}
