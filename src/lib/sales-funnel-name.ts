/**
 * A SALES FUNNEL NAME FOLLOWS ITS ID (owner 2026-10-13, EPIPHANY-NAME-FOLLOWS-ID-1013): a funnel name is a unique
 * identifier fleet-wide, so a client reading "Epiphany" on a campaign sees the funnel features-service names
 * Epiphany, the same for every client. The name is copied at birth onto the funnel campaign row
 * (`sales_funnel_campaigns.sales_funnel_name`) and into each unit's name prefix (`<name> <idTag> - ...`): any write
 * that moves a funnel campaign's `sales_funnel_id` writes the catalogue's name for the new id in the SAME transaction
 * (`renameSalesFunnelCampaignInTx`).
 *
 * The repair (`runSalesFunnelNameRepair`, `POST /internal/sales-funnel-campaigns/name-repair`, dry run default,
 * idempotent) rewrites a funnel campaign whose stored name differs from the name features-service serves for its
 * EXACT id (2026-10-11: the Lead Sourcing switch moved 6 funnel campaigns to the funnel named "Philanthropy" and left
 * them reading "Epiphany"). Never touched:
 *   - a LEGACY id (the catalogue answers it with another id): its stored name is the resolved funnel's, reported only;
 *   - an unreadable catalogue: skipped and logged, never a guessed name.
 * Nothing else moves (no status, no billing write). Unit names are unique per org: a collision is a named error and
 * that funnel campaign is rolled back.
 */
