-- A SALES FUNNEL CAMPAIGN MAY NAME ITS PEOPLE AND CARRY AN INSTRUCTION (2026-10-11).
--
-- Two general capabilities of any funnel campaign (owner: homogeneous infra, never a caller-only branch):
--   - `people`: the exact people it acts for ([{email, leadId}], NULL = whoever its pipes serve, as
--     before). `people_key` is their canonical identity (sorted lowercased emails, '' = none) and joins
--     the funnel campaign's identity: two campaigns on one funnel naming two different people are two
--     campaigns; the same people again is the same campaign (handed back, never created twice).
--   - `instruction`: free text every run of its units carries to the workflow (/start-run), editable.
--
-- The unit identity is widened by the funnel CAMPAIGN, so two funnel campaigns on one funnel each own
-- their pipe. Today one funnel campaign exists per (org, brand, offer, funnel), so the widened index
-- admits exactly what the old one admitted. Each index is rebuilt under a temporary name, the old one
-- dropped, then renamed back: the name the code catches on 23505 never changes, and there is no instant
-- in which live rows are unpoliced. Boot-safe: guarded on the index definition, re-runnable.
ALTER TABLE "sales_funnel_campaigns" ADD COLUMN IF NOT EXISTS "people" jsonb;
ALTER TABLE "sales_funnel_campaigns" ADD COLUMN IF NOT EXISTS "people_key" text DEFAULT '' NOT NULL;
ALTER TABLE "sales_funnel_campaigns" ADD COLUMN IF NOT EXISTS "instruction" text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE indexname = 'uniq_sales_funnel_campaigns_identity' AND indexdef LIKE '%people_key%'
  ) THEN
    CREATE UNIQUE INDEX IF NOT EXISTS "uniq_sales_funnel_campaigns_identity_0067"
      ON "sales_funnel_campaigns" ("org_id", "brand_id", "offer_id", "sales_funnel_id", "people_key");
    DROP INDEX IF EXISTS "uniq_sales_funnel_campaigns_identity";
    ALTER INDEX "uniq_sales_funnel_campaigns_identity_0067" RENAME TO "uniq_sales_funnel_campaigns_identity";
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE indexname = 'uniq_campaigns_org_brand_offer_sales_funnel_leg_channel'
      AND indexdef LIKE '%sales_funnel_campaign_id%'
  ) THEN
    CREATE UNIQUE INDEX IF NOT EXISTS "uniq_campaigns_identity_0067"
      ON "campaigns" USING btree (
        "org_id",
        "brand_id",
        coalesce("offer_id", ''),
        coalesce("sales_funnel_id", ''),
        coalesce("sales_funnel_campaign_id", ''),
        coalesce("leg_key", ''),
        "acquisition_channel"
      )
      WHERE "status" = 'ongoing' AND "brand_id" IS NOT NULL AND "acquisition_channel" IS NOT NULL;
    DROP INDEX IF EXISTS "uniq_campaigns_org_brand_offer_sales_funnel_leg_channel";
    ALTER INDEX "uniq_campaigns_identity_0067" RENAME TO "uniq_campaigns_org_brand_offer_sales_funnel_leg_channel";
  END IF;
END $$;
