import type { CatalogueLeg } from "./channel-operator-client.js";

/**
 * ONE LEG, TWO SPELLINGS — the outbound leg-key rename, wave 1 (owner, 2026-10-09).
 *
 * "Lead found" becomes an ordinary funnel step: a sourcing campaign is Start -> Lead found, and an
 * OUTBOUND campaign takes the lead from there. So, for the outbound channels and ONLY those, the
 * fleet renames two leg keys (LOCKED, one identity shared by six codebases):
 *
 *     start_to_conversation   ->  lead_found_to_conversation
 *     start_to_website_visit  ->  lead_found_to_website_visit
 *
 * The same legacy keys on any NON-outbound channel (ads, SEO, PR...) are NOT renamed, and every
 * other leg key is unchanged (sourcing keeps `start_to_lead_found`).
 *
 * The rename rolls across services one at a time, so for a while some speak the new key and some
 * the old. Wave 1 (this module) makes the two spellings of an outbound leg the SAME identity
 * wherever this service receives, matches, dedups or enforces uniqueness on a leg key, while it
 * keeps STORING and SERVING exactly what it stores and serves today:
 *
 *   - `sameLeg` / `legIdentity`   compare a leg read from anywhere (a row, billing, the catalogue,
 *                                 brand-service's combination keys) against another;
 *   - `legKeySpellings`           every spelling a stored row may carry, for a DB filter;
 *   - `storedLegKey`              the spelling WRITTEN. Wave 1 writes the legacy spelling (what
 *                                 every stored row carries today), so the partial unique index
 *                                 `uniq_campaigns_org_brand_offer_sales_funnel_leg_channel` still sees one value
 *                                 per identity and keeps policing a race between two spellings.
 *
 * Wave 2 (owner go 2026-10-09): migration 0063 moved every stored outbound row (campaigns and the
 * 2026-09-26 snapshot) to the new spelling and `STORED_SPELLING` is "new", so this service now
 * WRITES and SERVES `lead_found_to_*` for an outbound channel. The legacy spelling is still
 * ACCEPTED on every input (callers and stale caches send it); dropping that is a later decision.
 */

/** The outbound channels (features-service channelType OUTBOUND), LOCKED by the rename brief. */
export const OUTBOUND_RENAMED_FEATURE_SLUGS: ReadonlySet<string> = new Set([
  "sales-cold-email-outreach",
  "feedback-request-cold-email-outreach",
  "sales-crm-email-outreach",
  "cold-call-outreach",
  "cold-instagram-outreach",
  "cold-linkedin-outreach",
  "cold-reddit-outreach",
  "cold-sms-outreach",
  "cold-whatsapp-outreach",
  "cold-x-outreach",
]);

/** legacy spelling -> new spelling, outbound channels only (LOCKED). */
const LEGACY_TO_NEW: ReadonlyMap<string, string> = new Map([
  ["start_to_conversation", "lead_found_to_conversation"],
  ["start_to_website_visit", "lead_found_to_website_visit"],
]);
const NEW_TO_LEGACY: ReadonlyMap<string, string> = new Map(
  [...LEGACY_TO_NEW].map(([legacy, renamed]) => [renamed, legacy]),
);

/** Which spelling this service WRITES. Wave 2 flipped it to "new", with migration 0063 moving every stored row. */
const STORED_SPELLING: "legacy" | "new" = "new";

function isRenamedChannel(featureSlug: string | null | undefined): boolean {
  return !!featureSlug && OUTBOUND_RENAMED_FEATURE_SLUGS.has(featureSlug);
}

/**
 * The value two spellings of one leg share, for comparison ONLY (never stored, never served).
 * A non-outbound channel, a key outside the rename, or a missing key comes back unchanged.
 */
export function legIdentity(featureSlug: string | null | undefined, legKey: string): string;
export function legIdentity(featureSlug: string | null | undefined, legKey: string | null | undefined): string | null | undefined;
export function legIdentity(featureSlug: string | null | undefined, legKey: string | null | undefined): string | null | undefined {
  if (!legKey || !isRenamedChannel(featureSlug)) return legKey;
  return NEW_TO_LEGACY.get(legKey) ?? legKey;
}

/** Whether two leg keys name the same leg of `featureSlug`'s channel (null equals null only). */
export function sameLeg(
  featureSlug: string | null | undefined,
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  if (!a || !b) return (a ?? null) === (b ?? null);
  return legIdentity(featureSlug, a) === legIdentity(featureSlug, b);
}

/** Every spelling a stored row of `featureSlug` may carry for this leg (the key itself first). */
export function legKeySpellings(featureSlug: string | null | undefined, legKey: string): string[] {
  if (!isRenamedChannel(featureSlug)) return [legKey];
  const other = LEGACY_TO_NEW.get(legKey) ?? NEW_TO_LEGACY.get(legKey);
  return other ? [legKey, other] : [legKey];
}

/**
 * Every spelling of `legKey` on ANY outbound channel, for a filter that states no channel: the
 * other spelling matches only rows whose channel is outbound (see `routes/campaigns.ts` GET).
 */
export function otherOutboundSpelling(legKey: string): string | null {
  return LEGACY_TO_NEW.get(legKey) ?? NEW_TO_LEGACY.get(legKey) ?? null;
}

