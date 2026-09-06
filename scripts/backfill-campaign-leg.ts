/**
 * Backfill: every campaign that CAN state the LEG it is bought for, states it.
 *
 * A campaign is (brand, offer, funnel, acquisition channel, LEG). `campaigns.leg_key` (migration
 * 0055) carries features-service's own identifier for the leg a customer bought, and the write
 * path states it — but every campaign created before the column existed carries a funnel and a
 * channel and no leg. While the column is blank, every consumer resolving what such a campaign
 * buys falls back to DERIVING the leg from its funnel and its channel, which is the derivation the
 * column exists to replace, and a ceiling stated at the leg grain cannot find the campaign it
 * paces.
 *
 * THE RULE IS THE ONE THE CONSUMERS ALREADY USE — nothing new is decided here. features-service
 * publishes, on one public catalogue, which legs each CHANNEL performs
 * (`channels[].stepTransitions[].legKey`) and which funnels each LEG is a leg of
 * (`legs[].funnelKeys`). The leg a campaign is bought for is the leg that sits in BOTH: performed
 * by the campaign's channel, and a leg of the campaign's funnel. When exactly one leg satisfies
 * both, that is what the derivation answers today and it is what this writes down. So a backfilled
 * campaign reads identically to the way it reads now: this makes explicit what is already inferred
 * and changes no campaign's meaning.
 *
 * THE IDENTIFIER IS features-service's, READ FROM WHAT IT PUBLISHES. Nothing is minted, nothing is
 * parsed, and no list of legs exists here — the same posture this service holds for the goal, the
 * offer and the channel. It reuses `fetchChannelCatalogue`, the ONE reader of that catalogue.
 *
 * LEFT ALONE, never guessed: a campaign whose (funnel, channel) resolves to no leg, or to SEVERAL,
 * gets nothing. So does one whose channel the catalogue does not publish, and every campaign if the
 * catalogue cannot be read at all. Each is reported with its reason, grouped by the pair.
 *
 * Idempotent: it only ever selects and writes rows whose `leg_key` is still NULL, and the UPDATE
 * re-states that guard — so a second run writes nothing and a run racing a live create cannot
 * overwrite a leg a caller just stated.
 *
 * Reversible: the previous value is NULL by construction (that is the guard), so the reverse of a
 * run is exactly the ids it printed. The script emits the undo statement at the end.
 *
 * Dry run is the DEFAULT — it resolves and reports without writing. Pass --apply to write.
 *
 * Only `leg_key` (and `updated_at`) ever moves. Status, money, schedule, history and every other
 * word of the identity are untouched, and no campaign is created or deleted.
 *
 * Usage:
 *   CAMPAIGN_SERVICE_DATABASE_URL=... FEATURES_SERVICE_URL=... \
 *     npx tsx scripts/backfill-campaign-leg.ts            # dry run, writes nothing
 *   ... npx tsx scripts/backfill-campaign-leg.ts --apply  # writes
 */

import postgres from "postgres";
import { fetchChannelCatalogue, type ChannelCatalogueRead } from "../src/lib/channel-operator-client";
import { toFunnelKey } from "../src/lib/sales-funnel-vocabulary";

/**
 * What the catalogue answers for one (funnel, channel) pair.
 *
 * `legKey` is set ONLY when exactly one leg is both performed by the channel and a leg of the
 * funnel. Anything else — none, several, a channel the catalogue does not publish — carries a
 * `reason` and no identifier, and the caller leaves the campaign alone. There is deliberately no
 * "pick the first" branch: several legs means the funnel genuinely does not say which one was
 * bought, which is the entire reason this column exists.
 */
export type LegResolution =
  | { legKey: string; reason?: undefined }
  | { legKey: null; reason: string };

export interface UnresolvedCampaign {
  campaignId: string;
  orgId: string;
  funnelKey: string;
  featureSlug: string;
  reason: string;
}

export interface BackfillResult {
  /** Rows written (or, on a dry run, rows that WOULD be written). */
  written: number;
  /** The campaign ids behind `written` — the exact set an undo would target. */
  writtenCampaignIds: string[];
  /** Campaigns left untouched because their (funnel, channel) does not resolve to exactly one leg. */
  unresolved: UnresolvedCampaign[];
  dryRun: boolean;
}

/**
 * The leg a (funnel, channel) is bought for, under the catalogue features-service published.
 *
 * Both halves of the join are features-service's own statements, joined VERBATIM: a channel that
 * the catalogue does not publish is a different answer from one that publishes an empty set, and
 * both are reported as themselves rather than collapsed into a silent nothing.
 */
export function resolveLeg(
  read: Extract<ChannelCatalogueRead, { ok: true }>,
  funnelKey: string,
  featureSlug: string,
): LegResolution {
  const performed = read.legsBySlug.get(featureSlug);
  if (!performed) {
    return { legKey: null, reason: "features-service's catalogue publishes no such channel" };
  }

  const candidates = read.legs
    .filter((leg) => performed.has(leg.legKey) && leg.funnelKeys.has(funnelKey))
    .map((leg) => leg.legKey);

  if (candidates.length === 1) return { legKey: candidates[0] };
  return {
    legKey: null,
    reason:
      candidates.length === 0
        ? "features-service states no leg of this funnel that this channel performs"
        : `this channel performs ${candidates.length} legs of this funnel (${candidates.join(", ")}) — the funnel does not say which was bought`,
  };
}

/**
 * Write each campaign the leg its (funnel, channel) resolves to.
 *
 * One catalogue read for the whole run — it is a public, brand-agnostic product statement, so a
 * campaign is not a reason to ask it again.
 */
