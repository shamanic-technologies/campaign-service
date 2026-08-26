/**
 * A campaign's IDENTITY: (org, brand, sales funnel, acquisition channel).
 *
 * Nothing else is part of it. In particular the WORKFLOW is not: a campaign changes workflow over
 * time — selection re-picks one every run — and it does not get replaced by a new campaign each
 * time it does. Treating the workflow as part of the identity is what grew one brand 137 stopped
 * rows, one per workflow version (`Aurora`, `Aurora V2`, `V3`, `Hassium` x12, `Tributary` x5 …),
 * each holding a slice of the history nobody could read as one campaign.
 *
 * Two of the four were not stored facts before this module:
 *
 *   - the BRAND was an ARRAY (`brand_ids`), which no unique index can span, so Postgres could not
 *     enforce anything. The reality is one brand per campaign; `brand_id` states it.
 *   - the ACQUISITION CHANNEL was not stored at all — consumers derived it from the workflow slug,
 *     i.e. from the one attribute that legitimately changes under a campaign.
 *
 * Both are written once, at creation, from what the campaign already states. Nothing re-derives
 * either at read time.
 */

/**
 * The medium a campaign reaches people through, as a stored token.
 *
 * Named per FEATURE FAMILY rather than per medium alone, and that is deliberate: `cold_email`
 * would make a brand's PR cold-email campaign and its SALES cold-email campaign the same identity
 * while they sell different things, so a legitimate second campaign would collide with the first.
 * The sales funnels — the only campaigns that state a funnel — get the plain medium name, and
 * every other product family names its own channel.
 *
 * Total by construction: a feature absent from this map yields its own slug with `-` as `_`, so a
 * feature shipped after this file can never silently share another one's identity.
 */
const CHANNEL_BY_FEATURE: Readonly<Record<string, string>> = Object.freeze({
  // The sales funnels. `cold_email` and `crm_email` are the two mediums a sales funnel is worked
  // through today; a brand may fund the same funnel on both, and those are two campaigns.
  "sales-cold-email-outreach": "cold_email",
  "sales-crm-email-outreach": "crm_email",
  // The feedback-request offer. Same medium as `cold_email` and deliberately NOT the same channel
  // token: a brand may work one funnel through both offers at once, and those are two campaigns,
  // so they must hold two identities or the unique index would let only one of them exist.
  "feedback-request-cold-email-outreach": "feedback_request_email",
  // Paid reach. Bought impressions rather than an outbound message, so it shares no identity with
  // any cold-email channel and a brand may work one funnel through both at once. Stated
  // explicitly rather than left to the fallback below: the fallback is total by construction, so
  // an upstream RENAME of this slug would file the campaign under a channel nothing else uses,
  // silently, with no error and no failing test.
  "google-ads": "google_ads",

  // Everything else. A sales funnel is not something these run — their funnel stays NULL — but
  // they still carry a channel so the identity key is enforceable for them too.
  "pr-cold-email-outreach": "pr_cold_email",
  "hiring-cold-email-outreach": "hiring_cold_email",
  "vc-cold-email-outreach": "vc_cold_email",
  "pr-expert-quote-outreach": "expert_quote_outreach",
  "pr-expert-quote-opportunities": "expert_quote_opportunities",
  "ai-visibility-scoring": "ai_visibility",
  "press-kit-page-generation": "press_kit",
  "outlet-database-discovery": "outlet_discovery",
});

/**
 * The channel a feature acquires through, or null when the campaign states no feature.
 *
 * Null is honest, not a default: a campaign with no feature slug states no channel, and the
 * uniqueness index skips it rather than folding every such row onto one key.
 */
export function acquisitionChannelForFeature(featureSlug: string | null | undefined): string | null {
  if (!featureSlug) return null;
  return CHANNEL_BY_FEATURE[featureSlug] ?? featureSlug.replace(/-/g, "_");
}

/**
 * The identity columns to stamp on a campaign at creation.
 *
 * Every `insert(campaigns)` in this service goes through here, so a new write site cannot forget
 * one half of the key and leave a row Postgres will not police.
 */
export function campaignIdentityColumns(input: {
  brandIds?: string[] | null;
  featureSlug?: string | null;
}): { brandId: string | null; acquisitionChannel: string | null } {
  return {
    brandId: input.brandIds?.[0] ?? null,
    acquisitionChannel: acquisitionChannelForFeature(input.featureSlug),
  };
}
