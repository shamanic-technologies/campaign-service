-- REVERT of 0070 (#688, owner 2026-10-13: a campaign IS a sales funnel of INDEPENDENT pipes; an audience
-- list stated on the funnel campaign and fanned to every unit is not part of that model).
--
-- 1. Units that inherited their funnel campaign's audiences lose them (as before #688). Only units of a
--    funnel campaign that STATES audiences are touched: a unit carrying audiences of its own (written before
--    #688) keeps them. In prod on 2026-10-13 that was 6 units of 2 funnel campaigns of brand Distribute.you:
--      9a355026-03e9-486a-9efb-bdf49d6acede {813fbac4-8657-4fca-b914-44a44388bbed}
--        units 4204b6fb-b1fe-4eff-884b-9654b43bcba3, 9523312b-1626-4ddc-96dc-0f4776e14c26, 4af21454-ae93-4d62-8528-cc95081145ac
--      82fe01fc-4a2d-462b-9543-a9dabb779d73 {297ac32a-f9be-485c-91dd-c6f852ae9b93}
--        units fb201499-4f90-40da-9cc3-f612392664f2, f854b5d1-752b-4b91-abf5-68d3feca6f58, 7e09a0e5-2956-4561-9b23-c9e7c504cfcd
--    Status untouched.
-- 2. The column goes. Guarded on the column, so a replay is a no-op. Boot-safe.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'sales_funnel_campaigns' AND column_name = 'audience_ids'
  ) THEN
    UPDATE "campaigns" c
       SET "audience_ids" = NULL, "updated_at" = now()
      FROM "sales_funnel_campaigns" s
     WHERE c."sales_funnel_campaign_id"::text = s."id"::text
       AND s."audience_ids" IS NOT NULL
       AND c."audience_ids" IS NOT DISTINCT FROM s."audience_ids";

    ALTER TABLE "sales_funnel_campaigns" DROP COLUMN "audience_ids";
  END IF;
END $$;
