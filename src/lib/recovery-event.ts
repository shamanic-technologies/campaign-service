import { traceEvent } from "./trace-event.js";

/**
 * A campaign the stuck sweep brought back, said out loud on the run ledger.
 *
 * `(status=ongoing, nextRunAt=NULL)` is how a campaign looks while a run is in flight AND how it
 * looks when that run died without ever calling `/end-run`. The sweep tells the two apart by asking
 * runs-service, and when it decides the second it re-schedules the campaign — which is a RECOVERY,
 * i.e. the statement that something was lost. It used to be a `console.log` and nothing else, so
 * from `run_events` alone — the artifact a human actually reads — a campaign that was forgotten and
 * a campaign that was fine were the same thing.
 *
 * Same argument and same shape as `campaign-hold` (PR #470): the decision was right, its
 * invisibility was the bug. Unlike a hold this is NOT a per-tick path — it fires once per orphaned
 * run, which is why it is reported at all and why it is a fault (`warn`) rather than an expected
 * business state.
 */
export interface CampaignRecoveryCampaign {
  id: string;
  orgId: string;
  createdByUserId: string | null;
  parentRunId: string | null;
  workflowSlug: string | null;
  brandIds: string[] | null;
  featureSlug: string | null;
}

export interface CampaignRecovery {
  campaign: CampaignRecoveryCampaign;
  /** One sentence a human reads without opening the code. */
  detail: string;
  /** When the campaign will be looked at again — `now`, since the sweep claims it for this tick. */
  nextRunAt: Date;
  /** The orphaned runs the sweep found and finalized. */
  orphanedRunIds: string[];
}

/**
 * Report one recovery. Fail-SOFT in every direction: `traceEvent` swallows its own failures, and a
 * recovery that cannot be reported must never change whether the campaign is brought back.
 */
export async function reportCampaignRecovery(recovery: CampaignRecovery): Promise<void> {
  const { campaign, detail, nextRunAt, orphanedRunIds } = recovery;

  // No ancestor run means this campaign has never been triggered, so there is no run to hang the
  // recovery on and none is invented (runs-service refuses a minted uuid). Said out loud rather
  // than skipped in silence.
  if (!campaign.parentRunId) {
    console.warn(
      `[campaign-service] campaign ${campaign.id} recovered and has no ancestor run to report it on: ${detail}`,
    );
    return;
  }

  await traceEvent(
    campaign.parentRunId,
    {
      service: "campaign-service",
      event: "campaign-recovery",
      level: "warn",
      detail,
      data: {
        reason: "orphaned_run",
        campaignId: campaign.id,
        nextRunAt: nextRunAt.toISOString(),
        orphanedRunIds,
      },
    },
    {
      "x-org-id": campaign.orgId,
      "x-user-id": campaign.createdByUserId ?? undefined,
      "x-brand-id": campaign.brandIds?.[0],
      "x-campaign-id": campaign.id,
      "x-workflow-slug": campaign.workflowSlug ?? undefined,
      "x-feature-slug": campaign.featureSlug ?? undefined,
    },
  );
}
