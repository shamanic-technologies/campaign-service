import { sql } from "drizzle-orm";
import { pgTable, text, timestamp, index, uniqueIndex, date, decimal, integer, jsonb, boolean, primaryKey } from "drizzle-orm/pg-core";

// Campaigns table
export const campaigns = pgTable(
  "campaigns",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    orgId: text("org_id").notNull(),
    createdByUserId: text("created_by_user_id"),

    // The run ID that initiated the campaign (from x-run-id at creation time)
    parentRunId: text("parent_run_id"),

    name: text("name").notNull(),

    // Workflow slug — resolved by workflow-service, passed at campaign creation
    workflowSlug: text("workflow_slug").notNull(),

    // Brand IDs from brand-service (CSV in x-brand-id header, stored as array)
    // Nullable initially, populated when brands are created/found in brand-service
    brandIds: text("brand_ids").array(),

    // The brand this campaign works — HALF THE IDENTITY KEY, and the reason it exists beside the
    // array above: no unique index can span a `text[]`, so Postgres could not police
    // one-campaign-per-(org, brand, funnel, channel) at all while the brand was only ever an array.
    // The reality is one brand per campaign; this states it. Written once at creation from
    // brandIds[0] (see campaignIdentityColumns) — the historical multi-brand rows are all stopped.
    brandId: text("brand_id"),

    // The medium this campaign acquires through — the OTHER half of the key that was not a stored
    // fact: consumers derived it from the workflow slug, i.e. from the one attribute that
    // legitimately changes under a campaign. Derived ONCE from the feature at creation
    // (`acquisitionChannelForFeature`) and read here afterwards; nothing re-derives it.
    acquisitionChannel: text("acquisition_channel"),

    // Feature slug — references features-service catalogue (e.g. "sales-cold-email-outreach")
    featureSlug: text("feature_slug"),

    // Feature inputs — dynamic key/value inputs declared by the feature
    featureInputs: jsonb("feature_inputs"),

    // Optional real attribution for persona/profile-scoped campaigns.
    // Null means explicitly unattributed; never infer or distribute by hash.
    activeGoalId: text("active_goal_id"),
    brandProfileId: text("brand_profile_id"),
    audienceId: text("audience_id"),

    // === Per-campaign OWN configuration (Campaign v2) ===
    // A campaign owns each of these independently of its brand and of sibling campaigns.
    // Every column is nullable and NULL means "inherit the brand": a campaign that sets
    // nothing keeps the pre-v2 behavior (brand-level goal / audiences / services /
    // destination), so no existing or running campaign is disrupted.

    // The campaign's OWN optimization goal — an OPAQUE string, no enum. Drives THIS
    // campaign's runtime pacing / candidate-selection (workflow greedy pick at the trigger +
    // audience Thompson at /start-run): when set it overrides the brand's currentGoal for
    // this campaign only. NULL → pace on the brand goal.
    //
    // Deliberately unconstrained here: brand-service owns which goals a brand authorizes and
    // features-service owns the spelling (and fails loud on one it cannot resolve). The
    // previous three-value enum on the API schema capped a campaign to a subset of the goals
    // the fleet supports while the brand-goal path — which never passes through this column —
    // already carried the wider set. Non-empty is enforced at the API boundary: an absent
    // goal means "default" downstream, so an empty string would be a silent default.
    //
    // Distinct from activeGoalId (an opaque attribution id threaded as x-active-goal-id and
    // never consumed for pacing).
    goal: text("goal"),

    // The SUBSET (one OR more) of the brand's audiences this campaign targets
    // (human-service saved-filter-set UUIDs == audience.id). NULL/absent → target the
    // brand's full active audience set (inherit). When set, the per-run audience bandit is
    // HARD-restricted to this subset — the campaign never contacts an audience outside it,
    // regardless of workflow-conditioning. Replaces the singular audienceId for targeting.
    audienceIds: text("audience_ids").array(),

    // The services this campaign offers. NULL → inherit the brand's services. Exposed to the
    // sending runtime on /start-run so downstream nodes read authoritative per-campaign
    // config rather than the brand default.
    servicesOffered: text("services_offered").array(),

    // The campaign's OWN click-destination URL. NULL → inherit the brand's. Exposed on
    // /start-run for the sending runtime.
    clickDestinationUrl: text("click_destination_url"),

    // Legacy campaign budget limits. Daily spend control is brand-level via billing-service.
    maxBudgetDailyUsd: decimal("max_budget_daily_usd", { precision: 10, scale: 2 }),
    maxBudgetWeeklyUsd: decimal("max_budget_weekly_usd", { precision: 10, scale: 2 }),
    maxBudgetMonthlyUsd: decimal("max_budget_monthly_usd", { precision: 10, scale: 2 }),
    maxBudgetTotalUsd: decimal("max_budget_total_usd", { precision: 10, scale: 2 }),

    // Per-CAMPAIGN daily budget for the sales feature (cents). This is the campaign's OWN
    // daily spend ceiling, paced against the campaign's OWN committed spend today — so two
    // campaigns under one brand pace independently. NULL = no own budget → the sales gate
    // falls back to the brand daily budget (billing-service brand_daily_budgets), keeping
    // behaviour identical to the pre-per-campaign world. Cents (not USD) to compare directly
    // against runs-service *CostInUsdCents and billing's brand dailyBudgetCents — no ×100.
    dailyBudgetCents: integer("daily_budget_cents"),

    // The sales funnel this campaign works — the ONE word for what this campaign sells, in
    // brand-service's canonical vocabulary (sales_meetings_from_conversation |
    // sales_meetings_from_website | website_purchases | form_magnet). A consumer reads what a
    // campaign buys HERE and needs no translation table: `goal` above cannot tell a meeting won
    // from a reply apart from one won on the website, and that is why the goal set was retired.
    //
    // A customer funds each of a brand's funnels separately (billing-service
    // brand_funnel_budgets), so a funded funnel gets its OWN campaign: the cost ledger is already
    // keyed on campaignId, which makes "how much did this funnel spend today" answerable without
    // a new attribution dimension.
    //
    // NULL = not funnel-scoped. Every campaign that predates per-funnel funding keeps NULL and
    // paces exactly as before (own dailyBudgetCents, else the brand-level daily budget — which
    // billing still answers as the SUM of the per-funnel ceilings). A brand that never declares
    // per-funnel ceilings never grows funnel campaigns.
    //
    // A funnel campaign also carries that funnel's goal in `goal` — a legacy alias of the same
    // statement, for consumers that have not migrated — which is why it is never goal-arbitrated:
    // the customer's funding decided which funnel runs, so features-service is asked only for the
    // best workflow and the audience evidence.
    //
    // Values are canonical past migration 0043; `toFunnelKey` in sales-funnel-vocabulary.ts still
    // resolves the pre-rename spellings, because billing-service emits them to this day.
    funnelKey: text("funnel_key"),

    // The OFFER this campaign sells — a brand-service offer UUID.
    //
    // An offer is one distinct thing a brand sells: its value proposition plus the sales funnels
    // it sells through. A brand selling a $200 self-serve plan and a $20k enterprise contract has
    // two offers, and without this column its two campaigns — same funnel, same channel — are the
    // same row to every reader, in the data, in the money attribution and on the customer's
    // screen. It is the dimension that separates them.
    //
    // brand-service OWNS the entity; this column carries its id and nothing else. No offer
    // vocabulary, table or enum exists here and none is to be introduced — the same posture this
    // service holds for the goal and the acquisition channel.
    //
    // NEVER derived. A funnel does not name an offer (several offers legitimately sell through
    // one funnel, which is the entire reason this dimension exists), and neither does the goal or
    // the workflow. It is stated by the creator or it is NULL.
    //
    // NULL = the campaign states no offer, and behaves exactly as it did before this column
    // existed: nothing reads it for pacing, funding, selection or identity. Stating an offer is
    // optional on create while callers migrate; it becomes required in a later wave, and only
    // then, because requiring it now would break every live caller.
    offerId: text("offer_id"),

    // Volume limit (optional, total leads across all runs)
    maxLeads: integer("max_leads"),

    // Scheduling
    startDate: date("start_date"),
    endDate: date("end_date"),

    // Status: 'ongoing' or 'stopped'
    status: text("status").notNull().default("ongoing"),

    // WHY this campaign stopped — see STOP_REASONS in src/lib/stop-reason.ts for the vocabulary.
    //
    // Load-bearing for exactly one decision: a campaign that stopped because it ran out of people
    // to contact comes back on its own once the brand has somebody to contact again, and a
    // campaign stopped for ANY other reason never does. Without a recorded reason those two are
    // the same row, so "resume the exhausted ones" would also resurrect the ones a person
    // switched off on purpose.
    //
    // NULL = not recorded (every row stopped before migration 0046, and every ongoing row). Never
    // resumed: a stop nobody wrote a reason for is not evidence of exhaustion. Cleared back to
    // NULL whenever a campaign becomes ongoing again, so the column always describes the CURRENT
    // stop, never a previous one.
    stopReason: text("stop_reason"),

    nextRunAt: timestamp("next_run_at", { withTimezone: true }),

    // Notifications (legacy - to be replaced by reportingFrequency)
    notifyFrequency: text("notify_frequency"),  // 'daily', 'weekly', 'per_reply'
    notifyChannel: text("notify_channel"),      // 'email', 'webhook'
    notifyDestination: text("notify_destination"),  // email address or webhook URL

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_campaigns_org").on(table.orgId),
    uniqueIndex("uniq_campaigns_org_name").on(table.orgId, table.name),
    index("idx_campaigns_org_feature_funnel").on(table.orgId, table.featureSlug, table.funnelKey),
    // Serves "what did this offer buy" — the per-offer attribution read the column exists for.
    // Partial: a campaign that states no offer is not part of any offer's answer.
    index("idx_campaigns_org_offer")
      .on(table.orgId, table.offerId)
      .where(sql`${table.offerId} is not null`),
    // Serves the resume sweep's only read — the stopped campaigns that ran out of people to
    // contact. Partial so it covers that narrow population and not the whole stopped history.
    index("idx_campaigns_resumable")
      .on(table.stopReason, table.updatedAt)
      .where(sql`${table.status} = 'stopped' and ${table.stopReason} is not null`),
    // A campaign is unique on (org, brand, sales funnel, acquisition channel) — see migration 0044.
    // Scoped to `ongoing`: a stopped row is history, not a competitor for the brand's turn.
    // `coalesce(funnel_key, '')` is load-bearing — Postgres treats NULLs as distinct, so without it
    // a brand could grow unlimited funnel-less campaigns on one channel.
    uniqueIndex("uniq_campaigns_org_brand_funnel_channel")
      .on(table.orgId, table.brandId, sql`coalesce(${table.funnelKey}, '')`, table.acquisitionChannel)
      .where(
        sql`${table.status} = 'ongoing' and ${table.brandId} is not null and ${table.acquisitionChannel} is not null`,
      ),
  ]
);

