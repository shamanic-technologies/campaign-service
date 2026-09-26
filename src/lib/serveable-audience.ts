import type { Campaign } from "../db/schema.js";
import type { DownstreamIdentity } from "./downstream-headers.js";
import { getFreshExhaustedAudienceIds } from "./audience-exhaustion.js";
import {
  fetchLegProjectionRows,
  serveableAudienceIdsInProjection,
} from "./features-workflow-projection-client.js";

/** The campaign fields the serveable-audience read needs. */
export type ServeableAudienceCampaign = Pick<
  Campaign,
  "id" | "orgId" | "legKey" | "audienceIds"
>;

/**
 * WHICH audiences this campaign could be served right now — the brand's active audiences,
 * narrowed to the campaign's targeted subset, minus the ones currently marked exhausted.
 *
 * ONE definition, asked by the two legs that must agree on it:
 *   /end-run     — none left → every targeted audience is exhausted → auto-stop.
 *   resume sweep — at least one → the brand has somebody to contact again → come back.
 * Two legs on two definitions is how a campaign gets stopped by one and never picked up by the
 * other, so they read the same function rather than two copies of the same idea.
 *
 * The audience set comes from features-service, which owns it — this service never reaches into
 * the service that owns audiences to decide whether a brand has somebody to contact.
 *
 * Deliberately does NOT arbitrate, unlike /start-run. Audience MEMBERSHIP does not depend on what
 * the campaign sells (features-service enumerates every active audience of the brand per dynasty
 * either way; the leg only changes the cost metric attached to each row), so asking on the
 * campaign's own leg returns the same set. If that ever stopped holding this would see a SUPERSET,
 * which is the safe direction for both callers: it can only keep a campaign alive or bring one
 * back, never stop one wrongly.
 *
 * THROWS on any features/brand-service failure. Neither caller may treat an unreadable answer as
 * a decision: /end-run must not stop on an infra hiccup, and the sweep must not resume on one.
 */
export async function serveableAudienceIdsForCampaign(
  campaign: ServeableAudienceCampaign,
  featureSlug: string,
  identity: DownstreamIdentity,
): Promise<string[]> {
  const excludedAudienceIds = await getFreshExhaustedAudienceIds(campaign.id);
  // The leg-keyed body is the only read left (wave C2). Membership is every active audience per
  // dynasty whatever the leg prices on, and this read ignores cost; the body is UNFILTERED by the
  // leg's model rule, so the guard still sees the superset. A campaign that states NO leg has no
  // read to ask — that is not a verdict either way, so it THROWS like any unreadable answer.
  if (!campaign.legKey) {
    throw new Error(
      `[campaign-service] campaign ${campaign.id} states NO leg — no funnel- or goal-keyed read ` +
        "exists (wave C2), so whether it has a serveable audience cannot be asked",
    );
  }
  const rows = await fetchLegProjectionRows({
    featureSlug,
    brandId: identity.brandId,
    legKey: campaign.legKey,
    campaignId: campaign.id,
    identity,
  });
  return serveableAudienceIdsInProjection(rows, {
    requiredAudienceIds: campaign.audienceIds ?? undefined,
    excludedAudienceIds,
  });
}
