import type { IdentityHeaders } from "@distribute/runs-client";
import { siblingReadSignal } from "./sibling-read-timeout.js";

/**
 * The offers ONE (org, brand) pair holds, as brand-service reports them.
 *
 * AN OFFER BELONGS TO THE PAIR, NOT TO THE BRAND. A `brands` row is a shared global identity that
 * several orgs legitimately claim, and everything a customer configures on top of it — the goal,
 * the offers — belongs to the (org, brand) pair. brand-service resolves that org from
 * `x-org-id`, so naming the org is load-bearing rather than tracking: reading the brand's offers
 * without it would answer with ANOTHER org's offer, i.e. a cross-org write into the very per-offer
 * grouping the column exists to make correct.
 *
 * The outcomes are kept apart because a
 * refusal collapsed onto "this pair holds no offer" is indistinguishable from a truthful empty
 * answer, and the consequence is silent — a campaign that COULD be attributed simply never is.
 */
export type BrandOffersRead =
  | { ok: true; offerIds: string[] }
  | { ok: false; reason: "unavailable"; detail: string };

/**
 * Read the offers of one (org, brand) pair.
 *
 * Contract (brand-service): GET /internal/brands/{brandId}/offers  (x-api-key + x-org-id)
 *   -> { offers: [{ offerId, brandId, name, createdAt, updatedAt }] }
 *
 * There is no `active` on an offer — an offer is a proposition a brand states. An offer's
 * existence IS the answer.
 */
export async function fetchPairOffers(
  brandId: string,
  identity: IdentityHeaders,
): Promise<BrandOffersRead> {
  const baseUrl = process.env.BRAND_SERVICE_URL;
  const apiKey = process.env.BRAND_SERVICE_API_KEY;
  if (!baseUrl || !apiKey) {
    return { ok: false, reason: "unavailable", detail: "brand-service not configured" };
  }

  const headers: Record<string, string> = {
    "x-api-key": apiKey,
    "x-org-id": identity.orgId,
    "x-brand-id": brandId,
  };
  if (identity.userId) headers["x-user-id"] = identity.userId;
  if (identity.runId) headers["x-run-id"] = identity.runId;

  try {
    const res = await fetch(
      `${baseUrl.replace(/\/$/, "")}/internal/brands/${encodeURIComponent(brandId)}/offers`,
      { headers, signal: siblingReadSignal() },
    );
    if (!res.ok) {
      return { ok: false, reason: "unavailable", detail: `brand ${brandId}: HTTP ${res.status}` };
    }
    const data = (await res.json()) as { offers?: Array<{ offerId?: string | null }> };
    if (!Array.isArray(data?.offers)) {
      return { ok: false, reason: "unavailable", detail: `brand ${brandId}: unparseable payload` };
    }
    const offerIds = [
      ...new Set(
        data.offers
          .map((o) => o?.offerId)
          .filter((id): id is string => typeof id === "string" && id.length > 0),
      ),
    ];
    return { ok: true, offerIds };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: "unavailable", detail: `brand ${brandId}: ${message}` };
  }
}

export type OfferNameRead = { ok: true; name: string } | { ok: false; reason: "unavailable" | "offer_not_found"; detail: string };

/**
 * The NAME the (org, brand) pair gave one of its offers, as brand-service reports it (same read as `fetchPairOffers`).
 * Read so a campaign is born with a brief written from what its client stated (lib/sales-funnel-birth-brief.ts).
 * An offer the pair does not hold, or one with no name, is said so, never guessed.
 */
export async function fetchOfferName(
  brandId: string,
  offerId: string,
  identity: { orgId: string; userId?: string | null; runId?: string | null },
): Promise<OfferNameRead> {
  const baseUrl = process.env.BRAND_SERVICE_URL;
  const apiKey = process.env.BRAND_SERVICE_API_KEY;
  if (!baseUrl || !apiKey) return { ok: false, reason: "unavailable", detail: "brand-service not configured" };
  const headers: Record<string, string> = { "x-api-key": apiKey, "x-org-id": identity.orgId, "x-brand-id": brandId };
  if (identity.userId) headers["x-user-id"] = identity.userId;
  if (identity.runId) headers["x-run-id"] = identity.runId;
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/internal/brands/${encodeURIComponent(brandId)}/offers`, {
      headers,
      signal: siblingReadSignal(),
    });
    if (!res.ok) return { ok: false, reason: "unavailable", detail: `brand ${brandId}: HTTP ${res.status}` };
    const data = (await res.json()) as { offers?: Array<{ offerId?: string | null; name?: string | null }> };
    if (!Array.isArray(data?.offers)) return { ok: false, reason: "unavailable", detail: `brand ${brandId}: unparseable payload` };
    const offer = data.offers.find((o) => o?.offerId === offerId);
    const name = typeof offer?.name === "string" ? offer.name.trim() : "";
    if (!offer || name.length === 0) {
      return { ok: false, reason: "offer_not_found", detail: `brand ${brandId}: no named offer ${offerId}` };
    }
    return { ok: true, name };
  } catch (err) {
    return { ok: false, reason: "unavailable", detail: `brand ${brandId}: ${err instanceof Error ? err.message : String(err)}` };
  }
}
