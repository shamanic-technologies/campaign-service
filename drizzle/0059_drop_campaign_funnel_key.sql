-- Wave C3: the last funnel surface leaves campaign-service — `campaigns.funnel_key`.
--
-- Wave C2 (0058) kept the column READ-ONLY because four services still read `campaign.funnelKey`
-- off the campaign row. They have moved off it, so the column and its echo on the row go.
--
-- Before the drop, one thing the column still knew is written where it now lives: a STOPPED
-- campaign that stated a funnel but no leg is given the leg of the one OTHER campaign of the same
-- (org, brand, offer, channel) that sold the same funnel and states a leg — and only when exactly
-- one distinct leg is stated there. That is evidence recorded at the time, not an inference from
-- the funnel; a row whose siblings disagree, or have none, stays leg-less. Measured 2026-09-26:
-- 5 such rows, all stopped, each with exactly one sibling leg. Nothing already stated is
-- overwritten (the `leg_key IS NULL` guard is restated in the UPDATE).
--
-- Every row carrying a funnel was snapshotted in production before this ran
-- (`campaigns_funnel_key_snapshot_20260926`: id, funnel_key, leg_key before the backfill); the
-- guard below refuses to drop a populated column whose snapshot does not exist.
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

    EXECUTE $sql$
      UPDATE "campaigns" AS t
      SET "leg_key" = pick.leg
      FROM (
        SELECT t2."id"::text AS id, min(s."leg_key") AS leg
        FROM "campaigns" t2
        JOIN "campaigns" s
          ON s."org_id"::text = t2."org_id"::text
         AND s."brand_id" = t2."brand_id"
         AND s."offer_id" = t2."offer_id"
         AND s."acquisition_channel" = t2."acquisition_channel"
         AND s."funnel_key" = t2."funnel_key"
         AND s."id"::text <> t2."id"::text
         AND s."leg_key" IS NOT NULL
        WHERE t2."leg_key" IS NULL
          AND t2."funnel_key" IS NOT NULL
          AND t2."status" = 'stopped'
        GROUP BY t2."id"
        HAVING count(DISTINCT s."leg_key") = 1
      ) AS pick
      WHERE t."id"::text = pick.id
        AND t."leg_key" IS NULL
    $sql$;

    ALTER TABLE "campaigns" DROP COLUMN "funnel_key";
  END IF;
END $$;
