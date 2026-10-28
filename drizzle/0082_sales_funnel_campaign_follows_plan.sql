-- FACTORY-P1-FOLLOW-PLAN (2026-10-29): a funnel campaign may follow its plan (features-service's factory plan).
-- Purely additive: every existing row stays a fixed funnel (follows_plan false). Idempotent, boot-safe.
ALTER TABLE "sales_funnel_campaigns" ADD COLUMN IF NOT EXISTS "follows_plan" boolean NOT NULL DEFAULT false;
ALTER TABLE "sales_funnel_campaigns" ADD COLUMN IF NOT EXISTS "running_sales_funnel_id" text;
ALTER TABLE "sales_funnel_campaigns" ADD COLUMN IF NOT EXISTS "plan_check" jsonb;
ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "plan_role" text;
CREATE TABLE IF NOT EXISTS "sales_funnel_plan_changes" (
  "id" text PRIMARY KEY,
  "sales_funnel_campaign_id" text NOT NULL,
  "org_id" text NOT NULL,
  "from_sales_funnel_id" text NOT NULL,
  "to_sales_funnel_id" text NOT NULL,
  "plan_computed_at" timestamp with time zone,
  "units" jsonb NOT NULL,
  "applied_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "idx_sales_funnel_plan_changes_campaign" ON "sales_funnel_plan_changes" ("sales_funnel_campaign_id", "applied_at");
CREATE TABLE IF NOT EXISTS "plan_following_days" (
  "day" date PRIMARY KEY,
  "following" integer NOT NULL,
  "red" integer NOT NULL,
  "changes_applied" integer NOT NULL,
  "checked_at" timestamp with time zone NOT NULL
);
