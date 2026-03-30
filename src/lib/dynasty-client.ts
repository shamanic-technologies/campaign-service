/**
 * Client for resolving dynasty slugs via features-service and workflow-service.
 */

interface DynastyEntry {
  dynastySlug: string;
  slugs: string[];
}

/**
 * Resolve a workflow dynasty slug to the latest versioned slug (last in the list).
 */
export async function resolveLatestWorkflowSlug(dynastySlug: string): Promise<string> {
  const slugs = await resolveWorkflowDynastySlugs(dynastySlug);
  if (slugs.length === 0) {
    throw new Error(`[campaign-service] No versioned slugs found for workflow dynasty: ${dynastySlug}`);
  }
  return slugs[slugs.length - 1];
}

/**
 * Resolve a feature dynasty slug to the latest versioned slug (last in the list).
 */
export async function resolveLatestFeatureSlug(dynastySlug: string): Promise<string> {
  const slugs = await resolveFeatureDynastySlugs(dynastySlug);
  if (slugs.length === 0) {
    throw new Error(`[campaign-service] No versioned slugs found for feature dynasty: ${dynastySlug}`);
  }
  return slugs[slugs.length - 1];
}

/**
 * Resolve a workflow dynasty slug into all its versioned slugs.
 */
export async function resolveWorkflowDynastySlugs(dynastySlug: string): Promise<string[]> {
  const baseUrl = process.env.WORKFLOW_SERVICE_URL;
  const apiKey = process.env.WORKFLOW_SERVICE_API_KEY;
  if (!baseUrl || !apiKey) {
    throw new Error("[campaign-service] WORKFLOW_SERVICE_URL or WORKFLOW_SERVICE_API_KEY not configured");
  }

  const url = `${baseUrl}/workflows/dynasty/slugs?dynastySlug=${encodeURIComponent(dynastySlug)}`;
  const res = await fetch(url, {
    headers: { "x-api-key": apiKey },
  });

  if (!res.ok) {
    throw new Error(`[campaign-service] Failed to resolve workflow dynasty slug: ${res.status}`);
  }

  const body = (await res.json()) as { slugs: string[] };
  return body.slugs;
}

/**
 * Resolve a feature dynasty slug into all its versioned slugs.
 */
export async function resolveFeatureDynastySlugs(dynastySlug: string): Promise<string[]> {
  const baseUrl = process.env.FEATURES_SERVICE_URL;
  const apiKey = process.env.FEATURES_SERVICE_API_KEY;
  if (!baseUrl || !apiKey) {
    throw new Error("[campaign-service] FEATURES_SERVICE_URL or FEATURES_SERVICE_API_KEY not configured");
  }

  const url = `${baseUrl}/features/dynasty/slugs?dynastySlug=${encodeURIComponent(dynastySlug)}`;
  const res = await fetch(url, {
    headers: { "x-api-key": apiKey },
  });

  if (!res.ok) {
    throw new Error(`[campaign-service] Failed to resolve feature dynasty slug: ${res.status}`);
  }

  const body = (await res.json()) as { slugs: string[] };
  return body.slugs;
}

/**
 * Fetch all workflow dynasties and build a reverse map: slug → dynastySlug.
 */
export async function getWorkflowDynastyMap(): Promise<Map<string, string>> {
  const baseUrl = process.env.WORKFLOW_SERVICE_URL;
  const apiKey = process.env.WORKFLOW_SERVICE_API_KEY;
  if (!baseUrl || !apiKey) {
    throw new Error("[campaign-service] WORKFLOW_SERVICE_URL or WORKFLOW_SERVICE_API_KEY not configured");
  }

  const res = await fetch(`${baseUrl}/workflows/dynasties`, {
    headers: { "x-api-key": apiKey },
  });

  if (!res.ok) {
    throw new Error(`[campaign-service] Failed to fetch workflow dynasties: ${res.status}`);
  }

  const body = (await res.json()) as { dynasties: DynastyEntry[] };
  return buildSlugToDynastyMap(body.dynasties);
}

/**
 * Fetch all feature dynasties and build a reverse map: slug → dynastySlug.
 */
export async function getFeatureDynastyMap(): Promise<Map<string, string>> {
  const baseUrl = process.env.FEATURES_SERVICE_URL;
  const apiKey = process.env.FEATURES_SERVICE_API_KEY;
  if (!baseUrl || !apiKey) {
    throw new Error("[campaign-service] FEATURES_SERVICE_URL or FEATURES_SERVICE_API_KEY not configured");
  }

  const res = await fetch(`${baseUrl}/features/dynasties`, {
    headers: { "x-api-key": apiKey },
  });

  if (!res.ok) {
    throw new Error(`[campaign-service] Failed to fetch feature dynasties: ${res.status}`);
  }

  const body = (await res.json()) as { dynasties: DynastyEntry[] };
  return buildSlugToDynastyMap(body.dynasties);
}

function buildSlugToDynastyMap(dynasties: DynastyEntry[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const d of dynasties) {
    for (const slug of d.slugs) {
      map.set(slug, d.dynastySlug);
    }
  }
  return map;
}
