import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { campaigns, salesFunnelCampaigns } from "../db/schema.js";
import { fetchChannelCatalogue } from "./channel-operator-client.js";
import { insertSalesFunnelUnits, type SalesFunnelUnitBirth } from "./campaign-status-history.js";
import { sameLeg, storedLegKey } from "./leg-identity.js";
import { acquisitionChannelForFeature, derivedCampaignName } from "./campaign-identity.js";
import { fetchPipe, fetchSalesFunnel, isSourcingLeg, legsWithoutChannel } from "./sales-funnel-catalogue-client.js";

/** A pipe of the funnel the CUSTOMER's own team works ("Your team"): a unit with no workflow. */
export interface CustomerPipe {
  featureSlug: string;
  legKey: string;
}

/** The unit births of a funnel campaign's "Your team" pipes (no workflow: the customer works them). */
export function customerUnitBirths(
  parent: { id: string; brandId: string; offerId: string; salesFunnelName: string },
  pipes: CustomerPipe[],
): SalesFunnelUnitBirth[] {
  const idTag = parent.id.slice(0, 8);
  return pipes.map((p) => ({
    featureSlug: p.featureSlug,
    legKey: storedLegKey(p.featureSlug, p.legKey),
    workflowSlug: null,
    acquisitionChannel: acquisitionChannelForFeature(p.featureSlug)!,
    // Same name as a launch gives it (names are unique per org; the funnel id keeps funnels apart).
    name: `${parent.salesFunnelName} ${idTag} - ${derivedCampaignName(p.featureSlug, parent.brandId, parent.offerId, p.legKey)}`,
  }));
}

/**
 * EVERY LEG OF A FUNNEL CAMPAIGN HAS ITS CHANNEL (owner 2026-10-11: "a sales funnel never has a
 * leg without a channel; a human leg is the channel Your team; one straight line from Start, or a
 * trigger, to paid client").
 *
 * The 2026-10-10 conversion linked the live rows of a funnel and nothing else, so a converted
 * funnel campaign had no unit on its "Your team" legs (Shockwavecenters, Bliss: cold email, then
 * no channel on conversation → meeting booked; 3 interested prospects waited days). This pass
 * gives every funnel campaign a unit on each leg its catalogue funnel names:
 *   - a "Your team" pipe with no unit   → born, no workflow, in the funnel's status (source
 *     `sales_funnel`). It runs nothing and spends nothing; it states who works the leg.
 *   - a PLATFORM pipe with no unit      → listed, never created here (it would run and spend:
 *     a person's act, through the funnel launch).
 *   - a leg the catalogue names NOTHING on (not a lead-source leg) → listed: the funnel itself
 *     has a hole, features-service's to fix.
 * Sourcing legs are left to the sources rules (lib/source-campaigns.ts). Dry run by default;
 * idempotent (a leg with its unit is skipped).
 */

export interface UnitCompletion {
  salesFunnelCampaignId: string;
  orgId: string;
  brandId: string;
  salesFunnelId: string;
  status: string;
  added: CustomerPipe[];
  missingPlatformPipes: string[];
  legsWithoutChannel: string[];
  error?: string;
}

export async function completeSalesFunnelUnits(opts: { apply: boolean; orgId?: string }): Promise<{
  applied: boolean;
  funnelCampaigns: UnitCompletion[];
  counts: { funnelCampaigns: number; incomplete: number; unitsAdded: number; unresolved: number };
}> {
  const catalogue = await fetchChannelCatalogue();
  if (!catalogue.ok) throw new Error(`channel catalogue unreadable: ${catalogue.detail}`);
  const parents = await db
    .select()
    .from(salesFunnelCampaigns)
    .where(opts.orgId ? eq(salesFunnelCampaigns.orgId, opts.orgId) : undefined);

  const out: UnitCompletion[] = [];
  for (const parent of parents) {
    const funnel = await fetchSalesFunnel(parent.salesFunnelId);
    if (!funnel.ok) throw new Error(`sales funnel ${parent.salesFunnelId} unreadable: ${funnel.detail}`);
    const units = await db
      .select()
      .from(campaigns)
      .where(and(eq(campaigns.orgId, parent.orgId), eq(campaigns.salesFunnelCampaignId, parent.id)));
    const entry: UnitCompletion = {
      salesFunnelCampaignId: parent.id,
      orgId: parent.orgId,
      brandId: parent.brandId,
      salesFunnelId: parent.salesFunnelId,
      status: parent.status,
      added: [],
      missingPlatformPipes: [],
      legsWithoutChannel: legsWithoutChannel(funnel.value),
    };
    for (const leg of funnel.value.legs) {
      if (!leg.pipe || isSourcingLeg(leg)) continue;
      const pipe = await fetchPipe(leg.pipe.id);
      if (!pipe.ok) throw new Error(`pipe ${leg.pipe.id} unreadable: ${pipe.detail}`);
      const { channelSlug, legKey } = pipe.value;
      if (units.some((u) => u.featureSlug === channelSlug && sameLeg(channelSlug, u.legKey, legKey))) continue;
      if (catalogue.operatorBySlug.get(channelSlug) === "customer") entry.added.push({ featureSlug: channelSlug, legKey });
      else entry.missingPlatformPipes.push(leg.pipe.id);
    }
    if (opts.apply && entry.added.length > 0) {
      try {
        await db.transaction(async (tx) => {
          // Locks the funnel row: its status is read inside the same transaction that mirrors it.
          const [locked] = await tx
            .select()
            .from(salesFunnelCampaigns)
            .where(eq(salesFunnelCampaigns.id, parent.id))
            .for("update");
          await insertSalesFunnelUnits(tx, locked, customerUnitBirths(locked, entry.added));
        });
      } catch (err) {
        entry.error = err instanceof Error ? err.message : String(err);
        console.error(`[campaign-service] Completing units of sales funnel campaign ${parent.id} failed: ${entry.error}`);
      }
    }
    if (entry.added.length || entry.missingPlatformPipes.length || entry.legsWithoutChannel.length) {
      if (entry.missingPlatformPipes.length || entry.legsWithoutChannel.length) {
        console.error(
          `[campaign-service] Sales funnel campaign ${parent.id} (${parent.salesFunnelId}) still has a leg nobody works: ` +
          `platform pipes without a unit [${entry.missingPlatformPipes.join(", ")}], legs without a channel [${entry.legsWithoutChannel.join(", ")}]`,
        );
      }
      out.push(entry);
    }
  }
  return {
    applied: opts.apply,
    funnelCampaigns: out,
    counts: {
      funnelCampaigns: parents.length,
      incomplete: out.length,
      unitsAdded: opts.apply ? out.filter((e) => !e.error).reduce((s, e) => s + e.added.length, 0) : 0,
      unresolved: out.filter((e) => e.missingPlatformPipes.length || e.legsWithoutChannel.length || e.error).length,
    },
  };
}
