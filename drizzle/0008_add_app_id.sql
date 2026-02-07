-- Add app_id column to campaigns table
-- References an external app/product entity (not a local FK)
-- Nullable, set when campaign is associated with an app

ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "app_id" uuid;

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_campaigns_app_id" ON "campaigns" ("app_id");
