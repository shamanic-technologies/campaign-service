import { buildServiceHeaders, type DownstreamIdentity } from "./downstream-headers.js";

export type RuntimeGoal = "signup" | "meetingBooked" | "purchase";

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
