import { buildServiceHeaders, type DownstreamIdentity } from "./downstream-headers.js";
import { fetchBrandRuntimeContext, type RuntimeGoal } from "./brand-runtime-client.js";
import { thompsonArgminCost, type Arm, type Rng } from "./bandit.js";

// One (audienceId, workflow) candidate row from features-service /candidates.
// audienceId is null until features-service populates the audience grain; the
// workflow-level evidence (cost + sampleSize) is real today regardless, which is
// all the WORKFLOW bandit needs.
export interface Candidate {
  audienceId: string | null;
  workflow: { workflowDynastySlug: string; workflowDynastyName: string | null };
  goal: RuntimeGoal;
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

// Collapse the candidate set to one arm per workflow: aggregate the sample size
// across that workflow's rows (a workflow may appear once per audience once the
// audience grain is populated). Cost is the per-workflow unit cost (goal-global,
// identical across the workflow's rows). Success = the goal's outcome — clicks for
// signup, positive replies otherwise.
export function selectWorkflowByThompson(
  candidates: Candidate[],
  goal: RuntimeGoal,
  rng?: Rng,
): string | null {
  if (candidates.length === 0) return null;

  const byWorkflow = new Map<string, { arm: Arm }>();
  for (const c of candidates) {
    const slug = c.workflow.workflowDynastySlug;
    const successes = goal === "signup" ? c.sampleSize.clicks : c.sampleSize.replies;
    const existing = byWorkflow.get(slug);
    if (existing) {
      existing.arm.trials += c.sampleSize.contacted;
      existing.arm.successes += successes;
      if (existing.arm.costPerTrial == null && c.cost.costPerLeadUsd != null) {
        existing.arm.costPerTrial = c.cost.costPerLeadUsd;
      }
    } else {
      byWorkflow.set(slug, {
        arm: {
          trials: c.sampleSize.contacted,
          successes,
          costPerTrial: c.cost.costPerLeadUsd,
        },
      });
    }
  }

  const slugs = [...byWorkflow.keys()];
  const idx = thompsonArgminCost(slugs.map((s) => byWorkflow.get(s)!.arm), rng);
  return idx === null ? null : slugs[idx];
}

/**
 * Resolve which workflow to launch for THIS run: resolve the brand's current goal,
 * pull the candidate workflows from features-service, and Thompson-pick one — so a
 * campaign's workflow varies run-to-run instead of being frozen on its configured
 * slug. The workflow MUST be chosen here (at the trigger), because it is the DAG
 * identity in the /execute URL and cannot change once the DAG is running.
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
    return selectWorkflowByThompson(candidates, ctx.currentGoal) ?? fallbackSlug;
  } catch (err) {
    console.warn(
      `[campaign-service] workflow bandit failed for brand ${primaryBrandId}, using configured workflow ${fallbackSlug}:`,
      err,
    );
    return fallbackSlug;
  }
}
