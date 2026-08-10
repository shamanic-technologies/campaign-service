import type { Campaign } from "../db/schema.js";
import type { DownstreamIdentity } from "./downstream-headers.js";
import { fetchBrandRuntimeContext, type RuntimeGoal } from "./brand-runtime-client.js";
import { getFreshExhaustedAudienceIds } from "./audience-exhaustion.js";
import {
  fetchWorkflowProjectionRows,
  serveableAudienceIdsInProjection,
} from "./features-workflow-projection-client.js";

/** The campaign fields the serveable-audience read needs. */
export type ServeableAudienceCampaign = Pick<
  Campaign,
  "id" | "orgId" | "goal" | "audienceIds"
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
 * Deliberately does NOT arbitrate the goal, unlike /start-run. Audience MEMBERSHIP is
 * goal-independent (features-service enumerates every active audience of the brand per dynasty
 * whatever the goal; the goal only changes the cost metric attached to each row), so asking on
 * the brand goal returns the same set. If that ever stopped holding this would see a SUPERSET,
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
  const brandRuntimeContext = await fetchBrandRuntimeContext(identity.brandId, identity);
  const runtimeGoal: RuntimeGoal = campaign.goal ?? brandRuntimeContext.currentGoal;
  const excludedAudienceIds = await getFreshExhaustedAudienceIds(campaign.id);
  const rows = await fetchWorkflowProjectionRows({
    featureSlug,
    brandId: identity.brandId,
    goal: runtimeGoal,
    identity,
  });
  return serveableAudienceIdsInProjection(rows, {
    requiredAudienceIds: campaign.audienceIds ?? undefined,
    excludedAudienceIds,
  });
}
