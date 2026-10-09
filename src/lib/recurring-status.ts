import { and, arrayContains, eq, inArray, isNull, or } from "drizzle-orm";
import { db } from "../db/index.js";
import { campaignAudienceAvailability, campaigns } from "../db/schema.js";
import { isSourceCampaign } from "./source-campaigns.js";
import { fetchChannelCatalogue } from "./channel-operator-client.js";
import { legIsReactive, type CatalogueLegView } from "./leg-identity.js";

/**
 * WHICH CAMPAIGNS OF A BRAND (OR ORG) COUNT TOWARD RECURRING SPEND RIGHT NOW — the three facts
 * billing-service needs to compute "how much will this org spend per day on a recurring basis",
 * and nothing about money: amounts and payment state are billing's.
 *
 * Owner rules for that figure, each answered here from state this service already holds:
 *
 *   running    — the campaign's status is `ongoing`. The customer's statement of intent, read
 *                verbatim; nothing about holds or gates is re-derived here.
 *   proactive  — the campaign was bought for an ENTRY leg, i.e. a leg features-service publishes
 *                with no step before it: it starts from nothing and spends a daily budget. A leg
 *                that continues from a step a lead already reached is REACTIVE (it fires when a
 *                lead gets there, so nobody knows what it will spend). The leg's `fromStep` is
 *                ASKED of the public catalogue and never parsed out of the identifier — the same
 *                read `/predecessor` answers `entry_leg` from, so the two can never disagree.
 *   audience   — the campaign's CURRENT audience-availability period, which is exactly the verdict
 *                /end-run records and reschedules on: `exhausted` ⟺ the last run found every
 *                audience it draws from dry (and the scheduler is waiting on the audience recheck
 *                cadence); `available` ⟺ the last observation had somebody. No period at all is
 *                `not_recorded`, which is NEVER collapsed to available — a campaign whose runs
 *                never reported is unknown, not fine.
 *
 * `recurring` combines them, and is null (with the reason named) whenever one axis is unknown.
 * It is a READ: nothing is written, and no stop, hold, gate or schedule reads it.
 */

export type CampaignKind = "proactive" | "reactive";
export type KindUnknownReason = "campaign_states_no_leg" | "leg_not_published";
export type CurrentAudience = "available" | "exhausted" | "not_recorded";
export type RecurringUnknownReason = "kind_unknown" | "audience_not_recorded";

export interface RecurringCampaignStatus {
  campaignId: string;
  orgId: string;
  brandId: string | null;
  offerId: string | null;
  legKey: string | null;
  /** The acquisition channel — a features-service feature slug. */
  featureSlug: string | null;
  acquisitionChannel: string | null;
  status: string;
  /** True ⟺ status is `ongoing`. */
  running: boolean;
  /**
   * False ⟺ the campaign has no DAG (a channel the CUSTOMER operates): the scheduler never claims
   * it and it never spends, whatever its status.
   */
  executedByPlatform: boolean;
  kind: CampaignKind | null;
  kindUnknownReason?: KindUnknownReason;
  audience: CurrentAudience;
  /** Yes / no / unknown: true ⟺ `audience` is `exhausted`, null ⟺ `not_recorded`. */
  allAudiencesExhausted: boolean | null;
  /** When the current audience state began, and when it was last confirmed by a run. */
  audienceSince: string | null;
  audienceLastObservedAt: string | null;
  /**
   * Counts toward recurring daily spend right now: running AND platform-executed AND proactive
   * AND not exhausted. False as soon as any KNOWN axis says no; null only when the answer turns on
   * an unknown one.
   */
  recurring: boolean | null;
  recurringUnknownReason?: RecurringUnknownReason;
}

export class RecurringStatusCatalogueError extends Error {
  readonly status = 502;
  readonly reason = "catalogue_unavailable";
}

