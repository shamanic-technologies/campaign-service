-- A sales campaign row states the money that actually governs it, and nothing else.
--
-- gate-check runs the whole campaign-budget-windows block under `if (!isSalesFeature)`, so a
-- `max_budget_*` on a sales-family row is inert BY CONSTRUCTION: the sales family paces on
-- billing's per-(funnel, channel, offer) ceiling, read live on every plan. Correct behaviour,
-- silent presentation — the column shows a dollar ceiling that decides nothing.
--
-- It already misled a live diagnosis (#396): `max_budget_daily_usd | 10.00` on a campaign whose
-- real ceiling was $50 read as a stale mirror and cost a detour before `fundingFromBudgets`
-- confirmed billing was authoritative. The next person reading a sales row hits the same thing.
--
-- The values are LEGACY, from before the funnel model: nothing writes them today (provisioning
-- inserts sales campaigns with the columns null, the dashboard writes billing), and since the
-- code half of this fix the create/update routes REFUSE them for the sales family, so no new one
-- can appear. `daily_budget_cents` — the mirror `fundingFromBudgets` prefers over billing — is
-- untouched here and was verified null on all 22 live sales campaigns; this changes no pacing.
--
-- Measured on prod, 2026-08-24, scoped to the three sales-family feature slugs:
--
--   status    rows   max_budget_daily_usd set   weekly/monthly/total set
--   ongoing     22                         18                          2
--   stopped    358                        117                        231
--
-- NON-SALES campaigns are left exactly alone: for them the column is live and gate-check enforces
-- it. The column itself is never dropped for the same reason.
--
-- IDEMPOTENT: a second run selects nothing (every sales row is already null on all four).
-- REVERSIBLE by the previous values the audit table records, per campaign.

CREATE TABLE IF NOT EXISTS campaign_max_budget_decisions (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id               text NOT NULL,
  feature_slug              text,
  status                    text,
  previous_daily_usd        numeric(10, 2),
  previous_weekly_usd       numeric(10, 2),
  previous_monthly_usd      numeric(10, 2),
  previous_total_usd        numeric(10, 2),
  migration_tag             text NOT NULL,
  decided_at                timestamptz NOT NULL DEFAULT now()
);

WITH inert AS (
  SELECT id, feature_slug, status,
         max_budget_daily_usd, max_budget_weekly_usd, max_budget_monthly_usd, max_budget_total_usd
  FROM campaigns
  WHERE feature_slug IN (
          'sales-cold-email-outreach',
          'sales-crm-email-outreach',
          'feedback-request-cold-email-outreach'
        )
    AND (
          max_budget_daily_usd IS NOT NULL
       OR max_budget_weekly_usd IS NOT NULL
       OR max_budget_monthly_usd IS NOT NULL
       OR max_budget_total_usd IS NOT NULL
        )
), audited AS (
  INSERT INTO campaign_max_budget_decisions (
    campaign_id, feature_slug, status,
    previous_daily_usd, previous_weekly_usd, previous_monthly_usd, previous_total_usd,
    migration_tag
  )
  SELECT id::text, feature_slug, status,
         max_budget_daily_usd, max_budget_weekly_usd, max_budget_monthly_usd, max_budget_total_usd,
         '0053_null_inert_sales_max_budgets'
  FROM inert
  RETURNING campaign_id
)
UPDATE campaigns c
SET max_budget_daily_usd   = NULL,
    max_budget_weekly_usd  = NULL,
    max_budget_monthly_usd = NULL,
    max_budget_total_usd   = NULL,
    updated_at             = now()
FROM audited a
WHERE c.id::text = a.campaign_id;
