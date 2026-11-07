-- Re-key the retired coarse `post_published` outcome to its fine spelling (owner 2026-11-07, DELETE-POST-PUBLISHED-1107).
--
-- The catalogue (features-service) retires `post_published` and the three Threads legs spelled with it; their fine-key
-- twins are live. distribute.you's own Threads funnel campaign (7f522f03) and its units, plan history and dispatch
-- attributions still name the old leg keys / pipe ids / funnel ids. Every such value is re-keyed IN PLACE (ids, statuses,
-- history kept) by ONE token rule, the same as `src/lib/fine-outcome-spelling.ts` (pattern pinned by its unit test):
--
--     every `post_published` token NOT already `threads_` / `x_` / `linkedin_`-prefixed -> `threads_post_published`
--
-- Every leg ever spelled with the coarse key is a Threads leg (verified fleet-wide). The funnel campaign's own
-- `sales_funnel_id` is billing-service's caps key: billing states the same cap under the new id (it holds both), so the
-- campaign stays capped. Old values are copied first into `post_published_rekey_snapshot_20261107` (table, row id, column, old value).
--
-- Prod 2026-11-07 (all org f0420eb5): campaigns 5 rows (leg_key 3, sales_funnel_id 5, name 3), sales_funnel_campaigns 1
-- (sales_funnel_id, running_sales_funnel_id, plan_check), sales_funnel_plan_changes 1 (from/to, units),
-- run_play_attributions 1055. No row carries the fine spelling before this runs. Idempotent: a replay matches nothing.
CREATE TABLE IF NOT EXISTS "post_published_rekey_snapshot_20261107" (
  "table_name" text NOT NULL,
  "row_id" text NOT NULL,
  "column_name" text NOT NULL,
  "old_value" text NOT NULL,
  "snapshotted_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("table_name", "row_id", "column_name")
);
--> statement-breakpoint
INSERT INTO "post_published_rekey_snapshot_20261107" ("table_name", "row_id", "column_name", "old_value")
SELECT 'campaigns', "id"::text, 'leg_key', "leg_key"::text FROM "campaigns" WHERE "leg_key"::text ~ '(^|[^a-z_]|_to_)post_published(?=$|_to_|[^a-z0-9_])'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "post_published_rekey_snapshot_20261107" ("table_name", "row_id", "column_name", "old_value")
SELECT 'campaigns', "id"::text, 'sales_funnel_id', "sales_funnel_id"::text FROM "campaigns" WHERE "sales_funnel_id"::text ~ '(^|[^a-z_]|_to_)post_published(?=$|_to_|[^a-z0-9_])'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "post_published_rekey_snapshot_20261107" ("table_name", "row_id", "column_name", "old_value")
SELECT 'campaigns', "id"::text, 'name', "name"::text FROM "campaigns" WHERE "name"::text ~ '(^|[^a-z_]|_to_)post_published(?=$|_to_|[^a-z0-9_])'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
UPDATE "campaigns"
SET "leg_key" = regexp_replace("leg_key", '(^|[^a-z_]|_to_)post_published(?=$|_to_|[^a-z0-9_])', '\1threads_post_published', 'g'),
    "sales_funnel_id" = regexp_replace("sales_funnel_id", '(^|[^a-z_]|_to_)post_published(?=$|_to_|[^a-z0-9_])', '\1threads_post_published', 'g'),
    "name" = regexp_replace("name", '(^|[^a-z_]|_to_)post_published(?=$|_to_|[^a-z0-9_])', '\1threads_post_published', 'g')
