import { executeCampaignWorkflow } from "./workflows.js";
import { PLAY_NO_WORKFLOW_RECHECK_MS, resolveSelectionForTrigger } from "./features-workflow-projection-client.js";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { campaigns } from "../db/schema.js";
import { getFreshExhaustedAudienceIds, NO_SERVEABLE_AUDIENCE_RECHECK_MS } from "./audience-exhaustion.js";
import { replaceRetiredWorkflow } from "./retired-workflow.js";
import { answersOnDemand, ON_DEMAND_RECHECK_MS, readDispatchCatalogue } from "./on-demand-mode.js";

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
 * constraints (freshly-exhausted audiences) — not a second rule. The stored
 * slug stays what it always was on every other path: the configured fallback when nothing can be
 * ranked, so a selection failure never blocks a run. Nothing about the stored row changes.
 *
 * Returns the slug that was actually executed, or null when nothing was dispatched because every
 * audience the grid lists is exhausted for now (a run would reach lead-service with nobody to
 * serve): the campaign is parked on `NO_SERVEABLE_AUDIENCE_RECHECK_MS` and the scheduler takes it
 * from there, holding it out loud. Also null for a campaign answering on demand (lib/on-demand-mode.ts: another pipe
 * runs it when it needs it): nothing dispatched, parked on `ON_DEMAND_RECHECK_MS` like the scheduler parks it. Throws on a refused execution, like `executeCampaignWorkflow`
 * does — the fire-and-forget callers catch and log it.
 */
export async function dispatchSelectedRun(
  campaign: {
    id: string;
    workflowSlug: string;
    brandIds: string[] | null;
    featureSlug: string;
    legKey: string | null;
    offerId: string | null;
    audienceId: string | null;
    activeGoalId: string | null;
    brandProfileId: string | null;
    salesFunnelCampaignId?: string | null;
  },
  identity: { orgId: string; userId: string; runId: string },
): Promise<string | null> {
  if (answersOnDemand(campaign, await readDispatchCatalogue())) {
    await db
      .update(campaigns)
      .set({ nextRunAt: new Date(Date.now() + ON_DEMAND_RECHECK_MS), updatedAt: new Date() })
      .where(eq(campaigns.id, campaign.id));
    return null;
  }
  const brandIds = campaign.brandIds ?? [];
  const brandIdCsv = brandIds.join(",");
  const excludedAudienceIds = await getFreshExhaustedAudienceIds(campaign.id);
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
    excludedAudienceIds,
  });
  if (selection.playHold) {
    // The campaign's play allows no workflow yet: parked, the scheduler holds it out loud.
    await db
      .update(campaigns)
      .set({ nextRunAt: new Date(Date.now() + PLAY_NO_WORKFLOW_RECHECK_MS), updatedAt: new Date() })
      .where(eq(campaigns.id, campaign.id));
    return null;
  }
  if (selection.noServeableAudience) {
    await db
      .update(campaigns)
      .set({ nextRunAt: new Date(Date.now() + NO_SERVEABLE_AUDIENCE_RECHECK_MS), updatedAt: new Date() })
      .where(eq(campaigns.id, campaign.id));
    return null;
  }
  const inputs = {
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
  };
  try {
    await executeCampaignWorkflow(selection.workflowSlug, inputs);
    return selection.workflowSlug;
  } catch (err) {
    // A deprecated workflow (410) is replaced once and never asked for again — see retired-workflow.ts.
    const successor = await replaceRetiredWorkflow(err, {
      campaignId: campaign.id,
      storedSlug: campaign.workflowSlug,
      legKey: campaign.legKey,
      primaryBrandId: brandIds[0],
      featureSlug: campaign.featureSlug,
      identity: { ...identity, brandId: brandIdCsv },
    });
    if (!successor) throw err;
    await executeCampaignWorkflow(successor, inputs);
    return successor;
  }
}