import { and, eq, inArray, notInArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { campaigns, salesFunnelCampaigns } from "../db/schema.js";
import { fetchSalesFunnel } from "./sales-funnel-catalogue-client.js";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** PURE: the unit name under the new funnel name, or null when the unit does not carry the funnel's prefix. */
export function renamedUnitName(unitName: string, salesFunnelCampaignId: string, fromName: string, toName: string): string | null {
  const prefix = `${fromName} ${salesFunnelCampaignId.slice(0, 8)} - `;
  if (!unitName.startsWith(prefix)) return null;
  return `${toName} ${salesFunnelCampaignId.slice(0, 8)} - ${unitName.slice(prefix.length)}`;
}

export interface UnitRename {
  campaignId: string;
  from: string;
  to: string;
}

/**
 * Inside `tx`: the funnel campaign reads `toName` and every unit carrying its prefix is renamed; `salesFunnelId`
 * moves too when given (row + every unit). Throws `unit_name_taken` when a new unit name already exists in the org.
 */
export async function renameSalesFunnelCampaignInTx(
  tx: Tx,
  salesFunnelCampaignId: string,
  toName: string,
  salesFunnelId?: string,
): Promise<UnitRename[]> {
  const [parent] = await tx.select().from(salesFunnelCampaigns).where(eq(salesFunnelCampaigns.id, salesFunnelCampaignId)).for("update");
  if (!parent) throw new Error(`sales funnel campaign ${salesFunnelCampaignId} not found`);
  const units = await tx.select({ id: campaigns.id, name: campaigns.name }).from(campaigns).where(eq(campaigns.salesFunnelCampaignId, parent.id));
  const renames = units.flatMap((u) => {
    const to = renamedUnitName(u.name, parent.id, parent.salesFunnelName, toName);
    return to !== null && to !== u.name ? [{ campaignId: u.id, from: u.name, to }] : [];
  });
  if (renames.length > 0) {
    const taken = await tx
      .select({ id: campaigns.id, name: campaigns.name })
      .from(campaigns)
      .where(and(eq(campaigns.orgId, parent.orgId), inArray(campaigns.name, renames.map((r) => r.to)), notInArray(campaigns.id, units.map((u) => u.id))));
    if (taken.length > 0) {
      throw new Error(`unit_name_taken: org ${parent.orgId} already holds ${taken.map((t) => `"${t.name}" (${t.id})`).join(", ")}`);
    }
  }
  const now = new Date();
  await tx
    .update(salesFunnelCampaigns)
    .set({ salesFunnelName: toName, ...(salesFunnelId ? { salesFunnelId } : {}), updatedAt: now })
    .where(eq(salesFunnelCampaigns.id, parent.id));
  if (salesFunnelId) {
    await tx.update(campaigns).set({ salesFunnelId, updatedAt: now }).where(eq(campaigns.salesFunnelCampaignId, parent.id));
  }
  for (const r of renames) await tx.update(campaigns).set({ name: r.to, updatedAt: now }).where(eq(campaigns.id, r.campaignId));
  return renames;
}

export interface NameRepairItem {
  salesFunnelCampaignId: string;
  orgId: string;
  brandId: string;
  salesFunnelId: string;
  from: string;
  to: string;
  units: UnitRename[];
  error?: string;
}

export interface NameRepairSkip {
  salesFunnelCampaignId: string;
  salesFunnelId: string;
  storedName: string;
  reason: string;
}

export interface NameRepairResult {
  applied: boolean;
  renamed: NameRepairItem[];
  skipped: NameRepairSkip[];
}

export async function runSalesFunnelNameRepair(opts: {
  apply: boolean;
  orgId?: string;
  fetchFunnel?: typeof fetchSalesFunnel;
}): Promise<NameRepairResult> {
  const fetchFunnel = opts.fetchFunnel ?? fetchSalesFunnel;
  const parents = await db.select().from(salesFunnelCampaigns).where(opts.orgId ? eq(salesFunnelCampaigns.orgId, opts.orgId) : undefined);
  const reads = new Map<string, Awaited<ReturnType<typeof fetchSalesFunnel>>>();
  const result: NameRepairResult = { applied: opts.apply, renamed: [], skipped: [] };

  for (const parent of parents) {
    if (!reads.has(parent.salesFunnelId)) reads.set(parent.salesFunnelId, await fetchFunnel(parent.salesFunnelId));
    const read = reads.get(parent.salesFunnelId)!;
    const skip = (reason: string) => result.skipped.push({ salesFunnelCampaignId: parent.id, salesFunnelId: parent.salesFunnelId, storedName: parent.salesFunnelName, reason });
    if (!read.ok) {
      console.error(`[campaign-service] Sales funnel name repair: funnel ${parent.salesFunnelId} of ${parent.id} unreadable, not renamed: ${read.detail}`);
      skip(`funnel_unreadable: ${read.detail}`);
      continue;
    }
    if (read.value.name === parent.salesFunnelName) continue;
    if (read.value.id !== parent.salesFunnelId) {
      // A legacy id: features-service answers it with another funnel; its name is that funnel's, never rewritten here.
      skip(`legacy_id_resolves_to ${read.value.id} (${read.value.name})`);
      continue;
    }
    const units = await db.select({ id: campaigns.id, name: campaigns.name }).from(campaigns).where(eq(campaigns.salesFunnelCampaignId, parent.id));
    const item: NameRepairItem = {
      salesFunnelCampaignId: parent.id,
      orgId: parent.orgId,
      brandId: parent.brandId,
      salesFunnelId: parent.salesFunnelId,
      from: parent.salesFunnelName,
      to: read.value.name,
      units: units.flatMap((u) => {
        const to = renamedUnitName(u.name, parent.id, parent.salesFunnelName, read.value.name);
        return to !== null ? [{ campaignId: u.id, from: u.name, to }] : [];
      }),
    };
    if (opts.apply) {
      try {
        item.units = await db.transaction((tx) => renameSalesFunnelCampaignInTx(tx, parent.id, read.value.name));
        console.log(`[campaign-service] Sales funnel name repair: ${parent.id} "${item.from}" -> "${item.to}" (${item.units.length} units)`);
      } catch (err) {
        item.error = err instanceof Error ? err.message : String(err);
        console.error(`[campaign-service] Sales funnel name repair of ${parent.id} failed, rolled back: ${item.error}`);
      }
    }
    result.renamed.push(item);
  }
  return result;
}
