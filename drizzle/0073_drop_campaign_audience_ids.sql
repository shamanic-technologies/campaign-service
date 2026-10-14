-- Retire the per-campaign audience SUBSET — `campaigns.audience_ids` (owner 2026-10-14, LEAK-1012).
--
-- Who a pipe finds or contacts is its lead strategy's (features-service plays, stated by the
-- workflow), never an audience list stored on a campaign. Nothing reads the column any more:
-- selection, /start-run, the scheduler and the serveable-audience read behave as for a campaign
-- that states none, and the API refuses a stated list (400 `audience_ids_retired`).
--
-- In production on 2026-10-14 two rows carried a list, both STOPPED (a staff test funnel); no
-- ongoing campaign did. They are snapshotted here before the drop (history is never rewritten
-- without a copy). Guarded on the column, so a replay is a no-op.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'campaigns' AND column_name = 'audience_ids'
  ) THEN
    CREATE TABLE IF NOT EXISTS "campaigns_audience_ids_snapshot_20261014" (
      "campaign_id" text PRIMARY KEY,
      "audience_ids" text[] NOT NULL,
      "snapshotted_at" timestamptz NOT NULL DEFAULT now()
    );
    INSERT INTO "campaigns_audience_ids_snapshot_20261014" ("campaign_id", "audience_ids")
    SELECT "id"::text, "audience_ids" FROM "campaigns" WHERE "audience_ids" IS NOT NULL
    ON CONFLICT ("campaign_id") DO NOTHING;

    ALTER TABLE "campaigns" DROP COLUMN "audience_ids";
  END IF;
END $$;
