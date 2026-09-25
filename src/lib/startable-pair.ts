import type { IdentityHeaders } from "@distribute/runs-client";
import { fetchChannelCatalogue, type ChannelCatalogueRead } from "./channel-operator-client.js";
import {
  fetchFunnelBudgets,
  legCeilingCents,
  type FunnelBudgetsRead,
} from "./funnel-budget-client.js";
import { fundingFromBudgets } from "./campaign-funding.js";
import { isSalesFunnelFeature } from "./sales-outreach-campaign.js";
import { toFunnelKey, type SalesFunnelKey } from "./sales-funnel-vocabulary.js";
import { fetchStartableWorkflowSlug } from "./startable-workflow-client.js";

/**
 * CAN THE CUSTOMER START THE CAMPAIGN FOR THIS FUNDED PAIR, AND WHAT WOULD IT BE?
 *
 * A customer funds an acquisition channel on one of their sales funnels from their own dashboard,
 * and expects that channel to start working. Since 2026-09-06 funding states a ceiling and creates
 * nothing — money starts nothing, and that is not being reversed. What was missing is the other
 * half: a way for the CUSTOMER to say "start it". Their screen knows four things (brand, offer,
 * sales funnel, acquisition channel) and cannot know the other three:
 *
 *   - the WORKFLOW is this service's choice, re-picked every run, and a slug frozen in a browser
 *     goes stale the moment the catalogue moves;
 *   - the NAME is derivable from the identity;
 *   - the MONEY is billing's, per (offer x funnel x channel x leg), and is already set. That is
 *     what "funded" means, and accepting a per-campaign ceiling here would be a second
 *     representation of one fact.
 *
 * So this resolves those three from what is already stated elsewhere, and REFUSES — in a sentence
 * a person can read — when the pair cannot be started. The refusal is the product: a customer who
 * pressed start and got nothing must be told which of the four possible reasons applies.
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
    | "unknown_funnel"
    | "leg_required"
    | "channel_not_paced_here"
    | "unknown_channel"
    | "channel_does_not_sell_funnel"
    | "leg_not_performed"
    | "several_funded_legs"
    | "not_funded"
    | "no_workflow"
    | "catalogue_unavailable"
    | "billing_unavailable"
    | "workflow_unavailable";
  /** Customer-facing English. The dashboard shows this and nothing else. */
  message: string;
}

export interface StartablePair {
  /** The funnel the caller still named, or null for a start by (offer, leg, channel) alone. */
  funnelKey: SalesFunnelKey | null;
  /**
   * The single funnel LEG this campaign is bought for, taken from the CEILING the customer set —
   * never derived from the funnel or the channel. Null when the customer's money for this pair
   * names no leg, which is the pre-leg population and paces on the offer figure exactly as it
   * always did.
   */
  legKey: string | null;
  /** The ceiling billing states for this pair, by the one shared funding definition. */
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
  /**
   * OPTIONAL since wave C1. A caller that still names a funnel (any accepted spelling) is resolved
   * exactly as before. A caller that names none must state the OFFER and the LEG: that is the
   * campaign's identity, and the money is read at (offer, leg, channel).
   */
  funnelKey?: string | null;
  /** The acquisition channel — a features-service feature slug. */
  featureSlug: string;
  /**
   * OPTIONAL, and only ever a disambiguation: when the customer funds two legs of one (funnel,
   * channel, offer) there are genuinely two campaigns to start, and this says which. It is never
   * required, and a leg the channel does not perform is refused rather than stamped.
   */
  legKey?: string | null;
}

/**
 * Resolve everything a start needs, or say why it cannot happen.
 *
 * The reads are the ones this service already makes: features-service's PUBLIC channel catalogue
 * (the ONE place that says which legs a channel performs and which funnels each leg is a leg of),
 * billing's per-funnel ceilings, and workflow-service's active workflows for the channel. Nothing
 * new is stored, cached or summed, and no vocabulary is held here.
 */
