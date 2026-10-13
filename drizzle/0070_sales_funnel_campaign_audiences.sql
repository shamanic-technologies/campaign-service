-- A SALES FUNNEL CAMPAIGN STATES THE AUDIENCES IT WORKS (2026-10-13, LEAK-1012 part 2).
--
-- Two funnels of one offer on the same lead source (sourcing-crm-contacts) each walked EVERY audience of the
-- offer: one took 73 people of the other's audience. The audiences are now the funnel campaign's own fact,
-- copied onto every unit's `campaigns.audience_ids` (the hard subset lead-service and the bandit already
-- read). NULL = names none (units inherit the brand's audiences, unchanged). Not part of the identity:
-- restating them on the same funnel campaign rewrites them, never creates another. Boot-safe, re-runnable.
ALTER TABLE "sales_funnel_campaigns" ADD COLUMN IF NOT EXISTS "audience_ids" text[];
