-- Brand pause flag: ONE mutable row per brand. paused=true holds every ongoing campaign
-- targeting the brand at the scheduler (campaign stays 'ongoing', is not claimed/fired).
-- Idempotent (IF NOT EXISTS) so a partial-apply replay is safe.
CREATE TABLE IF NOT EXISTS "brand_pause" (
	"brand_id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_brand_pause_org" ON "brand_pause" USING btree ("org_id");
