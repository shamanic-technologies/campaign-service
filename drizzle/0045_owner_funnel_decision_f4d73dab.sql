-- The funnel of a brand that sells through several is UNKNOWN — until its owner answers it.
--
-- Migration 0042 and the boot backfill both read a campaign's goal to write the funnel it runs,
-- and both deliberately stopped at a goal naming no single funnel. `combinedSales` is that case:
-- it spans several funnels, so a campaign running on it keeps a NULL funnel, because the funnel
-- is a stored fact and never a guess. That branch is correct and stays for every brand nobody
-- has answered for.
--
-- For ONE (org, brand) pair the owner has now answered it. Kevin, 2026-08-02, on
-- org f0420eb5-8f72-4f0a-a150-f473746df1e6 / brand f4d73dab-1f9d-49b2-b16e-63ecde76a5eb:
--
--   * the brand optimized WEBSITE PURCHASES from the start, and switched to SALES MEETINGS FROM
--     CONVERSATION on 19 July 2026. It did NOT create a new campaign to do so — the same campaign
--     kept running under a new goal, so no campaign row marks the transition;
--   * the live campaign d5a759bf-6729-4325-b3cd-f1ff357d0538 (created 15 June) therefore states
--     `sales_meetings_from_conversation`;
--   * every one of the pair's STOPPED sales campaigns states `website_purchases`.
--
-- A run-date split is what the truth would require, and the owner was shown it and declined: he
-- does not want a campaign's history cut in two. The funnel stays ONE value per campaign, and the
-- accepted cost is recorded here so nobody "fixes" it later: 33,229 of d5a759bf's 54,809 runs
-- predate the switch and sit under the meeting funnel. The distortion is one-directional — a
-- meeting reads MORE expensive than it was, never less.
--
-- What this does NOT touch, on purpose:
--   * `goal` — the campaigns state none and keep stating none. The funnel is what a consumer
--     reads; writing a goal would change what the runtime optimizes, which is not a labelling
--     decision and was not asked for.
--   * status, schedule, budget, history. Nothing is deleted, stopped, rescheduled or re-budgeted.
--   * the brand's PR, AI-visibility and VC campaigns: they run no sales funnel, and a NULL funnel
--     is the true statement for them.
--   * the same brand's campaigns under OTHER orgs. A brand row is a shared global identity — four
--     orgs claim this one — and everything configured on top of it belongs to the (org, brand)
--     pair. The owner answered for HIS pair; the three stopped campaigns other orgs hold on this
--     brand are other customers' and keep a NULL funnel.
--   * every OTHER brand still sitting in the same unattributable state. None of them has been
--     answered for, and this migration names exactly one pair.
--
-- REVERSIBLE. Every row it writes is recorded in `campaign_funnel_owner_decisions` with the value
-- it replaced, so an operator can read back exactly what was written and undo it:
--
--   SELECT * FROM campaign_funnel_owner_decisions WHERE source = '0045_owner_funnel_decision_f4d73dab';
--
--   UPDATE campaigns c
--   SET funnel_key = d.previous_funnel_key
--   FROM campaign_funnel_owner_decisions d
--   WHERE c.id::text = d.campaign_id
--     AND d.source = '0045_owner_funnel_decision_f4d73dab'
--     AND c.funnel_key = d.funnel_key;
--
-- IDEMPOTENT: the decision rows are inserted ON CONFLICT DO NOTHING and the campaign write only
-- ever touches a row whose funnel is still NULL, so a re-boot (or a second replica booting at the
-- same moment) re-runs it for free and converges on the same rows.

CREATE TABLE IF NOT EXISTS "campaign_funnel_owner_decisions" (
  "campaign_id" text PRIMARY KEY,
  "org_id" text NOT NULL,
  "brand_id" text,
  "previous_funnel_key" text,
  "funnel_key" text NOT NULL,
  "decided_by" text NOT NULL,
  "decided_on" date NOT NULL,
  "source" text NOT NULL,
  "applied_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_cfod_source" ON "campaign_funnel_owner_decisions" ("source");

-- Record the decision first, so the rows it is about to write are readable even if the apply step
-- is interrupted.
INSERT INTO "campaign_funnel_owner_decisions" (
  "campaign_id", "org_id", "brand_id", "previous_funnel_key", "funnel_key",
  "decided_by", "decided_on", "source"
)
-- `campaigns.id` is a uuid in the database while `schema.ts` declares it text (a historical
-- drift, older than funnels). The decision row keys on the text spelling so this table matches
-- what Drizzle materializes, and every join casts — never compare the two raw.
SELECT
  c."id"::text,
  c."org_id",
  c."brand_id",
  c."funnel_key",
  CASE WHEN c."id" = 'd5a759bf-6729-4325-b3cd-f1ff357d0538'
    THEN 'sales_meetings_from_conversation'
    ELSE 'website_purchases'
  END,
  'kevin',
  DATE '2026-08-02',
  '0045_owner_funnel_decision_f4d73dab'
FROM "campaigns" c
WHERE c."org_id" = 'f0420eb5-8f72-4f0a-a150-f473746df1e6'
  AND c."brand_id" = 'f4d73dab-1f9d-49b2-b16e-63ecde76a5eb'
  AND c."feature_slug" IN ('sales-cold-email-outreach', 'sales-crm-email-outreach')
  AND c."funnel_key" IS NULL
ON CONFLICT ("campaign_id") DO NOTHING;

-- Apply it. The `funnel_key IS NULL` guard is what makes a second run a no-op, and it also means a
-- funnel written by anything else later is never overwritten by this pass.
UPDATE "campaigns" c
SET "funnel_key" = d."funnel_key",
    "updated_at" = now()
FROM "campaign_funnel_owner_decisions" d
WHERE c."id"::text = d."campaign_id"
  AND d."source" = '0045_owner_funnel_decision_f4d73dab'
  AND c."funnel_key" IS NULL;
