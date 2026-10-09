-- Outbound leg-key rename, WAVE 2 (owner go 2026-10-09; lib/leg-identity.ts).
--
-- For the OUTBOUND channels only (LOCKED list, `OUTBOUND_RENAMED_FEATURE_SLUGS`), every stored leg
-- moves to the spelling that says what it is:
--
--     start_to_conversation   ->  lead_found_to_conversation
--     start_to_website_visit  ->  lead_found_to_website_visit
--
-- Every row, ongoing AND stopped. The same keys on any other channel (google-ads...) are untouched.
--
-- Collisions: the partial unique index `uniq_campaigns_org_brand_offer_leg_channel` (ongoing only)
-- spans the leg. Wave 1 wrote ONLY the legacy spelling, so no row carries the new one before this
-- runs (measured 2026-10-09: 0 new-spelling rows, 256 legacy rows), and a legacy and a new row of one
-- identity cannot both exist. The NOT EXISTS guard below keeps that true on a replay anyway: an
-- ongoing legacy row whose identity already has an ongoing new-spelling row is left for a person
-- (never deleted, never merged) instead of failing the boot.
--
-- `campaigns_funnel_key_snapshot_20260926` (prod-only audit table, no feature column) is rewritten
-- through its campaign's feature slug, guarded on the table existing.
--
-- Idempotent: a second run matches nothing.
UPDATE "campaigns" AS c
SET "leg_key" = CASE c."leg_key"
    WHEN 'start_to_conversation' THEN 'lead_found_to_conversation'
    WHEN 'start_to_website_visit' THEN 'lead_found_to_website_visit'
  END
WHERE c."leg_key" IN ('start_to_conversation', 'start_to_website_visit')
  AND c."feature_slug" IN (
    'sales-cold-email-outreach', 'feedback-request-cold-email-outreach', 'sales-crm-email-outreach',
    'cold-call-outreach', 'cold-instagram-outreach', 'cold-linkedin-outreach', 'cold-reddit-outreach',
    'cold-sms-outreach', 'cold-whatsapp-outreach', 'cold-x-outreach'
  )
  AND NOT (
    c."status" = 'ongoing' AND EXISTS (
      SELECT 1 FROM "campaigns" n
      WHERE n."status" = 'ongoing'
        AND n."id"::text <> c."id"::text
        AND n."org_id"::text = c."org_id"::text
        AND n."brand_id" IS NOT DISTINCT FROM c."brand_id"
        AND coalesce(n."offer_id", '') = coalesce(c."offer_id", '')
        AND n."acquisition_channel" IS NOT DISTINCT FROM c."acquisition_channel"
        AND n."leg_key" = CASE c."leg_key"
          WHEN 'start_to_conversation' THEN 'lead_found_to_conversation'
          WHEN 'start_to_website_visit' THEN 'lead_found_to_website_visit'
        END
    )
  );
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables WHERE table_name = 'campaigns_funnel_key_snapshot_20260926'
  ) THEN
    EXECUTE $sql$
      UPDATE "campaigns_funnel_key_snapshot_20260926" AS s
      SET "leg_key" = CASE s."leg_key"
          WHEN 'start_to_conversation' THEN 'lead_found_to_conversation'
          WHEN 'start_to_website_visit' THEN 'lead_found_to_website_visit'
        END
      FROM "campaigns" c
      WHERE c."id"::text = s."id"::text
        AND s."leg_key" IN ('start_to_conversation', 'start_to_website_visit')
        AND c."feature_slug" IN (
          'sales-cold-email-outreach', 'feedback-request-cold-email-outreach', 'sales-crm-email-outreach',
          'cold-call-outreach', 'cold-instagram-outreach', 'cold-linkedin-outreach', 'cold-reddit-outreach',
          'cold-sms-outreach', 'cold-whatsapp-outreach', 'cold-x-outreach'
        )
    $sql$;
  END IF;
END $$;
