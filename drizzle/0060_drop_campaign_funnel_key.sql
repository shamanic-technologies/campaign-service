-- Wave C3, step 2 of 2: the last funnel surface leaves campaign-service — `campaigns.funnel_key`.
--
-- Wave C2 (0058) kept the column READ-ONLY because lead-service, instantly-service,
-- workflow-service's ai-meeting-booking DAG and features-service still read `campaign.funnelKey`
-- off the campaign row. None of them does in production any more, so the column and its echo on
-- the row go. The one thing it still knew — which leg a leg-less stopped ancestor ran — was written
-- to `leg_key` by 0059, shipped ahead of this.
--
-- Every row carrying a funnel was snapshotted in production first
-- (`campaigns_funnel_key_snapshot_20260926`, owned by the service role); this refuses to drop a
-- populated column whose snapshot does not exist. Guarded on the column, so a replay is a no-op.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'campaigns' AND column_name = 'funnel_key'
  ) THEN
    IF EXISTS (SELECT 1 FROM "campaigns" WHERE "funnel_key" IS NOT NULL)
       AND NOT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_name = 'campaigns_funnel_key_snapshot_20260926'
       ) THEN
      RAISE EXCEPTION 'campaigns.funnel_key holds values and has no snapshot — refusing to drop it';
    END IF;

    ALTER TABLE "campaigns" DROP COLUMN "funnel_key";
  END IF;
END $$;
