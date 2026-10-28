-- TRIGGER-SILENCE-NO-EMAIL-1028: the trigger silence EMAIL is gone; each watched trigger type gets a stored daily
-- verdict for dashboard v2 Monitoring. The 24h email latch is dropped with the email. Idempotent, boot-safe.
CREATE TABLE IF NOT EXISTS "trigger_health_days" (
  "trigger_id" text NOT NULL,
  "day" text NOT NULL,
  "label" text NOT NULL,
  "fired_by" text NOT NULL,
  "status" text NOT NULL,
  "reason" text,
  "sentence" text NOT NULL,
  "live_campaigns" integer NOT NULL,
  "facts_without_event" integer,
  "missing" jsonb,
  "checked_at" timestamp with time zone NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_trigger_health_days" ON "trigger_health_days" ("trigger_id", "day");
ALTER TABLE "trigger_silence_watch" DROP COLUMN IF EXISTS "last_alerted_at";
