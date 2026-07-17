-- Campaign v2: per-campaign OWN config, independent of the brand and sibling campaigns.
-- All columns nullable — NULL means "inherit the brand", so existing/running campaigns
-- keep pre-v2 behavior with zero disruption. Additive + idempotent + boot-safe
-- (ADD COLUMN IF NOT EXISTS), so migrate() can re-run it safely.
--   goal                  — the campaign's own RuntimeGoal; drives its runtime pacing.
--   audience_ids          — the subset of the brand's audiences the campaign targets.
--   services_offered      — the campaign's own services offered.
--   click_destination_url — the campaign's own click-destination URL.
ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "goal" text;
ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "audience_ids" text[];
ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "services_offered" text[];
ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "click_destination_url" text;
