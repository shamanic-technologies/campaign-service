/**
 * WHY a campaign stopped — the vocabulary written to `campaigns.stop_reason`.
 *
 * One value per place this service stops a campaign. The distinction exists for a single
 * decision: a campaign that stopped because it ran out of people to contact comes back by
 * itself once the brand has somebody to contact again (the customer was emailed asking them to
 * extend an audience — their action is the trigger, and they were told so). A campaign stopped
 * for any OTHER reason stays stopped: switching a campaign off on purpose has to mean something.
 */
export const STOP_REASONS = {
  /** /end-run: every targeted audience is exhausted. The ONLY reason a resume can act on. */
  AUDIENCE_EXHAUSTED: "audience_exhausted",
  /** gate-check: the campaign reached its configured maxLeads cap. */
  MAX_LEADS_REACHED: "max_leads_reached",
  /** PATCH /campaigns/:id with status=stop — a person's decision. */
  MANUAL: "manual",
  /** DELETE /internal/campaigns/by-org/:orgId — the org is being torn down. */
  ORG_TEARDOWN: "org_teardown",
} as const;

export type StopReason = (typeof STOP_REASONS)[keyof typeof STOP_REASONS];

/**
 * Can a campaign stopped for this reason come back on its own?
 *
 * Only exhaustion. NULL — every row stopped before the reason was recorded, and anything a
 * future code path stops without stating why — reads as NOT resumable: a stop whose reason
 * nobody wrote down is not evidence that the campaign ran out of people, and guessing would
 * resurrect campaigns a person deliberately switched off.
 */
export function isResumableStopReason(reason: string | null | undefined): boolean {
  return reason === STOP_REASONS.AUDIENCE_EXHAUSTED;
}
