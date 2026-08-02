import type { IdentityHeaders } from "@distribute/runs-client";
import type { RuntimeGoal } from "./brand-runtime-client.js";

/**
 * One sales funnel a brand has declared it sells through, as brand-service reports it.
 *
 * A funnel is one chain from the first signal outreach can buy (a positive reply, or a click
 * onto the site) down to a paid client, and it carries the GOAL that chain optimizes for. That
 * goal is the only field this service needs: it is what a funnel campaign paces on, so
 * features-service is asked for the best workflow and the audience evidence FOR THAT goal.
 *
 * The goal is forwarded verbatim, exactly like the brand's currentGoal — brand-service owns the
 * vocabulary and features-service owns the spelling. This service never maps or narrows it.
 */
export interface DeclaredSalesFunnel {
  /** reply_meeting | visit_meeting | visit_signup | visit_form. */
  funnelKey: string;
  active: boolean;
  goal: RuntimeGoal;
}

/**
 * Read the funnels a brand has declared it sells through.
 *
 * Contract (brand-service): GET /internal/brands/{brandId}/sales-funnels (x-api-key [+ x-org-id])
 *   -> { funnels: [{ funnelKey, active, goal, currentGoal, ... }], declared }
 *
 * Returns null when the set could not be read (missing config, network error, non-2xx,
 * unparseable payload). Callers treat that as "no funnel information this tick" and leave the
 * brand exactly as it is — provisioning a campaign is not worth guessing a goal for.
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
      funnels?: Array<{ funnelKey?: string; active?: boolean; goal?: string | null }>;
    };
    if (!Array.isArray(data.funnels)) return null;

    const funnels: DeclaredSalesFunnel[] = [];
    for (const raw of data.funnels) {
      if (!raw?.funnelKey || !raw.goal) continue;
      if (raw.active === false) continue;
      funnels.push({ funnelKey: raw.funnelKey, active: true, goal: raw.goal });
    }
    return funnels;
  } catch {
    return null;
  }
}
