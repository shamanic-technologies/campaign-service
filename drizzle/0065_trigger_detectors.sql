-- GENERIC TRIGGER DETECTORS (owner 2026-10-09): `delay` and `poll` trigger types declared as data at
-- features-service are detected here. New table + one new index only; nothing existing is touched.
-- Boot-safe (IF NOT EXISTS everywhere).
CREATE TABLE IF NOT EXISTS "trigger_poll_cursors" (
  "id" text PRIMARY KEY NOT NULL,
  "trigger_id" text NOT NULL,
  "org_id" text NOT NULL,
  "brand_id" text NOT NULL,
  "offer_id" text NOT NULL,
  "baseline_at" timestamp with time zone,
  "last_polled_at" timestamp with time zone,
  "next_poll_at" timestamp with time zone NOT NULL,
  "last_outcome" text,
  "last_error" text,
  "polls" integer DEFAULT 0 NOT NULL,
  "items_fired" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_trigger_poll_cursors_scope" ON "trigger_poll_cursors" ("trigger_id", "org_id", "brand_id", "offer_id");
CREATE INDEX IF NOT EXISTS "idx_trigger_events_lead" ON "trigger_events" ("org_id", "brand_id", "offer_id", "lead_id", "occurred_at") WHERE "lead_id" is not null;
