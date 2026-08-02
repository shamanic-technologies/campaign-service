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

    // Volume limit (optional, total leads across all runs)
    maxLeads: integer("max_leads"),

    // Scheduling
    startDate: date("start_date"),
    endDate: date("end_date"),

    // Status: 'ongoing' or 'stopped'
    status: text("status").notNull().default("ongoing"),
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
  ]
);

export type Campaign = typeof campaigns.$inferSelect;
export type NewCampaign = typeof campaigns.$inferInsert;

// Brand pause flag — ONE mutable row per brand (upsert in place).
//
// When paused=true, the campaign-service scheduler holds EVERY ongoing campaign whose
// brandIds includes this brand (same org): the campaign stays 'ongoing' but is not claimed
// or re-fired. Un-pausing (paused=false) lets the next scheduler tick pick those campaigns
// up again with zero re-launch. Read/written via GET/PATCH /brands/:brandId/pause and
// joined locally by the scheduler + gate-check (no per-tick HTTP). Mirrors the single-scalar
// per-brand store pattern (billing-service brand_daily_budgets).
export const brandPause = pgTable(
  "brand_pause",
  {
    brandId: text("brand_id").primaryKey(),
    orgId: text("org_id").notNull(),
    paused: boolean("paused").notNull().default(false),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_brand_pause_org").on(table.orgId),
  ]
);

export type BrandPause = typeof brandPause.$inferSelect;
export type NewBrandPause = typeof brandPause.$inferInsert;

// Brand pause transition log — APPEND-ONLY history of pause on/off flips per (org, brand).
//
// The brand_pause table above holds only the CURRENT scalar state (upsert-in-place). It cannot
// answer "when was this brand paused / resumed?" for the Customer Success health board. This
// table records one immutable row per state CHANGE: when PATCH /brands/:brandId/pause flips the
// paused boolean, brands.ts inserts a transition here in the same transaction. A no-op PATCH
// (same value) writes nothing. Forward-only — pre-existing flips before this table shipped were
// never recorded and are not backfilled. Read via GET /brands/:brandId/pause-history
// (features-service customer-health board). paused = the NEW state after the flip.
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
