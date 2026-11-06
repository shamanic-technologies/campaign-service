/**
 * MIGRATE-1105 S0 (owner 2026-11-05: « IL FAUT MIGRER »): a campaign's next outcome is made by its ENGINE, a stored
 * script, with no workflow. workflow-service runs it (`POST /engines/{outcome}/execute`) and says per org whether the
 * Engine runs that org's campaigns (`GET /internal/engines/{outcome}?orgId=`).
 *
 * One rule for every campaign, every outcome, proactive tick and reactive occurrence alike (never a branch on an
 * outcome, a channel or a client): the Engine of a campaign is the outcome its leg reaches (`<from>_to_<to>`), it is
 * dispatched when workflow-service says it is live for the org, and everything else goes exactly as before. Live:
 * the audience is picked as for any run, no workflow is run (the Engine's Rating picks the script), and the run's callbacks carry `x-engine-outcome`, never a workflow slug. Not live: the
 * workflow path, byte for byte.
 *
 * MIGRATE-1105 S2-FALLBACK (prod 2026-11-06: Doc Dinners ran the retired cold email workflow twice on a 10 s
 * timeout of this read): a state that cannot be read is NEVER read as "not live". The last answer read within
 * `ENGINE_STATE_STALE_MAX_MS` is served (loud); none = `EngineStateUnreadableError`, and the dispatcher holds this
 * run (`engine_state_unreadable`, retried on `ENGINE_STATE_RECHECK_MS`), never the old workflow.
 */
import { fetchChannelCatalogue, type ChannelCatalogueRead } from "./channel-operator-client.js";
import { catalogueLegOf, publishedSpelling } from "./leg-identity.js";
import type { WorkflowExecution, WorkflowExecutionInputs } from "./workflows.js";
import { WorkflowExecutionRefusedError } from "./workflow-refusal.js";

export interface CampaignEngine {
  /** The outcome the campaign makes next: its leg's `to` step. */
  outcome: string;
  /** Its leg's `from` step (`start` on a proactive leg): what a trigger pushes to it. */
  fromOutcome: string;
}

/**
 * MIGRATE-1105 S0b: the workflow slug a unit STORES when no workflow runs its pipe and its Engine does (a play its strategy
 * keeps a script for, no workflow allowed): the Engine's name, never a workflow's. Every dispatch runs the Engine
 * (`liveEngineFor` first); were the Engine switched off, the workflow path refuses this slug loudly (no such workflow).
 */
export const engineUnitWorkflowSlug = (outcome: string): string => `engine:${outcome}`;

/** The step a proactive leg starts from (the catalogue states none). */
export const START_OUTCOME = "start";
/** A minute: how long an Engine state read (and the catalogue it is keyed on) is reused. */
export const ENGINE_STATE_CACHE_MS = 60_000;
/** An hour: how long the last good answer stands in for a read that failed (served loud). */
export const ENGINE_STATE_STALE_MAX_MS = 60 * 60_000;
/** A minute: when a run held on an unreadable Engine state is tried again. */
export const ENGINE_STATE_RECHECK_MS = 60_000;

/** The Engine state (or the catalogue it is keyed on) could not be read and no recent answer stands in: hold the run. */
export class EngineStateUnreadableError extends Error {
  constructor(readonly detail: string) {
    super(`Engine state unreadable: ${detail}`);
    this.name = "EngineStateUnreadableError";
  }
}

/**
 * PURE: the Engine a campaign's pipe runs, read off the catalogue (a leg is never parsed): the outcome the pipe names
 * (MIGRATE-1105 S5, `stepTransitions[].outcome`: the finest WHAT, e.g. Threads post published on the Threads leg to Post
 * published), else the step its leg reaches. One rule for every pipe; the Rating then picks among that outcome's scripts.
 */
export function engineOfLeg(catalogue: ChannelCatalogueRead, featureSlug: string | null | undefined, legKey: string | null | undefined): CampaignEngine | null {
  if (!legKey || !catalogue.ok) return null;
  const leg = catalogueLegOf(catalogue, featureSlug, legKey);
  if (!leg?.toStepKey) return null;
  const stated = featureSlug ? catalogue.engineOutcomeBySlug?.get(featureSlug) : undefined;
  const spelling = stated ? publishedSpelling(featureSlug, stated.keys(), legKey) : null;
  return { outcome: (spelling ? stated!.get(spelling) : undefined) ?? leg.toStepKey, fromOutcome: leg.fromStepKey ?? START_OUTCOME };
}

const cache = new Map<string, { live: boolean; at: number }>();
let catalogueCache: { read: ChannelCatalogueRead; at: number } | null = null;
export function resetEngineStateCache(): void {
  cache.clear();
  catalogueCache = null;
}

async function catalogue(): Promise<ChannelCatalogueRead> {
  if (catalogueCache && Date.now() - catalogueCache.at < ENGINE_STATE_CACHE_MS) return catalogueCache.read;
  let detail: string;
  try {
    const read = await fetchChannelCatalogue();
    if (read.ok) {
      catalogueCache = { read, at: Date.now() };
      return read;
    }
    detail = read.detail;
  } catch (err) {
    detail = err instanceof Error ? err.message : String(err);
  }
  if (catalogueCache && Date.now() - catalogueCache.at < ENGINE_STATE_STALE_MAX_MS) {
    console.error(`[campaign-service] catalogue unreadable (${detail}): the Engine of each campaign is read off the last catalogue read`);
    return catalogueCache.read;
  }
  throw new EngineStateUnreadableError(`catalogue unreadable (${detail})`);
}

