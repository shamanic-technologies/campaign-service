-- The OFFER a campaign sells — a brand-service offer UUID.
--
-- A new granularity sits between the brand and the campaign: Org > Brand > OFFER > Campaign. An
-- offer is one distinct thing a brand sells — its value proposition plus the sales funnels it
-- sells through — so a brand selling a $200 self-serve plan and a $20k enterprise contract has
-- two. A campaign sells exactly one, which makes a campaign (offer x sales funnel x acquisition
-- channel); it already states the funnel (migration 0041) and the channel (0044), and this is the
-- missing third word. Without it, two campaigns of one brand on the same funnel through the same
-- channel for two DIFFERENT offers are the same row to every reader.
--
-- brand-service owns the entity; this column carries its id and nothing else. No offer vocabulary
-- is introduced here, exactly as none is for the goal or the channel.
--
-- NOTHING IS BACKFILLED BY THIS MIGRATION, and that is deliberate: resolving a campaign's brand to
-- its offer is a brand-service READ, and SQL cannot make one. The backfill is
-- scripts/backfill-campaign-offer.ts, which resolves each brand to its single offer, writes only
-- rows still NULL, and leaves alone (and reports) any brand that does not resolve to exactly one.
--
-- NULL = the campaign states no offer and behaves exactly as it did before this column existed:
-- no pacing, funding, selection, identity or uniqueness decision reads it. Stating one is optional
-- on create while callers migrate.
--
-- Idempotent (IF NOT EXISTS on both statements) so a partial-apply replay is safe.
ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "offer_id" text;

-- Serves "what did this offer buy" — the per-offer attribution read the column exists for.
-- Partial: a campaign that states no offer is not part of any offer's answer.
CREATE INDEX IF NOT EXISTS "idx_campaigns_org_offer"
  ON "campaigns" USING btree ("org_id", "offer_id")
  WHERE "offer_id" IS NOT NULL;
