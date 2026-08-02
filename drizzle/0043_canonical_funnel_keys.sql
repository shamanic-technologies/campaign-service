-- Rename every stored funnel to the name it is now called.
--
-- brand-service retired the goal vocabulary and renamed the four funnel keys with it (#434):
--
--   visit_form     -> form_magnet                        (Form Magnet)
--   reply_meeting  -> sales_meetings_from_conversation   (Sales Meeting from Conversation)
--   visit_meeting  -> sales_meetings_from_website        (Sales Meeting from Website)
--   visit_signup   -> website_purchases                  (Website Purchases)
--
-- Campaign rows written before this ship carry the pre-rename spelling. A row that keeps it does
-- not resolve to the funnel it was provisioned for: its ceiling is looked up under a name billing
-- and brand-service no longer agree on, so the gate would read it as unfunded and the campaign
-- would stop sending. This rewrites them once, so every row states its funnel in the one
-- vocabulary the fleet uses.
--
-- The provisioned NAME carries the same token (`<feature> - <brandId> - <funnelKey>`), and it is
-- the only uniqueness Postgres can enforce for one-campaign-per-funnel — so it moves with the key
-- in the same statement. Only names matching exactly what this service provisions are touched; a
-- name a customer chose contains no funnel token and is left alone.
--
-- Idempotent and re-runnable: a second pass matches no pre-rename value and updates nothing.
-- Nothing is deleted, stopped, rescheduled or re-budgeted — no campaign loses its turn, its
-- pacing or a cent of attribution because of a vocabulary change.

UPDATE "campaigns"
SET "name" = replace("name", ' - ' || "funnel_key", ' - ' || CASE "funnel_key"
      WHEN 'visit_form'    THEN 'form_magnet'
      WHEN 'reply_meeting' THEN 'sales_meetings_from_conversation'
      WHEN 'visit_meeting' THEN 'sales_meetings_from_website'
      WHEN 'visit_signup'  THEN 'website_purchases'
    END)
WHERE "funnel_key" IN ('visit_form', 'reply_meeting', 'visit_meeting', 'visit_signup')
  AND "name" LIKE '% - ' || "funnel_key";

UPDATE "campaigns"
SET "funnel_key" = CASE "funnel_key"
      WHEN 'visit_form'    THEN 'form_magnet'
      WHEN 'reply_meeting' THEN 'sales_meetings_from_conversation'
      WHEN 'visit_meeting' THEN 'sales_meetings_from_website'
      WHEN 'visit_signup'  THEN 'website_purchases'
    END
WHERE "funnel_key" IN ('visit_form', 'reply_meeting', 'visit_meeting', 'visit_signup');
