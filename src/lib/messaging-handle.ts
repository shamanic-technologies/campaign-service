/**
 * A person's MESSAGING HANDLE (LEAD-REPLY-CHANNEL-1127): how crm-service names someone who writes to a brand's
 * linked Pro account on a bridged app, `msg:<network>:<id>` (the spelling it already states to human-service),
 * e.g. `msg:telegram:123456789`. The identity of a person known by neither an email nor a phone. Any network:
 * nothing here (or anywhere in this service) reads which network it is, and nothing derives an email or a phone
 * from it.
 */
export const MESSAGING_HANDLE_RE = /^msg:[a-z0-9][a-z0-9_.-]{0,49}:\S.{0,248}$/;

/** Whether a value is a messaging handle. Pure. */
export function isMessagingHandle(value: unknown): value is string {
  return typeof value === "string" && MESSAGING_HANDLE_RE.test(value.trim());
}
