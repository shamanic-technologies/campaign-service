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
  // How many people this row's audience can still be served, as human-service counts them
  // (features-service#1035). 0 = served out; null = features-service could not read it, which is
  // UNKNOWN and never excludes anything. Always null on the brand-level row.
  availableToContactCount?: number | null;
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
  availableToContactCount?: number | null;
}

// A FUNNEL- or GOAL-keyed read of a brand selling SEVERAL OFFERS does NOT fail: features-service
// serves 200 and states, here, that it could not resolve which offer's declared funnels to price
// through. The VOLUME half of the body is unaffected (spend is a measured fact about this brand);
// the PROJECTED half — every `resolved.costPerOutcomeUsd`, i.e. the one number both argmins rank
// on — reads null. So the body parses, the rows are all there, and NOTHING is rankable: the pick
// silently collapses to the campaign's configured workflow. This block is the only thing that
// tells that apart from a channel with no history, which is why it is read rather than ignored.
interface DeclaredFunnelsUnresolved {
  reason: string;
  message?: string;
  offers?: Array<{ offerId: string; name: string | null }>;
}

interface WorkflowProjectionResponse {
  rows: RawProjectionRow[];
  declaredFunnelsUnresolved?: DeclaredFunnelsUnresolved | null;
}

/** A priced body, plus features-service's statement that it could NOT price it. */
export interface WorkflowProjection {
  rows: ProjectionRow[];
  /** Set only when the brand sells several offers and this read named none — see above. */
  declaredFunnelsUnresolved: DeclaredFunnelsUnresolved | null;
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
export async function fetchWorkflowProjectionRows(
  input: FetchWorkflowProjectionInput,
): Promise<ProjectionRow[]> {
  return (await fetchWorkflowProjection(input)).rows;
}

// The same read, with features-service's own statement about whether it could PRICE it. A caller
// that ranks on the figures reads this form; `fetchWorkflowProjectionRows` is the rows-only
// wrapper every other caller keeps using, byte-identically.
export async function fetchWorkflowProjection({
  featureSlug,
  brandId,
  funnelKey,
  goal,
  identity,
}: FetchWorkflowProjectionInput): Promise<WorkflowProjection> {
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
  return {
    rows: normalizeProjectionRows(body.rows),
    declaredFunnelsUnresolved: body.declaredFunnelsUnresolved ?? null,
  };
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
      availableToContactCount:
        typeof r.availableToContactCount === "number" ? r.availableToContactCount : null,
      resolved: r.resolved,
    };
  });
}


// ── WHICH WORKFLOWS THE LEG'S MODEL RULE EXCLUDES ───────────────────────────────────────────
//
// features-service measured, fleet-wide, that the CAPABILITY TIER of the model a workflow writes
// its emails with decides how that workflow performs, and that the direction depends on what the
// LEG sells: the cheap tier badly underperforms on a leg selling a conversation, and the strong
// and frontier tiers are money burnt on one selling a website visit. It STATES that verdict on
// every row it serves for a leg (`modelEligibility`) and deliberately acts on none of it, because
// two consumers need the difference — a customer surface must be able to tell "this workflow is
// excluded" apart from "this workflow does not exist". ACTING on it is this service's job and
// nobody else's, and this is where it happens.
//
// THE RULE IS NEVER RE-DERIVED HERE. No tier, no alias, no step, and no table of any of them
// exists in this repo and none is to be introduced: we read `modelEligibility.eligible` and
// nothing else — the same posture this service holds for the goal, the offer, the channel and the
// leg. A second copy of the rule is a second thing to drift.
//
// THE LEG-KEYED BODY IS ALSO WHAT A LEG CAMPAIGN IS PRICED ON. The verdict rides ONLY on a
// LEG-keyed body, and features-service refuses `?leg=` and `?funnel=` on one request (400
// `leg_and_funnel`) because the two price differently: a leg is denominated in the leg's OWN
// outcome (for `start_to_conversation`, a positive reply), a funnel in the funnel's terminal one
// (a booked meeting). A campaign bought for a leg is bought for that leg's outcome, and the
// dashboard's campaign Workflows page ranks on exactly this body — so the selector ranks on it
// too, and the page and the pick cannot disagree about which workflow is best. The funnel-keyed
// body is read only for a campaign that states no leg, or when the leg read gave us nothing.
//
// THE FILTER IS APPLIED ONCE, TO THE ROWS, BEFORE EITHER ARGMIN. Both legs of the pick must see
// the same restricted grid or the first one is judged on evidence the second can never serve: an
// audience pooled over its WHOLE column looks good because a cheap-tier workflow did well on it,
// and then receives the strong-tier workflow that is cheapest among the ones left. Filtering the
// rows up front is what makes the pooled column and the cell argmin agree by construction.
//
// IT REMOVES NO AUDIENCE. features-service enumerates EVERY active audience of the brand under
// EVERY dynasty, so an audience survives as long as one eligible workflow does — verified in prod
// 2026-09-14 (brand 75d7e3e8, leg start_to_conversation): 351 rows, 27 dynasties, 12 audiences
// under each. Dropping 9 dynasties leaves all 12 audiences standing under the other 18. That is
// why this cannot become the workflow-scoped audience narrowing v0.44.1 deleted — the one whose
// collapse the unscoped `/end-run` stop-guard could not see. The stop-guard stays unfiltered on
// purpose: an audience serveable under ANY workflow keeps the campaign alive, and a guard seeing
// a SUPERSET is the safe direction for a fail-safe stop.

