/**
 * WHY a campaign stopped — the vocabulary written to `campaigns.stop_reason`.
 *
 * A campaign's STATUS is the CUSTOMER's statement of intent, and nothing else may change it.
 * So there is exactly one kind of value here: a value written by a person's decision. A system
 * CONDITION — out of credit, audience exhausted, today's budget spent, a lead cap reached — never
 * stops a campaign. It stops the campaign RUNNING this tick; the campaign stays exactly as the
 * customer left it and runs again on a later tick once the condition has passed.
 *
 * That is why there is nothing here for exhaustion or a lead cap any more, and why nothing
 * resumes a campaign either: a campaign a condition never stopped has nothing to be resumed from.
 * `audience_exhausted` and `max_leads_reached` are RETIRED — no live or stopped row in production
 * carries either (verified 2026-09-06: 17 `manual`, 680 NULL, and no other value has ever been
 * written to the column).
 */
export const STOP_REASONS = {
  /** PATCH /campaigns/:id with status=stop — a person's decision. */
  MANUAL: "manual",
  /** DELETE /internal/campaigns/by-org/:orgId — the org is being torn down. */
  ORG_TEARDOWN: "org_teardown",
} as const;

export type StopReason = (typeof STOP_REASONS)[keyof typeof STOP_REASONS];
