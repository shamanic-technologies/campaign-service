import type { IdentityHeaders } from "@distribute/runs-client";
import { fetchChannelCatalogue, type ChannelCatalogueRead } from "./channel-operator-client.js";
import { fetchCampaignBudgets, type CampaignBudgetsRead } from "./campaign-budget-client.js";
import { fundingFromBudgets } from "./campaign-funding.js";
import { isSalesFamilyFeature } from "./sales-outreach-campaign.js";
import { fetchStartableWorkflowSlug } from "./startable-workflow-client.js";

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
  /** The ceiling billing states for this campaign, by the one shared funding definition. */
  ceilingCents: number;
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
  const legKey = input.legKey;

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
  if (!performed.has(legKey)) {
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
  const operator = catalogue.operatorBySlug.get(input.featureSlug) ?? "platform";
  if (operator === "customer") {
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
