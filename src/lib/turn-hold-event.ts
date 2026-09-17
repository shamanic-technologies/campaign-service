import { traceEvent } from "./trace-event.js";

/**
 * A campaign that is ONGOING, funded or not, and that the turn planner decided must not run this
 * tick — for a reason that parks it on a cadence of its own rather than on its turn.
 *
 * A campaign that is deliberately not running MUST say so. Before this, every one of these
 * decisions returned early with no run created, so no `gate-check-result` was ever emitted and
 * nothing was logged (the planner's paths are per campaign per tick across the fleet, so a
 * console line there would bury the signal it is meant to carry). The campaign's row kept being
 * updated every ten minutes and its last run-event stayed frozen at whatever it did last — which
 * reads, from `run_events` alone, as a campaign that silently died.
 *
 * Prod 2026-09-17, campaign 38ba8069-3d50-4ae7-b37a-54409071e260: it spent $4.28 of its $4.00
 * daily ceiling by 00:23 UTC, was correctly parked by `selectLowestFillRatio` on every tick for
 * the next five hours, and said nothing at all. The decision was right; its invisibility was the
 * bug.
 */
export type TurnHoldReason =
  /** The customer funds nothing for this campaign. Waits for money on `FUNDING_RECHECK_MS`. */
  | "unfunded"
  /** Billing could not be read. Fail-CLOSED: the brand is held rather than spent. */
  | "budgets_unreadable"
  /** Funded, and it has already spent its whole ceiling today. Re-opens on a raise or the rollover. */
  | "daily_ceiling_reached"
  /** Planning threw. The brand is held; the gate would refuse these runs anyway. */
  | "planning_failed";

/** The campaign fields an event needs to be attributable. A structural subset of a claimed row. */
export interface TurnHoldCampaign {
  id: string;
  orgId: string;
  createdByUserId: string | null;
  parentRunId: string | null;
  workflowSlug: string | null;
  brandIds: string[] | null;
  featureSlug: string | null;
}

export interface TurnHold {
  campaign: TurnHoldCampaign;
  reason: TurnHoldReason;
  /** One sentence a human reads without opening the code. */
  detail: string;
  /** When the planner will look at this campaign again. */
  nextRunAt: Date;
  /** The figures the decision was made on, when there are any. */
  data?: Record<string, unknown>;
}

/**
 * Out of credit, out of budget and out of money are EXPECTED business states, so they trace at
 * `info` exactly as the credit gate's own block does. A read that FAILED, or a planner that
 * threw, is a genuine fault and is the one class this repo reserves `warn` for.
 */
function levelFor(reason: TurnHoldReason): "info" | "warn" {
  return reason === "budgets_unreadable" || reason === "planning_failed" ? "warn" : "info";
}

/**
 * Say, on the run ledger, that a campaign was held and why.
 *
 * The event rides the campaign's OWN ANCESTOR run (`campaigns.parent_run_id`) — a run
 * runs-service can resolve, never a minted uuid, which it would refuse. That run is what every
 * execution of this campaign already chains under, so the hold lands in the same place a human
 * looking at "what did this campaign do" is already looking, and `run_events.campaign_id` (set
 * from the `x-campaign-id` header) makes it readable from `run_events` alone.
 *
 * Fail-SOFT in every direction: `traceEvent` swallows its own failures, and an unreportable hold
 * must never change whether a campaign runs.
 */
export async function reportTurnHolds(holds: TurnHold[]): Promise<void> {
  // allSettled, not all: a hold that cannot be reported is not a licence to change what the
  // planner decided, and `traceEvent` swallowing its own failures is not something to rely on.
  await Promise.allSettled(holds.map(reportOne));
}

async function reportOne(hold: TurnHold): Promise<void> {
  const { campaign, reason, detail, nextRunAt, data } = hold;

  // No ancestor run means this campaign has never been triggered, so there is no run to hang the
  // hold on and none is invented. Said out loud rather than skipped in silence — and at the
  // hold's own cadence (ten minutes), not the tick's.
  if (!campaign.parentRunId) {
    console.warn(
      `[campaign-service] campaign ${campaign.id} held (${reason}) and has no ancestor run to report it on: ${detail}`,
    );
    return;
  }

  await traceEvent(
    campaign.parentRunId,
    {
      service: "campaign-service",
      event: "campaign-hold",
      level: levelFor(reason),
      detail,
      data: {
        reason,
        campaignId: campaign.id,
        nextRunAt: nextRunAt.toISOString(),
        ...(data ?? {}),
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
