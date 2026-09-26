import { and, arrayContains, eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { campaigns } from "../db/schema.js";
import { fetchChannelCatalogue, type ChannelCatalogueRead } from "./channel-operator-client.js";

/**
 * WHICH CAMPAIGN RAN THE LEG THAT ENDS WHERE THIS ONE BEGINS.
 *
 * A customer's journey is several LEGS and this service mints one campaign per leg, so the customer's single
 * journey is filed across siblings. That is fine until a leg's work is ABOUT A NAMED PERSON whose
 * history lives on the leg before it: a prospect replies to a cold email (`start_to_conversation`)
 * and the campaign bought to answer them (`conversation_to_meeting_booked`) knows only its own id,
 * while the person, the thread and the record of what we owe them are all filed under the
 * cold-email campaign. The worker then looks in its own campaign's drawer, finds it empty every
 * time, and reports "nobody is due" forever — which is indistinguishable from there being nothing
 * to do. Measured 2026-09-21: six people waiting, none ever claimed, zero answers sent.
 *
 * The worker cannot resolve this itself. Only this service knows that two campaigns are two legs
 * of one journey for one offer.
 *
 * ── IT IS A LOOKUP OVER STATE ALREADY HELD ──────────────────────────────────────────────────────
 *
 * A campaign states its (org, brand, offer) and the single LEG it was bought for;
 * features-service publishes, per leg, which step it leaves and which step it enters. Joining the
 * two is the whole resolution. No column, table, link, accumulator or scheduler is added, and
 * nothing about how a campaign is funded, gated, scheduled or triggered changes — money stays on
 * the campaign that spends it.
 *
 * ── THE IDENTIFIER IS ASKED, NEVER PARSED ───────────────────────────────────────────────────────
 *
 * The leg a campaign is bought for is features-service's identifier, carried verbatim. The steps
 * ride BESIDE it on the catalogue precisely so nobody splits it: a well-formed `a_to_b` that no
 * catalogue names is still not a leg, so parsing could only ever invent one. `channel-operator-
 * client.ts` stays the ONE reader of that catalogue, exactly as the step trigger left it.
 *
 * ── NOTHING IS GUESSED ──────────────────────────────────────────────────────────────────────────
 *
 * A campaign at the FIRST leg of a journey has no predecessor, and that is expressible: an ENTRY
 * leg states no step before it, so the answer is a named ABSENCE, never the closest-looking
 * sibling. Same for a campaign that states no leg, no offer or no brand — each is a
 * true statement about the data and each says which one it is. And "there is no predecessor" is
 * kept strictly apart from "it could not be worked out": an unreadable catalogue, a leg the
 * catalogue does not publish, and two live siblings that both end where this one begins are
 * REFUSALS, because answering any of them with `null` would make an outage look exactly like a
 * journey with one leg.
 *
 * ── WHICH SIBLING, WHEN THERE ARE SEVERAL ROWS ──────────────────────────────────────────────────
 *
 * The LIVE campaign of the preceding leg wins; when none is live, the most recently created
 * STOPPED one does — the history the caller is looking for is filed under it, and production
 * carries hundreds of stopped rows per identity from before this was one campaign. Two LIVE
 * siblings (two channels performing the same preceding leg for one offer) is genuinely ambiguous
 * and is refused rather than resolved by a tie-break nobody agreed to.
 */

/** Why there is no predecessor. Every one is an ordinary, true statement about the data. */
export const PREDECESSOR_ABSENCES = {
  /** This campaign's leg STARTS a journey: the lead was at no step before it. */
  ENTRY_LEG: "entry_leg",
  /** The campaign predates the leg column, or nobody has said which leg it was bought for. */
  NO_LEG: "campaign_states_no_leg",
  /** The campaign states no offer, and an offer is never inferred from a brand. */
  NO_OFFER: "campaign_states_no_offer",
  /** The row names no brand, so there is no (org, brand) scope to look inside. */
  NO_BRAND: "campaign_states_no_brand",
  /** The preceding leg exists; nobody bought a campaign for it on this offer. */
  NO_CAMPAIGN: "no_campaign_for_preceding_leg",
} as const;

export type PredecessorAbsence = (typeof PREDECESSOR_ABSENCES)[keyof typeof PREDECESSOR_ABSENCES];

export interface PredecessorCampaign {
  campaignId: string;
  legKey: string;
  status: string;
  acquisitionChannel: string | null;
  featureSlug: string | null;
  workflowSlug: string | null;
}

export interface PredecessorOutcome {
  /** The campaign asked about, restated so a caller can see what the answer was resolved on. */
  campaignId: string;
  legKey: string | null;
  offerId: string | null;
  brandId: string | null;
  /** The step this campaign's leg takes a lead OUT of — where its predecessor must end. */
  fromStepKey: string | null;
  /** Every published leg that ENDS at that step, as features-service names them. */
  precedingLegKeys: string[];
  predecessor: PredecessorCampaign | null;
  /** Names WHY there is none. `null` exactly when `predecessor` is not null. */
  absence: PredecessorAbsence | null;
}

/**
 * The question could not be answered — as opposed to answered with "there is none". A caller must
 * be able to tell an outage or a disagreement from a journey whose first leg this is.
 */
export class PredecessorScopeError extends Error {
  readonly status: 404 | 409 | 502;
  readonly reason: string;
  constructor(message: string, status: 404 | 409 | 502, reason: string) {
    super(message);
    this.name = "PredecessorScopeError";
    this.status = status;
    this.reason = reason;
  }
}

/**
 * `catalogueRead` lets a caller resolving several campaigns in one pass (the answering-campaign
 * read) share ONE catalogue read. Absent, the catalogue is read here exactly as before.
 */
export async function resolvePredecessorCampaign(
  campaignId: string,
  catalogueRead?: ChannelCatalogueRead,
): Promise<PredecessorOutcome> {
  const campaign = await db.query.campaigns.findFirst({
    where: eq(campaigns.id, campaignId),
  });
  if (!campaign) {
    throw new PredecessorScopeError(
      `campaign ${JSON.stringify(campaignId)} does not exist`,
      404,
      "unknown_campaign",
    );
  }

  const brandId = campaign.brandId ?? campaign.brandIds?.[0] ?? null;

  const answer = (absence: PredecessorAbsence, extra?: Partial<PredecessorOutcome>): PredecessorOutcome => ({
    campaignId: campaign.id,
    legKey: campaign.legKey,
    offerId: campaign.offerId,
    brandId,
    fromStepKey: null,
    precedingLegKeys: [],
    predecessor: null,
    absence,
    ...extra,
  });

  // Each of these is a TRUE statement about this campaign, not a failure to work something out.
  if (!campaign.legKey) return answer(PREDECESSOR_ABSENCES.NO_LEG);
  if (!campaign.offerId) return answer(PREDECESSOR_ABSENCES.NO_OFFER);
  if (!brandId) return answer(PREDECESSOR_ABSENCES.NO_BRAND);

  const catalogue = catalogueRead ?? (await fetchChannelCatalogue());
  if (!catalogue.ok) {
    // Fail LOUD. "The catalogue is down" and "this leg starts the journey" are different answers
    // and collapsing them is how an outage looks like a one-leg chain.
    throw new PredecessorScopeError(
      `the acquisition-channel catalogue could not be read: ${catalogue.detail}`,
      502,
      "catalogue_unavailable",
    );
  }

  const ownLeg = catalogue.legs.find((leg) => leg.legKey === campaign.legKey);
  if (!ownLeg) {
    // The campaign carries a leg the fleet no longer publishes. A real disagreement between two
    // services about what a leg is — not an absence, and never resolved by guessing.
    throw new PredecessorScopeError(
      `leg ${JSON.stringify(campaign.legKey)} is not a leg features-service publishes`,
      409,
      "leg_not_published",
    );
  }

  // An ENTRY leg takes a lead out of NOTHING: they were at no step before it. That is the first
  // leg of the chain and it has no predecessor, full stop.
  if (!ownLeg.fromStepKey) return answer(PREDECESSOR_ABSENCES.ENTRY_LEG);

  const fromStepKey = ownLeg.fromStepKey;
  // The legs that END where this one BEGINS. The OFFER is what scopes the journey: the sibling
  // that ran the preceding leg is the campaign of this offer bought for one of these legs.
  const precedingLegKeys = catalogue.legs
    .filter((leg) => leg.legKey !== ownLeg.legKey)
    .filter((leg) => leg.toStepKey === fromStepKey)
    .map((leg) => leg.legKey);

  const partial = { fromStepKey, precedingLegKeys };
  if (precedingLegKeys.length === 0) {
    return answer(PREDECESSOR_ABSENCES.NO_CAMPAIGN, partial);
  }

  // Same org, same brand, same offer — the identity a sibling leg of one journey shares. Status is NOT filtered: the history the caller wants is filed under whichever row ran
  // that leg, and production carries hundreds of stopped rows per identity.
  const rows = await db.query.campaigns.findMany({
    where: and(
      eq(campaigns.orgId, campaign.orgId),
      arrayContains(campaigns.brandIds, [brandId]),
      eq(campaigns.offerId, campaign.offerId),
      inArray(campaigns.legKey, precedingLegKeys),
    ),
  });

  const siblings = rows;
  const live = siblings.filter((row) => row.status === "ongoing");
  if (live.length > 1) {
    throw new PredecessorScopeError(
      `${live.length} live campaigns run the leg preceding ${JSON.stringify(campaign.legKey)} for this offer (${live.map((c) => c.id).join(", ")})`,
      409,
      "several_predecessor_campaigns",
    );
  }

  const chosen =
    live[0] ??
    [...siblings].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];

  if (!chosen) return answer(PREDECESSOR_ABSENCES.NO_CAMPAIGN, partial);

  return {
    campaignId: campaign.id,
    legKey: campaign.legKey,
    offerId: campaign.offerId,
    brandId,
    fromStepKey,
    precedingLegKeys,
    predecessor: {
      campaignId: chosen.id,
      // Narrowed by the `inArray` above; restated so the caller reads what was matched.
      legKey: chosen.legKey as string,
      status: chosen.status,
      acquisitionChannel: chosen.acquisitionChannel,
      featureSlug: chosen.featureSlug,
      workflowSlug: chosen.workflowSlug,
    },
    absence: null,
  };
}
