-- REPLAY-CHANNEL-DOWN-1023: a sender refusal that only means "the brand's channel was unavailable" is replayed once
-- the channel is back (lib/channel-down-replay.ts). Jev's verdict and the replay decision live on the delivery row.
-- Idempotent, boot-safe.
ALTER TABLE "trigger_event_deliveries" ADD COLUMN IF NOT EXISTS "channel_down_p" real;
ALTER TABLE "trigger_event_deliveries" ADD COLUMN IF NOT EXISTS "channel_down_judged_at" timestamp with time zone;
ALTER TABLE "trigger_event_deliveries" ADD COLUMN IF NOT EXISTS "replay_state" text;
CREATE INDEX IF NOT EXISTS "idx_trigger_event_deliveries_refused" ON "trigger_event_deliveries" ("ended_at") WHERE "status" = 'refused';