WHERE "leg_key"::text ~ '(^|[^a-z_]|_to_)post_published(?=$|_to_|[^a-z0-9_])' OR "sales_funnel_id"::text ~ '(^|[^a-z_]|_to_)post_published(?=$|_to_|[^a-z0-9_])' OR "name"::text ~ '(^|[^a-z_]|_to_)post_published(?=$|_to_|[^a-z0-9_])';
--> statement-breakpoint
INSERT INTO "post_published_rekey_snapshot_20261107" ("table_name", "row_id", "column_name", "old_value")
SELECT 'sales_funnel_campaigns', "id"::text, 'sales_funnel_id', "sales_funnel_id"::text FROM "sales_funnel_campaigns" WHERE "sales_funnel_id"::text ~ '(^|[^a-z_]|_to_)post_published(?=$|_to_|[^a-z0-9_])'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "post_published_rekey_snapshot_20261107" ("table_name", "row_id", "column_name", "old_value")
SELECT 'sales_funnel_campaigns', "id"::text, 'running_sales_funnel_id', "running_sales_funnel_id"::text FROM "sales_funnel_campaigns" WHERE "running_sales_funnel_id"::text ~ '(^|[^a-z_]|_to_)post_published(?=$|_to_|[^a-z0-9_])'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "post_published_rekey_snapshot_20261107" ("table_name", "row_id", "column_name", "old_value")
SELECT 'sales_funnel_campaigns', "id"::text, 'plan_check', "plan_check"::text FROM "sales_funnel_campaigns" WHERE "plan_check"::text ~ '(^|[^a-z_]|_to_)post_published(?=$|_to_|[^a-z0-9_])'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
UPDATE "sales_funnel_campaigns"
SET "sales_funnel_id" = regexp_replace("sales_funnel_id", '(^|[^a-z_]|_to_)post_published(?=$|_to_|[^a-z0-9_])', '\1threads_post_published', 'g'),
    "running_sales_funnel_id" = regexp_replace("running_sales_funnel_id", '(^|[^a-z_]|_to_)post_published(?=$|_to_|[^a-z0-9_])', '\1threads_post_published', 'g'),
    "plan_check" = regexp_replace("plan_check"::text, '(^|[^a-z_]|_to_)post_published(?=$|_to_|[^a-z0-9_])', '\1threads_post_published', 'g')::jsonb
WHERE "sales_funnel_id"::text ~ '(^|[^a-z_]|_to_)post_published(?=$|_to_|[^a-z0-9_])' OR "running_sales_funnel_id"::text ~ '(^|[^a-z_]|_to_)post_published(?=$|_to_|[^a-z0-9_])' OR "plan_check"::text ~ '(^|[^a-z_]|_to_)post_published(?=$|_to_|[^a-z0-9_])';
--> statement-breakpoint
INSERT INTO "post_published_rekey_snapshot_20261107" ("table_name", "row_id", "column_name", "old_value")
SELECT 'sales_funnel_plan_changes', "id"::text, 'from_sales_funnel_id', "from_sales_funnel_id"::text FROM "sales_funnel_plan_changes" WHERE "from_sales_funnel_id"::text ~ '(^|[^a-z_]|_to_)post_published(?=$|_to_|[^a-z0-9_])'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "post_published_rekey_snapshot_20261107" ("table_name", "row_id", "column_name", "old_value")
SELECT 'sales_funnel_plan_changes', "id"::text, 'to_sales_funnel_id', "to_sales_funnel_id"::text FROM "sales_funnel_plan_changes" WHERE "to_sales_funnel_id"::text ~ '(^|[^a-z_]|_to_)post_published(?=$|_to_|[^a-z0-9_])'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "post_published_rekey_snapshot_20261107" ("table_name", "row_id", "column_name", "old_value")
SELECT 'sales_funnel_plan_changes', "id"::text, 'units', "units"::text FROM "sales_funnel_plan_changes" WHERE "units"::text ~ '(^|[^a-z_]|_to_)post_published(?=$|_to_|[^a-z0-9_])'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
UPDATE "sales_funnel_plan_changes"
SET "from_sales_funnel_id" = regexp_replace("from_sales_funnel_id", '(^|[^a-z_]|_to_)post_published(?=$|_to_|[^a-z0-9_])', '\1threads_post_published', 'g'),
    "to_sales_funnel_id" = regexp_replace("to_sales_funnel_id", '(^|[^a-z_]|_to_)post_published(?=$|_to_|[^a-z0-9_])', '\1threads_post_published', 'g'),
    "units" = regexp_replace("units"::text, '(^|[^a-z_]|_to_)post_published(?=$|_to_|[^a-z0-9_])', '\1threads_post_published', 'g')::jsonb
