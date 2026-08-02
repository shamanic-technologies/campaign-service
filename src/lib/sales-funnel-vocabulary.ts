/**
 * Which sales funnel a campaign's optimization goal means.
 *
 * A campaign used to say what it was for in the GOAL vocabulary ("form submissions", "booked
 * meeting", "website purchase"). brand-service now speaks FUNNELS — one named chain from the
 * first signal outreach can buy down to a paid client — and a campaign states the funnel it
 * runs on its own row (`campaigns.funnel_key`). This map is the one place the old word is read
 * as the new one, and it exists to REWRITE stored rows once, not to translate on read: after
 * the backfill, every determinable campaign carries its funnel and no consumer has to infer it.
 *
 * The three mappings are brand-service's own catalogue (`salesFunnelCatalogue.ts`), plus one
 * owner decision (2026-08-02): a booked-meeting campaign runs `reply_meeting` ("Sales Meeting
 * from Conversation"), never `visit_meeting`. Both funnels optimize for `meetingBooked`, but
 * these campaigns are cold email — the chain that actually ran is reply → meeting, not a
 * website visit.
 *
 * Every accepted spelling brand-service still takes on write (`goal-vocabulary.ts`
 * LEGACY_OPTIMIZATION_GOALS) is listed, because a stored row may carry any of them.
 *
 * A goal that names no single funnel is ABSENT here on purpose and resolves to null:
 *   - `combinedSales` spans several funnels at once,
 *   - `websiteVisit`, `positiveReply`, `whatsappConversation` stop short of a paid client.
 * Those campaigns keep a NULL funnel. Inventing one would state a chain the customer never
 * declared, and the funnel is a stored fact, not a guess.
 */
const FUNNEL_BY_GOAL: Readonly<Record<string, string>> = Object.freeze({
  // Form Magnet — website visit → form filled → paid client.
  formSubmission: "visit_form",
  form_submissions: "visit_form",

  // Sales Meeting from Conversation — positive reply → meeting booked → attended → paid client.
  meetingBooked: "reply_meeting",
  booked_meetings: "reply_meeting",
  sales_meetings: "reply_meeting",

  // Website Purchase — website visit → signup → paid client. `signup` is the goal
  // brand-service's catalogue puts on this funnel; `websitePurchase` (and its older spellings)
  // is what the same chain is called on screen. Both name this one funnel.
  signup: "visit_signup",
  signups: "visit_signup",
  websitePurchase: "visit_signup",
  website_purchase: "visit_signup",
  purchase: "visit_signup",
  sales: "visit_signup",
});

/**
 * The funnel this goal runs, or null when the goal names no single funnel.
 *
 * Never guesses: an unknown or absent goal returns null and the campaign keeps a NULL funnel.
 */
export function funnelForGoal(goal: string | null | undefined): string | null {
  if (!goal) return null;
  return FUNNEL_BY_GOAL[goal] ?? null;
}

/** Every goal spelling that determines a funnel — the SQL backfill enumerates the same list. */
export function goalsWithAFunnel(): string[] {
  return Object.keys(FUNNEL_BY_GOAL);
}
