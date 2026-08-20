import type { ProvisioningIdentity } from "./provisioning-identity.js";

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
 * Contract (workflow-service): GET /workflows?featureSlug=&status=active (x-api-key + FULL identity)
 *   -> { workflows: [{ workflowSlug, workflowDynastySlug, featureSlug, createdAt, ... }] }
 *
 * The identity is not tracking: workflow-service answers `400 x-org-id, x-user-id, and x-run-id
 * headers are required` to anything less, so all three are always sent and the run id is one
 * runs-service can resolve (see provisioning-identity.ts).
 *
 * "This channel has NO active workflow" and "I could not READ what workflows this channel has" are
 * different answers and are returned as different ones. Both skip the pair — but only one of them
 * means the customer is funding something we failed to evaluate, and collapsing them is how a read
 * that was rejected outright on every sweep looked exactly like a channel with no dynasty.
 */
export type ActiveWorkflowRead =
  | { ok: true; workflowSlug: string }
  | { ok: true; workflowSlug: null }
  | { ok: false; detail: string };

export async function fetchActiveWorkflowSlugForFeature(
  featureSlug: string,
  identity: ProvisioningIdentity,
): Promise<ActiveWorkflowRead> {
  const baseUrl = process.env.WORKFLOW_SERVICE_URL;
  const apiKey = process.env.WORKFLOW_SERVICE_API_KEY;
  if (!baseUrl || !apiKey) {
    return { ok: false, detail: "WORKFLOW_SERVICE_URL / WORKFLOW_SERVICE_API_KEY not configured" };
  }

  const headers: Record<string, string> = {
    "x-api-key": apiKey,
    "x-org-id": identity.orgId,
    "x-user-id": identity.userId,
    "x-run-id": identity.runId,
  };
  if (identity.brandId) headers["x-brand-id"] = identity.brandId;

  try {
    const url = new URL(`${baseUrl.replace(/\/$/, "")}/workflows`);
    url.searchParams.set("featureSlug", featureSlug);
    url.searchParams.set("status", "active");

    const res = await fetch(url, { headers });
    if (!res.ok) {
      // The BODY names the missing header (`x-org-id, x-user-id, and x-run-id headers are
      // required`), which is the whole diagnostic — a bare status says nothing actionable.
      let body = "";
      try {
        body = (await res.text()).slice(0, 200);
      } catch {
        body = "";
      }
      return { ok: false, detail: `HTTP ${res.status}${body ? ` ${body}` : ""}` };
    }

    const data = await res.json() as {
      workflows?: Array<{ workflowSlug?: string; featureSlug?: string; createdAt?: string }>;
    };
    if (!Array.isArray(data.workflows)) {
      return { ok: false, detail: "response states no workflows array" };
    }

    // Filtered again on the feature: the seed must belong to the channel it is provisioned for,
    // whatever the query returned.
    const candidates = data.workflows.filter(
      (w) => typeof w?.workflowSlug === "string" && w.workflowSlug.length > 0
        && (w.featureSlug === undefined || w.featureSlug === featureSlug),
    );
    if (candidates.length === 0) return { ok: true, workflowSlug: null };

    // Newest first, so a brand-new campaign starts on the channel's current workflow rather than
    // its oldest one. Ties (or an absent createdAt) fall back to the listed order, which is stable.
    candidates.sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")));
    return { ok: true, workflowSlug: candidates[0]!.workflowSlug! };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}
