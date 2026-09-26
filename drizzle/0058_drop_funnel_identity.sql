-- Wave C2: the sales funnel leaves campaign-service's model.
--
-- A campaign is (offer x leg x acquisition channel); billing funds it at that grain and nothing in
-- this service reads a funnel any more. This drops what only ever existed to key on the funnel:
--
--   * `uniq_campaigns_org_brand_funnel_channel` is replaced by
--     `uniq_campaigns_org_brand_offer_leg_channel` — the same partial unique index without
--     `coalesce(funnel_key, '')`. Measured before shipping (2026-09-26): ZERO groups of live
--     campaigns share (org, brand, channel, offer, leg), so no currently-live row collides.
--   * `idx_campaigns_org_feature_funnel` — served the funnel-keyed reads that are gone.
--   * `campaign_funnel_owner_decisions` — the audit trail of owner answers about a campaign's
--     funnel (migrations 0045/0047/0048/0051). Nothing in the runtime ever read it. It was
--     snapshotted in production before this ran; the guard below refuses to drop a populated table
--     whose snapshot does not exist, so the drop can never outrun the copy.
--
-- `campaigns.funnel_key` is NOT dropped here: four services still read `campaign.funnelKey` off the
-- campaign row in production, so the column stays, read-only, until they move off it.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'campaign_funnel_owner_decisions')
     AND EXISTS (SELECT 1 FROM "campaign_funnel_owner_decisions")
     AND NOT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_name = 'campaign_funnel_owner_decisions_funnel_snapshot_20260926'
     ) THEN
    RAISE EXCEPTION 'campaign_funnel_owner_decisions holds rows and has no snapshot — refusing to drop it';
  END IF;
END $$;

DROP INDEX IF EXISTS "uniq_campaigns_org_brand_funnel_channel";

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_campaigns_org_brand_offer_leg_channel"
  ON "campaigns" USING btree (
    "org_id",
    "brand_id",
    coalesce("offer_id", ''),
    coalesce("leg_key", ''),
    "acquisition_channel"
  )
  WHERE "status" = 'ongoing' AND "brand_id" IS NOT NULL AND "acquisition_channel" IS NOT NULL;

DROP INDEX IF EXISTS "idx_campaigns_org_feature_funnel";

DROP TABLE IF EXISTS "campaign_funnel_owner_decisions";