WHERE "from_sales_funnel_id"::text ~ '(^|[^a-z_]|_to_)post_published(?=$|_to_|[^a-z0-9_])' OR "to_sales_funnel_id"::text ~ '(^|[^a-z_]|_to_)post_published(?=$|_to_|[^a-z0-9_])' OR "units"::text ~ '(^|[^a-z_]|_to_)post_published(?=$|_to_|[^a-z0-9_])';
--> statement-breakpoint
INSERT INTO "post_published_rekey_snapshot_20261107" ("table_name", "row_id", "column_name", "old_value")
SELECT 'run_play_attributions', "id"::text, 'sales_funnel_id', "sales_funnel_id"::text FROM "run_play_attributions" WHERE "sales_funnel_id"::text ~ '(^|[^a-z_]|_to_)post_published(?=$|_to_|[^a-z0-9_])'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "post_published_rekey_snapshot_20261107" ("table_name", "row_id", "column_name", "old_value")
SELECT 'run_play_attributions', "id"::text, 'leg_key', "leg_key"::text FROM "run_play_attributions" WHERE "leg_key"::text ~ '(^|[^a-z_]|_to_)post_published(?=$|_to_|[^a-z0-9_])'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "post_published_rekey_snapshot_20261107" ("table_name", "row_id", "column_name", "old_value")
SELECT 'run_play_attributions', "id"::text, 'play_id', "play_id"::text FROM "run_play_attributions" WHERE "play_id"::text ~ '(^|[^a-z_]|_to_)post_published(?=$|_to_|[^a-z0-9_])'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "post_published_rekey_snapshot_20261107" ("table_name", "row_id", "column_name", "old_value")
SELECT 'run_play_attributions', "id"::text, 'pipe_id', "pipe_id"::text FROM "run_play_attributions" WHERE "pipe_id"::text ~ '(^|[^a-z_]|_to_)post_published(?=$|_to_|[^a-z0-9_])'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "post_published_rekey_snapshot_20261107" ("table_name", "row_id", "column_name", "old_value")
SELECT 'run_play_attributions', "id"::text, 'detail', "detail"::text FROM "run_play_attributions" WHERE "detail"::text ~ '(^|[^a-z_]|_to_)post_published(?=$|_to_|[^a-z0-9_])'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
UPDATE "run_play_attributions"
SET "sales_funnel_id" = regexp_replace("sales_funnel_id", '(^|[^a-z_]|_to_)post_published(?=$|_to_|[^a-z0-9_])', '\1threads_post_published', 'g'),
    "leg_key" = regexp_replace("leg_key", '(^|[^a-z_]|_to_)post_published(?=$|_to_|[^a-z0-9_])', '\1threads_post_published', 'g'),
    "play_id" = regexp_replace("play_id", '(^|[^a-z_]|_to_)post_published(?=$|_to_|[^a-z0-9_])', '\1threads_post_published', 'g'),
    "pipe_id" = regexp_replace("pipe_id", '(^|[^a-z_]|_to_)post_published(?=$|_to_|[^a-z0-9_])', '\1threads_post_published', 'g'),
    "detail" = regexp_replace("detail", '(^|[^a-z_]|_to_)post_published(?=$|_to_|[^a-z0-9_])', '\1threads_post_published', 'g')
WHERE "sales_funnel_id"::text ~ '(^|[^a-z_]|_to_)post_published(?=$|_to_|[^a-z0-9_])' OR "leg_key"::text ~ '(^|[^a-z_]|_to_)post_published(?=$|_to_|[^a-z0-9_])' OR "play_id"::text ~ '(^|[^a-z_]|_to_)post_published(?=$|_to_|[^a-z0-9_])' OR "pipe_id"::text ~ '(^|[^a-z_]|_to_)post_published(?=$|_to_|[^a-z0-9_])' OR "detail"::text ~ '(^|[^a-z_]|_to_)post_published(?=$|_to_|[^a-z0-9_])';
