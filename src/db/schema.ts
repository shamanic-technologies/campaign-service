import { pgTable, uuid, text, timestamp, uniqueIndex, index, date, decimal, integer } from "drizzle-orm/pg-core";

// Local users table (maps to Clerk)
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clerkUserId: text("clerk_user_id").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_users_clerk_id").on(table.clerkUserId),
  ]
);

// Local orgs table (maps to Clerk)
export const orgs = pgTable(
  "orgs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clerkOrgId: text("clerk_org_id").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_orgs_clerk_id").on(table.clerkOrgId),
  ]
);

// Campaigns table
export const campaigns = pgTable(
  "campaigns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    createdByUserId: uuid("created_by_user_id")
      .references(() => users.id),  // Optional - MCP calls don't have user context
    
    name: text("name").notNull(),

    // Campaign type — determines which Windmill DAG to execute
    type: text("type").notNull().default("cold-email-outreach"),

    // Brand URL - used to identify which brand this campaign promotes
    brandUrl: text("brand_url"),
    
    // Brand ID from brand-service (set by worker after brand-upsert)
    // Nullable initially, populated when brand is created/found in brand-service
    brandId: uuid("brand_id"),

    // Parent run ID from api-service — root of the cost tree for this campaign's runs
    parentRunId: uuid("parent_run_id"),

    // App ID from external app/product service
    // Nullable, populated when campaign is associated with an app
    appId: text("app_id"),

    // Free-text target audience description (e.g. "CEOs at SaaS startups in the US")
    targetAudience: text("target_audience"),

    // What the user wants to achieve (e.g. "Book sales demos", "Get press coverage")
    targetOutcome: text("target_outcome"),

    // What the target audience gains from responding (e.g. "Access to enterprise analytics at startup pricing")
    valueForTarget: text("value_for_target"),

    // Sales persuasion fields (user-provided, forwarded to brand-service + email-generate)
    urgency: text("urgency"),
    scarcity: text("scarcity"),
    riskReversal: text("risk_reversal"),
    socialProof: text("social_proof"),

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
    
    // Key source: how downstream services resolve API keys ('byok' = org's own keys, 'app' = platform keys)
    keySource: text("key_source").notNull().default("byok"),

    // Status: 'ongoing' or 'stopped'
    status: text("status").notNull().default("ongoing"),
    toResumeAt: timestamp("to_resume_at", { withTimezone: true }),
    
    // Reporting (coming soon - will be required: 'none', 'daily', 'weekly', 'monthly')
    // reportingFrequency: text("reporting_frequency").notNull(),
    
    // Notifications (legacy - to be replaced by reportingFrequency)
    notifyFrequency: text("notify_frequency"),  // 'daily', 'weekly', 'per_reply'
    notifyChannel: text("notify_channel"),      // 'email', 'webhook'
    notifyDestination: text("notify_destination"),  // email address or webhook URL
    
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_campaigns_org").on(table.orgId),
    index("idx_campaigns_app_id").on(table.appId),
  ]
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Org = typeof orgs.$inferSelect;
export type NewOrg = typeof orgs.$inferInsert;
export type Campaign = typeof campaigns.$inferSelect;
export type NewCampaign = typeof campaigns.$inferInsert;
