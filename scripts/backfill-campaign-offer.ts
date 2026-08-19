/**
 * One-shot backfill: every existing campaign states the OFFER it sells.
 *
 * A campaign is (offer x sales funnel x acquisition channel). Migration 0050 adds `offer_id` and
 * backfills NOTHING, because resolving a campaign's brand to its offer is a brand-service READ and
 * SQL cannot make one. This script makes it.
 *
 * Every brand has exactly one offer at the moment this runs — brand-service ships that migration
 * in the same wave — so this is a RESOLUTION, not a guess. Where a brand does not resolve to
 * exactly one offer, the campaign is LEFT ALONE and REPORTED. Nothing is ever inferred from the
 * funnel, the goal or the workflow: several offers legitimately sell through one funnel, which is
 * the whole reason the dimension exists, so picking one would invent an attribution.
 *
 * Idempotent: it only ever selects and writes rows whose `offer_id` is still NULL, and the UPDATE
 * re-states that guard, so a second run writes nothing and a run racing a live create cannot
 * overwrite an offer a caller just stated.
 *
 * Reversible: the previous value is NULL by construction (that is the guard), so the reverse of a
 * run is exactly the ids it printed. The script emits the undo statement at the end.
 *
 * Dry run is the DEFAULT — it resolves and reports without writing. Pass --apply to write.
 *
 * Usage:
 *   CAMPAIGN_SERVICE_DATABASE_URL=... BRAND_SERVICE_URL=... BRAND_SERVICE_API_KEY=... \
 *     npx tsx scripts/backfill-campaign-offer.ts            # dry run, writes nothing
 *   ... npx tsx scripts/backfill-campaign-offer.ts --apply  # writes
 */

import postgres from "postgres";

/**
 * What brand-service answers for one (org, brand) pair.
 *
 * `offerId` is set ONLY when the pair resolves to exactly one offer. Anything else — no offer,
 * several offers, an unreadable answer — carries a `reason` and no id, and the caller leaves the
 * campaign alone. There is deliberately no "pick the first" branch.
 */
export type OfferResolution =
  | { offerId: string; reason?: undefined }
  | { offerId: null; reason: string };

export interface UnresolvedCampaign {
  campaignId: string;
  orgId: string;
  brandId: string | null;
  reason: string;
}

export interface BackfillResult {
  /** Rows written (or, on a dry run, rows that WOULD be written). */
  written: number;
  /** The campaign ids behind `written` — the exact set an undo would target. */
  writtenCampaignIds: string[];
  /** Campaigns left untouched because their brand did not resolve to exactly one offer. */
  unresolved: UnresolvedCampaign[];
  dryRun: boolean;
}

/**
 * Read the offer a brand sells, for ONE org's view of it.
 *
 * Contract (brand-service, verified against the deployed route rather than assumed):
 *   GET /internal/brands/{brandId}/offers  (x-api-key + x-org-id)
 *   -> { offers: [{ offerId, brandId, name, createdAt, updatedAt }] }
 *
 * `x-org-id` is load-bearing, not tracking: a `brands` row is a shared global identity that
 * several orgs legitimately claim, and everything configured on top of it belongs to the (org,
 * brand) pair. Naming the org is what stops brand-service answering for somebody else's offer.
 *
 * THERE IS NO `active` ON AN OFFER, and this used to filter on one. An offer is a proposition
 * a brand states; it is the FUNNELS underneath it that are switched on and off, which is why
 * brand-service's own funnel read is the one that says "active only". Filtering here on a field
 * that is never sent read as a deliberate liveness check while doing nothing — the dangerous
 * kind of dead code, because the day brand-service adds an unrelated `active` it would start
 * silently dropping offers. An offer's existence IS the answer.
 */
