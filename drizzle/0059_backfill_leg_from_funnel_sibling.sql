-- Wave C3, step 1 of 2: before `campaigns.funnel_key` is dropped (0060), write the one thing it still
-- knows where it now lives.
--
-- A STOPPED campaign that stated a funnel but no leg is given the leg of the OTHER campaign(s) of the
-- same (org, brand, offer, channel) that sold the same funnel and state a leg, and only when exactly
-- one distinct leg is stated there. That is evidence recorded at the time, not an inference from the
-- funnel: a row whose siblings disagree, or that has none, stays leg-less. Nothing already stated is
-- overwritten (`leg_key IS NULL` is restated in the UPDATE). Measured 2026-09-26: 5 such rows, all
-- stopped, each with exactly one sibling leg.
--
-- Shipped on its own, ahead of the drop, so features-service (which keys a campaign identity on the
-- leg) never reads those ancestors as leg-less. Their pre-backfill state is in production's
-- `campaigns_funnel_key_snapshot_20260926` (id, funnel_key, leg_key, ...).
--
-- Guarded on the column so a replay after 0060 is a no-op.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'campaigns' AND column_name = 'funnel_key'
  ) THEN
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
  END IF;
END $$;
