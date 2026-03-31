import { pgTable, text, timestamp, index, uniqueIndex, date, decimal, integer, jsonb } from "drizzle-orm/pg-core";

// Campaigns table
export const campaigns = pgTable(
  "campaigns",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    orgId: text("org_id").notNull(),
    createdByUserId: text("created_by_user_id"),

    name: text("name").notNull(),

    // Workflow slug — resolved by workflow-service, passed at campaign creation
    workflowSlug: text("workflow_slug").notNull(),

    // Brand URL - used to identify which brand this campaign promotes
    brandUrl: text("brand_url"),

    // Brand IDs from brand-service (CSV in x-brand-id header, stored as array)
    // Nullable initially, populated when brands are created/found in brand-service
    brandIds: text("brand_ids").array(),

    // Dynasty slugs — stable lineage identifiers (e.g. "cold-email", "sales-cold-email")
    workflowDynastySlug: text("workflow_dynasty_slug"),
    featureDynastySlug: text("feature_dynasty_slug"),

    // Feature slug — references features-service catalogue (e.g. "sales-cold-email-v1")
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
    toResumeAt: timestamp("to_resume_at", { withTimezone: true }),

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
