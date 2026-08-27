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

/**
 * The first PAID-REACH channel: bought impressions rather than an outbound message.
 *
 * A channel is still a feature slug, so this is one line and no new vocabulary — google-service
 * wraps the Google Ads API and declares the spend an org's campaigns incur as that org's cost,
 * features-service publishes the channel and states which funnels it may be sold through (the
 * visit-led funnels: an ad buys a click, and there is no reply in it to sell a conversation with),
 * and billing states its per-(funnel, channel, offer) ceiling like any other. What was missing was
 * the one thing that makes a funded channel happen at all: a campaign, provisioned and scheduled.
 *
 * Only THIS channel of the published paid-reach catalogue is here. The rest (meta-ads,
 * linkedin-ads, …) are published but nothing can execute them yet, and a campaign for a channel
 * with no workflow behind it would sit ongoing and produce nothing forever.
 */
export const GOOGLE_ADS_FEATURE_SLUG = "google-ads";

/**
 * The OUTBOUND cold-email channels — the three that reach a named person one at a time.
 *
 * They share what a paid-reach channel shares with nothing: the same lead population, the same
 * sending accounts, the same "everybody in this audience has now been contacted" ending. So three
 * behaviours are theirs alone and are keyed on THIS set rather than on the funnel-funded family:
 * the per-brand serialization (one outbound run in flight per brand, because two of them would
 * contact the same people from the same mailboxes), the greedy workflow rotation (which prices a
 * DAG on send-tagged outcome evidence these channels produce), and the extend-audience lifecycle
 * email (which asks a customer for more PEOPLE to contact).
 */
export const OUTBOUND_SALES_FEATURE_SLUGS: ReadonlySet<string> = new Set([
  SALES_OUTREACH_FEATURE_SLUG,
  SALES_CRM_FEATURE_SLUG,
  SALES_FEEDBACK_REQUEST_FEATURE_SLUG,
]);

export function isOutboundSalesFeature(slug?: string | null): boolean {
  return !!slug && OUTBOUND_SALES_FEATURE_SLUGS.has(slug);
}

/**
 * THE FUNNEL-FUNDED FAMILY: every acquisition channel that SELLS A SALES FUNNEL.
 *
 * Membership means one thing and it is a MONEY statement, not a medium one: this campaign's
 * ceiling is billing's, stated per (sales funnel, acquisition channel, offer) and read live on
 * every plan — so the campaign states its funnel at birth, is provisioned one per funded pair,
 * is held when the customer funds nothing for it, takes its turn on its own fill ratio, and
 * carries no per-campaign budget column of its own.
 *
 * A paid-reach channel answers all of that identically to a cold-email one, which is why Google
 * Ads is a member and not a family of its own. Where it genuinely differs — it shares no leads
 * and no mailboxes with an outbound channel — the narrower OUTBOUND set above is what is asked.
 *
 * Adding a further channel is one line here (plus its CHANNEL_BY_FEATURE token), once something
 * can execute it.
 */
export const SALES_FUNNEL_FEATURE_SLUGS: ReadonlySet<string> = new Set([
  ...OUTBOUND_SALES_FEATURE_SLUGS,
  GOOGLE_ADS_FEATURE_SLUG,
]);

export function isSalesFunnelFeature(slug?: string | null): boolean {
  return !!slug && SALES_FUNNEL_FEATURE_SLUGS.has(slug);
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
  if (!isSalesFunnelFeature(featureSlug)) return null;
  const stated = MAX_BUDGET_FIELDS.filter((field) => body?.[field] !== undefined);
  if (stated.length === 0) return null;
  return (
    `A ${featureSlug} campaign cannot state ${stated.join(", ")} — nothing reads a per-campaign ` +
    `budget ceiling for the sales family. Its money is billing's, stated per (sales funnel, ` +
    `acquisition channel, offer) on the brand's daily ceilings; set it there instead.`
  );
}
