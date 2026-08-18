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
  parentRunId: string | null;
  createdByUserId?: string | null;
  brandIds?: string[] | null;
  brandId?: string | null;
  featureSlug?: string | null;
}

/**
 * The run id this campaign hands downstream — guaranteed to EXIST in runs-service.
 *
 * A campaign's `parentRunId` is its static ancestor: the run of whoever created it, which every
 * execution's run tree then chains under. It is written once, at creation, from the caller's
 * `x-run-id` — and a creator that carries no run of its own (the per-funnel provisioner, the idle
 * sweep) leaves it NULL. That NULL used to be filled with a freshly minted uuid at trigger time,
 * which can never work: workflow-service uses the `x-run-id` we send as the `parentRunId` of the
 * run it creates, `runs.parent_run_id` carries a foreign key to `runs.id`, so runs-service refuses
 * the insert and the whole execution 502s before the DAG runs a single node. The campaign stays
 * `ongoing`, reschedules as normal, and produces nothing — the failure is invisible from its own
 * state (prod 2026-08-18: 3,593 refusals in six hours, a different minted id on every line).
 *
 * So a campaign that never stored an ancestor is given a real one: a root run, created once and
 * PERSISTED on the campaign, so it is minted a single time rather than per tick and every later
 * trigger takes the same branch as a campaign that was born with one.
 *
 * The anchor states only what is TRUE OF THE CAMPAIGN FOR ITS WHOLE LIFE — its org, its user, its
 * brands, its feature. Nothing per-execution:
 *
 *   - No `campaignId`. It is not an execution, it is the tree's root, and every campaign-scoped
 *     read in this service (the gate's stale-run cleanup and lifetime `completed` count, the
 *     scheduler's in-flight guard, the brand serialization) filters on `campaignId`. Tagging it
 *     would make it an orphan run those reads have to reason about, which is the exact problem
 *     that stopped run creation happening here in the first place.
 *   - No `workflowSlug`. The workflow is re-picked EVERY run by the greedy bandit, so freezing one
 *     on a permanent ancestor states a fact that stops being true on the next run — and
 *     runs-service refuses a child whose workflowSlug differs from its parent's
 *     (`409 Parent-child field conflict`), which is the same silent full stop one layer along.
 *     A child states its own and inherits nothing.
 *
 * It is marked `completed` immediately for the same reason: nothing is executing under it yet.
 *
 * Throws when the anchor cannot be established — the caller must NOT dispatch. Handing over an id
 * that cannot resolve is what this exists to stop.
 */
export async function ensureCampaignRunId(campaign: AnchorableCampaign): Promise<string> {
  if (campaign.parentRunId) return campaign.parentRunId;

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
    .set({ parentRunId: run.id, updatedAt: new Date() })
    .where(eq(campaigns.id, campaign.id));
  campaign.parentRunId = run.id;

  await updateRun(run.id, "completed", {
    orgId: campaign.orgId,
    userId: campaign.createdByUserId ?? undefined,
    brandId: brandIdCsv,
    featureSlug: campaign.featureSlug ?? undefined,
  });

  console.log(
    `[campaign-service] Campaign ${campaign.id} had no ancestor run — anchored on run ${run.id} (org ${campaign.orgId})`,
  );

  return run.id;
}
