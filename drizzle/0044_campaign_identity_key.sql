-- A campaign is unique on (org, brand, sales funnel, acquisition channel).
--
-- Two of those four were not stored facts, which is why nothing could enforce the key:
--
--   * the BRAND lived in `brand_ids text[]`. No unique index can span an array, so Postgres was
--     never able to police anything. The reality is one brand per campaign — every `ongoing` row
--     in prod carries exactly one — so `brand_id` states it. Historical multi-brand rows (all
--     stopped) keep their array and take its first element.
--   * the ACQUISITION CHANNEL was not stored at all: consumers derived it from the workflow slug,
--     i.e. from the one attribute that legitimately CHANGES under a campaign. It is now written
--     once, from the feature the campaign already states.
--
-- The workflow is NOT part of the identity and never was: a campaign changes workflow every time
-- selection picks a better one. Treating it as identity is what grew brand
-- f4d73dab-1f9d-49b2-b16e-63ecde76a5eb 137 stopped rows — one per workflow version — each holding
-- a slice of a history nobody could read as one campaign.
--
-- Idempotent and re-runnable: the columns are added IF NOT EXISTS, the backfill only writes rows
-- that are still NULL, and the index is created IF NOT EXISTS. Nothing is deleted, stopped,
-- rescheduled or re-budgeted, and no row that ever ran is touched beyond gaining two columns that
-- restate what it already said.

ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "brand_id" text;
ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "acquisition_channel" text;

-- The brand a campaign works. `brand_ids[1]` is Postgres' first element (1-indexed).
UPDATE "campaigns"
SET "brand_id" = "brand_ids"[1]
WHERE "brand_id" IS NULL AND "brand_ids" IS NOT NULL AND array_length("brand_ids", 1) >= 1;

-- The channel it acquires through. Byte-equal with `acquisitionChannelForFeature` in
-- src/lib/campaign-identity.ts, INCLUDING its fallback: a feature neither list names keeps its own
-- slug with '-' as '_', so a feature shipped later can never silently share another one's identity.
UPDATE "campaigns"
SET "acquisition_channel" = CASE "feature_slug"
      WHEN 'sales-cold-email-outreach'     THEN 'cold_email'
      WHEN 'sales-crm-email-outreach'      THEN 'crm_email'
      WHEN 'pr-cold-email-outreach'        THEN 'pr_cold_email'
      WHEN 'hiring-cold-email-outreach'    THEN 'hiring_cold_email'
      WHEN 'vc-cold-email-outreach'        THEN 'vc_cold_email'
      WHEN 'pr-expert-quote-outreach'      THEN 'expert_quote_outreach'
      WHEN 'pr-expert-quote-opportunities' THEN 'expert_quote_opportunities'
      WHEN 'ai-visibility-scoring'         THEN 'ai_visibility'
      WHEN 'press-kit-page-generation'     THEN 'press_kit'
      WHEN 'outlet-database-discovery'     THEN 'outlet_discovery'
      ELSE replace("feature_slug", '-', '_')
    END
WHERE "acquisition_channel" IS NULL AND "feature_slug" IS NOT NULL;

-- Enforce the key on the campaigns that are ALIVE. A stopped row is history: it is not competing
-- for a brand's turn, it spends nothing, and collapsing the historical rows is a separate,
-- reversible data operation — this index must never make a deploy fail on data that predates it.
--
-- `coalesce(funnel_key, '')` is load-bearing: Postgres treats NULLs as distinct in a unique index,
-- so without it a brand could grow unlimited funnel-less campaigns on one channel — which is the
-- exact duplication this key exists to stop.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_campaigns_org_brand_funnel_channel"
  ON "campaigns" ("org_id", "brand_id", coalesce("funnel_key", ''), "acquisition_channel")
  WHERE "status" = 'ongoing' AND "brand_id" IS NOT NULL AND "acquisition_channel" IS NOT NULL;
