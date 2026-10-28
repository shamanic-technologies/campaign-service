-- FACTORY-P1-CAMPAIGN-TARGET-BRIEF (2026-10-28): a funnel campaign states the outcome it targets and its brief.
-- Purely additive; filled for existing rows by the boot backfill (lib/sales-funnel-target.ts). Idempotent, boot-safe.
ALTER TABLE "sales_funnel_campaigns" ADD COLUMN IF NOT EXISTS "target" text;
ALTER TABLE "sales_funnel_campaigns" ADD COLUMN IF NOT EXISTS "brief" text;
ALTER TABLE "sales_funnel_campaigns" ADD COLUMN IF NOT EXISTS "brief_updated_at" timestamp with time zone;
ALTER TABLE "sales_funnel_campaigns" ADD COLUMN IF NOT EXISTS "brief_updated_by_user_id" text;
ALTER TABLE "sales_funnel_campaigns" ADD COLUMN IF NOT EXISTS "mode" text;
ALTER TABLE "sales_funnel_campaigns" ADD COLUMN IF NOT EXISTS "trigger_id" text;
