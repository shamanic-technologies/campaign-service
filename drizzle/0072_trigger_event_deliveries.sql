-- One row per RUN dispatched for a trigger occurrence that carries something (a person, an item):
-- lib/trigger-deliveries.ts. `/end-run` settles the row by the run id workflow-service answered on
-- `/execute`; a run that did not complete its work puts the occurrence back for that campaign (bounded),
-- so a downstream failure never loses what the occurrence carried. No org column: the event row owns the
-- org/brand (moved by brand transfer), this table only points at it. Idempotent, boot-safe.
CREATE TABLE IF NOT EXISTS "trigger_event_deliveries" (
  "id" text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "event_id" text NOT NULL,
  "campaign_id" text NOT NULL,
  "run_id" text NOT NULL,
  "status" text NOT NULL,
  "dispatched_at" timestamptz NOT NULL DEFAULT now(),
  "ended_at" timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_trigger_event_deliveries_run" ON "trigger_event_deliveries" ("run_id");
CREATE INDEX IF NOT EXISTS "idx_trigger_event_deliveries_event" ON "trigger_event_deliveries" ("event_id", "campaign_id");
