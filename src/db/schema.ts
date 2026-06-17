import { pgTable, text, timestamp, index, uniqueIndex, date, decimal, integer, jsonb, boolean } from "drizzle-orm/pg-core";

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

    // Budget limits per campaign (at least one required)
    maxBudgetDailyUsd: decimal("max_budget_daily_usd", { precision: 10, scale: 2 }),
    maxBudgetWeeklyUsd: decimal("max_budget_weekly_usd", { precision: 10, scale: 2 }),
    maxBudgetMonthlyUsd: decimal("max_budget_monthly_usd", { precision: 10, scale: 2 }),
    maxBudgetTotalUsd: decimal("max_budget_total_usd", { precision: 10, scale: 2 }),

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