/**
 * The raw leg-keyed row. It is the SAME row shape the pricing read serves (one endpoint, one
 * body), carrying the verdict block on top — so it can be normalized like any other row when the
 * funnel-keyed read could not be priced. See `legRows` below for when that happens.
 */
interface RawEligibilityRow extends RawProjectionRow {
  modelEligibility?: {
    eligible?: boolean;
    modelAlias?: string | null;
    modelTier?: string | null;
    ineligibleReason?: string | null;
  };
}

/** What one leg's model rule EXCLUDES. Only exclusions — an eligible workflow is simply absent. */
export interface LegModelEligibility {
  legKey: string;
  /** Dynasty slug → the sentence features-service stated for excluding it. */
  ineligible: Map<string, string>;
  /**
   * This body's own PRICED rows — what a campaign stating this leg is RANKED on. They are
   * denominated in the leg's own outcome, and because the read names the campaign, features-service
   * resolves the offer transitively and prices them even for a brand selling several offers.
   */
  rows: ProjectionRow[];
}

interface LegProjectionInput {
  featureSlug: string;
  brandId: string;
  legKey: string;
  /** The campaign the leg is bought for. A campaign sells exactly ONE offer, so naming it names
   * the offer the read is priced on — brand-service answers instead of refusing a brand selling
   * several with 409 `several_offers`. Omitted keeps today's brand-scoped read. */
  campaignId?: string | null;
  identity: DownstreamIdentity;
}

/**
 * The LEG-keyed body's rows, normalized to the shape every audience/workflow pick reads. THROWS on
 * any failure — for a caller that must not read an unreadable answer as a decision (the /end-run
 * stop-guard) or that already fails soft on a throw (/start-run's audience pick). A campaign that
 * states a leg reads this body and never the funnel-keyed one (wave C1).
 */
export async function fetchLegProjectionRows(input: LegProjectionInput): Promise<ProjectionRow[]> {
  return normalizeProjectionRows(await fetchLegProjectionRawRows(input));
}

async function fetchLegProjectionRawRows({
  featureSlug,
  brandId,
  legKey,
  campaignId,
  identity,
}: LegProjectionInput): Promise<RawEligibilityRow[]> {
  const baseUrl = process.env.FEATURES_SERVICE_URL;
  const apiKey = process.env.FEATURES_SERVICE_API_KEY;
  if (!baseUrl || !apiKey) {
    throw new Error("[campaign-service] FEATURES_SERVICE_URL or FEATURES_SERVICE_API_KEY not configured");
  }

  const url = new URL(`${baseUrl.replace(/\/$/, "")}/features/${encodeURIComponent(featureSlug)}/workflow-projection`);
  url.searchParams.set("brandId", brandId);
  // A leg-keyed read names NO funnel: features-service refuses both at once, and the funnel the
  // leg is priced through is its own answer from the brand's declared set. The leg identifier is
  // forwarded VERBATIM — it is features-service's word and is never parsed into its two steps.
  url.searchParams.set("leg", legKey);
  // campaignId is only ever answered BESIDE a leg (features-service 400s it alone), which this
  // read always carries.
  if (campaignId && campaignId.trim() !== "") {
    url.searchParams.set("campaignId", campaignId);
  }
  // NET — the basis the dashboard's campaign Workflows page ranks this same body on. The pick
  // ranks on these figures, so it asks for them on the basis the customer reads them on.
  url.searchParams.set("pricing", "net");

  const res = await fetch(url, { method: "GET", headers: buildServiceHeaders(apiKey, identity) });
  if (!res.ok) throw new Error(`workflow-projection (leg) failed (${res.status}): ${await res.text()}`);

  const body = await res.json() as { rows?: RawEligibilityRow[] };
  if (!Array.isArray(body.rows)) throw new Error("workflow-projection (leg) returned an invalid rows payload");
  return body.rows;
}

