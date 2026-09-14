import { buildServiceHeaders, type DownstreamIdentity } from "./downstream-headers.js";
import { fetchBrandRuntimeContext, type RuntimeGoal } from "./brand-runtime-client.js";
import { thompsonArgminCost, type Arm, type Rng } from "./bandit.js";
import { isOutboundSalesFeature } from "./sales-outreach-campaign.js";

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
  /**
   * The SALES FUNNEL to price on — what a sales campaign STATES on its own row. Wins over `goal`
   * at features-service and is the only word that separates a meeting bought with a positive reply
   * from one bought with a click onto the site.
   */
  funnelKey?: string | null;
  /**
   * The brand's optimization goal, for a campaign that states no funnel — i.e. a feature that
   * sells through no sales funnel (PR, hiring, VC, AI-visibility). features-service reads an
   * ABSENT goal as "default to meeting-booked", so one of the two MUST be given: pricing on a
   * silent default is exactly the wrong answer quietly.
   */
  goal?: RuntimeGoal | null;
  identity: DownstreamIdentity;
}

// Pull the (audience × workflow) evidence rows from features-service's reshaped
// /workflow-projection endpoint. Sends brandId + either the funnel (a sales campaign) or the goal
// (a feature with no sales funnel). brandProfileId is not a parameter — the endpoint derives
// economics from brandId alone.
export async function fetchWorkflowProjectionRows({
  featureSlug,
  brandId,
  funnelKey,
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
  // The funnel is the finer word and features-service prices on it in preference to a goal, so a
  // campaign that states one is never priced through a goal that cannot tell its funnel apart.
  if (funnelKey) url.searchParams.set("funnel", funnelKey);
  else if (goal) url.searchParams.set("goal", goal);
  else {
    throw new Error(
      "[campaign-service] workflow-projection needs the funnel the campaign states or, for a " +
      "feature with no sales funnel, the brand's goal — features-service silently defaults to " +
      "meeting-booked when neither is sent",
    );
  }

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
// goal-outcome — e.g. per signup — over the upgrade funnel × the brand's effective
// economics, for the goal we queried). So the "best" workflow is simply
// argmin(resolved.costPerOutcomeUsd) over the rows. GRAIN IS IRRELEVANT: whether the
// evidence resolved at brand level or cross-org, we take the cheapest — "always the
// best workflow returned by /workflow-projection", per the product decision.
//
// A workflow can appear in several rows (a brand-level row + one per audience grain);
// the global argmin naturally picks its lowest-cost row. Rows with a null
// costPerOutcomeUsd carry no rankable economics and are skipped. If NO row has a
// costPerOutcomeUsd, return null → resolveSelectionForTrigger falls back to the
// campaign's configured slug (only fallback path).
export function selectWorkflowGreedy(rows: ProjectionRow[]): string | null {
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

// ── The GRID, and which cell a run lands on ─────────────────────────────────────────────────
//
// features-service prices a GRID: one row per (audience × workflow dynasty). Doc Dinners's
// campaign is 24 workflows over 12 audiences, 288 cells. This service used to pick the WORKFLOW
// first — the global argmin over the whole grid — and only then pick the audience, restricted to
// the workflow already running. So the cells a run could ever land on were ONE ROW of the grid,
// and a workflow whose single cheapest cell won the global argmin then ran on EVERY audience,
// including the eleven it is worst on. Measured in prod 2026-09-14 (brand 75d7e3e8, campaign
// f7b1b610): `lithium` is $20/outcome on one audience and $185–$572 on the other eleven, and it
// took 2,554 of the campaign's 2,759 leads, while `alioth` — $21 on ten of the twelve columns —
// had never served a single lead. The starvation is self-reinforcing: a workflow that never runs
// never earns evidence, so it never wins.
//
// So the order is inverted and the run serves the best CELL, not the best row:
//
//   1. the AUDIENCE, by the exploration mechanism this service already uses for it (Thompson),
//      over evidence POOLED across the whole of that audience's column — i.e. not conditioned on
//      any one workflow, because conditioning on a workflow is what made the choice a row;
//   2. the WORKFLOW, greedily, WITHIN that audience's column, on the same
//      `resolved.costPerOutcomeUsd` the previous pick already ranked on.
//
// Nothing about how features-service prices anything changes, and no parameter sent to it
// changes: the cells and their ordering are identical, only which argmin is taken and in what
// order. Ties on the workflow leg stay DETERMINISTIC on purpose — consuming a workflow raises its
// own floor, which rotates it out by itself, and the catalogue sweeps. That convergence is the
// mechanism, not a gap to patch with a shuffle.

// Pool one audience's WHOLE column into a single Thompson arm — every workflow's evidence for
// that audience summed, so the audience is judged on how it performs for the brand rather than on
// how it performed under whichever workflow happens to be winning. The sums are the same
// quantities `toArm` reads for one cell (contacted, goal-resolved outcomes, spend), which is what
// makes the pooled arm commensurable with a single-cell one: score = spend / resolvedOutcomes =
// cost-per-outcome either way.
//
// An audience the grid enumerates with NO evidence anywhere (never run under any workflow) pools
// to a COLD arm (0 trials, null cost) and is still explored — exactly as a floored cell was.
function poolArmsByAudience(rows: ProjectionRow[]): Map<string, Arm> {
  const byId = new Map<string, Arm>();
  for (const r of rows) {
    if (r.audienceId == null) continue;
    const arm = byId.get(r.audienceId) ?? { trials: 0, successes: 0, costPerTrial: null };
    const ev = r.audienceEvidence;
    if (ev) {
      // costPerTrial is carried as the running SPEND while pooling and divided out at the end —
      // averaging per-cell costs would weight a cell that contacted three leads like one that
      // contacted three thousand.
      arm.trials += ev.observedContacted;
      arm.successes += ev.resolvedOutcomeCount ?? 0;
      arm.costPerTrial = (arm.costPerTrial ?? 0) + ev.spentUsd;
    }
    byId.set(r.audienceId, arm);
  }
  for (const arm of byId.values()) {
    arm.costPerTrial = arm.trials > 0 && arm.costPerTrial != null ? arm.costPerTrial / arm.trials : null;
  }
  return byId;
}

/**
 * Per-run AUDIENCE selection at the TRIGGER: cost-aware Thompson sampling over every audience the
 * grid enumerates, each scored on its POOLED column.
 *
 * The two constraints are the campaign's, not a workflow's, so they apply here exactly as they
 * applied to the later, workflow-scoped pick this replaces:
 *   requiredAudienceIds — the Campaign v2 HARD targeting subset (no fallback — empty → null).
 *   excludedAudienceIds — the freshly-exhausted set (no fallback — empty → null).
 *
 * Returns the chosen audienceId, or null when the grid enumerates no audience the campaign may
 * be served.
 */
export function selectAudiencePooled(
  rows: ProjectionRow[],
  opts: { requiredAudienceIds?: string[]; excludedAudienceIds?: string[]; rng?: Rng } = {},
): string | null {
  let entries = [...poolArmsByAudience(rows).entries()];

  if (opts.requiredAudienceIds && opts.requiredAudienceIds.length > 0) {
    const required = new Set(opts.requiredAudienceIds);
    entries = entries.filter(([id]) => required.has(id));
  }
  if (opts.excludedAudienceIds && opts.excludedAudienceIds.length > 0) {
    const excluded = new Set(opts.excludedAudienceIds);
    entries = entries.filter(([id]) => !excluded.has(id));
  }
  if (entries.length === 0) return null;

  const idx = thompsonArgminCost(entries.map(([, arm]) => arm), opts.rng);
  return idx === null ? null : entries[idx][0];
}

/** The (audience, workflow) cell a run is dispatched on. Either half may be null — see below. */
export interface ProjectionCell {
  audienceId: string | null;
  workflowSlug: string | null;
}

/**
 * The best CELL of the grid for this run: the audience first, then the cheapest workflow within
 * that audience's column.
 *
 * Two fallbacks, both of which reduce to the behaviour that preceded this change rather than to
 * nothing:
 *   - no audience could be chosen (the grid enumerates none, or the campaign's constraints leave
 *     none) → the workflow is the global argmin over the whole grid, as before, and no audience
 *     is supplied on the dispatch, so /start-run picks one exactly as it always has;
 *   - an audience was chosen but its column carries no rankable economics at all → the workflow
 *     falls back to the global argmin. The audience still stands: it was chosen on its pooled
 *     evidence, which is a different question from whether any cell of its column is priced.
 */
export function selectCellFromProjection(
  rows: ProjectionRow[],
  opts: { requiredAudienceIds?: string[]; excludedAudienceIds?: string[]; rng?: Rng } = {},
): ProjectionCell {
  const audienceId = selectAudiencePooled(rows, opts);
  const column = audienceId == null ? [] : rows.filter((r) => r.audienceId === audienceId);
  const workflowSlug = selectWorkflowGreedy(column) ?? selectWorkflowGreedy(rows);
  return { audienceId, workflowSlug };
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
  return serveableAudienceIdsInProjection(rows, opts).length > 0;
}

/**
 * WHICH audiences are serveable — the same set hasServeableAudienceInProjection reduces to a
 * boolean. Named separately because a resume has to SAY what made the campaign serveable again:
 * "campaign X came back because audience Y is now reachable" is the only way the fleet number can
 * be checked afterwards, and a boolean cannot say it. Sorted so the log line is stable.
 */
export function serveableAudienceIdsInProjection(
  rows: ProjectionRow[],
  opts: { requiredAudienceIds?: string[]; excludedAudienceIds?: string[] } = {},
): string[] {
  let ids = new Set<string>();
  for (const r of rows) if (r.audienceId != null) ids.add(r.audienceId);

  if (opts.requiredAudienceIds && opts.requiredAudienceIds.length > 0) {
    const required = new Set(opts.requiredAudienceIds);
    ids = new Set([...ids].filter((id) => required.has(id)));
  }
  if (opts.excludedAudienceIds) {
    for (const e of opts.excludedAudienceIds) ids.delete(e);
  }
  return [...ids].sort();
}

/**
 * Whether the greedy workflow rotation applies to a given feature. When false, the
 * trigger keeps the campaign's configured workflowSlug (no features-service call).
 *
 * Scoped to the OUTBOUND cold-email channels — those vary their workflow across runs, and the
 * projection prices a DAG on the send-tagged outcome evidence only they produce. A paid-reach
 * channel runs the workflow its campaign states, run after run: there is no second dynasty to
 * rotate onto and no send evidence to rank one against another. Every other feature
 * always runs its campaign's configured workflowSlug, run after run, with no
 * features-service call and no rotation. (Product decision 2026-07-07: rotation is a
 * sales-outreach lever; extended to sales-crm-email-outreach 2026-07-24 and to every OUTBOUND
 * sales channel since — a second cold-email channel is a second feature, and it rotates like the
 * first.)
 */
export function isWorkflowRotationEnabled(featureSlug: string): boolean {
  return isOutboundSalesFeature(featureSlug);
}

/** What the trigger decided for THIS run: the cell it dispatches on. */
export interface TriggerSelection {
  /** The workflow to launch. Always a real slug — the configured one when nothing was pickable. */
  workflowSlug: string;
  /**
   * The audience this run must serve, chosen BEFORE dispatch so the workflow could be picked
   * within its column. Null when no audience was chosen (a non-rotating feature, an unreachable
   * features-service, a grid that enumerates none, or a campaign whose constraints leave none) —
   * the caller then supplies whatever it supplied before this existed, and /start-run picks the
   * audience exactly as it always has.
   */
  audienceId: string | null;
}

/**
 * Resolve the (audience, workflow) CELL this run is dispatched on: price on what the campaign
 * sells, pull the grid from features-service, Thompson-pick the AUDIENCE over its pooled column,
 * then greedily pick the cheapest workflow WITHIN that column — see selectCellFromProjection for
 * why that order, and what it cost to have it the other way round.
 *
 * Both halves MUST be decided here, at the trigger. The workflow because it is the DAG identity
 * in the /execute URL and cannot change once the DAG is running; the audience because the
 * workflow is chosen within its column, so a second draw at /start-run would run the workflow
 * that is cheapest for one audience against a different one — the exact mismatch this fixes.
 * The chosen audience rides on the execute call and /start-run CONSUMES it.
 *
 * Rotation is feature-scoped: any other feature keeps its configured workflow and chooses no
 * audience, with no features-service call at all.
 *
 * Falls back to the campaign's configured slug and NO chosen audience when there is no evidence
 * yet OR features-service is unavailable — a selection optimization must never block a run.
 */
export async function resolveSelectionForTrigger(args: {
  featureSlug: string;
  primaryBrandId: string;
  identity: DownstreamIdentity;
  fallbackSlug: string;
  // The SALES FUNNEL the campaign states. Set → the pick is priced on that funnel and the
  // campaign is NEVER goal-arbitrated: the customer funds the funnel, so the customer's funding
  // decides which funnel runs. Null → a feature that sells through no sales funnel, which is
  // arbitrated exactly as before and otherwise paces on the brand goal.
  funnelKey?: string | null;
  /** The campaign's HARD targeting subset — the audience pick may only ever land inside it. */
  requiredAudienceIds?: string[] | null;
  /** The campaign's freshly-exhausted audiences — never chosen. */
  excludedAudienceIds?: string[] | null;
}): Promise<TriggerSelection> {
  const {
    featureSlug,
    primaryBrandId,
    identity,
    fallbackSlug,
    funnelKey,
    requiredAudienceIds,
    excludedAudienceIds,
  } = args;
  // Rotation is feature-scoped: non-rotating features keep their configured workflow.
  if (!isWorkflowRotationEnabled(featureSlug)) return { workflowSlug: fallbackSlug, audienceId: null };
  try {
    // A campaign that STATES A FUNNEL is never arbitrated: the customer funds each funnel
    // separately, and that funding — not a cost ranking — decides which funnel is worked.
    // Arbitration only answers for a campaign that sells through no sales funnel.
    if (!funnelKey) {
      const arbitration = await fetchGoalArbitration({ featureSlug, brandId: primaryBrandId, identity });
      // The elected goal already determined this workflow — features-service ranked the goal's
      // workflows itself, and which goal a brand optimizes for is its answer, not a cell of a
      // grid we may re-argmin. So this leg is untouched: no audience is chosen here and
      // /start-run picks one over the elected pairing's rows exactly as it always has.
      // Null → no arbitration for this brand yet, fall through to the brand goal.
      if (arbitration) return { workflowSlug: arbitration.workflowSlug, audienceId: null };
    }
    // Only a campaign with no funnel needs a goal at all, and only the brand can answer it.
    const goal: RuntimeGoal | null = funnelKey
      ? null
      : (await fetchBrandRuntimeContext(primaryBrandId, identity)).currentGoal;
    const rows = await fetchWorkflowProjectionRows({
      featureSlug,
      brandId: primaryBrandId,
      funnelKey,
      goal,
      identity,
    });
    const cell = selectCellFromProjection(rows, {
      requiredAudienceIds: requiredAudienceIds ?? undefined,
      excludedAudienceIds: excludedAudienceIds ?? undefined,
    });
    return { workflowSlug: cell.workflowSlug ?? fallbackSlug, audienceId: cell.audienceId };
  } catch (err) {
    console.warn(
      `[campaign-service] workflow bandit failed for brand ${primaryBrandId}, using configured workflow ${fallbackSlug}:`,
      err,
    );
    return { workflowSlug: fallbackSlug, audienceId: null };
  }
}
