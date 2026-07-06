import { buildServiceHeaders, type DownstreamIdentity } from "./downstream-headers.js";
import { fetchBrandRuntimeContext, type RuntimeGoal } from "./brand-runtime-client.js";

// One (audienceId, workflow) row from features-service GET /features/:slug/workflow-projection.
// Mirrors the row the deleted /candidates endpoint used to return: audienceId is null for the
// brand-level row and non-null for an active audience that ran this workflow dynasty. The
// workflow ranking metric now lives at resolved.costPerOutcomeUsd (was top-level).
export interface ProjectionRow {
  audienceId: string | null;
  workflow: { workflowDynastySlug: string; workflowDynastyName: string | null };
  resolved: {
    // Finest grain at which THIS row's evidence resolved (provenance only — the workflow
    // pick ignores it): "audience" → "brand" → "crossOrg".
    grain: string;
    // Cost per goal-outcome (USD) for the queried goal — THE workflow ranking metric.
    // Null when the brand has no economics to compute it (row not rankable).
    costPerOutcomeUsd: number | null;
  };
}

interface WorkflowProjectionResponse {
  rows: ProjectionRow[];
}

interface FetchWorkflowProjectionInput {
  featureSlug: string;
  brandId: string;
  goal: RuntimeGoal;
  identity: DownstreamIdentity;
}

// Pull the (audience × workflow) evidence rows from features-service's reshaped
// /workflow-projection endpoint. Sends brandId + goal (the endpoint also accepts the
// `objective` spelling; `goal` camelCase is accepted). brandProfileId is no longer a
// parameter — the new endpoint derives economics from brandId alone.
export async function fetchWorkflowProjectionRows({
  featureSlug,
  brandId,
  goal,
  identity,
}: FetchWorkflowProjectionInput): Promise<ProjectionRow[]> {
  const baseUrl = process.env.FEATURES_SERVICE_URL;
  const apiKey = process.env.FEATURES_SERVICE_API_KEY;
  if (!baseUrl || !apiKey) {
    throw new Error("[campaign-service] FEATURES_SERVICE_URL or FEATURES_SERVICE_API_KEY not configured");
  }

  const url = new URL(`${baseUrl.replace(/\/$/, "")}/features/${encodeURIComponent(featureSlug)}/workflow-projection`);
  url.searchParams.set("brandId", brandId);
  url.searchParams.set("goal", goal);

  const res = await fetch(url, { method: "GET", headers: buildServiceHeaders(apiKey, identity) });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`[campaign-service] FeatureService workflow-projection failed (${res.status}): ${body}`);
  }

  const body = await res.json() as WorkflowProjectionResponse;
  if (!Array.isArray(body.rows)) {
    throw new Error("[campaign-service] FeatureService workflow-projection returned an invalid rows payload");
  }
  return body.rows;
}

// Per-run WORKFLOW selection: GREEDY — pick the workflow with the cheapest
// cost-per-outcome, deterministically. No exploration (the audience leg, chosen
// later at /start-run, keeps Thompson — see selectAudienceForRun).
//
// features-service already computes `resolved.costPerOutcomeUsd` per row (cost per
// goal-outcome — e.g. per signup — over the upgrade chain × the brand's effective
// economics, for the goal we queried). So the "best" workflow is simply
// argmin(resolved.costPerOutcomeUsd) over the rows. GRAIN IS IRRELEVANT: whether the
// evidence resolved at brand level or cross-org, we take the cheapest — "always the
// best workflow returned by /workflow-projection", per the product decision.
//
// A workflow can appear in several rows (a brand-level row + one per audience grain);
// the global argmin naturally picks its lowest-cost row. Rows with a null
// costPerOutcomeUsd carry no rankable economics and are skipped. If NO row has a
// costPerOutcomeUsd, return null → resolveWorkflowSlugForTrigger falls back to the
// campaign's configured slug (only fallback path).
export function selectWorkflowGreedy(
  rows: ProjectionRow[],
  _goal: RuntimeGoal,
): string | null {
  let bestSlug: string | null = null;
  let bestCost = Infinity;
  for (const r of rows) {
    const cpo = r.resolved.costPerOutcomeUsd;
    if (cpo == null || !(cpo > 0)) continue; // no rankable economics for this row
    if (cpo < bestCost) {
      bestCost = cpo;
      bestSlug = r.workflow.workflowDynastySlug;
    }
  }
  return bestSlug;
}

// The set of audiences that have actually run under `workflowSlug`, derived from the
// /workflow-projection audience-grain rows (audienceId non-null ⟺ an audience-attributed
// (audienceId × workflow) couple). Used to scope the audience Thompson to the chosen
// workflow: "explore among the best audiences FOR THIS WORKFLOW", not across every audience
// the brand ever contacted.
//
// Returns a de-duplicated list of audienceIds. Empty when this workflow has no
// audience-attributed couples yet (cold workflow) — the caller then falls back to
// the unconditioned audience set so a fresh workflow still gets an audience.
export function audienceIdsForWorkflow(
  rows: ProjectionRow[],
  workflowSlug: string,
): string[] {
  const ids = new Set<string>();
  for (const r of rows) {
    if (r.audienceId != null && r.workflow.workflowDynastySlug === workflowSlug) {
      ids.add(r.audienceId);
    }
  }
  return [...ids];
}

/**
 * Resolve which workflow to launch for THIS run: resolve the brand's current goal,
 * pull the workflow-projection rows from features-service, and greedily pick the best one
 * (cheapest expected cost-per-success) — so a campaign always runs its strongest
 * workflow instead of being frozen on its configured slug. The workflow MUST be
 * chosen here (at the trigger), because it is the DAG identity in the /execute URL
 * and cannot change once the DAG is running.
 *
 * Falls back to the campaign's configured slug (no behavior change) when there is
 * no evidence yet OR features-service is unavailable — a selection optimization must
 * never block a campaign from running.
 */
export async function resolveWorkflowSlugForTrigger(args: {
  featureSlug: string;
  primaryBrandId: string;
  identity: DownstreamIdentity;
  fallbackSlug: string;
}): Promise<string> {
  const { featureSlug, primaryBrandId, identity, fallbackSlug } = args;
  try {
    const ctx = await fetchBrandRuntimeContext(primaryBrandId, identity);
    const rows = await fetchWorkflowProjectionRows({
      featureSlug,
      brandId: primaryBrandId,
      goal: ctx.currentGoal,
      identity,
    });
    return selectWorkflowGreedy(rows, ctx.currentGoal) ?? fallbackSlug;
  } catch (err) {
    console.warn(
      `[campaign-service] workflow bandit failed for brand ${primaryBrandId}, using configured workflow ${fallbackSlug}:`,
      err,
    );
    return fallbackSlug;
  }
}
