import { buildServiceHeaders, type DownstreamIdentity } from "./downstream-headers.js";
import type { RuntimeGoal } from "./brand-runtime-client.js";

export interface CustomerPersonaCandidate {
  customerProfileId: string;
  brandProfileId: string | null;
  persona: Record<string, unknown>;
  evidence: Record<string, unknown>;
  metrics: Record<string, unknown>;
}

interface PersonaStatsResponse {
  personas: CustomerPersonaCandidate[];
}

interface FetchBestCustomerPersonaInput {
  featureSlug: string;
  brandId: string;
  goal: RuntimeGoal;
  brandProfileId?: string;
  identity: DownstreamIdentity;
}

export async function fetchBestCustomerPersona({
  featureSlug,
  brandId,
  goal,
  brandProfileId,
  identity,
}: FetchBestCustomerPersonaInput): Promise<CustomerPersonaCandidate | null> {
  const baseUrl = process.env.FEATURES_SERVICE_URL;
  const apiKey = process.env.FEATURES_SERVICE_API_KEY;
  if (!baseUrl || !apiKey) {
    throw new Error("[campaign-service] FEATURES_SERVICE_URL or FEATURES_SERVICE_API_KEY not configured");
  }

  const url = new URL(`${baseUrl.replace(/\/$/, "")}/features/${encodeURIComponent(featureSlug)}/persona-stats`);
  url.searchParams.set("brandId", brandId);
  url.searchParams.set("goal", goal);
  url.searchParams.set("limit", "1");
  if (brandProfileId) {
    url.searchParams.set("brandProfileId", brandProfileId);
  }

  const res = await fetch(url, {
    method: "GET",
    headers: buildServiceHeaders(apiKey, identity),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`[campaign-service] FeatureService persona-stats failed (${res.status}): ${body}`);
  }

  const body = await res.json() as PersonaStatsResponse;
  if (!Array.isArray(body.personas)) {
    throw new Error("[campaign-service] FeatureService persona-stats returned an invalid personas payload");
  }
  return body.personas[0] ?? null;
}