export async function recurringCampaignStatuses(scope: {
  orgId?: string;
  brandId?: string;
}): Promise<RecurringCampaignStatus[]> {
  const conditions = [];
  if (scope.orgId) conditions.push(eq(campaigns.orgId, scope.orgId));
  if (scope.brandId) {
    // A campaign names its brand in `brand_id`; rows from before that column name it only in the
    // array. A co-branded row (two brands) is not this brand's alone and is left out.
    conditions.push(
      or(
        eq(campaigns.brandId, scope.brandId),
        and(isNull(campaigns.brandId), arrayContains(campaigns.brandIds, [scope.brandId])),
      )!,
    );
  }
  if (conditions.length === 0) throw new Error("recurringCampaignStatuses needs an org or a brand");

  const rows = (
    await db.query.campaigns.findMany({ where: and(...conditions) })
  ).filter((c) => !scope.brandId || c.brandId !== null || (c.brandIds?.length ?? 0) === 1);
  if (rows.length === 0) return [];

  const periods = await db
    .select({
      campaignId: campaignAudienceAvailability.campaignId,
      hasAudience: campaignAudienceAvailability.hasAudience,
      startedAt: campaignAudienceAvailability.startedAt,
      lastObservedAt: campaignAudienceAvailability.lastObservedAt,
    })
    .from(campaignAudienceAvailability)
    .where(
      and(
        inArray(campaignAudienceAvailability.campaignId, rows.map((c) => c.id)),
        isNull(campaignAudienceAvailability.endedAt),
      ),
    );
  const currentPeriod = new Map(periods.map((p) => [p.campaignId, p]));

  // Only asked when some campaign states a leg: the catalogue is the ONE source of which legs are
  // entry legs, and an unreadable one is loud — answering "reactive" or "unknown" for every
  // campaign during an outage would read as a revenue drop.
  let catalogueLegs: CatalogueLegView | null = null;
  if (rows.some((c) => c.legKey)) {
    const catalogue = await fetchChannelCatalogue();
    if (!catalogue.ok) {
      throw new RecurringStatusCatalogueError(
        `the acquisition-channel catalogue could not be read (${catalogue.detail}), so which campaigns run an entry leg cannot be said`,
      );
    }
    catalogueLegs = catalogue;
  }

  return rows.map((c): RecurringCampaignStatus => {
    let kind: CampaignKind | null = null;
    let kindUnknownReason: KindUnknownReason | undefined;
    if (!c.legKey) {
      kindUnknownReason = "campaign_states_no_leg";
    } else if (isSourceCampaign(c)) {
      // A SOURCE campaign (lib/source-campaigns.ts) starts from nothing: proactive by features-service's
      // statement. Its leg is not a catalogue leg, so it is not asked. It runs no workflow, so it is
      // never `recurring` itself.
      kind = "proactive";
    } else {
      // features-service's per-(channel, leg) statement, either outbound spelling (lib/leg-identity.ts).
      const reactive = legIsReactive(catalogueLegs!, c.featureSlug, c.legKey);
      if (reactive === null) kindUnknownReason = "leg_not_published";
      else kind = reactive ? "reactive" : "proactive";
    }

    const period = currentPeriod.get(c.id);
    const audience: CurrentAudience = !period ? "not_recorded" : period.hasAudience ? "available" : "exhausted";

    const running = c.status === "ongoing";
    const executedByPlatform = c.workflowSlug !== null;
    let recurring: boolean | null;
    let recurringUnknownReason: RecurringUnknownReason | undefined;
    if (!running || !executedByPlatform || kind === "reactive" || audience === "exhausted") {
      recurring = false;
    } else if (kind === null) {
      recurring = null;
      recurringUnknownReason = "kind_unknown";
    } else if (audience === "not_recorded") {
      recurring = null;
      recurringUnknownReason = "audience_not_recorded";
    } else {
      recurring = true;
    }

    return {
      campaignId: c.id,
      orgId: c.orgId,
      brandId: c.brandId ?? (c.brandIds?.length === 1 ? c.brandIds[0] : null),
      offerId: c.offerId,
      legKey: c.legKey,
      featureSlug: c.featureSlug,
      acquisitionChannel: c.acquisitionChannel,
      status: c.status,
      running,
      executedByPlatform,
      kind,
      ...(kindUnknownReason ? { kindUnknownReason } : {}),
      audience,
      allAudiencesExhausted: audience === "not_recorded" ? null : audience === "exhausted",
      audienceSince: period?.startedAt.toISOString() ?? null,
      audienceLastObservedAt: period?.lastObservedAt.toISOString() ?? null,
      recurring,
      ...(recurringUnknownReason ? { recurringUnknownReason } : {}),
    };
  });
}
