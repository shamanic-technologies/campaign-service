import { and, eq, inArray, or, type SQL } from "drizzle-orm";
import { campaigns } from "../db/schema.js";
import { legKeySpellings, otherOutboundSpelling, OUTBOUND_RENAMED_FEATURE_SLUGS } from "./leg-identity.js";

/**
 * `campaigns.leg_key` names `legKey`, under either outbound spelling (lib/leg-identity.ts).
 *
 * With the channel known, every spelling that channel's rows may carry. With NO channel (a filter
 * that states none), the other spelling matches only rows whose channel is outbound: a non-outbound
 * `start_to_website_visit` is never matched by `lead_found_to_website_visit`, nor the reverse.
 */
export function legKeyMatches(featureSlug: string | null | undefined, legKey: string): SQL {
  if (featureSlug) {
    const spellings = legKeySpellings(featureSlug, legKey);
    return spellings.length === 1 ? eq(campaigns.legKey, legKey) : inArray(campaigns.legKey, spellings);
  }
  const other = otherOutboundSpelling(legKey);
  if (!other) return eq(campaigns.legKey, legKey);
  return or(
    eq(campaigns.legKey, legKey),
    and(eq(campaigns.legKey, other), inArray(campaigns.featureSlug, [...OUTBOUND_RENAMED_FEATURE_SLUGS])),
  )!;
}
