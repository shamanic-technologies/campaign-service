-- Rewrite the goal a campaign STATES into the funnel it runs.
--
-- A campaign used to say what it was for in the goal vocabulary; brand-service now speaks
-- funnels, and consumers must read the funnel off the campaign row rather than infer it from a
-- goal. This is the stored-data half of that move: every campaign that states a goal naming one
-- funnel gets that funnel written onto it.
--
--   form submissions  -> visit_form     (Form Magnet)
--   booked meeting    -> reply_meeting  (Sales Meeting from Conversation — these campaigns are
--                                        cold email, so the chain that ran is reply then
--                                        meeting, never the website one; owner-decided
--                                        2026-08-02)
--   website purchase  -> visit_signup   (Website Purchase)
--
-- Every legacy spelling brand-service still accepts on write is listed, because a stored row may
-- carry any of them. A goal that names no single funnel is deliberately absent and keeps a NULL
-- funnel: `combinedSales` spans several funnels, and `websiteVisit` / `positiveReply` /
-- `whatsappConversation` stop short of a paid client. A funnel is a fact, never a guess.
--
-- The campaigns that state NO goal at all (they run on their brand's goal) are stamped by the
-- boot pass in `src/lib/funnel-backfill.ts`, which can read brand-service; SQL cannot.
--
-- Only touches rows whose funnel is still NULL, so it is idempotent and re-runnable, and it
-- neither deletes, stops nor reschedules anything.
UPDATE "campaigns"
SET "funnel_key" = CASE "goal"
    WHEN 'formSubmission'       THEN 'visit_form'
    WHEN 'form_submissions'     THEN 'visit_form'
    WHEN 'meetingBooked'        THEN 'reply_meeting'
    WHEN 'booked_meetings'      THEN 'reply_meeting'
    WHEN 'sales_meetings'       THEN 'reply_meeting'
    WHEN 'signup'               THEN 'visit_signup'
    WHEN 'signups'              THEN 'visit_signup'
    WHEN 'websitePurchase'      THEN 'visit_signup'
    WHEN 'website_purchase'     THEN 'visit_signup'
    WHEN 'purchase'             THEN 'visit_signup'
    WHEN 'sales'                THEN 'visit_signup'
  END
WHERE "funnel_key" IS NULL
  AND "goal" IN (
    'formSubmission', 'form_submissions',
    'meetingBooked', 'booked_meetings', 'sales_meetings',
    'signup', 'signups', 'websitePurchase', 'website_purchase', 'purchase', 'sales'
  );
