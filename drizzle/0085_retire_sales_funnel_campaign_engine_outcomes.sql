-- Retire the per-campaign Engine hand-over list `sales_funnel_campaigns.engine_outcomes` (owner 2026-11-02,
-- ENGINE-HANDOVER-RETIRE-1102). features-service's Engine drives every result of every live funnel campaign
-- (ENGINE-FULL-MIGRATION-1102) and no longer reads the list; the API refuses it (400 `engine_outcomes_retired`).
--
-- In production on 2026-11-02 one row of 118 carried a list (891cc349, {lead_found}). Rows carrying one are
-- snapshotted before the drop (history is never rewritten without a copy). Guarded on the column: a replay is a no-op.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'sales_funnel_campaigns' AND column_name = 'engine_outcomes'
  ) THEN
    CREATE TABLE IF NOT EXISTS "sales_funnel_campaigns_engine_outcomes_snapshot_20261102" (
      "sales_funnel_campaign_id" text PRIMARY KEY,
      "engine_outcomes" text[] NOT NULL,
      "snapshotted_at" timestamptz NOT NULL DEFAULT now()
    );
    INSERT INTO "sales_funnel_campaigns_engine_outcomes_snapshot_20261102" ("sales_funnel_campaign_id", "engine_outcomes")
    SELECT "id"::text, "engine_outcomes" FROM "sales_funnel_campaigns" WHERE cardinality("engine_outcomes") > 0
    ON CONFLICT ("sales_funnel_campaign_id") DO NOTHING;

    ALTER TABLE "sales_funnel_campaigns" DROP COLUMN "engine_outcomes";
  END IF;
END $$;
