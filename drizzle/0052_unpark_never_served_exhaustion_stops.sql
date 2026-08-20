-- A campaign that served NOTHING was never exhausted — un-park the ones stopped on that verdict.
--
-- /end-run auto-stops a campaign as `audience_exhausted` when it has no serveable audience left.
-- "Nothing left to serve" is also true for a campaign that never had anything to serve, so the
-- test was satisfied trivially at zero: a campaign that had contacted nobody took the same branch
-- as one that had genuinely worked its audiences to the end. 0 of 0 read as 100%.
--
-- That verdict is STICKY. Funding deliberately brings back a campaign that was HELD but never one
-- that stopped for a reason of its own, so `audience_exhausted` parks a campaign indefinitely and
-- the funding sweep says so on every pass ("Not resuming ... it stopped for audience_exhausted").
-- A customer therefore funds a channel that produces nothing, forever, with no manual path back.
--
-- The code half of the fix (src/routes/internal.ts) gates the stop on POSITIVE evidence that
-- outreach actually ran out of people through that campaign: a row in
-- campaign_audience_exhaustion, which is only ever written for a run that named a real audience.
-- A campaign holding none is not stopped at all — it stays ongoing and is rescheduled.
--
-- This file states the SAME rule over the rows that already carry the verdict: a campaign stopped
-- for `audience_exhausted` that has never marked a single audience exhausted was parked on a
-- conclusion about work that never happened, so it goes back to the state the fixed code would
-- have produced — `ongoing`, no stop reason, due now.
--
-- What it selects in prod, read against the live database before this file was written
-- (2026-08-20): the WHOLE stopped-for-exhaustion population is two rows, and both hold zero
-- exhaustion marks.
--
--   4769db14-0a79-4f8e-8b3e-983189d0296d  org b645207b / brand 75d7e3e8
--                                         sales_meetings_from_conversation / feedback_request_email
--                                         created 10:08:01, stopped 10:08:11 the same day —
--                                         the first campaign the per-channel provisioner ever
--                                         created, dead ten seconds after birth having served
--                                         nothing, on a channel the customer funds at $10/day.
--   cb965e9d-211f-4caa-98bb-033102017633  org b645207b / brand ccc29ba2
--                                         website_purchases / crm_email — the brand with 0
--                                         audiences and 0 contacts ever (already documented as
--                                         the one that was wrongly told its outreach had
--                                         finished).
--
-- Neither collides: the partial unique index is on (org, brand, funnel, channel) over `ongoing`
-- rows, and the only live campaign on either brand is 9bc27ed7 (75d7e3e8 / cold_email), a
-- different channel. The exclusion below is stated as a rule anyway, so a re-run can never write
-- a row the index would refuse.
--
-- Returning a campaign to `ongoing` does NOT authorize it to spend: the turn planner holds an
-- unfunded campaign every tick and the gate refuses a run it cannot price. Money keeps deciding
-- what runs — this only removes a verdict about work that never happened.
--
-- IDEMPOTENT: a second run selects nothing (the rows it wrote are no longer stopped). REVERSIBLE
-- by the ids the audit table records.

CREATE TABLE IF NOT EXISTS campaign_stop_reason_decisions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id     text NOT NULL,
  previous_status text,
  previous_reason text,
  new_status      text NOT NULL,
  new_reason      text,
  decided_by      text NOT NULL,
  decided_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_campaign_stop_reason_decisions_campaign
  ON campaign_stop_reason_decisions (campaign_id);

WITH candidates AS (
  SELECT c.id
  FROM campaigns c
  WHERE c.status = 'stopped'
    AND c.stop_reason = 'audience_exhausted'
    -- POSITIVE evidence is what is missing: this campaign never ran out of people in an audience
    -- it actually had, because no run of it ever named one.
    AND NOT EXISTS (
      SELECT 1 FROM campaign_audience_exhaustion e
      WHERE e.campaign_id::text = c.id::text
    )
    -- At most one ongoing campaign per identity. A twin already holding it keeps it; bringing a
    -- second one back is what the partial unique index exists to refuse.
    AND NOT EXISTS (
      SELECT 1 FROM campaigns live
      WHERE live.status = 'ongoing'
        AND live.org_id = c.org_id
        AND live.brand_id IS NOT DISTINCT FROM c.brand_id
        AND live.acquisition_channel IS NOT DISTINCT FROM c.acquisition_channel
        AND coalesce(live.funnel_key, '') = coalesce(c.funnel_key, '')
    )
),
audited AS (
  INSERT INTO campaign_stop_reason_decisions
    (campaign_id, previous_status, previous_reason, new_status, new_reason, decided_by)
  SELECT c.id, c.status, c.stop_reason, 'ongoing', NULL,
         '0052_unpark_never_served_exhaustion_stops'
  FROM campaigns c
  JOIN candidates k ON k.id = c.id
  RETURNING campaign_id
)
UPDATE campaigns c
SET status = 'ongoing',
    stop_reason = NULL,
    -- Due now: the very next tick treats it like any other live campaign, where funding and the
    -- gate decide whether it may actually spend.
    next_run_at = now(),
    updated_at = now()
FROM audited a
WHERE c.id = a.campaign_id;
