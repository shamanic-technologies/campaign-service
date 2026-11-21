-- ONE CAMPAIGN PER BRIEF ON A TARGET (owner 2026-11-21, OUTREACH-3WAYS-1121: « On doit pouvoir créer autant de campaigns
-- différentes qu'on veut avec la même target tant que le brief est différent »). `launch_key` (migration 0092) is
-- RETIRED: a campaign is Target + start + budget + brief, so its BRIEF is what tells two campaigns of one brand on one
-- target apart. The identity becomes (org, brand, offer, funnel/target, people, github issue, brief): the same brief is the
-- same campaign (handed back), another brief is another campaign. md5 because a brief may be 12,000 chars (btree limit).
-- The 2 prod rows that stated a key keep it in a snapshot; their briefs already differ, so they stay two campaigns.
CREATE TABLE IF NOT EXISTS "sales_funnel_campaigns_launch_key_snapshot_20261121" (
  "sales_funnel_campaign_id" text PRIMARY KEY,
  "launch_key" text NOT NULL,
  "snapshotted_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'sales_funnel_campaigns' AND column_name = 'launch_key') THEN
    INSERT INTO "sales_funnel_campaigns_launch_key_snapshot_20261121" ("sales_funnel_campaign_id", "launch_key")
      SELECT "id"::text, "launch_key" FROM "sales_funnel_campaigns" WHERE "launch_key" <> ''
      ON CONFLICT ("sales_funnel_campaign_id") DO NOTHING;
  END IF;
END $$;
--> statement-breakpoint
DROP INDEX IF EXISTS "uniq_sales_funnel_campaigns_identity";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_sales_funnel_campaigns_identity" ON "sales_funnel_campaigns" USING btree ("org_id", "brand_id", coalesce("offer_id", ''), "sales_funnel_id", "people_key", coalesce("github_issue", ''), md5(coalesce("brief", '')));
--> statement-breakpoint
ALTER TABLE "sales_funnel_campaigns" DROP COLUMN IF EXISTS "launch_key";
