import { sql, and, eq, inArray, type SQL } from "drizzle-orm";
import { db } from "../db/index.js";
import { brandPause, campaigns } from "../db/schema.js";

/**
 * SQL predicate: the campaign is NOT held by a brand pause.
 *
 * A campaign is HELD when ANY brandId in its `brand_ids` array belongs to a paused brand
 * (brand_pause.paused = true) in the SAME org. This clause is the negation — true for
 * campaigns that should still run.
 *
 * Injected into every scheduler query that filters status='ongoing' (reRunDueCampaigns claim,
 * claimStuckCampaigns, loadOngoingSnapshot) so a paused brand's campaigns are excluded
 * atomically via a LOCAL join — no per-tick HTTP. When the brand un-pauses, the row flips and
 * those campaigns are picked up again on the next tick with zero re-launch.
 *
 * The inner subquery is self-contained (its own alias `c`), so it composes identically inside
 * a core UPDATE, a core SELECT, and a relational findMany regardless of the outer query's alias.
 */
export function notPausedBrandClause(): SQL {
  return sql`${campaigns.id} NOT IN (
    SELECT c.id FROM ${campaigns} c
    JOIN ${brandPause} bp
      ON bp.org_id = c.org_id
      AND bp.paused = true
      AND bp.brand_id = ANY(c.brand_ids)
  )`;
}

/**
 * Does ANY of the given brands belong to a paused brand in this org?
 *
 * Single-campaign equivalent of notPausedBrandClause, used by gate-check to HOLD a campaign
 * whose run was already in flight when its brand was paused. Org-scoped so a pause in one org
 * can never hold another org's campaign.
 */
export async function anyBrandPaused(orgId: string, brandIds: string[]): Promise<boolean> {
  if (brandIds.length === 0) return false;
  const rows = await db
    .select({ brandId: brandPause.brandId })
    .from(brandPause)
    .where(
      and(
        eq(brandPause.orgId, orgId),
        eq(brandPause.paused, true),
        inArray(brandPause.brandId, brandIds),
      ),
    )
    .limit(1);
  return rows.length > 0;
}
