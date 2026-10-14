import type { IdentityHeaders } from "@distribute/runs-client";

/**
 * The BRAND's daily budget, as billing serves it:
 *
 *   GET /internal/brands/{brandId}/daily-budget (x-api-key + x-org-id)
 *     -> { brandId, dailyBudgetCents: string | null, updatedAt }
 *
 * billing's own brand figure (its legacy brand pot plus every recurring sales funnel max budget per
 * day, billing v0.83.9), never recomputed here. It paces NOTHING in this service: a campaign's money
 * is its sales funnel's caps (owner 2026-10-14, one money model). It answers one question only, the
 * brand pause (`GET /brands/:brandId/pause`): does the customer fund anything for this brand.
 *
 * billing's per-campaign daily ceilings (`/campaign-budgets`, `/campaign-budget`) are RETIRED and
 * never read by this service again.
 */
export type BrandDailyBudgetRead =
  | { ok: true; dailyBudgetCents: number | null }
  | { ok: false };

/**
 * ok:false on missing config, network error, non-2xx or an unparseable payload: the caller fails
 * LOUD. `x-org-id` is load-bearing: a budget belongs to the (org, brand) pair.
 */
export async function fetchBrandDailyBudget(
  brandId: string,
  identity: Pick<IdentityHeaders, "orgId" | "userId">,
): Promise<BrandDailyBudgetRead> {
  const url = process.env.BILLING_SERVICE_URL;
  const apiKey = process.env.BILLING_SERVICE_API_KEY;
  if (!url || !apiKey) return { ok: false };

  const headers: Record<string, string> = {
    "x-api-key": apiKey,
    "x-org-id": identity.orgId,
    "x-brand-id": brandId,
  };
  if (identity.userId) headers["x-user-id"] = identity.userId;

  try {
    const res = await fetch(
      `${url.replace(/\/$/, "")}/internal/brands/${encodeURIComponent(brandId)}/daily-budget`,
      { headers },
    );
    if (!res.ok) return { ok: false };
    const data = (await res.json()) as { dailyBudgetCents?: string | number | null };
    if (data.dailyBudgetCents === null || data.dailyBudgetCents === undefined) {
      return { ok: true, dailyBudgetCents: null };
    }
    const cents = typeof data.dailyBudgetCents === "number" ? data.dailyBudgetCents : parseFloat(data.dailyBudgetCents);
    if (!Number.isFinite(cents)) return { ok: false };
    return { ok: true, dailyBudgetCents: cents };
  } catch {
    return { ok: false };
  }
}
