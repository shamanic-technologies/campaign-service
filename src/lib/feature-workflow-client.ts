import type { IdentityHeaders } from "@distribute/runs-client";

/**
 * A workflow that can actually RUN a given acquisition channel.
 *
 * Provisioning used to copy the seed campaign's workflow slug, which was right while every campaign
 * of a brand ran the same feature. It stops being right the moment a brand works one funnel through
 * TWO channels: a workflow belongs to a feature, so handing the feedback-request campaign the sales
 * pitch's DAG would run the wrong offer — and handing it a slug of no feature at all is refused by
 * workflow-service, which is a campaign that stays ongoing and produces nothing forever.
 *
 * So the workflow is asked for, per feature, and a channel workflow-service has no ACTIVE workflow
 * for is NOT provisioned. That is fail-closed on purpose: a campaign with no DAG to run is not a
 * campaign, and the next sweep provisions it the moment the dynasty ships. The slug chosen here is
 * only the seed — the greedy rotation re-picks one every run from that feature's own evidence.
 *
 * Contract (workflow-service): GET /workflows?featureSlug=&status=active
 *   -> { workflows: [{ workflowSlug, workflowDynastySlug, featureSlug, createdAt, ... }] }
 *
 * Returns null on missing config, network error, non-2xx, an unparseable payload, or a feature with
 * no active workflow.
 */
export async function fetchActiveWorkflowSlugForFeature(
  featureSlug: string,
  identity: IdentityHeaders,
): Promise<string | null> {
  const baseUrl = process.env.WORKFLOW_SERVICE_URL;
  const apiKey = process.env.WORKFLOW_SERVICE_API_KEY;
  if (!baseUrl || !apiKey) return null;

  const headers: Record<string, string> = {
    "x-api-key": apiKey,
    "x-org-id": identity.orgId,
  };
  if (identity.userId) headers["x-user-id"] = identity.userId;
  if (identity.runId) headers["x-run-id"] = identity.runId;
  if (identity.brandId) headers["x-brand-id"] = identity.brandId;

  try {
    const url = new URL(`${baseUrl.replace(/\/$/, "")}/workflows`);
    url.searchParams.set("featureSlug", featureSlug);
    url.searchParams.set("status", "active");

    const res = await fetch(url, { headers });
    if (!res.ok) return null;

    const data = await res.json() as {
      workflows?: Array<{ workflowSlug?: string; featureSlug?: string; createdAt?: string }>;
    };
    if (!Array.isArray(data.workflows)) return null;

    // Filtered again on the feature: the seed must belong to the channel it is provisioned for,
    // whatever the query returned.
    const candidates = data.workflows.filter(
      (w) => typeof w?.workflowSlug === "string" && w.workflowSlug.length > 0
        && (w.featureSlug === undefined || w.featureSlug === featureSlug),
    );
    if (candidates.length === 0) return null;

    // Newest first, so a brand-new campaign starts on the channel's current workflow rather than
    // its oldest one. Ties (or an absent createdAt) fall back to the listed order, which is stable.
    candidates.sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")));
    return candidates[0]!.workflowSlug!;
  } catch {
    return null;
  }
}
