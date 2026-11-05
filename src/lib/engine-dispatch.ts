/**
 * MIGRATE-1105 S0 (owner 2026-11-05: « IL FAUT MIGRER »): a campaign's next outcome is made by its ENGINE, a stored
 * script, with no workflow. workflow-service runs it (`POST /engines/{outcome}/execute`) and says per org whether the
 * Engine runs that org's campaigns (`GET /internal/engines/{outcome}?orgId=`).
 *
 * One rule for every campaign, every outcome, proactive tick and reactive occurrence alike (never a branch on an
 * outcome, a channel or a client): the Engine of a campaign is the outcome its leg reaches (`<from>_to_<to>`), it is
 * dispatched when workflow-service says it is live for the org, and everything else goes exactly as before. Live:
 * the audience is picked as for any run, no workflow is run (the Engine's Rating picks the script), and the run's callbacks carry `x-engine-outcome`, never a workflow slug. Not live, or the
 * state cannot be read: the workflow path, byte for byte.
 */
import { fetchChannelCatalogue, type ChannelCatalogueRead } from "./channel-operator-client.js";
import { catalogueLegOf } from "./leg-identity.js";
import type { WorkflowExecution, WorkflowExecutionInputs } from "./workflows.js";
import { WorkflowExecutionRefusedError } from "./workflow-refusal.js";

export interface CampaignEngine {
  /** The outcome the campaign makes next: its leg's `to` step. */
  outcome: string;
  /** Its leg's `from` step (`start` on a proactive leg): what a trigger pushes to it. */
  fromOutcome: string;
}

/** The step a proactive leg starts from (the catalogue states none). */
export const START_OUTCOME = "start";
/** A minute: how long an Engine state read (and the catalogue it is keyed on) is reused. */
export const ENGINE_STATE_CACHE_MS = 60_000;

/** PURE: the Engine a leg reaches, read off the steps the catalogue publishes beside it (a leg is never parsed). */
export function engineOfLeg(catalogue: ChannelCatalogueRead, featureSlug: string | null | undefined, legKey: string | null | undefined): CampaignEngine | null {
  if (!legKey || !catalogue.ok) return null;
  const leg = catalogueLegOf(catalogue, featureSlug, legKey);
  if (!leg?.toStepKey) return null;
  return { outcome: leg.toStepKey, fromOutcome: leg.fromStepKey ?? START_OUTCOME };
}

const cache = new Map<string, { live: boolean; at: number }>();
let catalogueCache: { read: ChannelCatalogueRead; at: number } | null = null;
export function resetEngineStateCache(): void {
  cache.clear();
  catalogueCache = null;
}

async function catalogue(): Promise<ChannelCatalogueRead> {
  if (catalogueCache && Date.now() - catalogueCache.at < ENGINE_STATE_CACHE_MS) return catalogueCache.read;
  const read = await fetchChannelCatalogue();
  if (read.ok) catalogueCache = { read, at: Date.now() };
  return read;
}

/** The campaign's Engine when it runs this org's campaigns; null = run its workflow as before. Never throws. */
export async function liveEngineFor(
  campaign: { featureSlug?: string | null; legKey?: string | null },
  orgId: string,
): Promise<CampaignEngine | null> {
  if (!campaign.legKey) return null;
  const url = process.env.WORKFLOW_SERVICE_URL;
  const apiKey = process.env.WORKFLOW_SERVICE_API_KEY;
  if (!url || !apiKey) return null;
  let engine: CampaignEngine | null;
  try {
    engine = engineOfLeg(await catalogue(), campaign.featureSlug, campaign.legKey);
  } catch (err) {
    console.warn("[campaign-service] catalogue unreadable, campaigns run their workflow:", err);
    return null;
  }
  if (!engine) return null;
  const key = `${engine.outcome}|${orgId}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ENGINE_STATE_CACHE_MS) return hit.live ? engine : null;
  try {
    const res = await fetch(`${url}/internal/engines/${encodeURIComponent(engine.outcome)}?orgId=${encodeURIComponent(orgId)}`, {
      headers: { "x-api-key": apiKey },
      signal: AbortSignal.timeout(10_000),
    });
    // 404 = workflow-service serves no Engine state yet: not live.
    const live = res.ok ? ((await res.json()) as { live?: unknown }).live === true : false;
    if (!res.ok && res.status !== 404) console.warn(`[campaign-service] Engine state of ${engine.outcome} for org ${orgId} unreadable (${res.status}): its campaigns run their workflow`);
    cache.set(key, { live, at: Date.now() });
    return live ? engine : null;
  } catch (err) {
    console.warn(`[campaign-service] Engine state of ${engine.outcome} for org ${orgId} unreadable: its campaigns run their workflow:`, err);
    return null;
  }
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
      cache.set(`${engine.outcome}|${inputs.orgId}`, { live: false, at: Date.now() });
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
