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
 * WHAT A SOURCE CAMPAIGN IS IN THIS SERVICE: a status and an id. A pre-funnel one has NO workflow (lead-service
 * finds the leads inside the outreach campaign's run, under the source campaign's id), so it is never
 * scheduled, triggered or gate-checked. A SALES FUNNEL source unit carries its pipe's workflow and runs on its
 * own once the catalogue reads its leg proactive (lib/on-demand-mode.ts). It is never one of
 * the offer's "one proactive campaign" (lib/single-proactive.ts): it neither stops nor is stopped by
 * the outreach campaign or another source. It is NOT in the sales family: no money path here paces it;
 * the sourcing it pays for is still counted in the outreach campaign that the found lead feeds
 * (lib/channel-spend.ts), which keeps what is spent today unchanged.
 */

import { readSourcingMap } from "./sourcing-origins-client.js";

/** The leg every source campaign is keyed on (features-service `SOURCE_LEG_KEY`). */
export const SOURCE_LEG_KEY = "start_to_lead_found";

/** The step a source campaign ends at: the hand-off to the outreach campaigns it feeds. */
export const LEAD_FOUND_STEP = "lead_found";

/**
 * LEAD SOURCING (features-service `LEAD_SOURCING_CHANNEL`, owner 2026-10-11): the sourcing channel that picks
 * its own origins (human-service decides which, per brand). A sales funnel names ONE channel on Start -> Lead
 * found: an origin below, or this one. Here it is a source campaign like the origins (same leg, same On/Off,
 * same "feeds the cold email outreach"); lead-service files a serve under it when the origin the audience came
 * from is one human-service chose for it.
 */
export const LEAD_SOURCING_SLUG = "lead-sourcing";

/** The source channels a customer can turn ON today: the origins, and Lead Sourcing. */
export const LIVE_SOURCE_ORIGIN_SLUGS = [
  "sourcing-apollo-cold-filters",
  "sourcing-apollo-buying-signals",
  "sourcing-linkedin-engagement-signals",
  "sourcing-crm-contacts",
  LEAD_SOURCING_SLUG,
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

/**
 * WHICH ORIGINS FEED WHICH OUTREACH CHANNEL, Lead Sourcing included, and the origin a new offer starts with, are
 * features-service's statement, READ at `GET /public/sourcing-origins` (lib/sourcing-origins-client.ts). No copy
 * lives here: the hand-kept one drifted on 2026-10-12 and a live WhatsApp campaign served nobody.
 */

/**
 * WHO DISPATCHES A SOURCE UNIT is lib/on-demand-mode.ts (owner 2026-10-12, "every pipe is independent"): the
 * catalogue's reading of its leg. Reactive on `on_demand` = it answers the lead request of the outreach run that needs
 * the lead (lib/on-demand-runs.ts); proactive = the scheduler dispatches it like every unit, and it finds leads on its
 * own inside its funnel campaign's caps.
 */

/**
 * True when campaigns of this channel are FED by source campaigns (it works found leads), per features-service's map.
 * Throws when the map is unreadable (lib/sourcing-origins-client.ts): never answers "not sourced" for "unknown".
 */
export async function isSourcedChannel(featureSlug?: string | null): Promise<boolean> {
  if (!featureSlug) return false;
  const map = await readSourcingMap();
  return (map.feedingByChannel[featureSlug]?.length ?? 0) > 0;
}
