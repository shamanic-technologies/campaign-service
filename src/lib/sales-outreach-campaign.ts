export const SALES_OUTREACH_FEATURE_SLUG = "sales-cold-email-outreach";
export const SALES_CRM_FEATURE_SLUG = "sales-crm-email-outreach";
/**
 * The second cold-email ACQUISITION CHANNEL: the same medium and the same measurement as
 * `sales-cold-email-outreach`, differing only in the OFFER — it asks a buyer for feedback on the
 * problem we solve instead of pitching, and the conversation that opens becomes the meeting.
 *
 * A channel IS a feature slug in this fleet's vocabulary, so a second channel is a second feature
 * and nothing else: no channel table, enum or vocabulary exists here or should be introduced.
 * Which legs it performs is features-service's statement, read from its catalogue — never a
 * matrix held here.
 */
export const SALES_FEEDBACK_REQUEST_FEATURE_SLUG = "feedback-request-cold-email-outreach";

/**
 * The first PAID-REACH channel: bought impressions rather than an outbound message.
 *
 * A channel is still a feature slug, so this is one line and no new vocabulary — google-service
 * wraps the Google Ads API and declares the spend an org's campaigns incur as that org's cost,
 * features-service publishes the channel and states which legs it performs (an ad buys a click),
 * and billing states its per-(offer, leg, channel) ceiling like any other. What was missing was
 * the one thing that makes a funded channel happen at all: a campaign, provisioned and scheduled.
 *
 * Only THIS channel of the published paid-reach catalogue is here. The rest (meta-ads,
 * linkedin-ads, …) are published but nothing can execute them yet, and a campaign for a channel
 * with no workflow behind it would sit ongoing and produce nothing forever.
 */
export const GOOGLE_ADS_FEATURE_SLUG = "google-ads";

/**
 * The channel that answers a lead who ALREADY replied: it books the meeting out of a stated sales
 * interest instead of reaching a new person.
 *
 * A channel is still a feature slug, so this is one line and no new mechanism — features-service
 * publishes it and states which legs it performs, workflow-service holds its dynasty, and billing
 * states its per-(offer, leg, channel) ceiling like any other. It is a member of the
 * sales family for exactly that reason: its money is billing's, read live on every plan.
 *
 * It is deliberately NOT a member of the OUTBOUND set below. It contacts nobody new: it shares no
 * lead population and no sending-account load with cold email, it produces no send-tagged outcome
 * evidence for a workflow rotation to price a DAG on, and asking its customer for more PEOPLE to
 * contact is nonsense for a channel whose whole input is people who already answered.
 */
export const AI_MEETING_BOOKING_FEATURE_SLUG = "ai-meeting-booking";

/**
 * The first EARNED-media channel: it answers a journalist's quote request on Featured.com, and the
 * article that publishes carries a link a buyer arrives on. Bought attention neither by an outbound
 * message nor by an impression, but by being quoted.
 *
 * A channel is still a feature slug, so this is one line and no new mechanism. features-service
 * publishes it (family `earned`, platform-operated, its one leg `start_to_website_visit` — a published article
 * buys a click), workflow-service holds eight active dynasties for it, and billing states its
 * per-(offer, leg, channel) ceiling like any other. It is a member of the sales family for exactly
 * that reason: its money is billing's, read live
 * on every plan.
 *
 * It is deliberately NOT a member of the OUTBOUND set below. It contacts nobody new: it shares no
 * lead population and no sending-account load with cold email, it produces no send-tagged outcome
 * evidence for a workflow rotation to price a DAG on, and asking its customer for more PEOPLE to
 * contact is nonsense for a channel whose whole input is journalists asking questions.
 *
 * Only the CURRENT slug. `pr-expert-quote-opportunities` is the RETIRED spelling of the same
 * channel — features-service states the rename on this one — and is never added here: two names
 * for one channel is how a brand grows two identities for one offer.
 */
export const PR_EXPERT_QUOTE_FEATURE_SLUG = "pr-expert-quote-outreach";

/**
 * The OUTBOUND cold-email channels — the three that reach a named person one at a time.
 *
 * They share what a paid-reach channel shares with nothing: the same lead population, the same
 * sending accounts, the same "everybody in this audience has now been contacted" ending. So three
 * behaviours are theirs alone and are keyed on THIS set rather than on the sales family:
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
 * THE SALES FAMILY: every acquisition channel whose campaigns are funded per (offer, leg, channel).
 *
 * Membership means one thing and it is a MONEY statement, not a medium one: this campaign's
 * ceiling is billing's, stated per (offer, leg, acquisition channel) and read live on every plan —
 * so the campaign states its offer and leg at birth (`POST /campaigns` refuses one that does not),
 * is HELD when the customer funds nothing for it, takes its turn on its own
 * spent-over-ceiling ratio, and carries no per-campaign budget column of its own.
 *
 * Membership says nothing about a campaign COMING INTO BEING. Money starts nothing: a campaign
 * exists because a person created it, and a brand that funds a channel it has no campaign for
 * simply has no campaign for it.
 *
 * A paid-reach channel answers all of that identically to a cold-email one, which is why Google
 * Ads is a member and not a family of its own, and an EARNED-media one answers it identically
 * again — being quoted in an article is a different way to buy a click, not a different way to be
 * funded. Where they genuinely differ — they share no leads and no mailboxes with an outbound
 * channel — the narrower OUTBOUND set above is what is asked.
 *
 * Adding a further channel is one line here (plus its CHANNEL_BY_FEATURE token), once something
 * can execute it. The set is WIDENED rather than DERIVED from features-service's catalogue on
 * purpose, and the reason is what membership means: it is a statement about whose ceiling paces
 * this campaign, which the catalogue does not publish — it publishes which channels exist and who
 * operates them, a different question. It is also read synchronously on gate-check's money path
 * and inside SQL, so deriving it would make an unreadable catalogue silently change whether a
 * per-campaign budget column binds. What IS derived is everything the catalogue actually owns:
 * who operates a channel and which legs it performs.
 *
 * The cost of a channel MISSING from this set is silent and it is the reason each addition is
 * worth the line: outside the family gate-check reads the campaign as a non-sales one and
 * enforces the (null) `maxBudget*` windows instead of billing's ceiling, the turn planner never
 * ranks it, and the funding hold never holds it — a campaign running a DAG against a ceiling
 * nothing enforces. Also auto-adopting every published channel would name the dozen paid-reach
 * slugs nothing can execute, so a channel is added only once something can run it.
 */
export const SALES_FAMILY_FEATURE_SLUGS: ReadonlySet<string> = new Set([
  ...OUTBOUND_SALES_FEATURE_SLUGS,
  GOOGLE_ADS_FEATURE_SLUG,
  AI_MEETING_BOOKING_FEATURE_SLUG,
  PR_EXPERT_QUOTE_FEATURE_SLUG,
]);

export function isSalesFamilyFeature(slug?: string | null): boolean {
  return !!slug && SALES_FAMILY_FEATURE_SLUGS.has(slug);
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
 * A sales campaign's money is BILLING's, per (offer, leg, channel) — read live on every plan.
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
  if (!isSalesFamilyFeature(featureSlug)) return null;
  const stated = MAX_BUDGET_FIELDS.filter((field) => body?.[field] !== undefined);
  if (stated.length === 0) return null;
  return (
    `A ${featureSlug} campaign cannot state ${stated.join(", ")} — nothing reads a per-campaign ` +
    `budget ceiling for the sales family. Its money is billing's, stated per (offer, leg, ` +
    `acquisition channel) on the brand's daily ceilings; set it there instead.`
  );
}
