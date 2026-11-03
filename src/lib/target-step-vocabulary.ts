/**
 * WHAT A FUNNEL CAMPAIGN'S `target` ACCEPTS, said once (CLIENT-FRICTION-API-1103-CAMPAIGN).
 *
 * An outside developer read `target` as free text (the served openapi said `string, 1..200`), sent a sentence and got
 * `unknown_target_step`. The accepted values are a LIVE vocabulary (features-service's channel catalogue `steps[].key`,
 * read on every create/update by `checkTargetStep`), so a hand-typed enum would drift the day a step is published.
 * Instead the doc names the exact read validation makes, and the refusal lists the keys it read.
 *
 * The validation read (`fetchChannelCatalogue`) and the doc share THIS path: features-service `GET /public/channels`,
 * served byte-for-byte by the public gateway at `/v1/public/channels` (no auth). Its `steps[].key` IS the accepted set.
 * Not `/v1/public/catalogue/steps`: prod 2026-11-03 it served 2 keys more (`lead_interested`, `lead_visited`) that the
 * channel catalogue does not publish, so a target picked there is refused.
 */
export const TARGET_STEPS_CATALOGUE_PATH = "/public/channels";

/** Where a client reads the accepted values, through the public gateway. */
export const TARGET_STEPS_PUBLIC_READ = `GET /v1${TARGET_STEPS_CATALOGUE_PATH}`;

export const TARGET_STEP_DESCRIPTION =
  "The OUTCOME this campaign aims at: a step key of the channel catalogue, never free text. " +
  `Accepted values = exactly the \`steps[].key\` values served by \`${TARGET_STEPS_PUBLIC_READ}\` (no authentication), ` +
  "read live on every create/update, so the list is always the one validation uses " +
  '(e.g. "paid_client", "meeting_booked", "signup"). Omitted on create = the sales funnel\'s last step. ' +
  "Any other value = 400 `unknown_target_step`, whose body lists the accepted values in `acceptedTargets`.";