export type Campaign = typeof campaigns.$inferSelect;
export type NewCampaign = typeof campaigns.$inferInsert;

// Brand pause transition log — a CLOSED record of the flag era.
//
// One immutable row per flip of the old `brand_pause.paused` boolean. Both that table and the
// PATCH route that wrote it are GONE (migration 0049): a brand is held by what the customer funds,
// so there is no flag left to flip and no new row can ever be written here. The table is kept
// because it is a true record of what happened to these brands and the Customer Success health
// board reads it via GET /brands/:brandId/pause-history — the alternative is losing the history to
// answer nothing. paused = the NEW state after that flip.
export const brandPauseTransitions = pgTable(
  "brand_pause_transitions",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    brandId: text("brand_id").notNull(),
    orgId: text("org_id").notNull(),
    paused: boolean("paused").notNull(),
    transitionedAt: timestamp("transitioned_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Serves the per-(org, brand) ordered history read directly.
    index("idx_brand_pause_transitions_org_brand_at").on(table.orgId, table.brandId, table.transitionedAt),
  ]
);

export type BrandPauseTransition = typeof brandPauseTransitions.$inferSelect;
export type NewBrandPauseTransition = typeof brandPauseTransitions.$inferInsert;

// Per-(campaign, audience) exhaustion marks. A run narrows to ONE bandit-picked audience;
// when that audience's serve returns no leads the DAG sends stopCampaign=true — which is
// AUDIENCE-scoped, not campaign-scoped. We record the audience here so the bandit skips it,
// and only auto-stop the campaign when EVERY targeted audience is exhausted. The mark expires
// after a 24h TTL (getFreshExhaustedAudienceIds) so audiences are re-probed daily — Apollo can
// add new matching leads to an audience over time, so "exhausted" is never permanent.
export const campaignAudienceExhaustion = pgTable(
  "campaign_audience_exhaustion",
  {
    campaignId: text("campaign_id").notNull(),
    audienceId: text("audience_id").notNull(),
    exhaustedAt: timestamp("exhausted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.campaignId, table.audienceId] }),
    // Serves the per-campaign fresh-within-TTL read directly.
    index("idx_cae_campaign_exhausted_at").on(table.campaignId, table.exhaustedAt),
  ]
);

export type CampaignAudienceExhaustion = typeof campaignAudienceExhaustion.$inferSelect;
export type NewCampaignAudienceExhaustion = typeof campaignAudienceExhaustion.$inferInsert;

// The funnel a campaign runs is a stored fact, derived from what the campaign itself said. When
// what it said names no single funnel — a brand selling through several under one `combinedSales`
// goal — the funnel stays NULL rather than being guessed, and only the OWNER can answer it.
//
// This table is the record of those answers: one row per campaign an owner decision wrote, holding
// the value it replaced. It is what makes such a write auditable and reversible — an operator reads
// back exactly which rows a decision touched and can restore `previous_funnel_key` — and what makes
// re-running one a no-op. Nothing in the runtime reads it: the funnel itself lives on the campaign
// row, as it does for every other campaign.
export const campaignFunnelOwnerDecisions = pgTable(
  "campaign_funnel_owner_decisions",
  {
    campaignId: text("campaign_id").primaryKey(),
    orgId: text("org_id").notNull(),
    brandId: text("brand_id"),
    previousFunnelKey: text("previous_funnel_key"),
    funnelKey: text("funnel_key").notNull(),
    decidedBy: text("decided_by").notNull(),
    decidedOn: date("decided_on").notNull(),
    // The migration (or script) that applied the decision — the handle an operator undoes by.
    source: text("source").notNull(),
    appliedAt: timestamp("applied_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("idx_cfod_source").on(table.source)]
);

export type CampaignFunnelOwnerDecision = typeof campaignFunnelOwnerDecisions.$inferSelect;
export type NewCampaignFunnelOwnerDecision = typeof campaignFunnelOwnerDecisions.$inferInsert;
