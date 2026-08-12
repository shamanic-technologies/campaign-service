/**
 * The sales-funnel vocabulary — the ONE word for what a campaign sells, and the ONLY one.
 *
 * A campaign runs one sales funnel: one chain from the first signal outreach can buy (a positive
 * reply, or a click onto the site) down to a paid client. The campaign STATES that funnel on its
 * own row (`campaigns.funnel_key`), at birth, and every consumer reads it there. Nothing infers
 * it — not at creation, not at read time, not as a fallback when it is missing. A sales campaign
 * with no funnel is a bug to fail loud on.
 *
 * There is NO goal vocabulary here any more. brand-service used to answer "what does this brand
 * sell through?" twice — once with a funnel, once with a goal — and the goal was strictly the
 * poorer word: `sales_meetings_from_conversation` and `sales_meetings_from_website` both collapsed
 * onto one `meetingBooked`, so a meeting won from a reply and one won on the website were the same
 * thing to every consumer. It was also wrong at the source (a NOT NULL default made a brand that
 * never chose one read as selling through website purchases). brand-service retired it (#434) and
 * so has this service: the goal→funnel map and the funnel→goal alias are DELETED, not translated.
 *
 * What remains is one canonicaliser: `toFunnelKey` resolves EVERY spelling of a funnel — from
 * brand-service, from billing-service (which still emits the pre-rename keys today), and from a
 * campaign row written before the rename — to one canonical token past this boundary, always.
 */

/**
 * The four funnels, in brand-service's canonical spelling. These are the ONLY funnel tokens this
 * service ever stores or emits.
 */
export const SALES_FUNNEL_KEYS = [
  "sales_meetings_from_conversation",
  "sales_meetings_from_website",
  "website_purchases",
  "form_magnet",
] as const;

export type SalesFunnelKey = (typeof SALES_FUNNEL_KEYS)[number];

/**
 * The pre-rename spelling of each funnel, as brand-service emitted it until #434, as
 * billing-service STILL emits it on `/internal/brands/:id/funnel-budgets` today, and as every
 * campaign row written before migration 0043 carries it.
 *
 * Accepted forever on the way in; never emitted. Deleting an entry silently unfunds every funnel
 * a producer still names the old way — which is the whole failure this map exists to prevent.
 */
const LEGACY_FUNNEL_KEYS: Readonly<Record<string, SalesFunnelKey>> = Object.freeze({
  reply_meeting: "sales_meetings_from_conversation",
  visit_meeting: "sales_meetings_from_website",
  visit_signup: "website_purchases",
  visit_form: "form_magnet",
});

const CANONICAL_FUNNEL_KEYS: ReadonlySet<string> = new Set(SALES_FUNNEL_KEYS);

/**
 * The canonical funnel a value names, under any spelling — or null when it names none.
 *
 * Never guesses: a token neither catalogue lists returns null, and the caller treats that as "no
 * funnel", not as a fifth funnel it may quietly work.
 */
export function toFunnelKey(value: string | null | undefined): SalesFunnelKey | null {
  if (!value) return null;
  if (CANONICAL_FUNNEL_KEYS.has(value)) return value as SalesFunnelKey;
  return LEGACY_FUNNEL_KEYS[value] ?? null;
}

/** Every funnel spelling this service accepts on the way in — the canonical four plus the four legacy. */
export function acceptedFunnelKeys(): string[] {
  return [...SALES_FUNNEL_KEYS, ...Object.keys(LEGACY_FUNNEL_KEYS)];
}
