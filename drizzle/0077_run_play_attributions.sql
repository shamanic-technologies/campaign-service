-- STRATEGY-ATTRIBUTION-1018: which PLAY (pipe x lead strategy) a run was dispatched under, one row per run, written
-- once at dispatch and never updated (lib/run-play-attribution.ts). Joined by run id to lead-service's serve
-- (`leads_campaigns.parent_run_id`) and to runs-service's tree. Idempotent, boot-safe.
CREATE TABLE IF NOT EXISTS "run_play_attributions" (
  "id" text PRIMARY KEY NOT NULL,
  "run_id" text NOT NULL,
  "run_kind" text NOT NULL,
  "dispatched_by" text NOT NULL,
  "caller_run_id" text,
  "campaign_id" text NOT NULL,
  "sales_funnel_campaign_id" text,
  "sales_funnel_id" text,
  "feature_slug" text,
  "leg_key" text,
  "workflow_slug" text,
  "audience_id" text,
  "play_state" text NOT NULL,
  "play_id" text,
  "pipe_id" text,
  "strategy_id" text,
  "strategy_name" text,
  "play_is_default" boolean,
  "excluded_workflow_dynasty_slugs" text[],
  "detail" text,
  "recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_run_play_attributions_run" ON "run_play_attributions" ("run_id");
CREATE INDEX IF NOT EXISTS "idx_run_play_attributions_campaign" ON "run_play_attributions" ("campaign_id", "recorded_at");
CREATE INDEX IF NOT EXISTS "idx_run_play_attributions_strategy" ON "run_play_attributions" ("strategy_id", "recorded_at");
