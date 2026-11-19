-- CAMPAIGN-CHANGE-LOG-1119. A funnel campaign's own words (target, brief, follows-its-plan) were overwritten in place:
-- "what did the brief say on the 4th" had no answer. From this migration on, every write that changes one of them
-- appends a row here in the same transaction: what it was, what it became, who wrote it (the person, or the path
-- that did). Append-only: a row is never updated and never deleted. No backfill: before this migration is "not recorded".
CREATE TABLE IF NOT EXISTS "sales_funnel_campaign_setting_changes" (
	"id" text PRIMARY KEY NOT NULL,
	"sales_funnel_campaign_id" text NOT NULL,
	"org_id" text NOT NULL,
	"field" text NOT NULL,
	"before_value" text,
	"after_value" text,
	"changed_by_user_id" text,
	"source" text NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_sfc_setting_changes_campaign" ON "sales_funnel_campaign_setting_changes" USING btree ("sales_funnel_campaign_id","changed_at");
