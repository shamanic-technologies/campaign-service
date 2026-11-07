/**
 * THE COARSE `post_published` OUTCOME IS RETIRED (owner 2026-11-07, DELETE-POST-PUBLISHED-1107): an outcome is the WHAT,
 * as fine as possible (« Threads post published », never « Post published »). features-service declared the fine-key
 * twins of the three catalogue legs spelled with the coarse key and retires the old ones once every service speaks the
 * new spelling. Every leg ever spelled with the coarse key was a Threads leg (verified fleet-wide), so the rule is ONE
 * token rewrite, never a per-network branch:
 *
 *     inside a leg key / pipe id / funnel id, every `post_published` token NOT already `threads_` / `x_` /
 *     `linkedin_`-prefixed becomes `threads_post_published`.
 *
 *     start_to_post_published@threads-post+post_published_to_paid_client
 *  -> start_to_threads_post_published@threads-post+threads_post_published_to_paid_client
 *
 * Migration 0088 re-keyed every stored row with the SAME pattern (`COARSE_POST_PUBLISHED_PATTERN`, pinned in
 * `tests/unit/fine-outcome-spelling.test.ts` against the migration text). In code it is an INPUT alias, like the
 * outbound wave-1 spelling (`leg-identity.ts`): a caller or a cached plan still naming the coarse token is read as the
 * fine one, so features-service's plan computed before the retirement never moves the funnel campaign back.
 */

/** Postgres ARE and JS share this syntax (no lookbehind: the prefix is captured and written back). */
export const COARSE_POST_PUBLISHED_PATTERN = "(^|[^a-z_]|_to_)post_published(?=$|_to_|[^a-z0-9_])";
export const FINE_POST_PUBLISHED_REPLACEMENT_SQL = "\\1threads_post_published";

const COARSE = new RegExp(COARSE_POST_PUBLISHED_PATTERN, "g");

/** `key` with every coarse `post_published` token in its fine spelling; any other text comes back unchanged. */
export function fineOutcomeSpelling(key: string): string;
export function fineOutcomeSpelling(key: string | null | undefined): string | null | undefined;
export function fineOutcomeSpelling(key: string | null | undefined): string | null | undefined {
  if (!key || !key.includes("post_published")) return key;
  return key.replace(COARSE, "$1threads_post_published");
}
