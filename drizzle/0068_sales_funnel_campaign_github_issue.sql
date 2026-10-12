-- A SALES FUNNEL CAMPAIGN MAY WAIT ON A GITHUB ISSUE (2026-10-12, ISSUE-IN-PROD-TRIGGER-1012).
--
-- The generic trigger kind `github_issue_in_prod` (declared at features-service) fires a funnel campaign's
-- pipe once the issue it waits on is IN PROD: closed as completed by a merge to the default branch, and
-- every deploy target of its repo on the box serving a commit containing that merge
-- (lib/github-issue-trigger.ts). Which issue is a per-campaign fact:
--   - `github_issue`: canonical `owner/repo#number` (lowercased owner/repo), NULL = waits on nothing.
--     Joins the identity: the same funnel + people waiting on another issue is another campaign.
--   - `github_issue_check`: the detector's latest verdict ({state, detail, checkedAt, ...}), a read for
--     callers ("is my follow-up still waiting, and why?"). Never decides anything.
-- The identity index is rebuilt under a temporary name, the old one dropped, then renamed back (the name
-- the code catches on 23505 never changes). Boot-safe: guarded on the index definition, re-runnable.
ALTER TABLE "sales_funnel_campaigns" ADD COLUMN IF NOT EXISTS "github_issue" text;
ALTER TABLE "sales_funnel_campaigns" ADD COLUMN IF NOT EXISTS "github_issue_check" jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE indexname = 'uniq_sales_funnel_campaigns_identity' AND indexdef LIKE '%github_issue%'
  ) THEN
    CREATE UNIQUE INDEX IF NOT EXISTS "uniq_sales_funnel_campaigns_identity_0068"
      ON "sales_funnel_campaigns" ("org_id", "brand_id", "offer_id", "sales_funnel_id", "people_key", coalesce("github_issue", ''));
    DROP INDEX IF EXISTS "uniq_sales_funnel_campaigns_identity";
    ALTER INDEX "uniq_sales_funnel_campaigns_identity_0068" RENAME TO "uniq_sales_funnel_campaigns_identity";
  END IF;
END $$;
