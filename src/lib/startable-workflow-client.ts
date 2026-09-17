import type { IdentityHeaders } from "@distribute/runs-client";

/**
 * WHICH WORKFLOW A CHANNEL RUNS — workflow-service's statement, asked when a PERSON starts a
 * campaign and at no other moment.
 *
 * This read looks like the one deleted on 2026-09-06 and it answers a different question, which is
 * the whole reason it exists under its own name. `feature-workflow-client.ts` was one of the reads
 * that only ever answered *"should this money have a campaign?"* — it ran on a sweep, off a funded
 * ceiling, and its answer decided whether this service would create a campaign nobody had asked
 * for. That question is gone and stays gone (`tests/unit/no-legacy.test.ts` keeps that file
 * deleted, and no sweep, tick or ceiling reaches this one).
 *
 * What is asked here is *"the customer pressed start on this channel: which DAG runs it?"* The
 * caller is a person on their own dashboard, and the answer cannot come from their browser: a
 * workflow is this service's choice, re-picked every run by the greedy rotation from that feature's
 * own evidence, and a slug a browser froze would go stale the moment the catalogue moves. So the
 * slug chosen here is only the SEED the campaign is born on.
 *
 * Contract (workflow-service): GET /workflows?featureSlug=&status=active (x-api-key + FULL identity)
 *   -> { workflows: [{ workflowSlug, workflowDynastySlug, featureSlug, createdAt, ... }] }
 *
 * The identity is not tracking: workflow-service answers `400 x-org-id, x-user-id, and x-run-id
 * headers are required` to anything less, so all three are always sent — and the run id is the
 * customer request's own, which api-service created and runs-service can resolve. A minted uuid is
 * never handed to another service (see trigger-run.ts).
 *
 * "This channel has NO active workflow" and "I could not READ what workflows it has" are different
 * answers and are returned as different ones. Only one of them means the customer is looking at a
 * channel nothing can run, and only the other means they should try again in a minute — collapsing
 * the two is how a read that was rejected outright looked exactly like a channel with no dynasty.
 */
export type StartableWorkflowRead =
  | { ok: true; workflowSlug: string }
  | { ok: true; workflowSlug: null }
  | { ok: false; detail: string };

export async function fetchStartableWorkflowSlug(
  featureSlug: string,
  identity: IdentityHeaders & { userId: string; runId: string },
): Promise<StartableWorkflowRead> {
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

    // Filtered again on the feature: the seed must belong to the channel it is started for,
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
