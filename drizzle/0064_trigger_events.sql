-- THE TRIGGER EVENTS (owner 2026-10-09): one row per occurrence of a trigger and what it did.
-- New tables only; nothing existing is touched. Boot-safe (IF NOT EXISTS everywhere).
CREATE TABLE IF NOT EXISTS "trigger_events" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "brand_id" text NOT NULL,
  "offer_id" text NOT NULL,
  "trigger_id" text,
  "step" text,
  "lead_id" text,
  "requested_by_campaign_id" text,
  "idempotency_key" text,
  "recorded_via" text NOT NULL,
  "occurred_at" timestamp with time zone NOT NULL,
  "due_at" timestamp with time zone NOT NULL,
  "status" text NOT NULL,
  "outcome" text,
  "skip_reason" text,
  "ran_campaign_ids" text[],
  "detail" jsonb,
  "performed_by_caller" boolean DEFAULT false NOT NULL,
  "claimed_at" timestamp with time zone,
  "attempts" integer DEFAULT 0 NOT NULL,
  "last_error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "processed_at" timestamp with time zone
);
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_trigger_events_idempotency" ON "trigger_events" ("org_id", "idempotency_key") WHERE "idempotency_key" is not null;
CREATE INDEX IF NOT EXISTS "idx_trigger_events_due" ON "trigger_events" ("due_at") WHERE "status" <> 'done';
CREATE INDEX IF NOT EXISTS "idx_trigger_events_offer" ON "trigger_events" ("org_id", "brand_id", "offer_id", "occurred_at");
CREATE INDEX IF NOT EXISTS "idx_trigger_events_type" ON "trigger_events" ("trigger_id", "occurred_at");

CREATE TABLE IF NOT EXISTS "trigger_silence_watch" (
  "trigger_id" text PRIMARY KEY NOT NULL,
  "watched_since" timestamp with time zone DEFAULT now() NOT NULL,
  "last_alerted_at" timestamp with time zone
);
