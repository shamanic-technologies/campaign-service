export const SALES_OUTREACH_FEATURE_SLUG = "sales-cold-email-outreach";
export const SALES_CRM_FEATURE_SLUG = "sales-crm-email-outreach";

// The sales-outreach feature family. Both features share the SAME runtime behaviour in this
// service — the funding hold, brand-daily-budget pacing, greedy workflow rotation + Thompson
// audience selection, and the extend-audience lifecycle email. Any per-feature gate keyed on
// "is this a sales-outreach campaign?" MUST test membership here, not a single slug, so the two
// features stay byte-identical. (Adding a third sales feature = one line here.)
export const SALES_OUTREACH_FEATURE_SLUGS: ReadonlySet<string> = new Set([
  SALES_OUTREACH_FEATURE_SLUG,
  SALES_CRM_FEATURE_SLUG,
]);

export function isSalesOutreachFeature(slug?: string | null): boolean {
  return !!slug && SALES_OUTREACH_FEATURE_SLUGS.has(slug);
}
