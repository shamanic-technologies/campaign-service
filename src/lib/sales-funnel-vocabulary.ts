/**
 * The sales-funnel vocabulary — the ONE word for what a campaign sells.
 *
 * A campaign runs one sales funnel: one chain from the first signal outreach can buy (a positive
 * reply, or a click onto the site) down to a paid client. The campaign STATES that funnel on its
 * own row (`campaigns.funnel_key`) and every consumer reads it there. Nothing infers it.
 *
 * brand-service used to answer "what does this brand sell through?" twice — once with a funnel,
 * once with a goal — and the goal was strictly the poorer word: `sales_meetings_from_conversation`
 * and `sales_meetings_from_website` both collapsed onto one `meetingBooked`, so a meeting won from
 * a reply and one won on the website were the same thing to every consumer. brand-service has now
 * retired the goal set (#434): the funnel is the only vocabulary it emits, and the four keys were
 * renamed while it was at it.
 *
 * This module is what makes that switch cost this service nothing:
 *
 *   - `toFunnelKey` canonicalises EVERY spelling of a funnel — from brand-service, from
 *     billing-service (which still emits the pre-rename keys today), and from a campaign row
 *     written before the rename. One canonical token past this boundary, always.
 *   - `funnelForGoal` reads a RETIRED GOAL as the funnel it named. Kept for the two places a goal
 *     is still the only thing on hand: the campaign rows written before funnels existed, and the
 *     brand's `currentGoal`, which brand-service deliberately still serves.
 *   - `goalForFunnel` derives the goal token FROM the funnel, for consumers still reading a goal
 *     off our campaign rows. It is a legacy alias — lossy by construction, since both meeting
 *     funnels name one goal — and that is exactly why nothing here reads it back.
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

/**
 * Which funnel a RETIRED optimization goal named.
 *
 * Only two things still speak goals: campaign rows written before funnels existed, and the brand's
 * `currentGoal`, which brand-service keeps serving on `/internal/brands/:id/runtime-context` for
 * every brand with no per-funnel budget. This map is how either is read as a funnel — once, to
 * WRITE the funnel onto the row. Nothing reads a goal to find a funnel afterwards.
 *
 * `meetingBooked` resolves to the CONVERSATION funnel, not the website one, and that is an owner
 * decision (2026-08-02): these campaigns are cold email, so the chain that actually ran is
 * reply → meeting. brand-service splits the same goal on whether the brand set a click
 * destination; here the campaign itself is the evidence and it is unambiguous.
 *
 * Every accepted spelling brand-service still takes on write is listed, because a stored row may
 * carry any of them.
 *
 * A goal that names no single funnel is ABSENT on purpose and resolves to null:
 *   - `combinedSales` spans several funnels at once,
 *   - `websiteVisit`, `positiveReply`, `whatsappConversation` stop short of a paid client.
 * Those campaigns keep a NULL funnel. Inventing one would state a chain the customer never
 * declared, and the funnel is a stored fact, not a guess.
 */
const FUNNEL_BY_GOAL: Readonly<Record<string, SalesFunnelKey>> = Object.freeze({
  // Form Magnet — website visit → form filled → paid client.
  formSubmission: "form_magnet",
  form_submissions: "form_magnet",

  // Sales Meeting from Conversation — positive reply → meeting booked → attended → paid client.
  meetingBooked: "sales_meetings_from_conversation",
  booked_meetings: "sales_meetings_from_conversation",
  sales_meetings: "sales_meetings_from_conversation",

  // Website Purchases — website visit → signup → paid client. `signup` is the goal
  // brand-service's catalogue put on this funnel; `websitePurchase` (and its older spellings) is
  // what the same chain is called on screen. Both name this one funnel.
  signup: "website_purchases",
  signups: "website_purchases",
  websitePurchase: "website_purchases",
  website_purchase: "website_purchases",
  purchase: "website_purchases",
  sales: "website_purchases",
});

/**
 * The funnel this goal runs, or null when the goal names no single funnel.
 *
 * Never guesses: an unknown or absent goal returns null and the campaign keeps a NULL funnel.
 */
export function funnelForGoal(goal: string | null | undefined): SalesFunnelKey | null {
  if (!goal) return null;
  return FUNNEL_BY_GOAL[goal] ?? null;
}

/** Every goal spelling that determines a funnel — the SQL backfill enumerates the same list. */
export function goalsWithAFunnel(): string[] {
  return Object.keys(FUNNEL_BY_GOAL);
}

/**
 * The goal token a funnel corresponds to — a LEGACY ALIAS, kept so a consumer still reading
 * `campaigns.goal` keeps working until it migrates to the funnel.
 *
 * Byte-equal with what brand-service's catalogue emitted per funnel before the retirement, so the
 * value on a campaign row does not move under a consumer as part of this ship.
 *
 * LOSSY, deliberately: both meeting funnels answer `meetingBooked`, which is exactly why the goal
 * is being retired. Nothing in this service reads the value back to decide anything — the funnel
 * is on the row. It is also what keeps a funnel campaign out of goal arbitration: a campaign that
 * states its own goal is never arbitrated, and the customer's funding is what decides which funnel
 * runs.
 */
const GOAL_BY_FUNNEL: Readonly<Record<SalesFunnelKey, string>> = Object.freeze({
  sales_meetings_from_conversation: "meetingBooked",
  sales_meetings_from_website: "meetingBooked",
  website_purchases: "signup",
  form_magnet: "formSubmission",
});

export function goalForFunnel(funnelKey: string | null | undefined): string | null {
  const canonical = toFunnelKey(funnelKey);
  return canonical ? GOAL_BY_FUNNEL[canonical] : null;
}
