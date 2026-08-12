-- Every LIVE campaign states the sales funnel it sells — the last three that did not.
--
-- The funnel used to be written by reading a campaign's GOAL (migration 0042, the boot backfill).
-- That layer is deleted in this ship: the goal is the poorer word (both meeting funnels collapse
-- onto one `meetingBooked`) and it is wrong at the source (brand-service's goal column carried a
-- NOT NULL default, so a brand that never chose one read as selling through website purchases).
-- Creation now REFUSES a sales campaign that does not state its funnel, so no new row can arrive
-- without one — and nothing infers a funnel at runtime any more.
--
-- Three live rows predate that rule (prod, 2026-08-12). Each is written from the funnel set its
-- (org, brand) pair DECLARED in brand-service, and only because that set names EXACTLY ONE active
-- funnel. A pair declaring several is left alone rather than guessed at: a stated funnel is a
-- fact, never a guess.
--
--   1. 9bc27ed7-2fd5-4fb4-b523-026eb919e8ae (org b645207b…, brand 75d7e3e8…) — funnel NULL.
--      Declares only sales_meetings_from_conversation; billing funds exactly that funnel
--      (reply_meeting, $50/day). While its funnel was unknown this brand grew NO funnel campaign
--      at all, so the customer funded a funnel and never got a campaign for it. That is the cost
--      this migration closes, not the empty column.
--   2. 3922c8e1-3405-46af-8a56-1eef3f221b19 (org 5fefaf5a…, brand a179bbd9…) — funnel NULL.
--      Same shape: declares only sales_meetings_from_conversation, funded at $8/day.
--   3. 2d750eda-1ff5-4aed-b3df-374dc58f9ee5 (org 37031b2f…, brand 5878518b…) — funnel
--      sales_meetings_from_conversation, RESTATED to sales_meetings_from_website. This value was
--      not stated by anyone: it was derived from the goal `meetingBooked` by migration 0042, which
--      resolved every booked-meeting goal to the CONVERSATION funnel because the campaigns it was
--      labelling were cold email. That guess is wrong for this pair — it declares only
--      sales_meetings_from_website, and billing funds only that funnel (visit_meeting, $1/day).
--      So today the gate reads this campaign as sitting on an UNFUNDED funnel and blocks every
--      tick: restating it is the fix, not a re-labelling. It is included here for exactly the same
--      reason as the other two (its pair declares one funnel) and for no other.
--
-- What this does NOT touch, on purpose:
--   * `goal` — nothing writes it any more; the rows keep whatever they carry and it is still
--     served. The column is scheduled for removal once its dashboard readers migrate.
--   * STOPPED campaigns. They are history: 682 of them, and a funnel nobody stated for a campaign
--     nobody is running changes nothing about what it did.
--   * status, schedule, budget, audiences, history. Nothing is stopped, resumed, rescheduled or
--     re-budgeted.
--   * any other (org, brand) pair, and any other org's campaigns on the SAME brand — a brand row
--     is a shared global identity and what a customer declares belongs to the (org, brand) pair.
--
-- REVERSIBLE. Every row is recorded in `campaign_funnel_owner_decisions` with the value it
-- replaced, so an operator can read back exactly what was written and undo it:
--
--   SELECT * FROM campaign_funnel_owner_decisions WHERE source = '0047_live_campaign_funnel_from_declaration';
--
--   UPDATE campaigns c
--   SET funnel_key = d.previous_funnel_key
--   FROM campaign_funnel_owner_decisions d
--   WHERE c.id::text = d.campaign_id
--     AND d.source = '0047_live_campaign_funnel_from_declaration'
--     AND c.funnel_key = d.funnel_key;
--
-- IDEMPOTENT: decision rows insert ON CONFLICT DO NOTHING, and each campaign write is guarded on
-- the id AND on the exact value it is replacing, so a re-run (or a second replica booting at the
-- same moment) converges on the same three rows and can never overwrite a funnel something else
-- wrote later.

-- Record the decision first, so the rows it is about to write are readable even if the apply step
-- is interrupted. `campaigns.id` is a uuid in the database while schema.ts declares it text (a
-- historical drift, older than funnels), so the decision row keys on the text spelling and every
-- join casts.
INSERT INTO "campaign_funnel_owner_decisions" (
  "campaign_id", "org_id", "brand_id", "previous_funnel_key", "funnel_key",
  "decided_by", "decided_on", "source"
)
SELECT
  c."id"::text,
  c."org_id",
  c."brand_id",
  c."funnel_key",
  v."funnel_key",
  'brand-declaration',
  DATE '2026-08-12',
  '0047_live_campaign_funnel_from_declaration'
FROM "campaigns" c
JOIN (
  VALUES
    ('9bc27ed7-2fd5-4fb4-b523-026eb919e8ae', NULL, 'sales_meetings_from_conversation'),
    ('3922c8e1-3405-46af-8a56-1eef3f221b19', NULL, 'sales_meetings_from_conversation'),
    ('2d750eda-1ff5-4aed-b3df-374dc58f9ee5', 'sales_meetings_from_conversation', 'sales_meetings_from_website')
) AS v("campaign_id", "expected_funnel_key", "funnel_key")
  ON c."id"::text = v."campaign_id"
WHERE c."status" = 'ongoing'
  -- Only ever writes a row that still carries the value this decision was taken against.
  AND c."funnel_key" IS NOT DISTINCT FROM v."expected_funnel_key"
ON CONFLICT ("campaign_id") DO NOTHING;

UPDATE "campaigns" c
SET "funnel_key" = d."funnel_key",
    "updated_at" = now()
FROM "campaign_funnel_owner_decisions" d
WHERE c."id"::text = d."campaign_id"
  AND d."source" = '0047_live_campaign_funnel_from_declaration'
  AND c."funnel_key" IS NOT DISTINCT FROM d."previous_funnel_key";
