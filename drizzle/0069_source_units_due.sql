-- LEADS-ONLY-FUNNEL-CAMPAIGN (owner 2026-10-12, "every pipe is independent"): who dispatches a unit is now the
-- catalogue's reading of its leg (src/lib/on-demand-mode.ts), decided when the scheduler CLAIMS it. Source units used
-- to rest at next_run_at NULL forever (never claimed); give every ONGOING one with a workflow a due time so the
-- scheduler claims it once: one answering on demand is parked on its recheck cadence, one running on its own is
-- dispatched. Status untouched. Idempotent: only rows still NULL are written.
UPDATE "campaigns"
SET "next_run_at" = now()
WHERE "status" = 'ongoing'
  AND "workflow_slug" IS NOT NULL
  AND "next_run_at" IS NULL
  AND "feature_slug" IN (
    'sourcing-apollo-cold-filters',
    'sourcing-apollo-buying-signals',
    'sourcing-linkedin-engagement-signals',
    'sourcing-crm-contacts',
    'lead-sourcing',
    'sourcing-apify-search'
  );
