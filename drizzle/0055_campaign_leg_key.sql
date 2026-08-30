-- The single funnel LEG a campaign is bought for — features-service's canonical leg identifier.
--
-- A sales funnel is a chain of steps, and the thing a customer actually BUYS is one of its LEGS:
-- the leg that takes a lead sitting at one step and moves it to the next. A campaign has stated a
-- FUNNEL (migration 0041) and the leg it performs has been derived downstream by intersecting that
-- funnel with the legs its acquisition channel can produce. That derivation stops working the
-- moment the funnel leaves a campaign's identity, because two DIFFERENT legs can land on the SAME
-- step (a booked meeting is reached from a positive reply AND from a website visit), so the step a
-- leg lands on does not identify the leg. Whatever the campaign states has to distinguish them on
-- its own — and this column is that statement.
--
-- features-service OWNS the vocabulary and MINTS the identifier (`lib/funnel-legs.ts`, published on
-- its `GET /public/channels` catalogue as `legs[].legKey`). This column carries that value and
-- nothing else: no leg vocabulary, table, enum or list is introduced here, and the value is never
-- SPLIT back into its parts — the two steps it connects ride BESIDE it on the catalogue, so a
-- consumer that wants them READS them there. Parsing the string is how a second, drifting
-- vocabulary starts.
--
-- A leg that STARTS a funnel (the lead was on no funnel before) carries a plain identifier like
-- every other one. It is the special case in features-service's DATA, never in the vocabulary, so
-- there is nothing to special-case here either.
--
-- NULL = the campaign states no leg and behaves exactly as it did before this column existed:
-- nothing reads it for pacing, funding, provisioning, scheduling, serialization or identity.
-- Stating one is OPTIONAL on create while callers migrate. The sales funnel is NOT removed by this
-- migration and the uniqueness index is NOT widened — a later ship does both, together.
--
-- Idempotent (IF NOT EXISTS on both statements) so a partial-apply replay is safe.
ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "leg_key" text;

-- Serves "what did this leg buy" — the per-leg attribution read the column exists for.
-- Partial: a campaign that states no leg is not part of any leg's answer.
CREATE INDEX IF NOT EXISTS "idx_campaigns_org_leg"
  ON "campaigns" USING btree ("org_id", "leg_key")
  WHERE "leg_key" IS NOT NULL;

-- A campaign bought for one leg is not the campaign bought for another, so the uniqueness that
-- says "at most one live campaign per identity" spans the leg too. Without this a brand working
-- ONE channel for TWO legs cannot hold two live campaigns at all — the second create is read as a
-- restatement of the first — which is precisely the pair the leg exists to tell apart.
--
-- This only ever LOOSENS: `coalesce(leg_key, '')` collapses every row that states no leg onto the
-- same value it had before the column existed, so every campaign alive today keys byte-identically
-- and no existing pair can start colliding. It is the same reason `coalesce(funnel_key, '')` is
-- there — Postgres treats NULLs as distinct, so without the coalesce a brand could grow unlimited
-- leg-less campaigns on one channel.
--
-- The NAME is deliberately left alone: the funnel is still part of this identity, and the ship
-- that removes it from a campaign renames the index along with it.
DROP INDEX IF EXISTS "uniq_campaigns_org_brand_funnel_channel";

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_campaigns_org_brand_funnel_channel"
  ON "campaigns" USING btree (
    "org_id",
    "brand_id",
    coalesce("funnel_key", ''),
    coalesce("leg_key", ''),
    "acquisition_channel"
  )
  WHERE "status" = 'ongoing' AND "brand_id" IS NOT NULL AND "acquisition_channel" IS NOT NULL;
