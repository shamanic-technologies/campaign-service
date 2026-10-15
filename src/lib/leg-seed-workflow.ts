import { fetchLegAssignedWorkflows } from "./features-workflow-projection-client.js";
import { fetchStartableWorkflowSlug, type StartableWorkflowRead } from "./startable-workflow-client.js";

/**
 * THE WORKFLOW A PIPE'S UNIT STORES (CAMPAIGN-FALLBACK-WORKFLOW-LEG-1015).
 *
 * The stored `workflow_slug` is what a campaign read shows and what runs whenever the per-run pick cannot be
 * made (features-service unreachable, empty grid). It must be a workflow features-service ASSIGNS to the unit's
 * leg: prod 2026-10-15, "Merrily"'s cold email unit on the positive-reply leg stored `denebola`, a
 * website-visit workflow, because the seed was the channel's newest active workflow whatever the leg.
 *
 * So the seed is features-service's FIRST CHOICE on the leg (`fetchLegAssignedWorkflows`: assigned `active`,
 * its rank order), minus what the pipe's PLAY rules out (features-service's `excludedWorkflowDynastySlugs`,
 * PLAY-SEED-1014) and any slug the caller excludes (a workflow just deprecated). Nothing re-ranked here.
 * Every writer of a unit's stored workflow asks this: a launch, the adopt pass, the 410 replacement, the repair.
 *
 * A channel features-service does not know at all (404, e.g. `email-sending`) has no leg ranking: its seed
 * stays the channel's newest active workflow (workflow-service), logged at error level. Any other unreadable
 * answer is `{ok: false}`: nothing is written on a guess.
 */
export async function fetchLegSeedWorkflowSlug(
  featureSlug: string,
  legKey: string,
  identity: { orgId: string; userId: string; runId: string; brandId: string; offerId?: string | null; campaignId?: string | null },
  excludedWorkflowSlugs: readonly string[] = [],
  deps: { assigned?: typeof fetchLegAssignedWorkflows; channelNewest?: typeof fetchStartableWorkflowSlug } = {},
): Promise<StartableWorkflowRead> {
  let assigned: string[] | null;
  try {
    assigned = await (deps.assigned ?? fetchLegAssignedWorkflows)({
      featureSlug,
      brandId: identity.brandId,
      legKey,
      campaignId: identity.campaignId ?? null,
      offerId: identity.campaignId ? null : (identity.offerId ?? null),
      identity: {
        orgId: identity.orgId,
        userId: identity.userId,
        runId: identity.runId,
        brandId: identity.brandId,
        campaignId: identity.campaignId ?? "",
        featureSlug,
        workflowSlug: null,
      },
    });
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
  if (assigned === null) {
    console.error(
      `[campaign-service] features-service ranks no workflow for channel ${featureSlug} (leg ${legKey}): ` +
        "seeding the channel's newest active workflow",
    );
    return (deps.channelNewest ?? fetchStartableWorkflowSlug)(
      featureSlug,
      { orgId: identity.orgId, userId: identity.userId, runId: identity.runId, brandId: identity.brandId },
      excludedWorkflowSlugs,
    );
  }
  return { ok: true, workflowSlug: legSeedFrom(assigned, excludedWorkflowSlugs) };
}

/** Pure: the first assigned workflow (features-service's order) nothing excludes, else null. */
export function legSeedFrom(assignedInRankOrder: readonly string[], excludedWorkflowSlugs: readonly string[]): string | null {
  const excluded = new Set(excludedWorkflowSlugs);
  return assignedInRankOrder.find((slug) => !excluded.has(slug)) ?? null;
}
