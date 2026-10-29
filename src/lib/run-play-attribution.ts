/**
 * STRATEGY-ATTRIBUTION-1018: WHICH PLAY (a pipe x a lead strategy, features-service's, owner 2026-10-13) every run
 * was dispatched under, recorded ONCE at dispatch and never updated.
 *
 * Why: the staff Research page compares lead STRATEGIES per pipe ("which strategy brings the cheapest positive reply
 * on this pipe?"). Nothing recorded it: the only trace was a `~<strategy>` suffix inside `sales_funnel_id`, absent on
 * a default play and lost when a funnel is edited. A run's play is a fact of the moment it went out, so it is kept
 * with the run, append-only: editing the funnel or the play later changes no past row.
 *
 * The join a read-only extract makes (no other service needs to change):
 *   lead-service `leads_campaigns.parent_run_id` (every serve) = `run_play_attributions.run_id`
 *   runs-service `runs.id` (the execute-workflow root; emails/costs hang under it) = `run_play_attributions.run_id`
 * Sourcing side: a source unit serving on demand opens its own run (lib/on-demand-runs.ts), recorded here with the
 * outreach run that asked (`caller_run_id`); a self-running source unit is recorded like any execution. So the
 * strategy that FOUND a lead and the strategy of the pipe that WROTE to it are both joinable.
 *
 * Owner of the vocabulary: features-service (plays, strategies, the tactics a strategy names). Read VERBATIM from its
 * catalogue: the unit's funnel (`GET /internal/catalogue/sales-funnels/{id}`) names the play id of each leg, the
 * pipe read (`GET /internal/catalogue/pipes/{id}`) states the play (strategy id/name, default or not, what it rules
 * out). The DEFAULT play is stated too (`play_is_default = true` + its strategy id): no "null means default".
 *
 * Never changes who is served nor whether a run goes out: called after the dispatch succeeded, never awaited by it,
 * every failure is `console.error`ed and the row says `unreadable` with the reason when the catalogue could not
 * answer. No backfill: a run before this shipped has no row.
 */
import { db } from "../db/index.js";
import { runPlayAttributions } from "../db/schema.js";
import { sameLeg } from "./leg-identity.js";
import {
  fetchPipe,
  fetchSalesFunnel,
  type CatalogueRead,
  type PipeFromCatalogue,
  type SalesFunnelFromCatalogue,
} from "./sales-funnel-catalogue-client.js";

export type RunKind = "execution" | "on_demand";
export type RunDispatcher = "scheduler" | "step_trigger" | "person_start" | "on_demand";
export type PlayState = "resolved" | "no_play" | "not_a_sales_funnel_unit" | "unreadable";

export interface UnitPlay {
  state: PlayState;
  playId: string | null;
  pipeId: string | null;
  strategyId: string | null;
  strategyName: string | null;
  isDefault: boolean | null;
  excludedWorkflowDynastySlugs: string[] | null;
  detail: string | null;
}

export interface AttributedCampaign {
  id: string;
  salesFunnelId: string | null;
  salesFunnelCampaignId: string | null;
  featureSlug: string | null;
  legKey: string | null;
}

export interface PlayCatalogueDeps {
  salesFunnel: (id: string) => Promise<CatalogueRead<SalesFunnelFromCatalogue>>;
  pipe: (id: string) => Promise<CatalogueRead<PipeFromCatalogue>>;
}

/** The catalogue changes on a human scale; a dispatch burst must not re-read it per run. Good answers only. */
const CACHE_MS = 60_000;
const salesFunnelCache = new Map<string, { at: number; value: SalesFunnelFromCatalogue }>();
const pipeCache = new Map<string, { at: number; value: PipeFromCatalogue }>();

async function cached<T>(
  cache: Map<string, { at: number; value: T }>,
  id: string,
  read: (id: string) => Promise<CatalogueRead<T>>,
): Promise<CatalogueRead<T>> {
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < CACHE_MS) return { ok: true, value: hit.value };
  const answer = await read(id);
  if (answer.ok) cache.set(id, { at: Date.now(), value: answer.value });
  return answer;
}

export function clearPlayCatalogueCache(): void {
  salesFunnelCache.clear();
  pipeCache.clear();
}

const nothing = (state: PlayState, detail: string | null): UnitPlay => ({
  state,
  playId: null,
  pipeId: null,
  strategyId: null,
  strategyName: null,
  isDefault: null,
  excludedWorkflowDynastySlugs: null,
  detail,
});