/**
 * The campaign's Engine when it runs this org's campaigns; null = run its workflow as before. Throws
 * `EngineStateUnreadableError` when the state cannot be read and no answer of the last hour stands in: the caller
 * holds the run, never runs the workflow on a guess.
 */
export async function liveEngineFor(
  campaign: { featureSlug?: string | null; legKey?: string | null },
  orgId: string,
): Promise<CampaignEngine | null> {
  if (!campaign.legKey) return null;
  const url = process.env.WORKFLOW_SERVICE_URL;
  const apiKey = process.env.WORKFLOW_SERVICE_API_KEY;
  if (!url || !apiKey) return null;
  const engine = engineOfLeg(await catalogue(), campaign.featureSlug, campaign.legKey);
  if (!engine) return null;
  // Per channel too: an Engine may hold scripts for one channel only (workflow-service answers per feature slug).
  const key = `${engine.outcome}|${orgId}|${campaign.featureSlug ?? ""}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ENGINE_STATE_CACHE_MS) return hit.live ? engine : null;
  let detail: string;
  try {
    const res = await fetch(`${url}/internal/engines/${encodeURIComponent(engine.outcome)}?orgId=${encodeURIComponent(orgId)}${campaign.featureSlug ? `&featureSlug=${encodeURIComponent(campaign.featureSlug)}` : ""}`, {
      headers: { "x-api-key": apiKey },
      signal: AbortSignal.timeout(10_000),
    });
    // 404 = workflow-service serves no Engine state yet: not live (an answer, not an outage).
    if (res.ok || res.status === 404) {
      const live = res.ok ? ((await res.json()) as { live?: unknown }).live === true : false;
      cache.set(key, { live, at: Date.now() });
      return live ? engine : null;
    }
    detail = `HTTP ${res.status}`;
  } catch (err) {
    detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  }
  if (hit && Date.now() - hit.at < ENGINE_STATE_STALE_MAX_MS) {
    console.error(`[campaign-service] Engine state of ${engine.outcome} for org ${orgId} unreadable (${detail}): its last answer (${hit.live ? "live" : "not live"}, ${Math.round((Date.now() - hit.at) / 1000)}s old) stands`);
    return hit.live ? engine : null;
  }
  console.error(`[campaign-service] Engine state of ${engine.outcome} for org ${orgId} unreadable (${detail}): this run is held, never run on its workflow`);
  throw new EngineStateUnreadableError(`Engine state of ${engine.outcome} for org ${orgId} unreadable (${detail})`);
}

/**
 * Dispatch one campaign run to its Engine. Answers like the workflow execute (the run `/end-run` will name), null
 * when workflow-service says the Engine is not live for the org after all (the caller runs the workflow), and throws
 * `WorkflowExecutionRefusedError` on any other refusal, exactly as the workflow execute does.
 */
export async function executeCampaignEngine(engine: CampaignEngine, inputs: WorkflowExecutionInputs): Promise<WorkflowExecution | null> {
  const url = process.env.WORKFLOW_SERVICE_URL;
  const apiKey = process.env.WORKFLOW_SERVICE_API_KEY;
  if (!url || !apiKey) return null;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
    "x-org-id": inputs.orgId,
    "x-user-id": inputs.userId,
    "x-run-id": inputs.runId,
    "x-brand-id": inputs.brandId,
    "x-campaign-id": inputs.campaignId,
    "x-feature-slug": inputs.featureSlug,
  };
  if (inputs.audienceId) headers["x-audience-id"] = inputs.audienceId;
  const res = await fetch(`${url}/engines/${encodeURIComponent(engine.outcome)}/execute`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      fromOutcome: engine.fromOutcome,
      inputs: {
        campaignId: inputs.campaignId,
        orgId: inputs.orgId,
        brandId: inputs.brandId,
        featureSlug: inputs.featureSlug,
        activeGoalId: inputs.activeGoalId ?? null,
        brandProfileId: inputs.brandProfileId ?? null,
        audienceId: inputs.audienceId ?? null,
        ...(inputs.trigger ? { trigger: inputs.trigger } : {}),
      },
      ...(inputs.conflictPolicy ? { conflictPolicy: inputs.conflictPolicy } : {}),
      ...(inputs.executionSubject ? { executionSubject: inputs.executionSubject } : {}),
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    if (res.status === 409 && engineNotLive(text)) {
      cache.set(`${engine.outcome}|${inputs.orgId}|${inputs.featureSlug ?? ""}`, { live: false, at: Date.now() });
      return null;
    }
    throw new WorkflowExecutionRefusedError({ workflowSlug: `engine:${engine.outcome}`, campaignId: inputs.campaignId, status: res.status, body: text });
  }
  const body = (text ? JSON.parse(text) : null) as { runId?: unknown } | null;
  return { runId: typeof body?.runId === "string" && body.runId ? body.runId : null };
}

function engineNotLive(text: string): boolean {
  try {
    return (JSON.parse(text) as { code?: unknown }).code === "engine_not_live";
  } catch {
    return false;
  }
}
