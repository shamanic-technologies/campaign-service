-- DISTRY-CALL-IS-CAMPAIGN-1121 (owner 2026-11-21: « go » to make the OFFER optional on a campaign). A campaign is
-- Target + start + budget + brief: a campaign launched on its TARGET alone (one unit run by its Engine, e.g. a
-- newsletter draft) may name no offer. NULL = it names none. Every row before keeps its offer (nothing rewritten).
ALTER TABLE "sales_funnel_campaigns" ALTER COLUMN "offer_id" DROP NOT NULL;
--> statement-breakpoint
-- The identity stays ONE row per (org, brand, offer, funnel, people, issue) whatever the status (owner rule 2): two
-- campaigns naming no offer on the same target are the same campaign, so a NULL offer must collide like a value.
DROP INDEX IF EXISTS "uniq_sales_funnel_campaigns_identity";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_sales_funnel_campaigns_identity" ON "sales_funnel_campaigns" USING btree ("org_id","brand_id",coalesce("offer_id", ''),"sales_funnel_id","people_key",coalesce("github_issue", ''));