/**
 * Read features-service's verdict on which workflows the model rule excludes for THIS leg.
 *
 * Returns null when the verdict could not be READ — a different answer from "this leg excludes
 * nothing", and the caller treats it as such: it selects over the UNFILTERED grid, i.e. exactly
 * what it did before this existed. We never exclude a workflow on a gap in our own reading, and
 * never silently: the failure warns. (features-service applies the same doctrine one level down —
 * a workflow whose tier IT cannot resolve is served ELIGIBLE with its own stated reason, so an
 * unknowable tier never reaches this map at all.)
 */
export async function readLegModelEligibility(
  input: LegProjectionInput,
): Promise<LegModelEligibility | null> {
  const { brandId, legKey } = input;
  try {
    const legRows = await fetchLegProjectionRawRows(input);

    const ineligible = new Map<string, string>();
    for (const row of legRows) {
      const slug = row.workflow?.workflowDynastySlug;
      const verdict = row.modelEligibility;
      // ONLY an explicit `false` excludes. A row with no verdict block at all (a body served
      // without the block, a shape older than the verdict) excludes nothing — the absence of a
      // statement is not a statement.
      if (!slug || !verdict || verdict.eligible !== false) continue;
      ineligible.set(
        slug,
        verdict.ineligibleReason ??
          `features-service excluded it for leg "${legKey}" (model ${verdict.modelAlias ?? "unstated"}, tier ${verdict.modelTier ?? "unstated"})`,
      );
    }
    return { legKey, ineligible, rows: normalizeProjectionRows(legRows) };
  } catch (err) {
    // FAIL OPEN, LOUDLY. Falling back to the unfiltered grid is the pre-filter behaviour; falling
    // back to NOTHING would stop a funded campaign over a read that decides only which cells are
    // worth trying. Silence would make an outage of this read indistinguishable from a leg whose
    // rule excludes nobody.
    // A 409 `several_offers` is NOT an outage: it is a question with several answers, asked by a
    // campaign that names no offer on a brand selling more than one. Nothing downstream can fix
    // it and no retry will, so it is stated at error level, naming what would make it answerable.
    const message = err instanceof Error ? err.message : String(err);
    if (/\(409\)/.test(message) && /several_offers/i.test(message)) {
      console.error(
        `[campaign-service] model-eligibility UNANSWERABLE for brand ${brandId} leg ${legKey}: the ` +
          "brand sells several offers and this campaign names none, so features-service cannot say " +
          "which offer's funnels price the leg. Selecting over the UNFILTERED grid — state the " +
          "campaign's offerId to make this answerable.",
      );
      return null;
    }
    console.warn(
      `[campaign-service] model-eligibility read failed for brand ${brandId} leg ${legKey} — ` +
        "selecting over the UNFILTERED grid (pre-filter behaviour):",
      err,
    );
    return null;
  }
}

/**
 * Restrict the grid to the workflows the leg's model rule allows — the ONE place the verdict is
 * acted on, applied before EITHER argmin so the pooled audience column and the cell pick are
 * computed over the same set.
 *
 * Three answers, and the third is the one worth stating:
 *   - no verdict could be read (null), or the leg excludes nobody → the grid, untouched;
 *   - some workflows excluded → the grid without them, silently (this is the routine path and
 *     fires on every dispatch of every campaign of every client — per the log discipline in
 *     CLAUDE.md that is exactly the event that must not be logged at all);
 *   - EVERY workflow excluded → the EMPTY grid, loudly. It is never widened back: serving the
 *     full set again would be serving precisely the workflows we just established cannot work for
 *     what this campaign sells. An empty grid resolves through the caller's existing
 *     configured-workflow fallback, which is what it already does when nothing is rankable.
 */
