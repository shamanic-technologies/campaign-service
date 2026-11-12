-- A brand's spendable budget (GET /brands/:brandId/spendable-budget) changes on THIS side when one of
-- its campaigns or funnel campaigns is created, deleted, or changes a field the computation reads
-- (MON-PAGE-SPEED-2-1112). billing-service stores that answer for the dashboard's runway and must hear
-- about such a change: every change is noted here BY THE DATABASE (a trigger, so no write path can
-- forget it), and lib/spendable-budget-push.ts drains the table into billing's invalidation route.
-- One row per (org, brand), the latest change time; a row is deleted once billing acknowledged it.
CREATE TABLE IF NOT EXISTS "spendable_budget_changes" (
	"org_id" text NOT NULL,
	"brand_id" text NOT NULL,
	"changed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "spendable_budget_changes_pk" PRIMARY KEY("org_id","brand_id")
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION note_campaign_spendable_change() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
	IF TG_OP <> 'INSERT' AND OLD.org_id IS NOT NULL THEN
		INSERT INTO spendable_budget_changes (org_id, brand_id, changed_at)
		-- One row per brand: a brand named in brand_id AND brand_ids would otherwise be
		-- proposed twice and ON CONFLICT refuses to touch a row twice in one command.
		SELECT OLD.org_id, x.b, clock_timestamp()
		FROM (SELECT DISTINCT b FROM unnest(array_append(COALESCE(OLD.brand_ids, '{}'::text[]), OLD.brand_id)) AS b WHERE b IS NOT NULL) AS x
		ON CONFLICT (org_id, brand_id) DO UPDATE SET changed_at = EXCLUDED.changed_at;
	END IF;
	IF TG_OP <> 'DELETE' AND NEW.org_id IS NOT NULL THEN
		INSERT INTO spendable_budget_changes (org_id, brand_id, changed_at)
		-- One row per brand: a brand named in brand_id AND brand_ids would otherwise be
		-- proposed twice and ON CONFLICT refuses to touch a row twice in one command.
		SELECT NEW.org_id, x.b, clock_timestamp()
		FROM (SELECT DISTINCT b FROM unnest(array_append(COALESCE(NEW.brand_ids, '{}'::text[]), NEW.brand_id)) AS b WHERE b IS NOT NULL) AS x
		ON CONFLICT (org_id, brand_id) DO UPDATE SET changed_at = EXCLUDED.changed_at;
	END IF;
	RETURN NULL;
END
$fn$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION note_sales_funnel_campaign_spendable_change() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
	IF TG_OP <> 'INSERT' AND OLD.org_id IS NOT NULL AND OLD.brand_id IS NOT NULL THEN
		INSERT INTO spendable_budget_changes (org_id, brand_id, changed_at)
		VALUES (OLD.org_id, OLD.brand_id, clock_timestamp())
		ON CONFLICT (org_id, brand_id) DO UPDATE SET changed_at = EXCLUDED.changed_at;
	END IF;
	IF TG_OP <> 'DELETE' AND NEW.org_id IS NOT NULL AND NEW.brand_id IS NOT NULL THEN
		INSERT INTO spendable_budget_changes (org_id, brand_id, changed_at)
		VALUES (NEW.org_id, NEW.brand_id, clock_timestamp())
		ON CONFLICT (org_id, brand_id) DO UPDATE SET changed_at = EXCLUDED.changed_at;
	END IF;
	RETURN NULL;
END
$fn$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS campaigns_spendable_change_ins_del ON campaigns;
--> statement-breakpoint
CREATE TRIGGER campaigns_spendable_change_ins_del AFTER INSERT OR DELETE ON campaigns
	FOR EACH ROW EXECUTE FUNCTION note_campaign_spendable_change();
--> statement-breakpoint
DROP TRIGGER IF EXISTS campaigns_spendable_change_upd ON campaigns;
--> statement-breakpoint
CREATE TRIGGER campaigns_spendable_change_upd AFTER UPDATE ON campaigns
	FOR EACH ROW WHEN (
		OLD.status IS DISTINCT FROM NEW.status OR OLD.org_id IS DISTINCT FROM NEW.org_id
		OR OLD.brand_id IS DISTINCT FROM NEW.brand_id OR OLD.brand_ids IS DISTINCT FROM NEW.brand_ids
		OR OLD.feature_slug IS DISTINCT FROM NEW.feature_slug OR OLD.offer_id IS DISTINCT FROM NEW.offer_id
		OR OLD.leg_key IS DISTINCT FROM NEW.leg_key OR OLD.created_at IS DISTINCT FROM NEW.created_at
		OR OLD.sales_funnel_campaign_id IS DISTINCT FROM NEW.sales_funnel_campaign_id
	) EXECUTE FUNCTION note_campaign_spendable_change();
--> statement-breakpoint
DROP TRIGGER IF EXISTS sales_funnel_campaigns_spendable_change_ins_del ON sales_funnel_campaigns;
--> statement-breakpoint
CREATE TRIGGER sales_funnel_campaigns_spendable_change_ins_del AFTER INSERT OR DELETE ON sales_funnel_campaigns
	FOR EACH ROW EXECUTE FUNCTION note_sales_funnel_campaign_spendable_change();
--> statement-breakpoint
DROP TRIGGER IF EXISTS sales_funnel_campaigns_spendable_change_upd ON sales_funnel_campaigns;
--> statement-breakpoint
CREATE TRIGGER sales_funnel_campaigns_spendable_change_upd AFTER UPDATE ON sales_funnel_campaigns
	FOR EACH ROW WHEN (
		OLD.status IS DISTINCT FROM NEW.status OR OLD.org_id IS DISTINCT FROM NEW.org_id
		OR OLD.brand_id IS DISTINCT FROM NEW.brand_id OR OLD.offer_id IS DISTINCT FROM NEW.offer_id
		OR OLD.sales_funnel_id IS DISTINCT FROM NEW.sales_funnel_id
	) EXECUTE FUNCTION note_sales_funnel_campaign_spendable_change();
