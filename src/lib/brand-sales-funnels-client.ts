import type { IdentityHeaders } from "@distribute/runs-client";
import { toFunnelKey, type SalesFunnelKey } from "./sales-funnel-vocabulary.js";

/**
 * One sales funnel a brand has declared it sells through, as brand-service reports it.
 *
 * A funnel is one chain from the first signal outreach can buy (a positive reply, or a click
 * onto the site) down to a paid client. The KEY is the only field this service needs: it names
 * what the campaign sells, it is what the campaign states on its own row, and it is what billing
 * holds that funnel's ceiling under.
 *
 * There is no goal here any more. brand-service retired the goal set (#434) because it was the
 * poorer of its two words — both meeting funnels collapsed onto one `meetingBooked` — and it now
 * emits the funnel and nothing else. Reading a goal off this payload is what would have stopped
 * every funnel campaign being provisioned the moment that shipped.
 */
export interface DeclaredSalesFunnel {
  /**
   * Canonical: sales_meetings_from_conversation | sales_meetings_from_website | website_purchases
   * | form_magnet. A pre-rename spelling on the wire is resolved to its canonical key here, so no
   * caller downstream ever sees two names for one funnel.
   */
  funnelKey: SalesFunnelKey;
  active: boolean;
}

/**
 * Read the funnels a brand has declared it sells through.
 *
 * Contract (brand-service): GET /internal/brands/{brandId}/sales-funnels (x-api-key [+ x-org-id])
 *   -> { funnels: [{ funnelKey, active, name, steps, rates, ... }] }
 *
 * Returns null when the set could not be read (missing config, network error, non-2xx,
 * unparseable payload). Callers treat that as "no funnel information this tick" and leave the
 * brand exactly as it is — provisioning a campaign is not worth guessing a funnel for.
 *
 * An EMPTY list is a real answer, not a failure: the org has declared nothing yet. Per
 * brand-service's own contract we never substitute a plausible set for it.
 *
 * Only ACTIVE funnels are returned to the caller — a funnel the org switched off must never be
 * worked, whatever billing still holds a ceiling for.
 */
export async function fetchDeclaredSalesFunnels(
  brandId: string,
  identity: IdentityHeaders,
): Promise<DeclaredSalesFunnel[] | null> {
  const url = process.env.BRAND_SERVICE_URL;
  const apiKey = process.env.BRAND_SERVICE_API_KEY;
  if (!url || !apiKey) return null;

  const headers: Record<string, string> = {
    "x-api-key": apiKey,
    // Per-brand configuration belongs to the (org, brand) pair — name the org rather than let
    // brand-service pick one for a brand several orgs claim.
    "x-org-id": identity.orgId,
    "x-brand-id": brandId,
  };
  if (identity.userId) headers["x-user-id"] = identity.userId;
  if (identity.runId) headers["x-run-id"] = identity.runId;
  if (identity.campaignId) headers["x-campaign-id"] = identity.campaignId;
  if (identity.workflowSlug) headers["x-workflow-slug"] = identity.workflowSlug;

  try {
    const res = await fetch(
      `${url.replace(/\/$/, "")}/internal/brands/${encodeURIComponent(brandId)}/sales-funnels`,
      { headers },
    );
    if (!res.ok) return null;

    const data = await res.json() as {
      funnels?: Array<{ funnelKey?: string; active?: boolean }>;
    };
    if (!Array.isArray(data.funnels)) return null;

    const funnels: DeclaredSalesFunnel[] = [];
    for (const raw of data.funnels) {
      // Any spelling in, one canonical token out. A key neither catalogue names is skipped
      // rather than worked: this service can only run a funnel it has a name for.
      const funnelKey = toFunnelKey(raw?.funnelKey);
      if (!funnelKey) continue;
      if (raw.active === false) continue;
      funnels.push({ funnelKey, active: true });
    }
    return funnels;
  } catch {
    return null;
  }
}