export function restrictToEligibleWorkflows(
  rows: ProjectionRow[],
  eligibility: LegModelEligibility | null,
  context: { brandId: string; featureSlug: string },
): ProjectionRow[] {
  if (!eligibility || eligibility.ineligible.size === 0) return rows;

  const kept = rows.filter((r) => !eligibility.ineligible.has(r.workflow.workflowDynastySlug));
  if (rows.length > 0 && kept.length === 0) {
    const excluded = [...eligibility.ineligible.keys()].sort().join(", ");
    console.error(
      `[campaign-service] EVERY workflow of ${context.featureSlug} is ineligible for leg ` +
        `${eligibility.legKey} on brand ${context.brandId} — nothing to select, falling back to the ` +
        `campaign's configured workflow. Excluded: ${excluded}`,
    );
  }
  return kept;
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
// Nothing about how features-service prices anything changes: the cells and their ordering are
// identical, only which argmin is taken and in what order. Ties on the workflow leg stay
// DETERMINISTIC on purpose — consuming a workflow raises its own floor, which rotates it out by
// itself, and the catalogue sweeps. That convergence is the mechanism, not a gap to patch with a
// shuffle.
//
// Since 2026-09-14 the rows these two argmins are taken over are RESTRICTED first, to the
// workflows features-service says the leg's model rule allows — see restrictToEligibleWorkflows.
// The restriction happens on the ROWS, once, before either argmin, and it moves no number: both
// argmins are the same argmins over a smaller set.

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
/**
 * Audience ids features-service states are SERVED OUT (availableToContactCount === 0) — known to have
 * nobody left to contact before any serve is spent finding out (features-service#1035). An unknown
 * count (null) is never in this set.
 */
function servedOutAudienceIds(rows: ProjectionRow[]): Set<string> {
  const out = new Set<string>();
  for (const r of rows) {
    if (r.audienceId != null && r.availableToContactCount === 0) out.add(r.audienceId);
  }
  return out;
}

/**
 * Drop served-out audiences from a pick — but ONLY while another candidate still has people (or an
 * unknown count). When EVERY candidate is served out the list is returned untouched: the run then
 * probes one, the serve comes back exhausted, and the existing exhaustion → auto-stop /
 * extend-audience path fires exactly as before. Never an empty list manufactured here.
 */
function preferAudiencesWithPeople<T>(candidates: T[], idOf: (c: T) => string, servedOut: Set<string>): T[] {
  if (servedOut.size === 0) return candidates;
  const withPeople = candidates.filter((c) => !servedOut.has(idOf(c)));
  return withPeople.length > 0 ? withPeople : candidates;
}

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
  entries = preferAudiencesWithPeople(entries, ([id]) => id, servedOutAudienceIds(rows));

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
  candidates = preferAudiencesWithPeople(candidates, (r) => r.audienceId!, servedOutAudienceIds(rows));
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
 * A campaign that STATES A LEG is ranked on the LEG-keyed body — priced in the leg's own
 * outcome, the body the dashboard's campaign Workflows page ranks on — and its grid is restricted
 * first to the workflows features-service says that leg's model rule allows, applied before
 * either argmin and never re-derived here. A verdict that could not be read excludes nothing, loudly; a leg
 * that excludes EVERY workflow leaves nothing to select and resolves through the same
 * configured-workflow fallback as any other unrankable grid. The GOAL-ARBITRATED leg above is
 * untouched on purpose: features-service elects both the goal and its workflow there, which is
 * its answer and not a cell of a grid we may re-argmin.
 *
 * Falls back to the campaign's configured slug and NO chosen audience when there is no evidence
 * yet OR features-service is unavailable — a selection optimization must never block a run.
 */
/**
 * The funnel-keyed body's rows, said out loud when features-service could not PRICE them.
 *
 * Only a campaign that states no leg — or whose leg read gave us nothing — ranks on this body. A
 * brand selling several offers degrades it to a 200 whose every `resolved.costPerOutcomeUsd` is
 * null (see `declaredFunnelsUnresolved`), so nothing is rankable and the cell pick collapses to the
 * configured workflow. That is invisible from here (no row is missing, no call failed), so it is
 * stated on `console.error`: an unpriced grid and a grid with no history must not look the same.
 */
function funnelRows(
  projection: WorkflowProjection,
  context: { brandId: string; featureSlug: string; legKey?: string | null },
): ProjectionRow[] {
  const unresolved = projection.declaredFunnelsUnresolved;
  if (!unresolved) return projection.rows;

  const offers = unresolved.offers?.map((o) => o.name ?? o.offerId).join(", ") ?? "unstated";
  console.error(
    `[campaign-service] ${context.featureSlug} is UNPRICED for brand ${context.brandId} ` +
      `(${unresolved.reason}: ${offers}) and no leg-keyed body priced it` +
      (context.legKey ? " (the leg read failed)" : " (the campaign states no leg)") +
      " — every cell reads null, so the pick falls back to the campaign's configured workflow.",
  );
  return projection.rows;
}

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
  /**
   * The single funnel LEG the campaign is bought for — features-service's identifier, carried and
   * NEVER parsed. Set → the leg's model rule is read and the grid is restricted to the workflows
   * it allows, before either argmin. Null (every campaign older than the leg column) → no verdict
   * exists to read, no extra call is made, and the selection is exactly what it was.
   */
  legKey?: string | null;
  /** The campaign the read is FOR. Naming it names the OFFER the read is priced on (a campaign
   * sells exactly one offer), so brand-service answers reads that would otherwise be refused
   * with 409 `SEVERAL_OFFERS` for a brand selling several. Null (the pre-offer population)
   * keeps the brand-scoped read, which fails loud on a multi-offer brand rather than guessing. */
  campaignId?: string | null;
  /** The campaign's own OFFER (brand-service's id, carried and never derived). Names whose
   * confirmed profile words the runtime-context read carries. */
  offerId?: string | null;
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
    legKey,
    campaignId,
    offerId,
    requiredAudienceIds,
    excludedAudienceIds,
  } = args;
  // Rotation is feature-scoped: non-rotating features keep their configured workflow.
  if (!isWorkflowRotationEnabled(featureSlug)) return { workflowSlug: fallbackSlug, audienceId: null };
  try {
    // A campaign that STATES A FUNNEL is never arbitrated: the customer funds each funnel
    // separately, and that funding — not a cost ranking — decides which funnel is worked.
    // Arbitration only answers for a campaign that sells through no sales funnel.
    // A campaign that states a LEG is a sales campaign bought for that leg (wave C1: the leg, not
    // the funnel, is what says so), so it is never arbitrated either — whatever funnel it carries.
    if (!funnelKey && !legKey) {
      const arbitration = await fetchGoalArbitration({ featureSlug, brandId: primaryBrandId, identity });
      // The elected goal already determined this workflow — features-service ranked the goal's
      // workflows itself, and which goal a brand optimizes for is its answer, not a cell of a
      // grid we may re-argmin. So this leg is untouched: no audience is chosen here and
      // /start-run picks one over the elected pairing's rows exactly as it always has.
      // Null → no arbitration for this brand yet, fall through to the brand goal.
      if (arbitration) return { workflowSlug: arbitration.workflowSlug, audienceId: null };
    }
    // A campaign bought for a LEG is ranked on that leg's own outcome — the leg-keyed body, which
    // carries the model verdict too and is exactly what the dashboard's campaign Workflows page
    // ranks on. Naming the campaign names its offer, so a multi-offer brand is priced as well.
    const eligibility = legKey
      ? await readLegModelEligibility({ featureSlug, brandId: primaryBrandId, legKey, campaignId, identity })
      : null;
    let rows: ProjectionRow[];
    if (legKey) {
      // A LEG campaign is ranked on the leg-keyed body and on nothing else — never the funnel it
      // may still carry (wave C1). A read that failed (it already said why) or enumerated nothing
      // leaves the pick on the campaign's configured workflow, the same fail-soft every other
      // failure of this read takes: a selection optimization never blocks a run.
      if (!eligibility || eligibility.rows.length === 0) {
        console.warn(
          `[campaign-service] leg-keyed workflow-projection for brand ${primaryBrandId} leg ` +
            `${legKey} ${eligibility ? "enumerated NO rows" : "could not be read"} — running the ` +
            `configured workflow ${fallbackSlug}.`,
        );
        return { workflowSlug: fallbackSlug, audienceId: null };
      }
      rows = eligibility.rows;
    } else {
      // No leg (the pre-leg population, and every feature that sells through no sales funnel):
      // rank on the funnel-keyed body exactly as before. Only a campaign with no funnel needs a
      // goal, and only the brand can answer it.
      const goal: RuntimeGoal | null = funnelKey
        ? null
        : (await fetchBrandRuntimeContext(primaryBrandId, identity, offerId)).currentGoal;
      const projection = await fetchWorkflowProjection({
        featureSlug,
        brandId: primaryBrandId,
        funnelKey,
        goal,
        identity,
      });
      rows = funnelRows(projection, { brandId: primaryBrandId, featureSlug, legKey });
    }
    // Applied to the ROWS, so the pooled audience column and the cell argmin are computed over the
    // SAME set — an audience must never be judged on evidence produced by a workflow that can
    // never be served to it.
    const candidates = restrictToEligibleWorkflows(rows, eligibility, {
      brandId: primaryBrandId,
      featureSlug,
    });
    const cell = selectCellFromProjection(candidates, {
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
