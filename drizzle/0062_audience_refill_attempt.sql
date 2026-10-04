-- One automatic audience refill attempt per exhaustion EPISODE (refill-before-exhausted-email).
--
-- An episode is a `campaign_audience_availability` period with has_audience = false: it opens when
-- /end-run first finds nobody left to contact and closes when the campaign serves somebody again.
-- Every /end-run inside the episode observes the same exhaustion, so the attempt is claimed here,
-- atomically (UPDATE ... WHERE refill_attempted_at IS NULL), and never repeated within the period.
-- NULL = not attempted (every pre-existing period, and every has_audience = true period).
ALTER TABLE "campaign_audience_availability" ADD COLUMN IF NOT EXISTS "refill_attempted_at" timestamp with time zone;
