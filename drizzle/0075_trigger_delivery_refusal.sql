-- A run states what happened to what its occurrence carried (`/end-run` `delivery`): a sender refusal is final,
-- kept on the delivery row with the sender's code and sentence (lib/trigger-deliveries.ts). Idempotent, boot-safe.
ALTER TABLE "trigger_event_deliveries" ADD COLUMN IF NOT EXISTS "refusal_code" text;
ALTER TABLE "trigger_event_deliveries" ADD COLUMN IF NOT EXISTS "refusal_reason" text;
