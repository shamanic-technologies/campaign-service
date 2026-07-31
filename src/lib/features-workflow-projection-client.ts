import { buildServiceHeaders, type DownstreamIdentity } from "./downstream-headers.js";
import { fetchBrandRuntimeContext, type RuntimeGoal } from "./brand-runtime-client.js";
import { thompsonArgminCost, type Arm, type Rng } from "./bandit.js";

// Audience-grain, send-tagged evidence for one (audience × workflow dynasty) couple.
// Present ONLY on audienceId != null rows whose audience actually spent under this couple
// (features-service omits the audience grain when audience-level spend is 0). An audience
// enumerated with NO audience grain has its cost floored to brand/crossOrg in `resolved` —
// campaign-service treats it as a COLD Thompson arm (zero trials → gets explored).
export interface ProjectionAudienceEvidence {
  spentUsd: number;
  observedContacted: number;
  observedClicks: number;
  observedPositiveReplies: number;
  // Goal-RESOLVED (expected) outcome count for this audience grain — the numerator behind the
  // grain's cost-per-outcome, projected from the grain's OWN observed clicks/replies through
  // the queried goal's funnel (features-service owns the funnel; for the combined `sales` goal
  // it's the best channel max(clicks·v2pc, replies·r2pc)). Coherent: spentUsd / this ==
  // cost-per-outcome. 0 when the grain observed 0 of the driving outcome; null only at cold
  // start (no economics). This is the Thompson success count — campaign-service NEVER re-decides
  // the CPC-vs-CPPR funnel metric, features-service does.
  resolvedOutcomeCount: number | null;
}

// One (audienceId, workflow) row from features-service GET /features/:slug/workflow-projection.
// audienceId is null for the brand-level row and non-null for EVERY active audience of the brand
// under this workflow dynasty (features-service#638 enumerates all active audiences per dynasty;
// audiences with no couple floor to brand/crossOrg). The workflow ranking metric lives at
// resolved.costPerOutcomeUsd; the audience Thompson reads audienceEvidence.
export interface ProjectionRow {
  audienceId: string | null;
  workflow: { workflowDynastySlug: string; workflowDynastyName: string | null };
  // Null when this row carries no audience-grain evidence (brand-level row, or a floored
  // audience with zero audience-level spend under this workflow).
  audienceEvidence: ProjectionAudienceEvidence | null;
  resolved: {
    // Finest grain at which THIS row's evidence resolved (provenance only — the workflow
    // pick ignores it): "audience" → "brand" → "crossOrg".
    grain: string;
    // Cost per goal-outcome (USD) for the queried goal — THE workflow ranking metric.
    // Null when the brand has no economics to compute it (row not rankable).
    costPerOutcomeUsd: number | null;
  };
}

// Raw endpoint row shape — richer than ProjectionRow. We extract only the fields both legs
// (workflow greedy + audience Thompson) need; the audience grain's raw evidence is folded into
// the normalized `audienceEvidence` so downstream code never reaches into estimatesByGrain.
interface RawProjectionRow {
  audienceId: string | null;
  workflow: { workflowDynastySlug: string; workflowDynastyName: string | null };
  estimatesByGrain?: {
    audience?: {
      evidence?: {
        spentUsd: number;
        observedContacted: number;
        observedClicks: number;
        observedPositiveReplies: number;
      };
      // Goal-resolved outcome numerator for the audience grain (features-service#645).
      resolvedOutcomeCount?: number | null;
    };
  };
  resolved: { grain: string; costPerOutcomeUsd: number | null };
}

interface WorkflowProjectionResponse {
  rows: RawProjectionRow[];
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
  return normalizeProjectionRows(body.rows);
}

// Fold the audience-grain raw evidence into `audienceEvidence` so the selection code reads a
// flat shape and never depends on the estimatesByGrain nesting. Shared by /workflow-projection
// and /goal-arbitration — both serve the SAME row shape, so both normalize identically and the
// audience bandit cannot behave differently depending on which endpoint fed it.
function normalizeProjectionRows(rows: RawProjectionRow[]): ProjectionRow[] {
  return rows.map((r): ProjectionRow => {
    const ev = r.estimatesByGrain?.audience?.evidence;
    return {
      audienceId: r.audienceId,
      workflow: r.workflow,
      audienceEvidence: ev
        ? {
            spentUsd: ev.spentUsd,
            observedContacted: ev.observedContacted,
            observedClicks: ev.observedClicks,
            observedPositiveReplies: ev.observedPositiveReplies,
            resolvedOutcomeCount: r.estimatesByGrain?.audience?.resolvedOutcomeCount ?? null,
          }
        : null,
      resolved: r.resolved,
    };
  });
}

