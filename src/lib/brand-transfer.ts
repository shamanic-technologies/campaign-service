import { sql, type SQL } from "drizzle-orm";
import { db } from "../db/index.js";
import type { DbTransaction } from "./campaign-status-history.js";

/**
 * Moving a brand from one org to another, WITH ITS HISTORY — the campaign-service half of the
 * fleet contract `POST /internal/transfer-brand`.
 *
 * What this service holds for a brand, and how each row is tied to the org:
 *
 *   campaigns                         org_id + brand_id + brand_ids   moved, brand rewritten
 *   campaign_status_transitions       org_id, through its campaign    moved
 *   campaign_audience_availability    org_id, through its campaign    moved
 *   brand_pause_transitions           org_id + brand_id               moved, brand rewritten
 *   trigger_events                    org_id + brand_id               moved, brand rewritten
 *   trigger_poll_cursors              org_id + brand_id               moved, brand rewritten; a row
 *                                     the target already holds for the same (trigger, offer) wins
 *                                     and the source's is dropped (a schedule, not history: the
 *                                     items seen are trigger_events rows, moved above)
 *   campaigns_funnel_key_snapshot_20260926            org_id + brand_id, per campaign   moved, brand rewritten
 *   campaign_funnel_owner_decisions_funnel_snapshot_20260926  same                       moved, brand rewritten
 *   campaign_audience_exhaustion      NO org column — keyed on the campaign id, which never changes
 *
 * The two `*_snapshot_20260926` tables are rollback snapshots created by migrations 0058 / 0060,
 * not declared in schema.ts; they are moved only where they exist, so a database built by
 * `db:push` (tests) answers the same way as production.
 *
 * Rules:
 * - A campaign is "of this brand" when its brand is the source brand ALONE (`brand_id`, or the
 *   single-element `brand_ids` of the older rows). A co-branded row (two or more brands) belongs to
 *   another brand too, so it is never moved; it is COUNTED and said, never skipped in silence.
 * - The brand id is rewritten only on rows that belong to the TARGET org after the move. A brand
 *   row is a shared global identity (Doc Dinners is claimed by two orgs in production), so a
 *   rewrite that ignored the org would re-brand another org's campaigns.
 * - Nothing about status, money, schedule or configuration is touched: campaign ids are unchanged,
 *   so every sibling service's run, cost and lead keyed on them follows by construction.
 * - One transaction: either every table moves or none does.
 * - Idempotent: a second call finds no row under the source org (and, when a target brand is given,
 *   no row of the source brand under the target org), and reports zeros.
 */

export interface BrandTransferInput {
  sourceBrandId: string;
  sourceOrgId: string;
  targetOrgId: string;
  targetBrandId?: string;
}

export interface BrandTransferResult {
  updatedTables: Array<{ tableName: string; count: number }>;
  /** Campaigns of the source org naming the source brand AND another brand — never moved. */
  coBrandedSkipped: number;
}

export const SNAPSHOT_TABLES = [
  { table: "campaigns_funnel_key_snapshot_20260926", campaignColumn: "id" },
  { table: "campaign_funnel_owner_decisions_funnel_snapshot_20260926", campaignColumn: "campaign_id" },
] as const;

/** The campaign names exactly this brand, and no other one. */
function soloBrand(brandId: string): SQL {
  return sql`(
    (brand_id = ${brandId} OR brand_ids = ARRAY[${brandId}]::text[])
    AND coalesce(cardinality(brand_ids), 0) <= 1
  )`;
}

function countOf(rows: unknown): number {
  return Number((rows as Array<{ cnt: number }>)[0]?.cnt ?? 0);
}

