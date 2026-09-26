import { and, arrayContains, eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { campaigns } from "../db/schema.js";
import { fetchChannelCatalogue, type ChannelCatalogueRead } from "./channel-operator-client.js";
import { resolvePredecessorCampaign, PredecessorScopeError } from "./predecessor-campaign.js";
import { SALES_FUNNEL_FEATURE_SLUGS } from "./sales-outreach-campaign.js";

/**
 * WHO ANSWERS THE PEOPLE THIS CAMPAIGN IS HOLDING — the inverse of `/predecessor`, and nothing else.
 *
 * A prospect who replies asking for a meeting is filed under the cold-email campaign that reached
 * them, and an answer is owed to them in lead-service's follow-up queue under THAT campaign's id.
 * The campaign that answers is a DIFFERENT one — bought for the leg that continues where this one
 * ends — and it finds the people it owes by asking `/predecessor` which campaign ran the leg before
 * it, then claiming on exactly that id. Nothing widens the claim, on purpose.
 *
 * So whether a held person will ever be answered is a question about OTHER campaigns, and before
 * this read nobody could ask it. Measured 2026-09-26: five people who asked for a meeting had been
 * waiting up to twenty days, every one of them on a brand with no campaign on the answering leg,
 * while their lead page promised "Next follow-up due now". Nothing was red anywhere, because a
 * queue nobody claims looks exactly like a queue with nothing due.
 *
 * ── IT IS DERIVED FROM THE CLAIM PATH ITSELF, NEVER A SECOND RULE ─────────────────────────────
 *
 * A campaign X answers the people held by H exactly when X would claim on H: X is live, X runs a
 * leg that starts where H's ends, and `resolvePredecessorCampaign(X)` — the very function the
 * worker's claim is keyed on — names H. The candidates are enumerated here; the verdict for each
 * is the predecessor resolver's. A second, independent "who answers" rule would drift from the
 * claim the day either changed, and the whole point is that this read cannot disagree with it.
 *
 * ── NOTHING IS STARTED, FUNDED OR PROVISIONED ─────────────────────────────────────────────────
 *
 * Money starts nothing and no system condition starts a campaign (the owner rule at the top of
 * CLAUDE.md). A brand with nobody to answer its prospects is told so, with the channels that could
 * — `startableFeatureSlugs` is what the customer's own "start" control needs — and the decision to
 * start one, and pay for it, stays theirs.
 *
 * ── "NOBODY" IS ALWAYS NAMED ──────────────────────────────────────────────────────────────────
 *
 * Every `answeredBy: null` carries an `absence` saying why, each a true statement about the data a
 * customer can read. "It could not be worked out" stays apart: an unreadable catalogue is a 502 and
 * a leg the catalogue does not publish is a 409 — never a null, or an outage would read exactly
 * like a brand that simply has not started the answering leg.
 */

export const ANSWERING_ABSENCES = {
  /** This campaign states no leg, so no campaign can ever name it as its predecessor. */
  NO_LEG: "campaign_states_no_leg",
  /** This campaign states no offer; an answering campaign is matched on the offer. */
  NO_OFFER: "campaign_states_no_offer",
  /** The row names no brand. */
  NO_BRAND: "campaign_states_no_brand",
  /** No published leg continues from where this campaign's leg ends. Nothing is owed a sequel. */
  NO_CONTINUING_LEG: "no_leg_continues",
  /** A leg continues, and nobody bought a campaign for it on this offer. The customer can start one. */
  NO_CAMPAIGN: "no_answering_campaign",
  /** A campaign for the continuing leg exists on this offer, and every one of them is stopped. */
  STOPPED: "answering_campaign_stopped",
  /**
   * A live campaign runs the continuing leg, and it answers the people of ANOTHER campaign — the
   * live sibling of this one's leg, typically, while this one is a stopped or leg-less row of the
   * same offer. The people filed here are not reached by it.
   */
  SERVES_ANOTHER: "answering_campaign_serves_another",
} as const;

export type AnsweringAbsence = (typeof ANSWERING_ABSENCES)[keyof typeof ANSWERING_ABSENCES];

export interface AnsweringCampaign {
  campaignId: string;
  legKey: string;
  status: string;
  featureSlug: string | null;
  acquisitionChannel: string | null;
  /** Null for a channel the CUSTOMER operates: a person answers, no workflow claims. */
  workflowSlug: string | null;
}

export interface AnsweringOutcome {
  campaignId: string;
  legKey: string | null;
  offerId: string | null;
  brandId: string | null;
  /** The step this campaign's leg takes a lead INTO — where an answering leg must start. */
  toStepKey: string | null;
  /** Every published leg starting at that step, as features-service names them. */
  continuingLegKeys: string[];
  /**
   * The sales-family features whose channel performs one of those legs, per features-service's
   * catalogue: what a customer could START to have these people answered. Empty when nothing can.
   */
  startableFeatureSlugs: string[];
  answeredBy: AnsweringCampaign | null;
  /** Names WHY nobody answers. `null` exactly when `answeredBy` is not null. */
  absence: AnsweringAbsence | null;
  /**
   * For `answering_campaign_serves_another` / `answering_campaign_stopped`: the campaign that runs
   * (or ran) the continuing leg, so a reader can see which one it is. Null otherwise.
   */
  candidate: AnsweringCampaign | null;
  /** For `answering_campaign_serves_another`: the campaign whose people that candidate answers. */
  candidateAnswersCampaignId: string | null;
}

/** The question could not be answered — as opposed to answered with "nobody". */
export class AnsweringScopeError extends Error {
  readonly status: 404 | 409 | 502;
  readonly reason: string;
  constructor(message: string, status: 404 | 409 | 502, reason: string) {
    super(message);
    this.name = "AnsweringScopeError";
    this.status = status;
    this.reason = reason;
  }
}

function asAnswering(row: typeof campaigns.$inferSelect): AnsweringCampaign {
  return {
    campaignId: row.id,
    legKey: row.legKey as string,
    status: row.status,
    featureSlug: row.featureSlug,
    acquisitionChannel: row.acquisitionChannel,
    workflowSlug: row.workflowSlug,
  };
}

export async function resolveAnsweringCampaign(
  campaignId: string,
  catalogueRead?: ChannelCatalogueRead,
): Promise<AnsweringOutcome> {
  const campaign = await db.query.campaigns.findFirst({ where: eq(campaigns.id, campaignId) });
  if (!campaign) {
    throw new AnsweringScopeError(`campaign ${JSON.stringify(campaignId)} does not exist`, 404, "unknown_campaign");
  }

  const brandId = campaign.brandId ?? campaign.brandIds?.[0] ?? null;
  const answer = (absence: AnsweringAbsence, extra?: Partial<AnsweringOutcome>): AnsweringOutcome => ({
    campaignId: campaign.id,
    legKey: campaign.legKey,
    offerId: campaign.offerId,
    brandId,
    toStepKey: null,
    continuingLegKeys: [],
    startableFeatureSlugs: [],
    answeredBy: null,
    absence,
    candidate: null,
    candidateAnswersCampaignId: null,
    ...extra,
  });

  // Each is a TRUE statement: the predecessor resolver refuses the same rows, so no campaign can
  // ever claim on this one.
  if (!campaign.legKey) return answer(ANSWERING_ABSENCES.NO_LEG);
  if (!campaign.offerId) return answer(ANSWERING_ABSENCES.NO_OFFER);
  if (!brandId) return answer(ANSWERING_ABSENCES.NO_BRAND);

  const catalogue = catalogueRead ?? (await fetchChannelCatalogue());
  if (!catalogue.ok) {
    throw new AnsweringScopeError(
      `the acquisition-channel catalogue could not be read: ${catalogue.detail}`,
      502,
      "catalogue_unavailable",
    );
  }

  const ownLeg = catalogue.legs.find((leg) => leg.legKey === campaign.legKey);
  if (!ownLeg) {
    throw new AnsweringScopeError(
      `leg ${JSON.stringify(campaign.legKey)} is not a leg features-service publishes`,
      409,
      "leg_not_published",
    );
  }
  if (!ownLeg.toStepKey) return answer(ANSWERING_ABSENCES.NO_CONTINUING_LEG);

  const toStepKey = ownLeg.toStepKey;
  const continuingLegKeys = catalogue.legs
    .filter((leg) => leg.legKey !== ownLeg.legKey && leg.fromStepKey === toStepKey)
    .map((leg) => leg.legKey);
  const continuing = new Set(continuingLegKeys);
  const startableFeatureSlugs = [...SALES_FUNNEL_FEATURE_SLUGS].filter((slug) => {
    const performed = catalogue.legsBySlug.get(slug);
    return performed ? [...performed].some((leg) => continuing.has(leg)) : false;
  });
  const partial = { toStepKey, continuingLegKeys, startableFeatureSlugs };
  if (continuingLegKeys.length === 0) return answer(ANSWERING_ABSENCES.NO_CONTINUING_LEG, partial);

  // Same scope the predecessor resolver searches from the other side: org, brand, offer.
  const rows = await db.query.campaigns.findMany({
    where: and(
      eq(campaigns.orgId, campaign.orgId),
      arrayContains(campaigns.brandIds, [brandId]),
      eq(campaigns.offerId, campaign.offerId),
      inArray(campaigns.legKey, continuingLegKeys),
    ),
  });
  if (rows.length === 0) return answer(ANSWERING_ABSENCES.NO_CAMPAIGN, partial);

  const live = rows.filter((row) => row.status === "ongoing");
  if (live.length === 0) {
    const latest = [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    return answer(ANSWERING_ABSENCES.STOPPED, { ...partial, candidate: asAnswering(latest) });
  }

  // The verdict is the claim path's own: a live candidate answers H exactly when its predecessor
  // resolves to H. A resolver refusal (two live predecessors) is propagated — the worker cannot
  // claim either, so "answered" would be false and "nobody" would hide a real disagreement.
  let servesAnother: { candidate: AnsweringCampaign; answers: string | null } | null = null;
  for (const row of live) {
    let resolved;
    try {
      resolved = await resolvePredecessorCampaign(row.id, catalogue);
    } catch (err) {
      if (err instanceof PredecessorScopeError) {
        throw new AnsweringScopeError(
          `answering campaign ${row.id} cannot resolve whom it answers: ${err.message}`,
          err.status,
          err.reason,
        );
      }
      throw err;
    }
    if (resolved.predecessor?.campaignId === campaign.id) {
      return { ...answer(ANSWERING_ABSENCES.NO_CAMPAIGN, partial), answeredBy: asAnswering(row), absence: null };
    }
    servesAnother ??= { candidate: asAnswering(row), answers: resolved.predecessor?.campaignId ?? null };
  }

  return answer(ANSWERING_ABSENCES.SERVES_ANOTHER, {
    ...partial,
    candidate: servesAnother!.candidate,
    candidateAnswersCampaignId: servesAnother!.answers,
  });
}

export type AnsweringBatchEntry =
  | ({ ok: true } & AnsweringOutcome)
  | { ok: false; campaignId: string; status: number; reason: string; error: string };

/**
 * The batch form: one catalogue read for every campaign asked, one entry per id in the order asked.
 * A campaign that could not be resolved is still RETURNED, as a refusal naming why — dropping it
 * would read as "answered" to a consumer counting what came back. An unreadable catalogue fails the
 * whole batch (502): every entry would be the same refusal.
 */
export async function resolveAnsweringCampaigns(campaignIds: string[]): Promise<AnsweringBatchEntry[]> {
  const catalogue = await fetchChannelCatalogue();
  if (!catalogue.ok) {
    throw new AnsweringScopeError(
      `the acquisition-channel catalogue could not be read: ${catalogue.detail}`,
      502,
      "catalogue_unavailable",
    );
  }
  const out: AnsweringBatchEntry[] = [];
  for (const id of campaignIds) {
    try {
      out.push({ ok: true, ...(await resolveAnsweringCampaign(id, catalogue)) });
    } catch (err) {
      if (err instanceof AnsweringScopeError) {
        out.push({ ok: false, campaignId: id, status: err.status, reason: err.reason, error: err.message });
        continue;
      }
      throw err;
    }
  }
  return out;
}