/** The play the unit runs NOW, as features-service's catalogue states it (see the header). Never throws. */
export async function resolveUnitPlay(
  campaign: AttributedCampaign,
  deps: PlayCatalogueDeps = { salesFunnel: fetchSalesFunnel, pipe: fetchPipe },
): Promise<UnitPlay> {
  if (!campaign.salesFunnelId) {
    return nothing("not_a_sales_funnel_unit", `campaign ${campaign.id} is not a unit of a sales funnel: it runs no play`);
  }
  try {
    const salesFunnel = await cached(salesFunnelCache, campaign.salesFunnelId, deps.salesFunnel);
    if (!salesFunnel.ok) return nothing("unreadable", `sales funnel ${campaign.salesFunnelId}: ${salesFunnel.detail}`);
    for (const playId of salesFunnel.value.pipeIds) {
      const pipe = await cached(pipeCache, playId, deps.pipe);
      if (!pipe.ok) return nothing("unreadable", `pipe ${playId} of sales funnel ${campaign.salesFunnelId}: ${pipe.detail}`);
      if (pipe.value.channelSlug !== campaign.featureSlug) continue;
      if (!sameLeg(campaign.featureSlug, pipe.value.legKey, campaign.legKey)) continue;
      const play = pipe.value.play ?? null;
      if (!play) {
        return {
          ...nothing("no_play", `pipe ${playId} catalogues no strategy: every workflow assigned to it may run`),
          playId,
          pipeId: playId,
        };
      }
      return {
        state: "resolved",
        playId,
        pipeId: play.pipeId ?? null,
        strategyId: play.strategyId,
        strategyName: play.strategyName,
        isDefault: play.default,
        excludedWorkflowDynastySlugs: [...play.excludedWorkflowDynastySlugs],
        detail: null,
      };
    }
    return nothing(
      "unreadable",
      `sales funnel ${campaign.salesFunnelId} lists no pipe of channel ${campaign.featureSlug} on leg ${campaign.legKey}`,
    );
  } catch (err) {
    return nothing("unreadable", err instanceof Error ? err.message : String(err));
  }
}

/**
 * RATION-PER-PLAY-1029: the key on which campaigns sharing a reactive pipe are rationed to one dispatch per event
 * (lib/sales-funnel-campaigns.ts rule 1) is the PLAY each unit runs, read from the catalogue like the attribution
 * above: `play:<play id>` (the default play is the bare pipe id). A unit whose play cannot be read gets no key, so
 * its caller rations it on the pipe as before (fail closed: never two answers because a read failed).
 */
export async function playRationKeys(units: readonly AttributedCampaign[], deps?: PlayCatalogueDeps): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const u of units) {
    const play = await resolveUnitPlay(u, deps);
    if ((play.state === "resolved" || play.state === "no_play") && play.playId) {
      out.set(u.id, `play:${play.playId}`);
    } else {
      console.error(`[campaign-service] campaign ${u.id}: its play could not be read (${play.state}: ${play.detail}); rationed on its pipe`);
    }
  }
  return out;
}

export interface RunPlayRecord {
  runId: string;
  runKind: RunKind;
  dispatchedBy: RunDispatcher;
  callerRunId?: string | null;
  campaign: AttributedCampaign;
  workflowSlug: string | null;
  audienceId: string | null;
}

/**
 * Write the run's play, once (a second write for the same run id is ignored: the first is the fact). Never throws:
 * attribution must never fail or slow a dispatch. Returns the play written (null when nothing could be written).
 */
export async function recordRunPlay(record: RunPlayRecord, deps?: PlayCatalogueDeps): Promise<UnitPlay | null> {
  try {
    const play = await resolveUnitPlay(record.campaign, deps);
    if (play.state === "unreadable") {
      console.error(`[campaign-service] run ${record.runId} of campaign ${record.campaign.id}: play not recorded (${play.detail})`);
    }
    await db
      .insert(runPlayAttributions)
      .values({
        runId: record.runId,
        runKind: record.runKind,
        dispatchedBy: record.dispatchedBy,
        callerRunId: record.callerRunId ?? null,
        campaignId: record.campaign.id,
        salesFunnelCampaignId: record.campaign.salesFunnelCampaignId,
        salesFunnelId: record.campaign.salesFunnelId,
        featureSlug: record.campaign.featureSlug,
        legKey: record.campaign.legKey,
        workflowSlug: record.workflowSlug,
        audienceId: record.audienceId,
        playState: play.state,
        playId: play.playId,
        pipeId: play.pipeId,
        strategyId: play.strategyId,
        strategyName: play.strategyName,
        playIsDefault: play.isDefault,
        excludedWorkflowDynastySlugs: play.excludedWorkflowDynastySlugs,
        detail: play.detail,
      })
      .onConflictDoNothing({ target: runPlayAttributions.runId });
    return play;
  } catch (err) {
    console.error(`[campaign-service] run ${record.runId} of campaign ${record.campaign.id}: play attribution failed:`, err);
    return null;
  }
}

/** Fire-and-forget form for dispatchers: the run is already out, nothing waits on this. */
export function attributeRunPlay(record: RunPlayRecord): void {
  void recordRunPlay(record);
}
