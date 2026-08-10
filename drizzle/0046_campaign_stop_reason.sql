-- Why a campaign stopped, recorded on the campaign itself.
--
-- A campaign whose every targeted audience ran dry is auto-stopped, and the customer is emailed
-- asking them to extend or add an audience. Nothing closed that loop: the customer did exactly
-- what the email asked and the campaign stayed stopped forever, because nothing anywhere turns a
-- stopped campaign back on. Resuming it needs one thing the row never said — WHY it stopped.
-- Without that, "resume the ones that ran out of people" is indistinguishable from "resume the
-- ones a person deliberately switched off", and the second must never happen.
--
-- Four reasons are written, one per place this service stops a campaign:
--   audience_exhausted  — /end-run, every targeted audience exhausted. The ONLY resumable one.
--   max_leads_reached   — gate-check, the campaign's configured lead cap was reached.
--   manual              — PATCH /campaigns/:id with status=stop. A person's decision; it stays.
--   org_teardown        — DELETE /internal/campaigns/by-org/:orgId. The org is gone.
--
-- NULL means "not recorded" and is NEVER resumed. Every row stopped before this column existed
-- keeps NULL, deliberately: a stop whose reason nobody wrote down is not evidence of exhaustion,
-- and guessing one from a timestamp correlation would resurrect campaigns a person had stopped
-- on purpose. The loop closes forward, for every campaign stopped from here on.

ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "stop_reason" text;

-- Serves the resume sweep's ONLY read: the stopped campaigns that ran out of people to contact.
-- Partial, so it indexes that narrow population and not the 682-row stopped history beside it —
-- the sweep must stay cheap however large the stopped population grows.
CREATE INDEX IF NOT EXISTS "idx_campaigns_resumable"
  ON "campaigns" ("stop_reason", "updated_at")
  WHERE "status" = 'stopped' AND "stop_reason" IS NOT NULL;
