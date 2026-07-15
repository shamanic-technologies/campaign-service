-- Brand pause transition log: APPEND-ONLY history of pause on/off flips per (org, brand).
-- brand_pause holds only the current scalar state; this records one immutable row per state
-- CHANGE (paused = the new state after the flip), written by PATCH /brands/:brandId/pause in the
-- same transaction. Feeds the Customer Success health board pause timeline via
-- GET /brands/:brandId/pause-history. Forward-only (no backfill of pre-ship flips).
-- Idempotent (IF NOT EXISTS) so a partial-apply replay is safe.
CREATE TABLE IF NOT EXISTS "brand_pause_transitions" (
	"id" text PRIMARY KEY NOT NULL,
	"brand_id" text NOT NULL,
	"org_id" text NOT NULL,
	"paused" boolean NOT NULL,
	"transitioned_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_brand_pause_transitions_org_brand_at" ON "brand_pause_transitions" USING btree ("org_id","brand_id","transitioned_at");
