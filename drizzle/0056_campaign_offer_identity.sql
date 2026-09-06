-- The OFFER a campaign sells joins the identity Postgres polices.
--
-- A customer funds their money PER OFFER: billing-service has keyed a daily ceiling on
-- (org, brand, funnel, channel, OFFER, leg) since its migration 0037, and the dashboard lets a
-- customer set each offer's ceiling separately on Offer Settings. This service dedupes campaigns on
-- (org, brand, funnel, leg, channel) and the offer is absent from that key, so a brand selling TWO
-- offers through the same (funnel, channel, leg) has two ceilings and can hold only ONE campaign:
-- the second offer is funded and never provisioned. Nothing errors, nothing is logged and no test
-- fails — the ceiling simply sits there producing nothing, which is the exact failure the
-- funded-but-never-runs work exists to prevent. Verified against production: 194 offers across 144
-- brands, 22 brands already hold two or more, and no brand yet funds two offers on one identity.
-- Armed, not yet fired.
--
-- brand-service OWNS the offer entity and mints its UUID; this column has carried that value since
-- migration 0050 and is still never derived, parsed or minted here. What changes is only that
-- Postgres now counts it when it asks whether two live campaigns are the same campaign.
--
-- This only ever LOOSENS. `coalesce(offer_id, '')` collapses every row that states no offer onto
-- the value it keyed under before this migration, so every campaign alive today keys
-- byte-identically, no currently-valid state becomes invalid, and no existing pair can start
-- colliding. Nothing is backfilled: an offer is never stamped on a campaign that states none —
-- only brand-service knows which offer a live campaign belongs to, and guessing would move real
-- money onto the wrong proposition.
--
-- The NAME is deliberately left alone, for the same reason 0055 left it alone: the funnel is still
-- part of this identity, and the ship that removes it renames the index along with it.
DROP INDEX IF EXISTS "uniq_campaigns_org_brand_funnel_channel";

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_campaigns_org_brand_funnel_channel"
  ON "campaigns" USING btree (
    "org_id",
    "brand_id",
    coalesce("funnel_key", ''),
    coalesce("offer_id", ''),
    coalesce("leg_key", ''),
    "acquisition_channel"
  )
  WHERE "status" = 'ongoing' AND "brand_id" IS NOT NULL AND "acquisition_channel" IS NOT NULL;
