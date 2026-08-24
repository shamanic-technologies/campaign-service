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
export const SALES_FEEDBACK_REQUEST_FEATURE_SLUG = "feedback-request-cold-email-outreach";

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

// The four per-campaign budget-window columns. gate-check enforces them for every OTHER feature
// family (`if (!isSalesFeature)`), which is why they stay on the row and are never dropped.
export const MAX_BUDGET_FIELDS = [
  "maxBudgetDailyUsd",
  "maxBudgetWeeklyUsd",
  "maxBudgetMonthlyUsd",
  "maxBudgetTotalUsd",
] as const;

/**
 * A sales campaign's money is BILLING's, per (funnel, channel, offer) — read live on every plan.
 * gate-check runs the whole campaign-budget-windows block under `if (!isSalesFeature)`, so a
 * `maxBudget*` on a sales row is inert BY CONSTRUCTION: correct behaviour, silent presentation.
 * A row that states a dollar ceiling nothing reads is what misled a live diagnosis (#396 —
 * `max_budget_daily_usd | 10.00` on a campaign whose real ceiling was $50).
 *
 * So a create or update that states one on a sales-family campaign is REFUSED, naming where the
 * ceiling actually belongs. Returns the refusal message, or null when there is nothing to refuse.
 * Non-sales campaigns are untouched: for them the column is live.
 */
export function salesMaxBudgetRefusal(
  featureSlug: string | null | undefined,
  body: Record<string, unknown>,
): string | null {
  if (!isSalesOutreachFeature(featureSlug)) return null;
  const stated = MAX_BUDGET_FIELDS.filter((field) => body?.[field] !== undefined);
  if (stated.length === 0) return null;
  return (
    `A ${featureSlug} campaign cannot state ${stated.join(", ")} — nothing reads a per-campaign ` +
    `budget ceiling for the sales family. Its money is billing's, stated per (sales funnel, ` +
    `acquisition channel, offer) on the brand's daily ceilings; set it there instead.`
  );
}