export async function resolveStartablePair(
  input: StartPairRequest,
  identity: IdentityHeaders & { userId: string; runId: string },
  deps: {
    catalogue?: () => Promise<ChannelCatalogueRead>;
    budgets?: (brandId: string) => Promise<FunnelBudgetsRead>;
    workflow?: typeof fetchStartableWorkflowSlug;
  } = {},
): Promise<StartablePairRead> {
  const readCatalogue = deps.catalogue ?? fetchChannelCatalogue;
  const readBudgets = deps.budgets ?? ((brandId: string) => fetchFunnelBudgets(brandId, identity));
  const readWorkflow = deps.workflow ?? fetchStartableWorkflowSlug;

  const funnelKey = input.funnelKey ? toFunnelKey(input.funnelKey) : null;
  if (input.funnelKey && !funnelKey) {
    return refuse(400, "unknown_funnel", `We don't recognise the sales funnel "${input.funnelKey}".`);
  }
  if (!funnelKey && (!input.offerId || !input.legKey)) {
    return refuse(
      400,
      "leg_required",
      "Tell us which offer and which step this channel should work, so we know which budget it runs on.",
    );
  }

  // Membership in the funnel-funded family is a MONEY statement: it says this campaign's ceiling is
  // billing's, read live on every plan. A channel outside it is paced on a per-campaign budget
  // column instead, and starting one from a billing ceiling would produce a campaign running a DAG
  // against a ceiling nothing enforces — the exact failure the family's own refusal exists to stop.
  if (!isSalesFunnelFeature(input.featureSlug)) {
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
      "We couldn't check what this channel sells just now. Please try again in a minute.",
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

  // A START BY (OFFER, LEG, CHANNEL) — no funnel named, none read (wave C1). The leg must be one
  // this channel performs (features-service's statement, joined verbatim), and the money is the
  // (offer, leg, channel) ceiling: the same one definition the gate and the turn planner read.
  if (!funnelKey) {
    const legKey = input.legKey!;
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
      { funnelKey: null, featureSlug: input.featureSlug, offerId: input.offerId ?? null, legKey },
      budgets,
    );
    if (!verdict.funded) return refuse(409, "not_funded", NOT_FUNDED_MESSAGE);
    return finishStart(catalogue, input.featureSlug, identity, readWorkflow, {
      funnelKey: null,
      legKey,
      ceilingCents: verdict.ceilingCents,
    });
  }

  // WHICH LEGS THIS CHANNEL CAN SELL THIS FUNNEL THROUGH — features-service's statement, joined
  // verbatim. A leg identifier is OPAQUE: the steps it connects ride beside it on the same payload
  // precisely so nobody splits it, and no leg vocabulary exists in this service.
  let candidates = catalogue.legs.filter(
    (leg) => performed.has(leg.legKey) && leg.funnelKeys.has(funnelKey),
  );
  if (candidates.length === 0) {
    return refuse(
      400,
      "channel_does_not_sell_funnel",
      "This channel doesn't sell that sales funnel.",
    );
  }

  if (input.legKey) {
    const stated = candidates.filter((leg) => leg.legKey === input.legKey);
    if (stated.length === 0) {
      return refuse(
        400,
        "leg_not_performed",
        "This channel doesn't perform that step of the sales funnel.",
      );
    }
    candidates = stated;
  }

  const budgets = await readBudgets(input.brandId);
  if (!budgets.ok) {
    return refuse(
      502,
      "billing_unavailable",
      "We couldn't read this brand's budget just now. Please try again in a minute.",
    );
  }

  // THE LEG COMES FROM THE MONEY, NEVER FROM THE FUNNEL. When this brand's ceilings for the pair
  // name legs, the campaign must state one of them — falling back to the coarser offer figure there
  // would hand this campaign the money a sibling leg was funded with, which is the failure the leg
  // grain exists to close. When they name none, the campaign states none: that is the pre-leg
  // population, and a leg is never fabricated for it.
  const legScoped = candidates.some(
    (leg) =>
      legCeilingCents(budgets, funnelKey, input.featureSlug, input.offerId ?? null, leg.legKey)
        .grain === "leg",
  );

  let resolvedLeg: string | null = null;

  if (legScoped) {
    const funded = candidates.filter((leg) => {
      const verdict = fundingFromBudgets(
        {
          funnelKey,
          featureSlug: input.featureSlug,
          offerId: input.offerId ?? null,
          legKey: leg.legKey,
        },
        budgets,
      );
      return verdict.funded;
    });

    if (funded.length === 0) return refuse(409, "not_funded", NOT_FUNDED_MESSAGE);
    if (funded.length > 1) {
      return refuse(
        400,
        "several_funded_legs",
        "You've funded more than one step of this sales funnel on this channel, so there is more " +
          "than one campaign to start. Tell us which step you mean.",
      );
    }
    resolvedLeg = funded[0]!.legKey;
  }

  const verdict = fundingFromBudgets(
    {
      funnelKey,
      featureSlug: input.featureSlug,
      offerId: input.offerId ?? null,
      legKey: resolvedLeg,
    },
    budgets,
  );
  if (!verdict.funded) return refuse(409, "not_funded", NOT_FUNDED_MESSAGE);

  return finishStart(catalogue, input.featureSlug, identity, readWorkflow, {
    funnelKey,
    legKey: resolvedLeg,
    ceilingCents: verdict.ceilingCents,
  });
}

/** Who runs the channel, and on which DAG — the same answer whichever way the pair was named. */
async function finishStart(
  catalogue: Extract<ChannelCatalogueRead, { ok: true }>,
  featureSlug: string,
  identity: IdentityHeaders & { userId: string; runId: string },
  readWorkflow: typeof fetchStartableWorkflowSlug,
  pair: { funnelKey: SalesFunnelKey | null; legKey: string | null; ceilingCents: number },
): Promise<StartablePairRead> {
  // A channel the CUSTOMER operates has NO workflow, and that absence is the statement rather than
  // a gap: the legs the platform does not automate are performed by a human off-platform, and the
  // campaign exists so their work has a budget line, a scope for stats and something they can
  // pause. Inventing a no-op DAG for it would be a second, false representation of the same fact.
  const operator = catalogue.operatorBySlug.get(featureSlug) ?? "platform";
  if (operator === "customer") {
    return { ok: true, pair: { ...pair, workflowSlug: null } };
  }

  const workflow = await readWorkflow(featureSlug, identity);
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

  return { ok: true, pair: { ...pair, workflowSlug: workflow.workflowSlug } };
}

const NOT_FUNDED_MESSAGE =
  "You haven't funded this channel for that sales funnel. Set its daily budget, then start it.";

function refuse(
  status: number,
  code: StartRefusal["code"],
  message: string,
): { ok: false; refusal: StartRefusal } {
  return { ok: false, refusal: { status, code, message } };
}
