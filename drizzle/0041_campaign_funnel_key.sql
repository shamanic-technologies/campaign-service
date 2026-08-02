-- The sales funnel this campaign works, in brand-service's funnel vocabulary
-- (reply_meeting | visit_meeting | visit_signup | visit_form).
--
-- A customer can now fund each of a brand's sales funnels separately (billing-service
-- brand_funnel_budgets), so a brand's spend is no longer one pot to be won by whichever
-- funnel features-service judged best. One campaign per funded funnel makes "how much did
-- this funnel spend today" answerable from the cost ledger already keyed on campaignId —
-- no new attribution dimension.
--
-- NULL means the campaign is not funnel-scoped: every campaign that predates per-funnel
-- funding keeps NULL and paces exactly as it does today (its own dailyBudgetCents, else the
-- brand-level daily budget, which billing still answers as the SUM of the per-funnel
-- ceilings). Nothing is backfilled: a brand that never declares per-funnel ceilings never
-- grows funnel campaigns.
--
-- Idempotent (IF NOT EXISTS) so a partial-apply replay is safe.
ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "funnel_key" text;

-- One campaign per (org, brand, feature, funnel) is the invariant the scheduler provisions
-- against. brand_ids is a text[] so no unique index can span it; this partial index makes the
-- lookup the provisioner runs every due-tick cheap without pretending to enforce uniqueness
-- (the provisioner uses a SELECT-then-INSERT guarded by the campaigns' unique name index).
CREATE INDEX IF NOT EXISTS "idx_campaigns_org_feature_funnel"
  ON "campaigns" USING btree ("org_id", "feature_slug", "funnel_key")
  WHERE "funnel_key" IS NOT NULL;
