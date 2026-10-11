import { inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { salesFunnelCampaigns } from "../db/schema.js";
import { storedPeople, type SalesFunnelCampaignTargeting } from "./sales-funnel-people.js";

/** The reads of lib/sales-funnel-people.ts (kept apart so the rules stay importable without a database). */

/** For each funnel campaign id, what it names (people, instruction). One query. */
export async function targetingOfSalesFunnelCampaigns(
  salesFunnelCampaignIds: readonly string[],
): Promise<Map<string, SalesFunnelCampaignTargeting>> {
  const ids = [...new Set(salesFunnelCampaignIds)];
  const out = new Map<string, SalesFunnelCampaignTargeting>();
  if (ids.length === 0) return out;
  const rows = await db
    .select({
      id: salesFunnelCampaigns.id,
      people: salesFunnelCampaigns.people,
      instruction: salesFunnelCampaigns.instruction,
    })
    .from(salesFunnelCampaigns)
    .where(inArray(salesFunnelCampaigns.id, ids));
  for (const r of rows) out.set(r.id, { people: storedPeople(r.people), instruction: r.instruction ?? null });
  return out;
}