// ── Goal arbitration (features-service GET /features/:slug/goal-arbitration) ────────────────
//
// The GOAL is the third selection lever, and it is arbitrated by features-service, not here.
// It answers, in ONE call: which of the goals the brand AUTHORIZES returns the most per dollar,
// that goal's best workflow, and the pairing's audience rows (same `ProjectionRow` shape the
// audience bandit already parses). campaign-service greedily takes the first two and
// Thompson-samples the third — it decides none of them and never issues one request per goal.
//
// Why features-service and not us: a cost-per-outcome is denominated in each goal's OWN outcome
// (a click, a reply, a booked meeting), so comparing two goals' cost-per-outcome compares two
// different things. Only features-service can normalise each goal through its own funnel to the
// same terminal unit. Ranking goals here would be re-deriving their economics.
export interface GoalArbitration {
  /** The elected goal, canonical camel spelling — forwarded verbatim, never rewritten. */
  goal: RuntimeGoal;
  /** The elected goal's best workflow dynasty slug. */
  workflowSlug: string;
  /** The winning (goal × workflow) pairing's rows, for the audience Thompson. */
  rows: ProjectionRow[];
}

interface RawGoalArbitrationResponse {
  arbitration?: { status?: string; goal?: string | null };
  workflow?: { workflowDynastySlug?: string } | null;
  rows?: RawProjectionRow[];
}

// features-service 502s with this reason for as long as brand-service has not declared the
// brand's authorized goal set. That is their fail-loud (they refuse to substitute a default
// set), but for US it is an EXPECTED business state, not a fault: it means "this brand has no
// arbitration yet", and it fires on EVERY tick for EVERY campaign of EVERY client until
// brand-service ships. Per the log discipline in CLAUDE.md that is exactly the routine
// high-frequency event that must not be logged at all — a warn here would bury real signal
// fleet-wide. Any OTHER failure is a genuine anomaly and still warns.
const EXPECTED_NO_ARBITRATION_REASON = "authorized_goals_unavailable";

/**
 * Ask features-service to elect the goal (and its best workflow) for this brand.
 *
 * Returns null when nothing could be elected — the brand authorizes no set yet, every
 * authorized goal is unrankable, or features-service is unreachable. The caller then paces on
 * the campaign's own goal or the brand's goal, i.e. exactly the pre-arbitration behaviour: a
 * selection optimization must never block a campaign from running.
 */
export async function fetchGoalArbitration({
  featureSlug,
  brandId,
  identity,
}: {
  featureSlug: string;
  brandId: string;
  identity: DownstreamIdentity;
}): Promise<GoalArbitration | null> {
  const baseUrl = process.env.FEATURES_SERVICE_URL;
  const apiKey = process.env.FEATURES_SERVICE_API_KEY;
  if (!baseUrl || !apiKey) {
    throw new Error("[campaign-service] FEATURES_SERVICE_URL or FEATURES_SERVICE_API_KEY not configured");
  }

  const url = new URL(`${baseUrl.replace(/\/$/, "")}/features/${encodeURIComponent(featureSlug)}/goal-arbitration`);
  url.searchParams.set("brandId", brandId);

  const res = await fetch(url, { method: "GET", headers: buildServiceHeaders(apiKey, identity) });
  if (!res.ok) {
    const body = await res.text();
    if (body.includes(EXPECTED_NO_ARBITRATION_REASON)) return null;
    throw new Error(`[campaign-service] FeatureService goal-arbitration failed (${res.status}): ${body}`);
  }

  const body = await res.json() as RawGoalArbitrationResponse;
  // "unrankable" is a real 200 answer, not an error: the brand authorizes an empty set, or every
  // goal it authorizes has no defined return. Nothing to elect → the caller keeps its own goal.
  if (body.arbitration?.status !== "resolved") return null;

  const goal = body.arbitration.goal;
  const workflowSlug = body.workflow?.workflowDynastySlug;
  if (!goal || !workflowSlug) {
    throw new Error(
      "[campaign-service] FeatureService goal-arbitration returned status=resolved without a goal or workflow",
    );
  }

  return { goal, workflowSlug, rows: normalizeProjectionRows(body.rows ?? []) };
}

