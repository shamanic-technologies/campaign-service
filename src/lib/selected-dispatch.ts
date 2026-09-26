import { executeCampaignWorkflow } from "./workflows.js";
import { resolveSelectionForTrigger, isWorkflowRotationEnabled } from "./features-workflow-projection-client.js";
import { getFreshExhaustedAudienceIds } from "./audience-exhaustion.js";

/**
 * A RUN A PERSON STARTED GOES THROUGH THE SAME SELECTION AS EVERY OTHER RUN.
 *
 * The scheduler and the step trigger never execute the workflow stored on the campaign row: they
 * pick the cell (audience first, then the cheapest workflow in its column) over a grid already
 * restricted to the workflows the campaign's LEG allows. The runs a PERSON fires — creating a
 * campaign, restarting one through a create, starting a funded pair, activating one — used to
 * execute `campaign.workflowSlug` verbatim, so whatever the creator stored ran once before the
 * selector ever saw the campaign. Prod 2026-09-24, campaign `c8133eca` (leg
 * `start_to_conversation`): created with a cheap-tier workflow its leg's rule excludes, which ran
 * as the campaign's first run 112ms later; every run after it went through the selector and never
 * picked that tier again.
 *
 * So those paths call this, and it is the scheduler's own pick — same function, same inputs, same
 * constraints (hard targeting subset, freshly-exhausted audiences) — not a second rule. The stored
 * slug stays what it always was on every other path: the configured fallback when nothing can be
 * ranked, so a selection failure never blocks a run. Nothing about the stored row changes.
 *
 * Returns the slug that was actually executed. Throws on a refused execution, like
 * `executeCampaignWorkflow` does — the fire-and-forget callers catch and log it.
 */
export async function dispatchSelectedRun(
  campaign: {
    id: string;
    workflowSlug: string;
    brandIds: string[] | null;
    featureSlug: string;
    funnelKey: string | null;
    legKey: string | null;
    offerId: string | null;
    audienceIds: string[] | null;
    audienceId: string | null;
    activeGoalId: string | null;
    brandProfileId: string | null;
  },
  identity: { orgId: string; userId: string; runId: string },
): Promise<string> {
  const brandIds = campaign.brandIds ?? [];
  const brandIdCsv = brandIds.join(",");
  // Only a rotating feature picks an audience, so only a rotating feature pays for this read.
  const excludedAudienceIds = isWorkflowRotationEnabled(campaign.featureSlug)
    ? await getFreshExhaustedAudienceIds(campaign.id)
    : [];
  const selection = await resolveSelectionForTrigger({
    featureSlug: campaign.featureSlug,
    primaryBrandId: brandIds[0],
    identity: {
      orgId: identity.orgId,
      userId: identity.userId,
      runId: identity.runId,
      campaignId: campaign.id,
      brandId: brandIdCsv,
      workflowSlug: campaign.workflowSlug,
      featureSlug: campaign.featureSlug,
    },
    fallbackSlug: campaign.workflowSlug,
    legKey: campaign.legKey,
    campaignId: campaign.id,
    requiredAudienceIds: campaign.audienceIds,
    excludedAudienceIds,
  });
  await executeCampaignWorkflow(selection.workflowSlug, {
    campaignId: campaign.id,
    orgId: identity.orgId,
    brandId: brandIdCsv,
    userId: identity.userId,
    runId: identity.runId,
    featureSlug: campaign.featureSlug,
    activeGoalId: campaign.activeGoalId,
    brandProfileId: campaign.brandProfileId,
    // Chosen at the trigger → /start-run CONSUMES it. Nothing chosen → exactly what this call
    // carried before, so a non-rotating feature is byte-unchanged.
    audienceId: selection.audienceId ?? campaign.audienceId,
  });
  return selection.workflowSlug;
}
