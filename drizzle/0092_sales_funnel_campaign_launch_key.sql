-- TWO CAMPAIGNS OF ONE BRAND ON THE SAME TARGET (2026-11-21, OUTREACH-3WAYS-1121).
--
-- A client runs several campaigns of one brand aiming at the same outcome with different briefs (one for
-- investors, one for industry peers), each with its own caps at billing (keyed on the funnel campaign id).
-- `launch_key` is the caller's own short name for the campaign among the brand's campaigns on the same
-- funnel/target ('investors'); '' = the brand's one campaign there (every row before, every call that states
-- none). It joins the identity: the same key again hands that campaign back, another key is another campaign.
-- The identity index is rebuilt under a temporary name, the old one dropped, then renamed back (the name the
-- code catches on 23505 never changes). Boot-safe: guarded on the index definition, re-runnable.
ALTER TABLE "sales_funnel_campaigns" ADD COLUMN IF NOT EXISTS "launch_key" text NOT NULL DEFAULT '';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE indexname = 'uniq_sales_funnel_campaigns_identity' AND indexdef LIKE '%launch_key%'
  ) THEN
    CREATE UNIQUE INDEX IF NOT EXISTS "uniq_sales_funnel_campaigns_identity_0092"
      ON "sales_funnel_campaigns" ("org_id", "brand_id", coalesce("offer_id", ''), "sales_funnel_id", "people_key", coalesce("github_issue", ''), "launch_key");
    DROP INDEX IF EXISTS "uniq_sales_funnel_campaigns_identity";
    ALTER INDEX "uniq_sales_funnel_campaigns_identity_0092" RENAME TO "uniq_sales_funnel_campaigns_identity";
  END IF;
END $$;
