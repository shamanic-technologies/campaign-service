import { sql } from "drizzle-orm";
import { db } from "../db/index.js";

/**
 * A stopped campaign's funnel is NOT inert history — it decides whose totals its history lands in.
 *
 * features-service groups a brand's campaigns into families keyed on
 * (org, brand, sales funnel, acquisition channel) and totals each family as ONE customer-visible
 * campaign. A stopped ancestor carrying a NULL funnel does not key onto the live campaign's
 * identity: it becomes a family of its own with no live member, so it renders no line at all —
 * while its runs, spend, leads and replies keep counting at BRAND level. That gap is exactly what
 * a customer reads between the offer view and the campaign view.
 *
 * Migration 0048 wrote that rule as a ONE-SHOT migration, against the fleet as it stood on 13 Aug.
 * That cannot hold the invariant, and the recurrence proved it in nine days:
 *
 *   org d3367008 / brand b97440f6 / cold_email
 *     2bd9ec88  funnel NULL, stopped 19 Aug, $51.68 of spend over 1,365 cost rows
 *     9570e3ce  sales_meetings_from_conversation, ongoing since 16 Aug, $1.81
 *
 *   On 13 Aug 2bd9ec88 was still LIVE and stated no funnel, so 0048 correctly left it alone. On
 *   16 Aug the funnel was funded and provisioning INSERTED a twin (a row at funnel_key NULL can
 *   never match `eq(campaigns.funnelKey, f.funnelKey)`). On 19 Aug the ancestor stopped. It became
 *   eligible to the 0048 rule the moment it did, and nothing would ever apply it again.
 *
 * So the rule lives HERE, on the tick, and is applied at the one moment a new funnel identity
 * comes into being for an (org, brand, acquisition channel): when a funnel campaign is provisioned
 * for it. The 471 stopped funnel-less rows still out there across 17 brands are covered the moment
 * their brand funds a funnel again — which is the only moment the rule can select them anyway,
 * because it needs a live sibling stating a funnel to fold onto.
 *
 * THE RULE, byte-for-byte the one migration 0048 states, and it is a fact rule, never a guess:
 * a stopped campaign carrying NO funnel is folded onto the funnel of the live campaign of its
 * (org, brand, acquisition channel), and ONLY when that triple has EXACTLY ONE live campaign
 * stating a funnel. A triple with none, or with several, is left exactly as it is. Nothing is
 * derived from a goal, a name, a workflow slug or a date.
 *
 * What it never touches, on purpose:
 *   - a stopped row whose funnel is already STATED. It answers to an identity already; this only
 *     ever fills an absence.
 *   - `goal`, status, stop_reason, schedule, budget, audiences, offer, history. The only column
 *     that moves is `funnel_key`. In particular the ancestor stays STOPPED: folding it onto the
 *     live member of the identity is the whole point, and resuming it would put a second campaign
 *     in the running.
 *   - any LIVE campaign. uniq_campaigns_org_brand_funnel_channel is PARTIAL on `status='ongoing'`
 *     (re-verified in prod's pg_indexes on 2026-08-20), so writing a funnel onto stopped rows
 *     cannot collide with it.
 *   - any other org's campaigns on the same brand row. A brand row is a shared global identity;
 *     what a customer declares belongs to the (org, brand) pair, so another org's campaigns on the
 *     same brand are another customer's.
 */

/** The handle an operator reads back and undoes runtime adoptions by. */
export const ANCESTOR_ADOPTION_SOURCE = "runtime-funnel-campaign-provisioning";

/** Who the decision is attributed to — the same author 0045/0047/0048 record. */
const DECIDED_BY = "campaign-identity";

/** The (org, brand, acquisition channel) a funnel campaign has just been provisioned for. */
export interface AncestorAdoptionScope {
  orgId: string;
  brandId: string;
  acquisitionChannel: string;
}

