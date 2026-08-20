-- Migration 0048's rule, applied to the row that became eligible AFTER 0048 ran.
--
-- 0048 folds by rule: a stopped campaign carrying no funnel states the funnel of the live campaign
-- of its (org, brand, acquisition channel), and only where that triple has exactly one live
-- campaign stating one. The rule is right. It ran ONCE, as a migration, against the fleet as it
-- stood on 13 Aug 2026 — and a one-shot migration cannot hold an invariant that new rows keep
-- entering. Nine days later a customer read $53 of spend on an offer and $1.81 on that offer's
-- single live campaign:
--
--   org d3367008-29cd-4dc5-a57e-d0d825bf1630 / brand b97440f6-5822-43de-ad1d-9886723536d6
--   / offer b0cc1851-9813-457d-81d2-1ff3482adb4a / channel cold_email
--
--     2bd9ec88-2714-468f-a42f-2a7575d6dc4a  funnel NULL, stopped, created 29 Jul
--                                           $51.68 net over 1,365 cost rows, 29 Jul -> 6 Aug
--     9570e3ce-dd0d-4181-8e34-c9820df5f54f  sales_meetings_from_conversation, ongoing, created 16 Aug
--                                           $1.81 net over 48 cost rows, 18 Aug
--
--   On 13 Aug 2bd9ec88 was still LIVE and stated no funnel, so 0048 correctly left it alone. On
--   16 Aug the funnel was funded and provisioning INSERTED a twin rather than adopting it (a row
--   at funnel_key NULL can never match `eq(campaigns.funnelKey, f.funnelKey)`). On 19 Aug the
--   ancestor stopped, becoming eligible to the 0048 rule that same moment — and nothing would ever
--   apply it again. features-service therefore files its $51.68 under an identity with no live
--   member: the money counts at brand level and renders on no campaign line at all.
--
-- This migration is the SAME rule with the SAME exclusions, re-stated so it selects what is
-- eligible TODAY. The lasting half of the fix is NOT here: it is
-- src/lib/funnel-ancestor-adoption.ts, which applies the rule on the tick, at the one moment a
-- live funnel identity comes into being for an (org, brand, acquisition channel) — so this is the
-- last time it needs writing as a migration.
--
-- What the rule selects in prod, DRY-RUN against the live database before this file was written
-- (2026-08-20): exactly ONE group, the one above, ONE row — 2bd9ec88. Nothing else fleet-wide.
-- The other 470 stopped funnel-less rows across 17 brands are NOT selected and are NOT touched:
-- none of them has a live sibling stating a funnel on its triple, so there is nothing to fold them
-- onto, and parking them on a funnel now would invent an attribution nobody recorded. They are
-- covered by the runtime half the moment their brand funds a funnel again.
--
-- Every other group is excluded by the rule itself, not by a list:
--   * a triple with SEVERAL live campaigns stating funnels — which one an ancestor ran is unknown;
--   * a triple with NO live campaign at all — nothing to answer to;
--   * a live campaign that states NO funnel — not a funnel to fold onto;
--   * a stopped row that already STATES a funnel — it answers to an identity already, and this
--     only ever fills an absence;
--   * another ORG's campaigns on the same brand row. A brand row is a shared global identity;
--     what a customer declares belongs to the (org, brand) pair, so those are another customer's.
--
-- What this does NOT touch, on purpose:
--   * status. The ancestor stays STOPPED — folding it onto the live member of the identity is the
--     whole point, and resuming it would put a second campaign in the running.
--   * `stop_reason` (NULL on the target row, which is the pre-funnel population), `goal`, schedule,
--     budget, audiences, offer, history. The only column that moves is `funnel_key`.
--   * any LIVE campaign. uniq_campaigns_org_brand_funnel_channel is PARTIAL on `status='ongoing'`
--     — re-verified in prod's pg_indexes on 2026-08-20 rather than taken on trust — so writing a
--     funnel onto stopped rows cannot collide with it.
--
-- REVERSIBLE. Every row it writes is recorded in `campaign_funnel_owner_decisions` with the value
-- it replaced, so an operator can read back exactly what was written and undo it:
--
--   SELECT * FROM campaign_funnel_owner_decisions WHERE source = '0051_stopped_ancestors_state_their_campaign_funnel_again';
--
--   UPDATE campaigns c
--   SET funnel_key = d.previous_funnel_key
--   FROM campaign_funnel_owner_decisions d
--   WHERE c.id::text = d.campaign_id
--     AND d.source = '0051_stopped_ancestors_state_their_campaign_funnel_again'
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
  DATE '2026-08-20',
  '0051_stopped_ancestors_state_their_campaign_funnel_again'
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
  AND d."source" = '0051_stopped_ancestors_state_their_campaign_funnel_again'
  AND c."status" = 'stopped'
  AND c."funnel_key" IS NULL;
