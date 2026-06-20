import { buildServiceHeaders, type DownstreamIdentity } from "./downstream-headers.js";
import type { RuntimeGoal } from "./brand-runtime-client.js";

export interface AudienceCandidate {
  audienceId: string;
  brandProfileId: string | null;
  audience: Record<string, unknown>;
  evidence: Record<string, unknown>;
  metrics: Record<string, unknown>;
}

interface AudienceStatsResponse {
  audiences: AudienceCandidate[];
}

interface FetchTopAudienceInput {
  featureSlug: string;
  brandId: string;
  goal: RuntimeGoal;
  brandProfileId?: string;
  identity: DownstreamIdentity;
}

export async function fetchTopAudience({
  featureSlug,
  brandId,
  goal,
  brandProfileId,
  identity,
}: FetchTopAudienceInput): Promise<AudienceCandidate | null> {
  const baseUrl = process.env.FEATURES_SERVICE_URL;
  const apiKey = process.env.FEATURES_SERVICE_API_KEY;
  if (!baseUrl || !apiKey) {
    throw new Error("[campaign-service] FEATURES_SERVICE_URL or FEATURES_SERVICE_API_KEY not configured");
  }

  const url = new URL(`${baseUrl.replace(/\/$/, "")}/features/${encodeURIComponent(featureSlug)}/audience-stats`);
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
    throw new Error(`[campaign-service] FeatureService audience-stats failed (${res.status}): ${body}`);
  }

  const body = await res.json() as AudienceStatsResponse;
  if (!Array.isArray(body.audiences)) {
    throw new Error("[campaign-service] FeatureService audience-stats returned an invalid audiences payload");
  }
  return body.audiences[0] ?? null;
}
