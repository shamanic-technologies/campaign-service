import type { IdentityHeaders } from "@distribute/runs-client";

/**
 * A brand's funding MODE, as billing-service holds it for ONE org's view of a brand.
 *
 *   GET /internal/brands/{brandId}/sales-budget (x-api-key + x-org-id)
 *     -> { brandId, orgId, mode: "campaigns" | "global", dailyBudgetCents: string | null, updatedAt }
 *
 * - `campaigns` (the default, and every brand before 2026-09-29): each (offer, leg, channel)
 *   campaign is paced on its own ceiling. The turn planner behaves exactly as it always did.
 * - `global`: the brand stated ONE daily amount for SALES. This service decides where it goes —
 *   behind the best-ROI sales path features-service ranks — and runs the reactive legs whenever
 *   the customer authorised them. billing only stores and serves the amount.
 *
 * billing never fabricates a mode: no stored row IS `campaigns`.
 */
export type BrandSalesBudgetRead =
  | { ok: true; mode: "campaigns" }
  | { ok: true; mode: "global"; dailyBudgetCents: number }
  | { ok: false; detail: string };

/**
 * Read the brand's funding mode.
 *
 * ok:false on missing config, network error, non-2xx, an unknown mode or a global mode stating no
 * parseable amount. The caller treats that exactly like an unreadable campaign ceiling: fail-CLOSED
 * (the brand is held), because a mode we cannot read is a cap we cannot read.
 */
export async function fetchBrandSalesBudget(
  brandId: string,
  identity: IdentityHeaders,
): Promise<BrandSalesBudgetRead> {
  const url = process.env.BILLING_SERVICE_URL;
  const apiKey = process.env.BILLING_SERVICE_API_KEY;
  if (!url || !apiKey) return { ok: false, detail: "BILLING_SERVICE_URL or BILLING_SERVICE_API_KEY not configured" };

  const headers: Record<string, string> = {
    "x-api-key": apiKey,
    "x-org-id": identity.orgId,
    "x-brand-id": brandId,
  };
  if (identity.userId) headers["x-user-id"] = identity.userId;
  if (identity.runId) headers["x-run-id"] = identity.runId;
  if (identity.campaignId) headers["x-campaign-id"] = identity.campaignId;

  try {
    const res = await fetch(
      `${url.replace(/\/$/, "")}/internal/brands/${encodeURIComponent(brandId)}/sales-budget`,
      { headers },
    );
    if (!res.ok) {
      let body = "";
      try {
        body = (await res.text()).slice(0, 200);
      } catch {
        body = "";
      }
      return { ok: false, detail: `HTTP ${res.status}${body ? ` ${body}` : ""}` };
    }
    const data = (await res.json()) as { mode?: unknown; dailyBudgetCents?: unknown };
    if (data.mode === "campaigns") return { ok: true, mode: "campaigns" };
    if (data.mode === "global") {
      const cents = typeof data.dailyBudgetCents === "string" ? parseFloat(data.dailyBudgetCents) : NaN;
      // A global mode with no readable amount is not "unbounded" — it is unreadable.
      if (!Number.isFinite(cents) || cents < 0) {
        return { ok: false, detail: `global mode states no readable amount (${String(data.dailyBudgetCents)})` };
      }
      return { ok: true, mode: "global", dailyBudgetCents: cents };
    }
    return { ok: false, detail: `unknown mode ${String(data.mode)}` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}
