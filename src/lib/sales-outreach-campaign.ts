export const SALES_OUTREACH_FEATURE_SLUG = "sales-cold-email-outreach";
export const SALES_CRM_FEATURE_SLUG = "sales-crm-email-outreach";
/**
 * The second cold-email ACQUISITION CHANNEL: the same medium and the same measurement as
 * `sales-cold-email-outreach`, differing only in the OFFER — it asks a buyer for feedback on the
 * problem we solve instead of pitching, and the conversation that opens becomes the meeting.
 *
 * A channel IS a feature slug in this fleet's vocabulary, so a second channel is a second feature
 * and nothing else: no channel table, enum or vocabulary exists here or should be introduced.
 * Which sales funnels this feature may be SOLD THROUGH is features-service's statement, read per
 * feature — never a matrix held here.
 */
export const SALES_FEEDBACK_REQUEST_FEATURE_SLUG = "sales-feedback-request-cold-email-outreach";

// The sales-outreach feature family. Every feature here shares the SAME runtime behaviour in this
// service — the funding hold, per-pair pacing, greedy workflow rotation + Thompson audience
// selection, brand serialization, and the extend-audience lifecycle email. Any per-feature gate
// keyed on "is this a sales-outreach campaign?" MUST test membership here, not a single slug, so
// the features stay byte-identical. (Adding a further sales channel = one line here.)
export const SALES_OUTREACH_FEATURE_SLUGS: ReadonlySet<string> = new Set([
  SALES_OUTREACH_FEATURE_SLUG,
  SALES_CRM_FEATURE_SLUG,
  SALES_FEEDBACK_REQUEST_FEATURE_SLUG,
]);

export function isSalesOutreachFeature(slug?: string | null): boolean {
  return !!slug && SALES_OUTREACH_FEATURE_SLUGS.has(slug);
}
