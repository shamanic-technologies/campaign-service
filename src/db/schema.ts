import { pgTable, text, timestamp, index, date, decimal, integer } from "drizzle-orm/pg-core";

// Campaigns table
export const campaigns = pgTable(
  "campaigns",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    orgId: text("org_id").notNull(),
    createdByUserId: text("created_by_user_id"),

    name: text("name").notNull(),

    // Workflow name — resolved by workflow-service, passed at campaign creation
    workflowName: text("workflow_name").notNull(),

    // Brand URL - used to identify which brand this campaign promotes
    brandUrl: text("brand_url"),

    // Brand ID from brand-service (set by worker after brand-upsert)
    // Nullable initially, populated when brand is created/found in brand-service
    brandId: text("brand_id"),

    // Free-text target audience description (e.g. "CEOs at SaaS startups in the US")
    targetAudience: text("target_audience"),

    // What the user wants to achieve (e.g. "Book sales demos", "Get press coverage")
    targetOutcome: text("target_outcome"),

    // What the target audience gains from responding (e.g. "Access to enterprise analytics at startup pricing")
    valueForTarget: text("value_for_target"),

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
  ]
);

export type Campaign = typeof campaigns.$inferSelect;
export type NewCampaign = typeof campaigns.$inferInsert;
