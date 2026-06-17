-- Preserve real persona/profile attribution for campaign run lifecycle.
-- Null means explicitly unattributed; no backfill or inferred persona/profile.
ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "active_goal_id" text;
ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "brand_profile_id" text;
ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "customer_persona_id" text;
ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "customer_profile_id" text;