export async function backfillCampaignLegs(
  querySql: postgres.Sql,
  readCatalogue: () => Promise<ChannelCatalogueRead>,
  options: { dryRun?: boolean } = {},
): Promise<BackfillResult> {
  const dryRun = options.dryRun !== false;

  // Only a campaign that carries BOTH a funnel and a channel can be asked about at all: the join
  // is over those two words, so a row missing either is not a gap the catalogue could close.
  const rows = (await querySql`
    SELECT "id", "org_id", "funnel_key", "feature_slug"
    FROM "campaigns"
    WHERE "leg_key" IS NULL
      AND "funnel_key" IS NOT NULL
      AND "feature_slug" IS NOT NULL
    ORDER BY "created_at"
  `) as unknown as Array<{ id: string; org_id: string; funnel_key: string; feature_slug: string }>;

  console.log(`Found ${rows.length} campaign(s) stating a funnel and a channel and no leg`);

  const writtenCampaignIds: string[] = [];
  const unresolved: UnresolvedCampaign[] = [];
  if (rows.length === 0) {
    return { written: 0, writtenCampaignIds, unresolved, dryRun };
  }

  const read = await readCatalogue();
  if (!read.ok) {
    // Fail LOUD and write nothing. A catalogue that cannot be read is not a catalogue that states
    // no leg, and inventing the difference is the one thing this must never do.
    throw new Error(`Could not READ features-service's channel catalogue: ${read.detail}`);
  }

  // The answer is a property of the (funnel, channel) PAIR, so it is resolved once per pair and
  // every campaign of that pair takes it.
  const cache = new Map<string, LegResolution>();

  for (const row of rows) {
    // Every spelling in, one canonical token out — billing and the older campaign rows still carry
    // the pre-rename funnel keys, and comparing a raw token against the catalogue's canonical ones
    // reads a perfectly ordinary campaign as naming a funnel nobody publishes.
    const funnelKey = toFunnelKey(row.funnel_key);
    if (!funnelKey) {
      unresolved.push({
        campaignId: row.id,
        orgId: row.org_id,
        funnelKey: row.funnel_key,
        featureSlug: row.feature_slug,
        reason: "campaign states a funnel no catalogue names",
      });
      continue;
    }

    const key = `${funnelKey}::${row.feature_slug}`;
    let resolution = cache.get(key);
    if (!resolution) {
      resolution = resolveLeg(read, funnelKey, row.feature_slug);
      cache.set(key, resolution);
    }

    if (!resolution.legKey) {
      unresolved.push({
        campaignId: row.id,
        orgId: row.org_id,
        funnelKey,
        featureSlug: row.feature_slug,
        reason: resolution.reason,
      });
      continue;
    }

    if (!dryRun) {
      // The `leg_key IS NULL` guard is restated here, not just in the SELECT: it is what makes a
      // re-run a no-op and what stops this overwriting a leg a live create stated meanwhile.
      await querySql`
        UPDATE "campaigns"
        SET "leg_key" = ${resolution.legKey}, "updated_at" = now()
        WHERE "id" = ${row.id} AND "leg_key" IS NULL
      `;
    }
    console.log(`  ${dryRun ? "[dry-run] would set" : "set"} campaign ${row.id} leg → ${resolution.legKey}`);
    writtenCampaignIds.push(row.id);
  }

  return { written: writtenCampaignIds.length, writtenCampaignIds, unresolved, dryRun };
}

async function main() {
  const DATABASE_URL = process.env.CAMPAIGN_SERVICE_DATABASE_URL;

  if (!DATABASE_URL || !process.env.FEATURES_SERVICE_URL) {
    console.error("Required: CAMPAIGN_SERVICE_DATABASE_URL, FEATURES_SERVICE_URL");
    process.exit(1);
  }

  // Dry run unless --apply is stated. A backfill that writes by default is one nobody inspected.
  const dryRun = !process.argv.includes("--apply");

  const sql = postgres(DATABASE_URL);
  console.log(`=== Backfilling campaign legs ${dryRun ? "(DRY RUN — nothing is written)" : "(APPLYING)"} ===\n`);

  const result = await backfillCampaignLegs(sql, fetchChannelCatalogue, { dryRun });

  console.log(`\n${result.written} campaign(s) ${dryRun ? "would be" : ""} written, ${result.unresolved.length} left alone`);

  if (result.unresolved.length > 0) {
    // Grouped by (funnel, channel): the reason is a property of the PAIR, so one line per campaign
    // prints the same sentence a hundred times and buries how many distinct things are unanswered.
    const byPair = new Map<string, { funnelKey: string; featureSlug: string; reason: string; campaigns: number }>();
    for (const u of result.unresolved) {
      const key = `${u.funnelKey}::${u.featureSlug}`;
      const entry = byPair.get(key);
      if (entry) entry.campaigns++;
      else byPair.set(key, { funnelKey: u.funnelKey, featureSlug: u.featureSlug, reason: u.reason, campaigns: 1 });
    }
    console.error(
      `\nLEFT ALONE — ${result.unresolved.length} campaign(s) across ${byPair.size} (funnel, channel) pair(s) that do not resolve to exactly one leg. No leg is invented for these:`,
    );
    for (const p of byPair.values()) {
      console.error(`  funnel ${p.funnelKey}, channel ${p.featureSlug} (${p.campaigns} campaign(s)): ${p.reason}`);
    }
  }

  if (result.written > 0) {
    const ids = result.writtenCampaignIds.map((id) => `'${id}'`).join(", ");
    console.log(`\nUndo this run:\n  UPDATE "campaigns" SET "leg_key" = NULL WHERE "id" IN (${ids});`);
  }

  await sql.end();
}

// Only run main() when executed directly (not imported in tests)
const isDirectRun = process.argv[1]?.includes("backfill-campaign-leg");
if (isDirectRun) {
  main().catch(async (err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}
