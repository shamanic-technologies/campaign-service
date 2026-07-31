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

export async function fetchBrandRuntimeContext(
  brandId: string,
  identity: DownstreamIdentity,
): Promise<BrandRuntimeContext> {
  const baseUrl = process.env.BRAND_SERVICE_URL;
  const apiKey = process.env.BRAND_SERVICE_API_KEY;
  if (!baseUrl || !apiKey) {
    throw new Error("[campaign-service] BRAND_SERVICE_URL or BRAND_SERVICE_API_KEY not configured");
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