// Per-run WORKFLOW selection: GREEDY — pick the workflow with the cheapest
// cost-per-outcome, deterministically. No exploration (the audience leg, chosen
// later at /start-run, keeps Thompson — see selectAudienceFromProjection).
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

// Maps a projection audience row to a Thompson arm, ranking on the GOAL-RESOLVED economics
// features-service owns — NOT a locally-chosen CPC-vs-CPPR proxy:
//   trials       = leads contacted
//   successes    = the audience grain's goal-resolved outcome count (features-service#645) —
//                  clicks / replies / combined-`sales`, whatever features resolved for the goal
//   costPerTrial = spend per contacted lead (USD — only ordering matters)
// The engine's score = costPerTrial / sampledRate = spend / resolvedOutcomes = cost-per-outcome
// (== ROI ranking, since a brand's LTR is constant). campaign-service never re-decides whether
// the funnel is click- or reply-driven; features-service is the guardian of that via the count.
// A row with no audience-grain evidence (floored / never-run couple) is a COLD arm (0 trials,
// null cost) so it still gets explored. resolvedOutcomeCount null (cold-start economics) → 0.
function toArm(ev: ProjectionAudienceEvidence | null): Arm {
  if (!ev) return { trials: 0, successes: 0, costPerTrial: null };
  const trials = ev.observedContacted;
  const successes = ev.resolvedOutcomeCount ?? 0;
  const costPerTrial = trials > 0 ? ev.spentUsd / trials : null;
  return { trials, successes, costPerTrial };
}

// Keep one row per audienceId, preferring the row that carries audience-grain evidence.
function dedupeByAudience(rows: ProjectionRow[]): ProjectionRow[] {
  const byId = new Map<string, ProjectionRow>();
  for (const r of rows) {
    if (r.audienceId == null) continue;
    const existing = byId.get(r.audienceId);
    if (!existing || (existing.audienceEvidence == null && r.audienceEvidence != null)) {
      byId.set(r.audienceId, r);
    }
  }
  return [...byId.values()];
}

/**
 * Per-run AUDIENCE selection: cost-aware Thompson sampling over the chosen workflow's audience
 * rows from /workflow-projection — so the contacted audience varies per run (exploration) and
 * is scored on THIS workflow's send-tagged evidence.
 *
 * features-service#638 enumerates EVERY active audience of the brand for each dynasty (floored
 * to brand/crossOrg when the audience has no couple), so the chosen-workflow rows already ARE
 * the brand's active-audience set — no separate audience-stats call is needed. Fallback: if the
 * chosen workflow has no rows at all (a cold/fallback slug absent from the projection), explore
 * one row per audience across ALL workflows so a fresh workflow still gets an audience.
 *
 * requiredAudienceIds is the Campaign v2 HARD targeting subset (no fallback — empty → null).
 * excludedAudienceIds is the fresh-exhausted set (no fallback — empty → null = the real
 * all-audiences-exhausted stop signal). Returns the chosen audienceId, or null.
 */
export function selectAudienceFromProjection(
  rows: ProjectionRow[],
  workflowSlug: string,
  opts: { requiredAudienceIds?: string[]; excludedAudienceIds?: string[]; rng?: Rng } = {},
): string | null {
  let candidates = rows.filter(
    (r) => r.audienceId != null && r.workflow.workflowDynastySlug === workflowSlug,
  );
  if (candidates.length === 0) {
    // Cold/fallback workflow not present in the projection → explore across all audiences.
    candidates = dedupeByAudience(rows.filter((r) => r.audienceId != null));
  } else {
    candidates = dedupeByAudience(candidates);
  }

  // HARD targeting subset — the campaign may ONLY ever be served one of its targeted audiences.
  if (opts.requiredAudienceIds && opts.requiredAudienceIds.length > 0) {
    const required = new Set(opts.requiredAudienceIds);
    candidates = candidates.filter((r) => required.has(r.audienceId!));
    if (candidates.length === 0) return null;
  }

  // Drop exhausted audiences (24h TTL). No fallback: empty → null (all exhausted = stop).
  if (opts.excludedAudienceIds && opts.excludedAudienceIds.length > 0) {
    const excluded = new Set(opts.excludedAudienceIds);
    candidates = candidates.filter((r) => !excluded.has(r.audienceId!));
    if (candidates.length === 0) return null;
  }

  if (candidates.length === 0) return null;
  const idx = thompsonArgminCost(
    candidates.map((r) => toArm(r.audienceEvidence)),
    opts.rng,
  );
  return idx === null ? null : candidates[idx].audienceId;
}

