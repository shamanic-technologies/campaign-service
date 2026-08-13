-- A stopped campaign's funnel is NOT inert history — it decides whose totals its history lands in.
--
-- Migration 0047 wrote the funnel of the last three LIVE campaigns and left stopped rows alone, on
-- the premise that "a funnel nobody stated for a campaign nobody is running changes nothing about
-- what it did". That premise is wrong, and this migration corrects it.
--
-- features-service groups a brand's campaigns into families keyed on
-- (org, brand, sales funnel, acquisition channel) and totals each family as ONE customer-visible
-- campaign. A stopped ancestor carrying a NULL funnel does not key onto the live campaign's
-- identity: it becomes a family of its own with no live member, so it renders no line at all —
-- while its runs, spend, leads and replies keep counting at BRAND level. That is the entire gap a
-- customer reads between the two views. Measured in prod on 2026-08-13 for brand 75d7e3e8: the
-- campaign page reported 12 positive replies against the brand's 15, and priced the campaign on
-- $1,246.63 of spend against the brand's $2,057.06 — the missing $810.43 (and ~14,000 leads) sat
-- on 45 stopped ancestors answering to no funnel.
--
-- THE RULE, and it is a fact rule, never a guess — the same standard 0045 and 0047 set:
-- a stopped campaign carrying NO funnel is folded onto the funnel of the live campaign of its
-- (org, brand, acquisition channel), and ONLY when that triple has EXACTLY ONE live campaign
-- stating a funnel. A triple with none, or with several, is left exactly as it is. Nothing is
-- derived from a goal, a name, a workflow slug or a date.
--
-- What that rule selects in prod, verified before this file was written (2026-08-13):
--
--   org b645207b-d8e9-40b0-9391-072b777cd9a9 / brand 75d7e3e8-6926-4f85-a557-976895400666
--   / channel cold_email — one live campaign, 9bc27ed7-2fd5-4fb4-b523-026eb919e8ae, stating
--   sales_meetings_from_conversation (written by 0047) → its 45 stopped ancestors state it too.
--
-- and nothing else, fleet-wide. Every other group is excluded by the rule itself, not by a list:
--   * brand f4d73dab runs TWO live funnels on cold_email — several live, so nothing folds;
--   * brand 5878518b's 5 orphans are held by a DIFFERENT org than its live campaign. A brand row
--     is a shared global identity; what a customer declares belongs to the (org, brand) pair, so
--     another org's campaigns on the same brand are another customer's and are never touched;
--   * every remaining group has no live campaign on that channel at all.
--
-- The rule is written as a rule (not as a list of ids) because it is the reason those rows fold —
-- it states, and the tests pin, exactly which cases are left alone.
--
-- What this does NOT touch, on purpose:
--   * a stopped row whose funnel is already STATED. It answers to an identity already; this
--     migration only ever fills an absence.
--   * `goal`, status, stop_reason, schedule, budget, audiences, history. Nothing is deleted,
--     resumed, rescheduled or re-budgeted — the only column that moves is `funnel_key`.
--   * any LIVE campaign. The partial unique index uniq_campaigns_org_brand_funnel_channel covers
--     ongoing rows only, so writing a funnel onto stopped rows cannot collide with it.
--   * any other org's campaigns on the same brand (see above).
--
-- REVERSIBLE. Every row it writes is recorded in `campaign_funnel_owner_decisions` with the value
-- it replaced, so an operator can read back exactly what was written and undo it:
--
--   SELECT * FROM campaign_funnel_owner_decisions WHERE source = '0048_stopped_ancestors_state_their_campaign_funnel';
--
--   UPDATE campaigns c
--   SET funnel_key = d.previous_funnel_key
--   FROM campaign_funnel_owner_decisions d
--   WHERE c.id::text = d.campaign_id
--     AND d.source = '0048_stopped_ancestors_state_their_campaign_funnel'
--     AND c.funnel_key = d.funnel_key;
--
-- IDEMPOTENT: both statements select only a stopped campaign whose funnel is still NULL, and the
-- decision rows insert ON CONFLICT DO NOTHING. A row this migration has already written states a
-- funnel, so a second run (or a second replica booting at the same moment) selects nothing and
-- changes zero rows.

-- Record the decision first, so the rows it is about to write are readable even if the apply step
-- is interrupted. `campaigns.id` is a uuid in the database while schema.ts declares it text (a
-- historical drift, older than funnels), so the decision row keys on the text spelling and every
-- join casts.
WITH "one_live_funnel" AS (
  -- The (org, brand, channel) triples answering to exactly ONE live campaign that states a funnel.
  SELECT
    "org_id",
    "brand_id",
    "acquisition_channel",
    min("funnel_key") AS "funnel_key"
  FROM "campaigns"
  WHERE "status" = 'ongoing'
    AND "funnel_key" IS NOT NULL
    AND "brand_id" IS NOT NULL
    AND "acquisition_channel" IS NOT NULL
  GROUP BY "org_id", "brand_id", "acquisition_channel"
  HAVING count(*) = 1
)
INSERT INTO "campaign_funnel_owner_decisions" (
  "campaign_id", "org_id", "brand_id", "previous_funnel_key", "funnel_key",
  "decided_by", "decided_on", "source"
)
SELECT
  c."id"::text,
  c."org_id",
  c."brand_id",
  c."funnel_key",
  l."funnel_key",
  'campaign-identity',
  DATE '2026-08-13',
  '0048_stopped_ancestors_state_their_campaign_funnel'
FROM "campaigns" c
JOIN "one_live_funnel" l
  ON c."org_id" = l."org_id"
  AND c."brand_id" = l."brand_id"
  AND c."acquisition_channel" = l."acquisition_channel"
WHERE c."status" = 'stopped'
  AND c."funnel_key" IS NULL
ON CONFLICT ("campaign_id") DO NOTHING;

UPDATE "campaigns" c
SET "funnel_key" = d."funnel_key",
    "updated_at" = now()
FROM "campaign_funnel_owner_decisions" d
WHERE c."id"::text = d."campaign_id"
  AND d."source" = '0048_stopped_ancestors_state_their_campaign_funnel'
  AND c."status" = 'stopped'
  AND c."funnel_key" IS NULL;
