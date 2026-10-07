/**
 * SOURCE CAMPAIGNS: the lead SOURCES of an offer are campaigns (owner 2026-10-07).
 *
 * The customer's Sales path page lists one campaign per sourcing origin above the outreach one:
 *
 *   Solstice    [Apollo Cold Filters] -> Lead found                    [On]
 *   Sparkle     [LinkedIn Engagement Signals] -> Lead found            [Off]
 *   Jubilation  Lead found -> Sales Cold Email -> Positive reply       [On]
 *
 * Several sources may be ON at once. The outreach campaign works every lead any ON source found,
 * and a person found by two sources is contacted once.
 *
 * VOCABULARY IS features-service's (`lib/source-campaigns.ts`, contract in its
 * `src/routes/CLAUDE.md` "Source campaigns"), held here verbatim:
 *   - a source campaign is keyed (offerId, featureSlug = <origin slug>, legKey = "start_to_lead_found");
 *   - it is PROACTIVE (it starts from nothing) and ends at step `lead_found`, which is a hand-off, not
 *     a funnel step: the catalogue publishes no such leg, so nothing here asks the catalogue about it.
 *
 * WHAT A SOURCE CAMPAIGN IS IN THIS SERVICE: a status and an id. It has NO workflow (lead-service
 * finds the leads inside the outreach campaign's run, under the source campaign's id), so it is never
 * scheduled, triggered or gate-checked, exactly like a service-performed channel. It is never one of
 * the offer's "one proactive campaign" (lib/single-proactive.ts): it neither stops nor is stopped by
 * the outreach campaign or another source. It is NOT in the sales family: no money path here paces it;
 * the sourcing it pays for is still counted in the outreach campaign that the found lead feeds
 * (lib/channel-spend.ts), which keeps what is spent today unchanged.
 */

/** The leg every source campaign is keyed on (features-service `SOURCE_LEG_KEY`). */
export const SOURCE_LEG_KEY = "start_to_lead_found";

/** The step a source campaign ends at: the hand-off to the outreach campaigns it feeds. */
export const LEAD_FOUND_STEP = "lead_found";

/** The origins a customer can turn ON today. */
export const LIVE_SOURCE_ORIGIN_SLUGS = [
  "sourcing-apollo-cold-filters",
  "sourcing-apollo-buying-signals",
  "sourcing-linkedin-engagement-signals",
  "sourcing-crm-contacts",
] as const;

/** A retired origin: an existing row is still served (history), it can never be turned ON again. */
export const RETIRED_SOURCE_ORIGIN_SLUGS = ["sourcing-apify-search"] as const;

const LIVE = new Set<string>(LIVE_SOURCE_ORIGIN_SLUGS);
const ALL = new Set<string>([...LIVE_SOURCE_ORIGIN_SLUGS, ...RETIRED_SOURCE_ORIGIN_SLUGS]);

/** True for any sourcing origin slug, live or retired: a campaign on it is a SOURCE campaign. */
export function isSourceOriginSlug(slug?: string | null): boolean {
  return !!slug && ALL.has(slug);
}

/** True for an origin that can be turned ON today. */
export function isLiveSourceOrigin(slug?: string | null): boolean {
  return !!slug && LIVE.has(slug);
}

/** A campaign row (or anything shaped like one) that is a source campaign. */
export function isSourceCampaign(c: { featureSlug?: string | null }): boolean {
  return isSourceOriginSlug(c.featureSlug);
}

/** features-service's row key for a source campaign (`sourceCampaignKeyOf`). */
export function sourceCampaignKey(originSlug: string): string {
  return `campaign:${originSlug}|${SOURCE_LEG_KEY}`;
}

const SEARCH_AND_SIGNAL_ORIGINS = [
  "sourcing-apollo-cold-filters",
  "sourcing-apollo-buying-signals",
  "sourcing-linkedin-engagement-signals",
  "sourcing-apify-search",
] as const;

/**
 * Which origins find leads for which OUTREACH channel. Mirrors features-service
 * `lib/sourcing-origins.ts` SOURCING_ORIGINS_BY_CHANNEL: a channel that starts serving another
 * origin must be listed in BOTH places. Read statically on purpose (it sits on gate-check's money
 * path, see lib/channel-spend.ts).
 */
export const SOURCING_ORIGINS_BY_CHANNEL: Readonly<Record<string, readonly string[]>> = {
  "sales-cold-email-outreach": SEARCH_AND_SIGNAL_ORIGINS,
  "feedback-request-cold-email-outreach": SEARCH_AND_SIGNAL_ORIGINS,
  "sales-crm-email-outreach": ["sourcing-crm-contacts"],
};

/**
 * The origin an outreach channel found its leads from before sources were campaigns: the source
 * a migrated or brand-new offer starts with, so nothing stops finding leads. null = the channel
 * sources nothing.
 */
export const DEFAULT_SOURCE_ORIGIN_BY_CHANNEL: Readonly<Record<string, string>> = {
  "sales-cold-email-outreach": "sourcing-apollo-cold-filters",
  "feedback-request-cold-email-outreach": "sourcing-apollo-cold-filters",
  "sales-crm-email-outreach": "sourcing-crm-contacts",
};

/** True when campaigns of this channel are FED by source campaigns (it works found leads). */
export function isSourcedChannel(featureSlug?: string | null): boolean {
  return !!featureSlug && featureSlug in SOURCING_ORIGINS_BY_CHANNEL;
}