export async function transferBrand(input: BrandTransferInput): Promise<BrandTransferResult> {
  const { sourceBrandId, sourceOrgId, targetOrgId } = input;
  const targetBrandId = input.targetBrandId ?? null;

  // The brand these rows carry once moved — the target brand when one is given.
  const brandAfter = targetBrandId ?? sourceBrandId;
  // Rows that still need work: under the source org, or (merge only) under the target org but
  // still carrying the source brand.
  const pending = (orgColumn: SQL) => targetBrandId
    ? sql`(${orgColumn} = ${sourceOrgId} OR ${orgColumn} = ${targetOrgId})`
    : sql`${orgColumn} = ${sourceOrgId}`;
  // Campaigns of this brand that now sit under the target org — the set every dependent table
  // follows. Covers the source brand (a pure move) and the target brand (after a rewrite).
  const movedCampaignIds = sql`(
    SELECT id::text FROM campaigns
    WHERE org_id = ${targetOrgId}
      AND (${soloBrand(sourceBrandId)} OR ${soloBrand(brandAfter)})
  )`;
  const rewriteBrand = (column: string) => targetBrandId
    ? sql`CASE WHEN ${sql.raw(column)} = ${sourceBrandId} THEN ${targetBrandId} ELSE ${sql.raw(column)} END`
    : sql.raw(column);

  return db.transaction(async (tx: DbTransaction) => {
    const campaignsMoved = countOf(await tx.execute(sql`
      WITH updated AS (
        UPDATE campaigns
        SET org_id = ${targetOrgId},
            brand_id = ${rewriteBrand("brand_id")},
            brand_ids = CASE WHEN brand_ids IS NULL THEN NULL ELSE ARRAY[${brandAfter}]::text[] END,
            updated_at = NOW()
        WHERE ${pending(sql`org_id`)} AND ${soloBrand(sourceBrandId)}
        RETURNING 1
      )
      SELECT count(*)::int AS cnt FROM updated`));

    const coBrandedSkipped = countOf(await tx.execute(sql`
      SELECT count(*)::int AS cnt FROM campaigns
      WHERE org_id = ${sourceOrgId}
        AND ${sourceBrandId} = ANY(brand_ids)
        AND cardinality(brand_ids) > 1`));

    const statusTransitions = countOf(await tx.execute(sql`
      WITH updated AS (
        UPDATE campaign_status_transitions SET org_id = ${targetOrgId}
        WHERE org_id = ${sourceOrgId} AND campaign_id IN ${movedCampaignIds}
        RETURNING 1
      )
      SELECT count(*)::int AS cnt FROM updated`));

    const availability = countOf(await tx.execute(sql`
      WITH updated AS (
        UPDATE campaign_audience_availability SET org_id = ${targetOrgId}
        WHERE org_id = ${sourceOrgId} AND campaign_id IN ${movedCampaignIds}
        RETURNING 1
      )
      SELECT count(*)::int AS cnt FROM updated`));

    const pauseTransitions = countOf(await tx.execute(sql`
      WITH updated AS (
        UPDATE brand_pause_transitions
        SET org_id = ${targetOrgId}, brand_id = ${rewriteBrand("brand_id")}
        WHERE ${pending(sql`org_id`)} AND brand_id = ${sourceBrandId}
        RETURNING 1
      )
      SELECT count(*)::int AS cnt FROM updated`));

    // Trigger events (lib/trigger-events.ts) are keyed on the brand itself, like the pause history.
    const triggerEventsMoved = countOf(await tx.execute(sql`
      WITH updated AS (
        UPDATE trigger_events
        SET org_id = ${targetOrgId}, brand_id = ${rewriteBrand("brand_id")}
        WHERE ${pending(sql`org_id`)} AND brand_id = ${sourceBrandId}
        RETURNING 1
      )
      SELECT count(*)::int AS cnt FROM updated`));

    // Poll schedules (lib/poll-trigger-detector.ts), keyed on the brand like the events they guard.
    const pollCursorsMoved = countOf(await tx.execute(sql`
      WITH updated AS (
        UPDATE trigger_poll_cursors c
        SET org_id = ${targetOrgId}, brand_id = ${rewriteBrand("c.brand_id")}
        WHERE ${pending(sql`c.org_id`)} AND c.brand_id = ${sourceBrandId}
          AND NOT EXISTS (
            SELECT 1 FROM trigger_poll_cursors t
            WHERE t.trigger_id = c.trigger_id AND t.org_id = ${targetOrgId}
              AND t.brand_id = ${brandAfter} AND t.offer_id = c.offer_id AND t.id <> c.id
          )
        RETURNING 1
      )
      SELECT count(*)::int AS cnt FROM updated`));
    await tx.execute(sql`
      DELETE FROM trigger_poll_cursors
      WHERE ${pending(sql`org_id`)} AND brand_id = ${sourceBrandId}
        AND NOT (org_id = ${targetOrgId} AND brand_id = ${brandAfter})`);

    const updatedTables = [
      { tableName: "campaigns", count: campaignsMoved },
      { tableName: "campaign_status_transitions", count: statusTransitions },
      { tableName: "campaign_audience_availability", count: availability },
      { tableName: "brand_pause_transitions", count: pauseTransitions },
      { tableName: "trigger_events", count: triggerEventsMoved },
      { tableName: "trigger_poll_cursors", count: pollCursorsMoved },
    ];

    for (const { table, campaignColumn } of SNAPSHOT_TABLES) {
      const exists = await tx.execute(sql`SELECT to_regclass(${`public.${table}`}) IS NOT NULL AS present`);
      if (!(exists as unknown as Array<{ present: boolean }>)[0]?.present) continue;
      const moved = countOf(await tx.execute(sql`
        WITH updated AS (
          UPDATE ${sql.raw(table)}
          SET org_id = ${targetOrgId}, brand_id = ${rewriteBrand("brand_id")}
          WHERE ${sql.raw(campaignColumn)}::text IN ${movedCampaignIds}
            AND (org_id <> ${targetOrgId} OR brand_id IS DISTINCT FROM ${brandAfter})
            AND ${pending(sql`org_id`)}
          RETURNING 1
        )
        SELECT count(*)::int AS cnt FROM updated`));
      updatedTables.push({ tableName: table, count: moved });
    }

    return { updatedTables, coBrandedSkipped };
  });
}
