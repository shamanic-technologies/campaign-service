/**
 * WHY a campaign stopped — the vocabulary written to `campaigns.stop_reason`.
 *
 * A campaign's STATUS is the CUSTOMER's statement of intent, and nothing else may change it.
 * So there is exactly one kind of value here: a value written by a person's decision. A system
 * CONDITION — out of credit, audience exhausted, today's budget spent, a lead cap reached — never
 * stops a campaign: it stops the campaign RUNNING this tick; the campaign stays exactly as the
 * customer left it and runs again on a later tick once the condition has passed. ONE exception,
 * stated by the owner: billing cannot charge the org — a declined card (`payment_declined`) or no
 * payment method at all (`no_payment_method`). Both stop every campaign of the org, and a person
 * restarts them once billing clears it.
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
  /**
   * The ONE system-written stop, by the owner's explicit decision (2026-09-26): billing reports it
   * cannot charge this org's card, so every campaign of the org is stopped and none may be started
   * until billing stops saying so (paid AND a chargeable card on file). See `lib/payment-hold.ts`.
   * It is not a condition that passes on its own: the customer must act, and then a PERSON starts
   * the campaign again — nothing resumes it automatically.
   */
  PAYMENT_DECLINED: "payment_declined",
  /**
   * Same stop, same refusal, same manual restart as `payment_declined`, for the case where nothing
   * was declined: the org has NO card billing can charge (the customer removed it, or never added
   * one — billing's `blockedReason: no_chargeable_card`). Its own value so the dashboard can say
   * "add a payment method" instead of "your card was declined" (owner rule, 2026-09-27).
   */
  NO_PAYMENT_METHOD: "no_payment_method",
} as const;

export type StopReason = (typeof STOP_REASONS)[keyof typeof STOP_REASONS];
