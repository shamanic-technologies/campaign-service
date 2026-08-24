import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { fetchPairOffers } from "./brand-offers-client.js";
import type { ProvisioningIdentity } from "./provisioning-identity.js";

/**
 * A campaign that states no offer is invisible on every offer-scoped surface.
 *
 * Org > Brand > Offer > Campaign. The dashboard's offer page lists the campaigns OF THE OFFER
 * being viewed, so a campaign attributed to no offer belongs to none of them and appears nowhere —
 * while it runs and spends. A customer opens their offer and reads an empty page.
 *
 * `offer_id` is stated by the CREATOR (migration 0050 makes it optional, deliberately and
 * temporarily, so a caller that has not migrated behaves exactly as it did before the column
 * existed). What was missing is the other half: a campaign that ALREADY EXISTS with no offer was
 * never adopted afterwards. Provisioning finds a live campaign for the triple and moves on, so an
 * unattributed row stayed unattributed forever and only a hand-run script
 * (`scripts/backfill-campaign-offer.ts`) ever closed it.
 *
 *   Prod 2026-08-24 — org 100ed4eb / brand fbe3ce77, campaign 16705a37 ongoing since 21:12Z on
 *   sales_meetings_from_conversation, no offer. The pair's ONE offer 231bb036 was created at
 *   20:44Z, 28 minutes BEFORE the campaign. The attribution was resolvable at create time and is
 *   still resolvable now; nothing on this service's own cadence was ever going to state it.
 *
 * So the rule lives on the TICK, exactly as the funnel-less-ancestor adoption does and for the
 * same reason: an invariant a migration can only ever state once is not an invariant. See
 * funnel-ancestor-adoption.ts.
 *
 * THE RULE, byte-for-byte the one the backfill script states, and it is NOT widened:
 * a campaign carrying no offer is written the offer of its (org, brand) PAIR, and ONLY when that
 * pair resolves to EXACTLY ONE offer. Zero offers, several offers, or an unreadable answer leaves
 * every campaign of the pair exactly as it is. Nothing is ever derived from the funnel, the goal
 * or the workflow — several offers legitimately sell through one funnel, which is the entire
 * reason the dimension exists.
 *
 * NEVER by brand alone. A brand row is claimed by many orgs and carries one offer per claiming
 * org, frequently all named the same thing, so "this brand has an offer" is not a question that
 * can be acted on: `x-org-id` is what makes the answer this org's. Every write is scoped to the
 * campaign's own `org_id` as well, so no campaign can be attributed to another org's offer.
 *
 * What it never touches: any campaign that already STATES an offer (this only ever fills an
 * absence), and any column other than `offer_id`. Status, funnel, schedule, budget and history are
 * untouched — the offer decides no money question, it is the grain the customer reads their
 * campaigns at.
 */

/**
 * How often one pair is asked. Same figure and same argument as `FUNDING_RECHECK_MS`: an offer
 * comes into being when a person creates one, hours or days apart, so asking on the turn cadence
 * would be one brand-service read per minute per brand answering "still nothing". This IS the
 * latency between an offer existing and a live campaign of that pair reading it.
 */
export const OFFER_ADOPTION_RECHECK_MS = 10 * 60_000; // 10 min

/** The (org, brand) pair a campaign's offer is resolved at. Never the brand on its own. */
export interface OfferAdoptionScope {
  orgId: string;
  brandId: string;
}

interface OfferlessCampaign extends Record<string, unknown> {
  id: string;
  status: string;
}

const lastAskedAt = new Map<string, number>();

/** Test seam: forget the per-pair throttle so a test can run consecutive adoptions. */
export function resetOfferAdoptionThrottle(): void {
  lastAskedAt.clear();
}

/**
 * The campaigns of this pair that state no offer.
 *
 * `brand_id` is the stored half of the campaign identity (migration 0044); the historical rows
 * only carry the array, so it is the fallback — but ONLY when it names exactly ONE brand. Taking
 * `brand_ids[1]` unconditionally reads a campaign of several brands as a campaign of its first,
 * which is precisely the guess this must never make.
 */
async function offerlessCampaignsOfPair(scope: OfferAdoptionScope): Promise<OfferlessCampaign[]> {
  const rows = await db.execute<OfferlessCampaign>(sql`
    SELECT "id", "status"
    FROM "campaigns"
    WHERE "org_id" = ${scope.orgId}
      AND "offer_id" IS NULL
      AND (
        "brand_id" = ${scope.brandId}
        OR (
          "brand_id" IS NULL
          AND coalesce(array_length("brand_ids", 1), 0) = 1
          AND "brand_ids"[1] = ${scope.brandId}
        )
      )
  `);
  return Array.from(rows as unknown as Iterable<OfferlessCampaign>);
}

