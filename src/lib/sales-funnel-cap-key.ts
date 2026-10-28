import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { salesFunnelCampaigns } from "../db/schema.js";

/**
 * WHICH sales funnel a unit's money is keyed on at billing (FACTORY-P1-FOLLOW-PLAN): its funnel CAMPAIGN's own
 * `sales_funnel_id`, the key the customer stated its caps under. A fixed funnel's unit carries that same id, so
 * nothing changes for it; a unit of a campaign that follows its plan carries the PLAN's funnel (its pipe and play),
 * and its caps must still be read under the campaign's key: never uncapped, never another funnel's cap.
 *
 * A funnel campaign's `sales_funnel_id` moves only through the staff Lead Sourcing respell, so a short cache is
 * safe. A row not found answers the unit's own id (as before this existed).
 */
const TTL_MS = 60_000;
const cache = new Map<string, { at: number; salesFunnelId: string | null }>();

export function resetSalesFunnelCapKeyCache(): void {
  cache.clear();
}

export async function capSalesFunnelIdOf(unitSalesFunnelId: string, salesFunnelCampaignId: string | null | undefined, nowMs: number = Date.now()): Promise<string> {
  if (!salesFunnelCampaignId) return unitSalesFunnelId;
  const hit = cache.get(salesFunnelCampaignId);
  if (hit && nowMs - hit.at < TTL_MS) return hit.salesFunnelId ?? unitSalesFunnelId;
  const [row] = await db
    .select({ salesFunnelId: salesFunnelCampaigns.salesFunnelId })
    .from(salesFunnelCampaigns)
    .where(eq(salesFunnelCampaigns.id, salesFunnelCampaignId))
    .limit(1);
  cache.set(salesFunnelCampaignId, { at: nowMs, salesFunnelId: row?.salesFunnelId ?? null });
  return row?.salesFunnelId ?? unitSalesFunnelId;
}
