import { buildServiceHeaders, type DownstreamIdentity } from "./downstream-headers.js";

/**
 * The brand's runtime optimization goal, as brand-service reports it.
 *
 * Deliberately a bare string, not a union. brand-service owns this vocabulary and its own
 * column already permits values this service has no name for; features-service owns the
 * spelling and fails loud on a goal it cannot resolve. campaign-service only carries the
 * value from one to the other, so narrowing it here bought nothing and silently capped what
 * a campaign could pace on.
 *
 * Kept as a named alias rather than inlining `string` so every call site still reads as "this
 * string is a goal" — the name is documentation, not a constraint.
 */
export type RuntimeGoal = string;

export interface BrandProfile {
  id: string;
  brandId: string;
  version: number;
  fields: Record<string, unknown>;
  createdAt: string;
}

export interface BrandRuntimeContext {
  brand: Record<string, unknown>;
  currentGoal: RuntimeGoal;
  brandProfile: BrandProfile | null;
}

/**
 * Read the runtime context brand-service holds for ONE org's view of a brand.
 *
 * The brand row is a shared global identity — several orgs legitimately claim the same
 * domain — but everything a customer configures on top of it (the goal, the confirmed
 * profile fields) belongs to the (org, brand) pair. So "the runtime context of brand X"
 * has no single answer, and brand-service resolves the org from `x-org-id`: it will only
 * fall back to the sole claiming org when exactly one exists, and 400s (`ORG_REQUIRED`)
 * rather than guess for a brand several orgs claim.
 *
 * `identity.orgId` is therefore load-bearing on this call, not merely tracking: it names
 * WHOSE configuration we want. It is asserted below rather than left to
 * `buildServiceHeaders`, so dropping it can never silently degrade into brand-service
 * picking an org for us.
 */
export async function fetchBrandRuntimeContext(
  brandId: string,
  identity: DownstreamIdentity,
): Promise<BrandRuntimeContext> {
  const baseUrl = process.env.BRAND_SERVICE_URL;
  const apiKey = process.env.BRAND_SERVICE_API_KEY;
  if (!baseUrl || !apiKey) {
    throw new Error("[campaign-service] BRAND_SERVICE_URL or BRAND_SERVICE_API_KEY not configured");
  }
  // Fail loud rather than let the call go out org-less. A stand-in org would be the very
  // cross-org read brand-service is closing, and an org-less call is only answerable for a
  // brand exactly one org claims — which is a silent, data-dependent behaviour change.
  if (!identity.orgId || identity.orgId.trim() === "") {
    throw new Error(
      `[campaign-service] BrandService runtime-context for brand ${brandId} requires an org: ` +
      "per-brand configuration belongs to an (org, brand) pair and this service must name the org.",
    );
  }

  const url = `${baseUrl.replace(/\/$/, "")}/internal/brands/${encodeURIComponent(brandId)}/runtime-context`;
  const res = await fetch(url, {
    method: "GET",
    headers: buildServiceHeaders(apiKey, identity),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`[campaign-service] BrandService runtime-context failed (${res.status}): ${body}`);
  }

  return await res.json() as BrandRuntimeContext;
}