/**
 * Write the pair's single offer onto every campaign of the pair that states none.
 *
 * Returns how many rows were written — zero on every ordinary tick, because the pair is only ever
 * asked about when one of its campaigns states no offer.
 *
 * IDEMPOTENT: the `offer_id IS NULL` guard is restated in the UPDATE, not only in the SELECT, so a
 * second call writes nothing and a call racing a live create can never overwrite an offer a caller
 * just stated.
 *
 * REVERSIBLE: the previous value is NULL by construction, so the reverse of a run is exactly the
 * ids it logs.
 */
export async function adoptOfferForPair(
  scope: OfferAdoptionScope,
  identity: ProvisioningIdentity,
  now: Date = new Date(),
): Promise<number> {
  const offerless = await offerlessCampaignsOfPair(scope);
  // The routine path for every attributed brand: nothing to ask, nothing read, nothing logged.
  if (offerless.length === 0) return 0;

  const key = `${scope.orgId}::${scope.brandId}`;
  const askedAt = lastAskedAt.get(key) ?? 0;
  if (now.getTime() - askedAt < OFFER_ADOPTION_RECHECK_MS) return 0;
  lastAskedAt.set(key, now.getTime());

  // A LIVE campaign nobody can see on their offer page is the customer-visible harm and is worth
  // a line every time the answer is not one offer. A pair whose only unattributed rows are STOPPED
  // is the pre-offers population #371 proved permanently unattributable (145 rows, most of them
  // belonging to orgs brand-service does not know at all) — saying so every ten minutes forever
  // would bury the signal it exists for.
  const live = offerless.filter((c) => c.status === "ongoing");
  const say = (message: string) => {
    if (live.length > 0) console.warn(message);
  };

  const read = await fetchPairOffers(scope.brandId, identity);
  if (!read.ok) {
    say(
      `[campaign-service] Could not attribute ${live.length} live campaign(s) of brand ${scope.brandId} (org ${scope.orgId}) to an offer — brand-service would not answer: ${read.detail}`,
    );
    return 0;
  }

  if (read.offerIds.length !== 1) {
    say(
      read.offerIds.length === 0
        ? `[campaign-service] ${live.length} live campaign(s) of brand ${scope.brandId} (org ${scope.orgId}) state no offer and this (org, brand) pair holds none — nothing is attributed, and they stay invisible on every offer surface until it does`
        : `[campaign-service] ${live.length} live campaign(s) of brand ${scope.brandId} (org ${scope.orgId}) state no offer and this (org, brand) pair holds ${read.offerIds.length} — none outranks another, so nothing is attributed`,
    );
    return 0;
  }

  const offerId = read.offerIds[0];
  const applied = await db.execute<{ id: string }>(sql`
    UPDATE "campaigns"
    SET "offer_id" = ${offerId}, "updated_at" = now()
    WHERE "org_id" = ${scope.orgId}
      AND "offer_id" IS NULL
      AND (
        "brand_id" = ${scope.brandId}
        OR (
          "brand_id" IS NULL
          AND coalesce(array_length("brand_ids", 1), 0) = 1
          AND "brand_ids"[1] = ${scope.brandId}
        )
      )
    RETURNING "id"
  `);

  const written = Array.from(applied as unknown as Iterable<{ id: string }>);
  if (written.length > 0) {
    console.log(
      `[campaign-service] ${written.length} campaign(s) of brand ${scope.brandId} (org ${scope.orgId}) now state offer ${offerId} — they were attributed to none and showed on no offer surface: ${written.map((r) => r.id).join(", ")}`,
    );
  }
  return written.length;
}

/**
 * Fail-SOFT wrapper for the provisioning tick.
 *
 * Adoption is an ATTRIBUTION correction: it decides which offer page a campaign appears on, and it
 * spends nothing, starts nothing and stops nothing. A failure must never hold up the provisioning
 * that called it — the funded pair still needs its campaign — so it is said out loud once and the
 * next sweep tries again.
 */
export async function adoptOfferForPairSafely(
  scope: OfferAdoptionScope,
  identity: ProvisioningIdentity,
  now: Date = new Date(),
): Promise<number> {
  try {
    return await adoptOfferForPair(scope, identity, now);
  } catch (err) {
    console.warn(
      `[campaign-service] Could not attribute the offer-less campaigns of brand ${scope.brandId} (org ${scope.orgId}) to their pair's offer:`,
      err,
    );
    return 0;
  }
}
