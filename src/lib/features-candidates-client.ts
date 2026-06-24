import { buildServiceHeaders, type DownstreamIdentity } from "./downstream-headers.js";
import { fetchBrandRuntimeContext, type RuntimeGoal } from "./brand-runtime-client.js";

// One (audienceId, workflow) candidate row from features-service /candidates.
// audienceId is null until features-service populates the audience grain; the
// workflow-level evidence (cost + sampleSize) is real today regardless, which is
// all the WORKFLOW bandit needs.
export interface Candidate {
  audienceId: string | null;
  workflow: { workflowDynastySlug: string; workflowDynastyName: string | null };
  goal: RuntimeGoal;
  // Finest grain at which THIS candidate's evidence resolved (provenance only —
  // the workflow pick ignores it): "audience" (brandId×goal×audienceId) →
  // "brand-goal" (brandId×goal) → "goal-global" (cross-org fallback).
  grain: "audience" | "brand-goal" | "goal-global";
  // Cost per goal-outcome (USD) for the queried goal — THE workflow ranking metric.
  // Null when the brand has no economics to compute it (row not rankable).
  costPerOutcomeUsd: number | null;
  cost: { costPerLeadUsd: number | null; clickUsd: number | null; replyUsd: number | null };
  sampleSize: { runs: number; contacted: number; clicks: number; replies: number };
}

interface CandidatesResponse {
  candidates: Candidate[];
}

interface FetchCandidatesInput {
  featureSlug: string;
  brandId: string;
  goal: RuntimeGoal;
  brandProfileId?: string;
  identity: DownstreamIdentity;
}

export async function fetchCandidates({
  featureSlug,
  brandId,
  goal,
  brandProfileId,
  identity,
}: FetchCandidatesInput): Promise<Candidate[]> {
  const baseUrl = process.env.FEATURES_SERVICE_URL;
  const apiKey = process.env.FEATURES_SERVICE_API_KEY;
  if (!baseUrl || !apiKey) {
    throw new Error("[campaign-service] FEATURES_SERVICE_URL or FEATURES_SERVICE_API_KEY not configured");
  }

  const url = new URL(`${baseUrl.replace(/\/$/, "")}/features/${encodeURIComponent(featureSlug)}/candidates`);
  url.searchParams.set("brandId", brandId);
  url.searchParams.set("goal", goal);
  if (brandProfileId) {
    url.searchParams.set("brandProfileId", brandProfileId);
  }

  const res = await fetch(url, { method: "GET", headers: buildServiceHeaders(apiKey, identity) });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`[campaign-service] FeatureService candidates failed (${res.status}): ${body}`);
  }

  const body = await res.json() as CandidatesResponse;
  if (!Array.isArray(body.candidates)) {
    throw new Error("[campaign-service] FeatureService candidates returned an invalid candidates payload");
  }
  return body.candidates;
}

// Per-run WORKFLOW selection: GREEDY — pick the workflow with the cheapest
// cost-per-outcome, deterministically. No exploration (the audience leg, chosen
// later at /start-run, keeps Thompson — see selectAudienceForRun).
//
// features-service already computes `costPerOutcomeUsd` per candidate (cost per
// goal-outcome — e.g. per signup — over the upgrade chain × the brand's effective
// economics, for the goal we queried). So the "best" workflow is simply
// argmin(costPerOutcomeUsd) over the candidate set. GRAIN IS IRRELEVANT: whether the
// evidence resolved at brand level or cross-org (goal-global), we take the cheapest —
// "always the best workflow returned by /candidates", per the product decision.
//
// A workflow can appear in several rows (a brand-goal row + one per audience grain);
// the global argmin naturally picks its lowest-cost row. Rows with a null
// costPerOutcomeUsd carry no rankable economics and are skipped. If NO candidate has a
// costPerOutcomeUsd, return null → resolveWorkflowSlugForTrigger falls back to the
// campaign's configured slug (only fallback path).
//
// Supersedes the prior Laplace-smoothed clicks/contacted recompute (greedyArgminCost
// in bandit.ts), which inflated the rate of tiny-sample workflows — contacted≈4 with
// 0 clicks read as a ~16% success rate — so the pick jumped run-to-run as samples grew.
export function selectWorkflowGreedy(
  candidates: Candidate[],
  _goal: RuntimeGoal,
): string | null {
  let bestSlug: string | null = null;
  let bestCost = Infinity;
  for (const c of candidates) {
    const cpo = c.costPerOutcomeUsd;
    if (cpo == null || !(cpo > 0)) continue; // no rankable economics for this row
    if (cpo < bestCost) {
      bestCost = cpo;
      bestSlug = c.workflow.workflowDynastySlug;
    }
  }
  return bestSlug;
}

// The set of audiences that have actually run under `workflowSlug`, derived from the
// /candidates audience-grain rows (audienceId non-null ⟺ grain "audience" ⟺ an
// audience-attributed (audienceId × workflow) couple — features-service #368). Used to scope
// the audience Thompson to the chosen workflow: "explore among the best audiences
// FOR THIS WORKFLOW", not across every audience the brand ever contacted.
//
// Returns a de-duplicated list of audienceIds. Empty when this workflow has no
// audience-attributed couples yet (cold workflow) — the caller then falls back to
// the unconditioned audience set so a fresh workflow still gets an audience.
export function audienceIdsForWorkflow(
  candidates: Candidate[],
  workflowSlug: string,
): string[] {
  const ids = new Set<string>();
  for (const c of candidates) {
    if (c.audienceId != null && c.workflow.workflowDynastySlug === workflowSlug) {
      ids.add(c.audienceId);
    }
  }
  return [...ids];
}

/**
 * Resolve which workflow to launch for THIS run: resolve the brand's current goal,
 * pull the candidate workflows from features-service, and greedily pick the best one
 * (cheapest expected cost-per-success) — so a campaign always runs its strongest
 * workflow instead of being frozen on its configured slug. The workflow MUST be
 * chosen here (at the trigger), because it is the DAG identity in the /execute URL
 * and cannot change once the DAG is running.
 *
 * Falls back to the campaign's configured slug (no behavior change) when there is
 * no candidate evidence yet OR features-service is unavailable — a selection
 * optimization must never block a campaign from running.
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
    const candidates = await fetchCandidates({
      featureSlug,
      brandId: primaryBrandId,
      goal: ctx.currentGoal,
      brandProfileId: ctx.brandProfile?.id,
      identity,
    });
    return selectWorkflowGreedy(candidates, ctx.currentGoal) ?? fallbackSlug;
  } catch (err) {
    console.warn(
      `[campaign-service] workflow bandit failed for brand ${primaryBrandId}, using configured workflow ${fallbackSlug}:`,
      err,
    );
    return fallbackSlug;
  }
}
