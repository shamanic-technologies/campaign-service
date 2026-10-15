import { eq } from "drizzle-orm";
import { createRun, updateRun } from "@distribute/runs-client";
import { db } from "../db/index.js";
import { campaigns } from "../db/schema.js";

/**
 * The columns needed to give a campaign a run id that actually resolves.
 * Narrow on purpose so both callers (the scheduler's claim projection and the resume sweep's
 * full row) satisfy it without either of them widening what it reads.
 */
export interface AnchorableCampaign {
  id: string;
  orgId: string;
  anchorRunId: string | null;
  createdByUserId?: string | null;
  brandIds?: string[] | null;
  brandId?: string | null;
  featureSlug?: string | null;
}

/**
 * The run id this campaign hands downstream — guaranteed to EXIST in runs-service AND to be the
 * campaign's OWN: a root run campaign-service minted for it, persisted on `campaigns.anchor_run_id`.
 *
 * Never the creator's `x-run-id` (`parent_run_id`, kept as provenance only). workflow-service makes
 * the id we send the `parentRunId` of the run it creates, and runs-service refuses a child whose
 * campaign / workflow / feature differs from its parent's (`409 Parent-child field conflict`). A
 * creator's run can sit inside ANOTHER campaign's tree: prod 2026-10-12, Doc Dinners' "Affection"
 * funnel units were born under a chat-service judgment run stamped with the Apollo sourcing unit of
 * another funnel campaign, so every run of its AI Meeting Booking unit 502'd and a Meta Ads form
 * waited 14 h (HOTFIX ANCESTOR-1015). Whoever creates a campaign, its pipe runs under its own root.
 *
 * Before that, a NULL ancestor was filled with a freshly minted uuid at trigger time, which can never
 * work either (`runs.parent_run_id` is a foreign key): prod 2026-08-18, 3,593 refusals in six hours.
 * So the anchor is a real root run, created once and PERSISTED, minted a single time rather than per
 * tick.
 *
 * The anchor states only what is TRUE OF THE CAMPAIGN FOR ITS WHOLE LIFE — its org, its user, its
 * brands, its feature. Nothing per-execution:
 *
 *   - No `campaignId`. It is not an execution, it is the tree's root, and every campaign-scoped
 *     read in this service (the gate's stale-run cleanup and lifetime `completed` count, the
 *     scheduler's in-flight guard, the brand serialization) filters on `campaignId`. Tagging it
 *     would make it an orphan run those reads have to reason about.
 *   - No `workflowSlug`. The workflow is re-picked EVERY run, and runs-service refuses a child whose
 *     workflowSlug differs from its parent's. A child states its own and inherits nothing.
 *   - No parent. A parent would hand its campaign / workflow down (runs-service inherits what a
 *     child does not state), which is exactly the conflict this exists to stop.
 *
 * It is marked `completed` immediately: nothing is executing under it yet.
 *
 * Throws when the anchor cannot be established — the caller must NOT dispatch. Handing over an id
 * that cannot resolve is what this exists to stop.
 */
export async function ensureCampaignRunId(campaign: AnchorableCampaign): Promise<string> {
  if (campaign.anchorRunId) return campaign.anchorRunId;

  const brandIdCsv = campaign.brandIds?.length
    ? campaign.brandIds.join(",")
    : (campaign.brandId ?? undefined);

  const run = await createRun({
    orgId: campaign.orgId,
    serviceName: "campaign-service",
    taskName: "campaign-trigger",
    userId: campaign.createdByUserId ?? undefined,
    brandId: brandIdCsv,
    featureSlug: campaign.featureSlug ?? undefined,
  });

  // Persist BEFORE finalizing: if the finalize call fails, the campaign already owns a real,
  // resolvable ancestor and the next tick reuses it. Doing it the other way round would throw
  // away a created run and mint another one on every attempt.
  await db
    .update(campaigns)
    .set({ anchorRunId: run.id, updatedAt: new Date() })
    .where(eq(campaigns.id, campaign.id));
  campaign.anchorRunId = run.id;

  await updateRun(run.id, "completed", {
    orgId: campaign.orgId,
    userId: campaign.createdByUserId ?? undefined,
    brandId: brandIdCsv,
    featureSlug: campaign.featureSlug ?? undefined,
  });

  console.log(
    `[campaign-service] Campaign ${campaign.id} anchored on its own root run ${run.id} (org ${campaign.orgId})`,
  );

  return run.id;
}