export function makeOfferResolver(baseUrl: string, apiKey: string) {
  return async function resolveBrandOffer(brandId: string, orgId: string): Promise<OfferResolution> {
    const url = `${baseUrl.replace(/\/$/, "")}/internal/brands/${encodeURIComponent(brandId)}/offers`;
    let res: Response;
    try {
      res = await fetch(url, { headers: { "x-api-key": apiKey, "x-org-id": orgId, "x-brand-id": brandId } });
    } catch (err) {
      return { offerId: null, reason: `brand-service unreachable: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (!res.ok) {
      return { offerId: null, reason: `brand-service returned ${res.status}` };
    }

    let data: { offers?: Array<{ offerId?: string }> };
    try {
      data = (await res.json()) as typeof data;
    } catch {
      return { offerId: null, reason: "brand-service answer is not JSON" };
    }
    if (!Array.isArray(data.offers)) {
      return { offerId: null, reason: "brand-service answer carries no offers array" };
    }

    const ids = data.offers
      .map((o) => o?.offerId)
      .filter((id): id is string => typeof id === "string" && id.length > 0);

    if (ids.length === 1) return { offerId: ids[0] };
    return {
      offerId: null,
      reason: ids.length === 0 ? "brand declares no offer" : `brand declares ${ids.length} offers`,
    };
  };
}

/**
 * Write each campaign the offer its (org, brand) pair resolves to.
 *
 * One brand-service read per distinct pair, not per campaign — a brand with twenty campaigns is
 * one question asked once.
 */
export async function backfillCampaignOffers(
  querySql: postgres.Sql,
  resolveBrandOffer: (brandId: string, orgId: string) => Promise<OfferResolution>,
  options: { dryRun?: boolean } = {},
): Promise<BackfillResult> {
  const dryRun = options.dryRun !== false;

  // `brand_id` is the stored half of the campaign identity (migration 0044); the historical
  // multi-brand rows only carry the array, so fall back to its first element exactly as 0044 did.
  const rows = (await querySql`
    SELECT "id", "org_id", coalesce("brand_id", "brand_ids"[1]) AS "brand_id"
    FROM "campaigns"
    WHERE "offer_id" IS NULL
    ORDER BY "created_at"
  `) as unknown as Array<{ id: string; org_id: string; brand_id: string | null }>;

  console.log(`Found ${rows.length} campaign(s) with no offer stated`);

  const writtenCampaignIds: string[] = [];
  const unresolved: UnresolvedCampaign[] = [];
  const cache = new Map<string, OfferResolution>();

  for (const row of rows) {
    if (!row.brand_id) {
      unresolved.push({
        campaignId: row.id,
        orgId: row.org_id,
        brandId: null,
        reason: "campaign states no brand",
      });
      continue;
    }

    const key = `${row.org_id}::${row.brand_id}`;
    let resolution = cache.get(key);
    if (!resolution) {
      resolution = await resolveBrandOffer(row.brand_id, row.org_id);
      cache.set(key, resolution);
    }

    if (!resolution.offerId) {
      unresolved.push({
        campaignId: row.id,
        orgId: row.org_id,
        brandId: row.brand_id,
        reason: resolution.reason,
      });
      continue;
    }

    if (!dryRun) {
      // The `offer_id IS NULL` guard is restated here, not just in the SELECT: it is what makes a
      // re-run a no-op and what stops this overwriting an offer a live create stated meanwhile.
      await querySql`
        UPDATE "campaigns"
        SET "offer_id" = ${resolution.offerId}, "updated_at" = now()
        WHERE "id" = ${row.id} AND "offer_id" IS NULL
      `;
    }
    console.log(`  ${dryRun ? "[dry-run] would set" : "set"} campaign ${row.id} offer → ${resolution.offerId}`);
    writtenCampaignIds.push(row.id);
  }

  return { written: writtenCampaignIds.length, writtenCampaignIds, unresolved, dryRun };
}

async function main() {
  const DATABASE_URL = process.env.CAMPAIGN_SERVICE_DATABASE_URL;
  const BRAND_SERVICE_URL = process.env.BRAND_SERVICE_URL;
  const BRAND_SERVICE_API_KEY = process.env.BRAND_SERVICE_API_KEY;

  if (!DATABASE_URL || !BRAND_SERVICE_URL || !BRAND_SERVICE_API_KEY) {
    console.error("Required: CAMPAIGN_SERVICE_DATABASE_URL, BRAND_SERVICE_URL, BRAND_SERVICE_API_KEY");
    process.exit(1);
  }

  // Dry run unless --apply is stated. A backfill that writes by default is one nobody inspected.
  const dryRun = !process.argv.includes("--apply");

  const sql = postgres(DATABASE_URL);
  console.log(`=== Backfilling campaign offers ${dryRun ? "(DRY RUN — nothing is written)" : "(APPLYING)"} ===\n`);

  const result = await backfillCampaignOffers(sql, makeOfferResolver(BRAND_SERVICE_URL, BRAND_SERVICE_API_KEY), { dryRun });

  console.log(`\n${result.written} campaign(s) ${dryRun ? "would be" : ""} written, ${result.unresolved.length} left alone`);

  if (result.unresolved.length > 0) {
    console.error("\nLEFT ALONE — their brand does not resolve to exactly one offer. No offer is invented for these:");
    for (const u of result.unresolved) {
      console.error(`  campaign ${u.campaignId} (org ${u.orgId}, brand ${u.brandId ?? "none"}): ${u.reason}`);
    }
  }

  if (result.written > 0) {
    const ids = result.writtenCampaignIds.map((id) => `'${id}'`).join(", ");
    console.log(`\nUndo this run:\n  UPDATE "campaigns" SET "offer_id" = NULL WHERE "id" IN (${ids});`);
  }

  await sql.end();

  // A campaign left alone is a real gap somebody must answer, so the run reports it as a failure
  // — the writes that did land stay, and re-running after the gap is closed picks up only those.
  if (result.unresolved.length > 0) process.exit(1);
}

// Only run main() when executed directly (not imported in tests)
const isDirectRun = process.argv[1]?.includes("backfill-campaign-offer");
if (isDirectRun) {
  main().catch(async (err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}
