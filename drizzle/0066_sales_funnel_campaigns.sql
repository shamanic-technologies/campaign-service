-- SALES FUNNEL CAMPAIGNS (owner 2026-10-10): a campaign is brand x offer x SALES FUNNEL, and it owns
-- one running unit (a `campaigns` row) per pipe (leg x channel) of the funnel. Uniqueness is
-- brand x offer x sales funnel x channel x leg: a pipe two funnels share runs once per funnel.
--
-- Additive: two nullable columns on `campaigns` (NULL on every existing row = a pre-funnel campaign,
-- untouched), one new table, and the identity index widened by the funnel. Every existing row states
-- no funnel, so `coalesce(sales_funnel_id, '')` is '' for all of them and the widened index admits
-- exactly what the old one admitted. Boot-safe (IF [NOT] EXISTS everywhere).
ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "sales_funnel_id" text;
ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "sales_funnel_campaign_id" text;

CREATE TABLE IF NOT EXISTS "sales_funnel_campaigns" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "brand_id" text NOT NULL,
  "offer_id" text NOT NULL,
  "sales_funnel_id" text NOT NULL,
  "sales_funnel_name" text NOT NULL,
  "status" text NOT NULL,
  "stop_reason" text,
  "created_by_user_id" text,
  "parent_run_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_sales_funnel_campaigns_identity"
  ON "sales_funnel_campaigns" ("org_id", "brand_id", "offer_id", "sales_funnel_id");
CREATE INDEX IF NOT EXISTS "idx_sales_funnel_campaigns_org_status"
  ON "sales_funnel_campaigns" ("org_id", "status");

CREATE INDEX IF NOT EXISTS "idx_campaigns_sales_funnel_campaign"
  ON "campaigns" ("sales_funnel_campaign_id") WHERE "sales_funnel_campaign_id" IS NOT NULL;

-- The identity, widened by the funnel. Created BEFORE the old one is dropped, so there is no instant
-- in which the live rows are unpoliced.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_campaigns_org_brand_offer_sales_funnel_leg_channel"
  ON "campaigns" USING btree (
    "org_id",
    "brand_id",
    coalesce("offer_id", ''),
    coalesce("sales_funnel_id", ''),
    coalesce("leg_key", ''),
    "acquisition_channel"
  )
  WHERE "status" = 'ongoing' AND "brand_id" IS NOT NULL AND "acquisition_channel" IS NOT NULL;

DROP INDEX IF EXISTS "uniq_campaigns_org_brand_offer_leg_channel";
