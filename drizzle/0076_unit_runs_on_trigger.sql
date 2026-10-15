-- FUNNEL-HEAD-TRIGGER-1015: a sales funnel may be HEADED by a trigger (features-service `trigger:<id>+<legs>`), reusing
-- proactive pipes. Such a unit runs ONLY when that trigger fires, never on its own cadence (lib/sales-funnel-head-trigger.ts).
-- Written at birth from the funnel read; NULL on every existing row (no live campaign changes). Idempotent, boot-safe.
ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "runs_on_trigger_id" text;
