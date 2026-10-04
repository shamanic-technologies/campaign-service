import type { IdentityHeaders } from "@distribute/runs-client";
import type { SalesItem } from "./sales-items.js";

/**
 * A brand's funding MODE, as billing-service holds it for ONE org's view of a brand.
 *
 *   GET /internal/brands/{brandId}/sales-budget (x-api-key + x-org-id)
 *     -> { brandId, orgId, mode: "campaigns" | "global" | "items", dailyBudgetCents: string | null,
 *          items?: [{ offerId, legKey, featureSlug, role: "proactive" | "reactive" | null,
 *                     budgetCents: string, period: "day" | "month", periodStart: string | null,
 *                     periodEnd: string | null, managed: boolean | null }], updatedAt }
 *
 * - `campaigns` (the default, and every brand before 2026-09-29): each (offer, leg, channel)
 *   campaign is paced on its own ceiling. The turn planner behaves exactly as it always did.
 * - `global`: the brand stated ONE daily amount for SALES, the one pot every sales campaign of the
 *   brand draws on (reactive legs first, entry legs on what is left, behind the best-ROI sales path
 *   features-service ranks). billing only stores and serves the amount.
 * - `items` (2026-10-04, one budget per campaign): served for a brand holding a subscriber's MONTHLY
 *   budget; one row per (offer, leg, channel) campaign. Each budget is spent by the campaign
 *   performing it and nothing else; the global pot is gone for that brand. See `sales-items.ts`.
 *
 * billing never fabricates a mode: no stored row IS `campaigns`.
 */
export type BrandSalesBudgetRead =
  | { ok: true; mode: "campaigns" }
  | { ok: true; mode: "global"; dailyBudgetCents: number }
  | { ok: true; mode: "items"; items: SalesItem[] }
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
    const data = (await res.json()) as { mode?: unknown; dailyBudgetCents?: unknown; items?: unknown };
    if (data.mode === "campaigns") return { ok: true, mode: "campaigns" };
    if (data.mode === "global") {
      const cents = typeof data.dailyBudgetCents === "string" ? parseFloat(data.dailyBudgetCents) : NaN;
      // A global mode with no readable amount is not "unbounded" — it is unreadable.
      if (!Number.isFinite(cents) || cents < 0) {
        return { ok: false, detail: `global mode states no readable amount (${String(data.dailyBudgetCents)})` };
      }
      return { ok: true, mode: "global", dailyBudgetCents: cents };
    }
    if (data.mode === "items") {
      const items = parseSalesItems(data.items);
      if (typeof items === "string") return { ok: false, detail: `items mode: ${items}` };
      return { ok: true, mode: "items", items };
    }
    return { ok: false, detail: `unknown mode ${String(data.mode)}` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Parse billing's item list. Any item that does not state all of (offer, leg, channel), a readable
 * non-negative budget and a known period refuses the WHOLE read (returns why): one unreadable item
 * is a cap we cannot read, and the brand is held rather than one campaign spending on nothing.
 * A monthly item must state the period it covers.
 */
export function parseSalesItems(raw: unknown): SalesItem[] | string {
  if (!Array.isArray(raw)) return "no items array";
  const items: SalesItem[] = [];
  for (const r of raw as Array<Record<string, unknown>>) {
    if (!r || typeof r !== "object") return "an item is not an object";
    const { offerId, legKey, featureSlug, role, budgetCents, period, periodStart, periodEnd, managed } = r;
    if (typeof offerId !== "string" || !offerId) return "an item states no offerId";
    if (typeof legKey !== "string" || !legKey) return "an item states no legKey";
    if (typeof featureSlug !== "string" || !featureSlug) return "an item states no featureSlug";
    const cents = typeof budgetCents === "string" || typeof budgetCents === "number" ? Number(budgetCents) : NaN;
    if (!Number.isFinite(cents) || cents < 0) return `item ${offerId}/${legKey}/${featureSlug} states no readable budget (${String(budgetCents)})`;
    if (period !== "day" && period !== "month") return `item ${offerId}/${legKey}/${featureSlug} states an unknown period (${String(period)})`;
    const start = typeof periodStart === "string" ? new Date(periodStart) : null;
    const end = typeof periodEnd === "string" ? new Date(periodEnd) : null;
    if (period === "month") {
      if (!start || !end || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
        return `monthly item ${offerId}/${legKey}/${featureSlug} states no readable period (${String(periodStart)} to ${String(periodEnd)})`;
      }
    }
    // null = billing could not read its catalogue for this channel: THAT campaign is held, not the brand.
    if (managed !== null && typeof managed !== "boolean") return `item ${offerId}/${legKey}/${featureSlug} states a non-boolean managed (${String(managed)})`;
    // null/absent = billing could not read the catalogue for this leg: our own catalogue read decides.
    if (role !== undefined && role !== null && role !== "proactive" && role !== "reactive") {
      return `item ${offerId}/${legKey}/${featureSlug} states an unknown role (${String(role)})`;
    }
    items.push({
      offerId,
      legKey,
      featureSlug,
      role: role ?? null,
      budgetCents: cents,
      period,
      periodStart: start,
      periodEnd: end,
      managed,
    });
  }
  return items;
}
