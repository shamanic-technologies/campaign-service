-- A campaign that fails every run must back off and be noticed (campaign-service#407).
--
-- Four additive columns on `campaigns`, written only by `/end-run` (src/lib/run-failure-backoff.ts):
--   consecutive_run_failures — failed runs in a row since the last success (0 = healthy)
--   failing_since            — when the current streak's first failure landed (NULL = healthy)
--   last_run_failure_at      — the latest failure (a streak whose last failure is older than
--                              FAILURE_STREAK_STALE_MS is not continued: it starts over)
--   failure_alerted_at       — the last staff alert; survives a reset so a campaign flapping
--                              between failure and success alerts at most once per cooldown
-- Nothing reads these to change a STATUS: a system condition never stops a campaign.
ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "consecutive_run_failures" integer NOT NULL DEFAULT 0;
ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "failing_since" timestamp with time zone;
ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "last_run_failure_at" timestamp with time zone;
ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "failure_alerted_at" timestamp with time zone;
