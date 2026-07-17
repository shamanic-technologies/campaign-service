-- Per-campaign daily budget for the sales feature (cents), enabling multiple campaigns per
-- brand to pace independently. NULL = no own budget → the sales gate falls back to the brand
-- daily budget (billing-service), so every existing running campaign keeps the brand's CURRENT
-- number as its effective ceiling with ZERO backfill (no stale value trusted, no billing copy).
-- Idempotent + boot-safe: only adds when the column is absent.
ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "daily_budget_cents" integer;