/**
 * Fold the funnel-less stopped ancestors of ONE (org, brand, acquisition channel) onto the funnel
 * of its single live campaign.
 *
 * Returns how many rows were written — zero on every ordinary tick, which is why nothing is logged
 * on that path (a per-tick line for every campaign of every client buries real signal, and the
 * decision is already durable in `campaign_funnel_owner_decisions` when it is not zero).
 *
 * IDEMPOTENT by construction: both statements select only a stopped campaign whose funnel is still
 * NULL, and the decision rows insert ON CONFLICT DO NOTHING. A row this has already written states
 * a funnel, so a second call selects nothing and changes zero rows.
 *
 * REVERSIBLE: every write records the value it replaced.
 *
 *   SELECT * FROM campaign_funnel_owner_decisions WHERE source = 'runtime-funnel-campaign-provisioning';
 *
 *   UPDATE campaigns c
 *   SET funnel_key = d.previous_funnel_key
 *   FROM campaign_funnel_owner_decisions d
 *   WHERE c.id::text = d.campaign_id
 *     AND d.source = 'runtime-funnel-campaign-provisioning'
 *     AND c.funnel_key = d.funnel_key;
 */
export async function adoptFunnellessAncestors(
  scope: AncestorAdoptionScope,
  now: Date = new Date(),
): Promise<number> {
  const decidedOn = now.toISOString().slice(0, 10);

  // Record the decision FIRST, so the rows about to be written are readable even if the apply step
  // is interrupted. `campaigns.id` is a uuid in the database while schema.ts declares it text (a
  // historical drift, older than funnels), so the decision row keys on the text spelling and every
  // join casts.
  await db.execute(sql`
    WITH "one_live_funnel" AS (
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
        AND "org_id" = ${scope.orgId}
        AND "brand_id" = ${scope.brandId}
        AND "acquisition_channel" = ${scope.acquisitionChannel}
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
      ${DECIDED_BY},
      ${decidedOn}::date,
      ${ANCESTOR_ADOPTION_SOURCE}
    FROM "campaigns" c
    JOIN "one_live_funnel" l
      ON c."org_id" = l."org_id"
      AND c."brand_id" = l."brand_id"
      AND c."acquisition_channel" = l."acquisition_channel"
    WHERE c."status" = 'stopped'
      AND c."funnel_key" IS NULL
    ON CONFLICT ("campaign_id") DO NOTHING
  `);

  const applied = await db.execute<{ id: string }>(sql`
    UPDATE "campaigns" c
    SET "funnel_key" = d."funnel_key",
        "updated_at" = now()
    FROM "campaign_funnel_owner_decisions" d
    WHERE c."id"::text = d."campaign_id"
      AND d."source" = ${ANCESTOR_ADOPTION_SOURCE}
      AND c."org_id" = ${scope.orgId}
      AND c."brand_id" = ${scope.brandId}
      AND c."acquisition_channel" = ${scope.acquisitionChannel}
      AND c."status" = 'stopped'
      AND c."funnel_key" IS NULL
    RETURNING c."id"
  `);

  return Array.isArray(applied) ? applied.length : 0;
}

/**
 * Fail-SOFT wrapper for the provisioning tick.
 *
 * Adoption is an ATTRIBUTION correction: it decides whose totals a stopped row's history lands in,
 * and it spends nothing and starts nothing. A failure must never hold up the provisioning that
 * called it — the funded funnel still needs its campaign — so the error is said out loud once and
 * the next tick tries again.
 */
export async function adoptFunnellessAncestorsSafely(
  scope: AncestorAdoptionScope,
  now: Date = new Date(),
): Promise<number> {
  try {
    const adopted = await adoptFunnellessAncestors(scope, now);
    if (adopted > 0) {
      console.log(
        `[campaign-service] ${adopted} stopped campaign(s) of brand ${scope.brandId} (org ${scope.orgId}, channel ${scope.acquisitionChannel}) now state the funnel of their live campaign — their spend and replies total onto it`,
      );
    }
    return adopted;
  } catch (err) {
    console.warn(
      `[campaign-service] Could not fold the funnel-less stopped campaigns of brand ${scope.brandId} (org ${scope.orgId}, channel ${scope.acquisitionChannel}) onto their live campaign's funnel:`,
      err,
    );
    return 0;
  }
}
