import type { IdentityHeaders } from "@distribute/runs-client";

/**
 * The offers ONE (org, brand) pair holds, as brand-service reports them.
 *
 * AN OFFER BELONGS TO THE PAIR, NOT TO THE BRAND. A `brands` row is a shared global identity that
 * several orgs legitimately claim, and everything a customer configures on top of it — the goal,
 * the funnels, the offers — belongs to the (org, brand) pair. brand-service resolves that org from
 * `x-org-id`, so naming the org is load-bearing rather than tracking: reading the brand's offers
 * without it would answer with ANOTHER org's offer, i.e. a cross-org write into the very per-offer
 * grouping the column exists to make correct.
 *
 * The three outcomes are kept apart for the same reason `SalesFunnelsRead` keeps its own apart: a
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
 * There is no `active` on an offer — an offer is a proposition a brand states, and it is the
 * FUNNELS underneath it that are switched on and off. An offer's existence IS the answer.
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
      { headers },
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
