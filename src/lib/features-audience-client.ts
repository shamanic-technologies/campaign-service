import { buildServiceHeaders, type DownstreamIdentity } from "./downstream-headers.js";
import type { RuntimeGoal } from "./brand-runtime-client.js";
import { thompsonArgminCost, type Arm, type Rng } from "./bandit.js";

export interface AudienceEvidence {
  totalCostInUsdCents: number;
  completedRuns: number;
  firstRunAt: string | null;
  lastRunAt: string | null;
  contacted: number;
  opened: number;
  websiteClicks: number;
  positiveReplies: number;
}

export interface AudienceCandidate {
  audienceId: string;
  brandProfileId: string | null;
  audience: {
    id: string;
    name: string;
    status: "active" | "paused" | "archived";
    filters: Record<string, unknown> | null;
  };
  evidence: AudienceEvidence;
  metrics: { cpcCents: number | null; cpprCents: number | null };
}

type SortMetric = "cpc" | "cppr";

interface AudienceStatsResponse {
  sortMetric: SortMetric;
  audiences: AudienceCandidate[];
}

interface SelectAudienceInput {
  featureSlug: string;
  brandId: string;
  goal: RuntimeGoal;
  brandProfileId?: string;
  identity: DownstreamIdentity;
  rng?: Rng;
  // When provided and non-empty, restrict the Thompson exploration to these
  // audiences — the audiences that have actually run under the chosen workflow
  // (from /workflow-projection audience-grain rows). So the audience is explored "for this
  // workflow", not across every audience the brand ever contacted. If the
  // intersection with the active audiences is empty (cold workflow), the
  // restriction is ignored and selection falls back to all active audiences —
  // a fresh workflow must still get an audience.
  eligibleAudienceIds?: string[];
  // Campaign v2 HARD targeting filter. When set + non-empty, the bandit may ONLY pick from
  // this subset of the brand's audiences — the campaign's targeted audiences. Unlike
  // eligibleAudienceIds (a soft workflow-conditioning filter that falls back to all active
  // audiences when it would leave nothing), this is authoritative: if none of the required
  // audiences is active, selection returns null (the campaign contacts none of them) rather
  // than falling back to an untargeted audience. NULL/empty → no restriction (inherit brand).
  requiredAudienceIds?: string[];
}

// Maps each active audience to a bandit arm: trials = leads contacted, successes
// = the goal's outcome (clicks for the signup/cpc goal, positive replies for the
// cppr goals), cost = spend per contacted lead. Mirrors the metric features-service
// sorts /audience-stats by, so the bandit optimizes the SAME thing the dashboard shows.
function toArm(c: AudienceCandidate, sortMetric: SortMetric): Arm {
  const trials = c.evidence.contacted;
  const successes = sortMetric === "cpc" ? c.evidence.websiteClicks : c.evidence.positiveReplies;
  const costPerTrial = trials > 0 ? c.evidence.totalCostInUsdCents / trials : null;
  return { trials, successes, costPerTrial };
}

/**
 * Pull every audience's cost/outcome evidence from features-service and pick one
 * by cost-aware Thompson sampling — so the contacted audience varies per run
 * instead of being frozen on rank #1. Only `active` audiences are eligible.
 * Returns null when no active audience exists.
 */
export async function selectAudienceForRun({
  featureSlug,
  brandId,
  goal,
  brandProfileId,
  identity,
  rng,
  eligibleAudienceIds,
  requiredAudienceIds,
}: SelectAudienceInput): Promise<AudienceCandidate | null> {
  const baseUrl = process.env.FEATURES_SERVICE_URL;
  const apiKey = process.env.FEATURES_SERVICE_API_KEY;
  if (!baseUrl || !apiKey) {
    throw new Error("[campaign-service] FEATURES_SERVICE_URL or FEATURES_SERVICE_API_KEY not configured");
  }

  // No `limit` — the bandit needs the full set to explore, not just rank #1.
  const url = new URL(`${baseUrl.replace(/\/$/, "")}/features/${encodeURIComponent(featureSlug)}/audience-stats`);
  url.searchParams.set("brandId", brandId);
  url.searchParams.set("goal", goal);
  if (brandProfileId) {
    url.searchParams.set("brandProfileId", brandProfileId);
  }

  const res = await fetch(url, { method: "GET", headers: buildServiceHeaders(apiKey, identity) });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`[campaign-service] FeatureService audience-stats failed (${res.status}): ${body}`);
  }

  const body = await res.json() as AudienceStatsResponse;
  if (!Array.isArray(body.audiences)) {
    throw new Error("[campaign-service] FeatureService audience-stats returned an invalid audiences payload");
  }

  const active = body.audiences.filter((a) => a.audience?.status === "active");
  if (active.length === 0) return null;

  // Campaign v2 HARD targeting subset: the campaign may only ever be served one of its
  // targeted audiences. No fallback — if none of the targeted audiences is active, return
  // null (contact none) rather than reaching outside the subset. NULL/empty → inherit.
  let candidates = active;
  if (requiredAudienceIds && requiredAudienceIds.length > 0) {
    const required = new Set(requiredAudienceIds);
    candidates = active.filter((a) => required.has(a.audienceId));
    if (candidates.length === 0) return null;
  }

  // Scope to the chosen workflow's audiences (within the targeted subset) when we have them;
  // ignore this SOFT restriction if it would leave nothing (cold workflow) so a fresh
  // workflow still gets an audience.
  let eligible = candidates;
  if (eligibleAudienceIds && eligibleAudienceIds.length > 0) {
    const allow = new Set(eligibleAudienceIds);
    const scoped = candidates.filter((a) => allow.has(a.audienceId));
    if (scoped.length > 0) eligible = scoped;
  }

  const sortMetric: SortMetric = body.sortMetric === "cpc" ? "cpc" : "cppr";
  const idx = thompsonArgminCost(eligible.map((a) => toArm(a, sortMetric)), rng);
  return idx === null ? null : eligible[idx];
}