/**
 * Does the campaign still have at least one serveable, non-exhausted audience?
 *
 * Mirrors selectAudienceFromProjection's eligibility but drops the workflow scoping — an
 * audience serveable under ANY workflow keeps the campaign alive — and ignores the Thompson
 * draw (a boolean, not a pick). Returns false only when EVERY targeted audience is exhausted
 * (the sole legitimate campaign-wide stop condition).
 */
export function hasServeableAudienceInProjection(
  rows: ProjectionRow[],
  opts: { requiredAudienceIds?: string[]; excludedAudienceIds?: string[] } = {},
): boolean {
  let ids = new Set<string>();
  for (const r of rows) if (r.audienceId != null) ids.add(r.audienceId);

  if (opts.requiredAudienceIds && opts.requiredAudienceIds.length > 0) {
    const required = new Set(opts.requiredAudienceIds);
    ids = new Set([...ids].filter((id) => required.has(id)));
  }
  if (opts.excludedAudienceIds) {
    for (const e of opts.excludedAudienceIds) ids.delete(e);
  }
  return ids.size > 0;
}

// Per-run workflow rotation (the greedy bandit) is enabled ONLY for these features.
// Every other feature always runs its campaign's configured workflowSlug, run after run,
// with no features-service call and no rotation. Product decision (2026-07-07): only
// sales-cold-email-outreach should vary its workflow across runs.
const WORKFLOW_ROTATION_FEATURE_SLUGS = new Set<string>(["sales-cold-email-outreach"]);

/**
 * Whether the greedy workflow rotation applies to a given feature. When false, the
 * trigger keeps the campaign's configured workflowSlug (no features-service call).
 */
export function isWorkflowRotationEnabled(featureSlug: string): boolean {
  return WORKFLOW_ROTATION_FEATURE_SLUGS.has(featureSlug);
}

/**
 * Resolve which workflow to launch for THIS run: resolve the brand's current goal,
 * pull the workflow-projection rows from features-service, and greedily pick the best one
 * (cheapest expected cost-per-success) — so a campaign always runs its strongest
 * workflow instead of being frozen on its configured slug. The workflow MUST be
 * chosen here (at the trigger), because it is the DAG identity in the /execute URL
 * and cannot change once the DAG is running.
 *
 * Rotation is scoped to the features in WORKFLOW_ROTATION_FEATURE_SLUGS; for any other
 * feature this returns the configured slug immediately (no rotation, no fetch).
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
  // Campaign v2: the campaign's OWN goal. When set, the greedy workflow pick paces on it
  // instead of the brand's currentGoal — so the campaign's own goal drives BOTH the trigger
  // (workflow) and /start-run (audience) legs. NULL/undefined → pace on the brand goal.
  goalOverride?: RuntimeGoal | null;
}): Promise<string> {
  const { featureSlug, primaryBrandId, identity, fallbackSlug, goalOverride } = args;
  // Rotation is feature-scoped: non-rotating features keep their configured workflow.
  if (!isWorkflowRotationEnabled(featureSlug)) return fallbackSlug;
  try {
    // A campaign that states its OWN goal is a manual override and is NOT arbitrated — the
    // customer picked that goal on purpose. Arbitration only fills the inherit case.
    if (!goalOverride) {
      const arbitration = await fetchGoalArbitration({ featureSlug, brandId: primaryBrandId, identity });
      // The elected goal already determined this workflow (features-service ranks the goal's
      // workflows on the same cost-per-outcome our greedy uses), so there is nothing left to
      // pick here. Null → no arbitration for this brand yet, fall through to the brand goal.
      if (arbitration) return arbitration.workflowSlug;
    }
    const ctx = await fetchBrandRuntimeContext(primaryBrandId, identity);
    const goal: RuntimeGoal = goalOverride ?? ctx.currentGoal;
    const rows = await fetchWorkflowProjectionRows({
      featureSlug,
      brandId: primaryBrandId,
      goal,
      identity,
    });
    return selectWorkflowGreedy(rows, goal) ?? fallbackSlug;
  } catch (err) {
    console.warn(
      `[campaign-service] workflow bandit failed for brand ${primaryBrandId}, using configured workflow ${fallbackSlug}:`,
      err,
    );
    return fallbackSlug;
  }
}