/**
 * Whether `legKey` is the LEGACY spelling of a renamed outbound leg, as far as `featureSlug` lets
 * us tell: true on an outbound channel, false on any other stated channel, and true when no
 * channel is stated (a channel-less filter still widens to the outbound rows, see
 * `otherOutboundSpelling`). Feeds the `legacy-outbound-leg-key` log only (`legacy-leg-key-log.ts`).
 */
export function isLegacyOutboundSpelling(featureSlug: string | null | undefined, legKey: string): boolean {
  if (!LEGACY_TO_NEW.has(legKey)) return false;
  return !featureSlug || isRenamedChannel(featureSlug);
}

/** The spelling this service WRITES (and therefore serves) for `featureSlug`'s leg (wave 2: the new one). */
export function storedLegKey(featureSlug: string | null | undefined, legKey: string): string;
export function storedLegKey(featureSlug: string | null | undefined, legKey: string | null | undefined): string | null | undefined;
export function storedLegKey(featureSlug: string | null | undefined, legKey: string | null | undefined): string | null | undefined {
  if (!legKey || !isRenamedChannel(featureSlug)) return legKey;
  return STORED_SPELLING === "legacy"
    ? NEW_TO_LEGACY.get(legKey) ?? legKey
    : LEGACY_TO_NEW.get(legKey) ?? legKey;
}

/**
 * Of the keys a channel PUBLISHES, the one naming the same leg as `legKey` (its own spelling,
 * exact match first), or null. Used to resolve a stored leg against the catalogue whichever side
 * has already moved to the new spelling.
 */
export function publishedSpelling(
  featureSlug: string | null | undefined,
  published: Iterable<string>,
  legKey: string,
): string | null {
  let match: string | null = null;
  for (const key of published) {
    if (key === legKey) return key;
    if (match === null && sameLeg(featureSlug, key, legKey)) match = key;
  }
  return match;
}

/**
 * `legKeys` plus every other outbound spelling of each, for a DB `IN` that states no channel.
 * A SUPERSET: the caller re-checks each row with `sameLeg` under the row's own channel, so a
 * non-outbound row carrying the other spelling is never matched.
 */
export function withOtherOutboundSpellings(legKeys: readonly string[]): string[] {
  const all = new Set(legKeys);
  for (const key of legKeys) {
    const other = otherOutboundSpelling(key);
    if (other) all.add(other);
  }
  return [...all];
}

/**
 * A sales-path COMBINATION key (`<leg>@<channel>+<leg>@<channel>...`, brand-service's and
 * features-service's shared spelling) as one identity across the outbound rename: each part's leg
 * is replaced by its `legIdentity` under that part's own channel. For comparison ONLY. The leg
 * itself is never split; a part this cannot read is left as written.
 */
export function combinationIdentity(combinationKey: string): string {
  return combinationKey
    .split("+")
    .map((part) => {
      const at = part.lastIndexOf("@");
      if (at <= 0) return part;
      const channel = part.slice(at + 1);
      return `${legIdentity(channel, part.slice(0, at))}@${channel}`;
    })
    .join("+");
}

/** The part of a catalogue read the leg resolvers below need (a hand-built one may hold legs only). */
export interface CatalogueLegView {
  legs: readonly CatalogueLeg[];
  legsBySlug?: ReadonlyMap<string, ReadonlySet<string>>;
  reactiveBySlug?: ReadonlyMap<string, ReadonlyMap<string, boolean>>;
}

/**
 * The published leg a campaign of `featureSlug` stating `legKey` is bought for, whichever side
 * already speaks the renamed outbound spelling (above): the channel's own published
 * spelling first, else the global vocabulary under either spelling (exact first). Undefined when
 * nothing publishes it.
 */
export function catalogueLegOf(
  catalogue: CatalogueLegView,
  featureSlug: string | null | undefined,
  legKey: string,
): CatalogueLeg | undefined {
  const channelLegs = featureSlug ? catalogue.legsBySlug?.get(featureSlug) : undefined;
  const spelling = channelLegs ? publishedSpelling(featureSlug, channelLegs, legKey) : null;
  if (spelling) {
    const leg = catalogue.legs.find((l) => l.legKey === spelling);
    if (leg) return leg;
  }
  return catalogue.legs.find((l) => l.legKey === legKey)
    ?? catalogue.legs.find((l) => sameLeg(featureSlug, l.legKey, legKey));
}

/**
 * Whether a campaign of `featureSlug` bought for `legKey` is REACTIVE (runs when a lead reaches
 * its from-step) — `false` = it starts the journey (proactive / entry). features-service's
 * per-(channel, leg) `reactive` when the channel publishes the leg with one; otherwise the global
 * leg's `fromStep` (null = entry), which agreed with every published transition on 2026-10-09.
 * `null` = the catalogue publishes neither (unknown leg).
 */
export function legIsReactive(
  catalogue: CatalogueLegView,
  featureSlug: string | null | undefined,
  legKey: string | null | undefined,
): boolean | null {
  if (!legKey) return null;
  const byLeg = featureSlug ? catalogue.reactiveBySlug?.get(featureSlug) : undefined;
  if (byLeg) {
    const spelling = publishedSpelling(featureSlug, byLeg.keys(), legKey);
    if (spelling) return byLeg.get(spelling)!;
  }
  const leg = catalogueLegOf(catalogue, featureSlug, legKey);
  return leg === undefined ? null : leg.fromStepKey !== null;
}
