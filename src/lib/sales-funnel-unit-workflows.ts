import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { campaigns } from "../db/schema.js";
import { fetchChannelCatalogue } from "./channel-operator-client.js";
import { sameLeg } from "./leg-identity.js";
import { fetchPipe, fetchSalesFunnel } from "./sales-funnel-catalogue-client.js";
import { fetchStartableWorkflowSlug } from "./startable-workflow-client.js";

/**
 * EVERY PLATFORM PIPE RUNS ITS WORKFLOW (owner 2026-10-15, AIC-COMMON-1015: « a channel performed
 * inside another service's code is a defect »).
 *
 * AI Instant Call units were born with NO workflow (the call was a side effect inside
 * instantly-service's reply ingestion, so this service never dispatched them). Births now take their
 * pipe's workflow like every platform pipe (`resolveSalesFunnelPlan`); this
 * pass gives the units ALREADY born that way the workflow a launch would give them today:
 *   - a unit of a sales funnel campaign, `workflow_slug` NULL, whose channel the catalogue says the
 *     PLATFORM operates (a "Your team" unit keeps none: the customer works it);
 *   - the seed is the same read a launch makes: the channel's newest active workflow outside what its
 *     funnel's play rules out (`fetchStartableWorkflowSlug`); a play allowing none, or no active
 *     workflow, is listed `skipped`, never written.
 * An ongoing unit becomes due now (`next_run_at`); a stopped one stays as it is. Status is never
 * touched. Dry run by default; idempotent (a unit with a workflow is not a candidate).
 */

export interface UnitWorkflowAdoption {
  campaignId: string;
  orgId: string;
  salesFunnelCampaignId: string;
  featureSlug: string;
  legKey: string | null;
  status: string;
  pipeId: string | null;
  workflowSlug: string | null;
  skipped?: string;
}

export async function adoptSalesFunnelUnitWorkflows(opts: {
  apply: boolean;
  orgId?: string;
  identity: { orgId: string; userId: string; runId: string };
  deps?: {
    catalogue?: typeof fetchChannelCatalogue;
    salesFunnel?: typeof fetchSalesFunnel;
    pipe?: typeof fetchPipe;
    workflow?: typeof fetchStartableWorkflowSlug;
  };
}): Promise<{ applied: boolean; units: UnitWorkflowAdoption[]; counts: { candidates: number; adopted: number; skipped: number } }> {
  const catalogue = await (opts.deps?.catalogue ?? fetchChannelCatalogue)();
  if (!catalogue.ok) throw new Error(`channel catalogue unreadable: ${catalogue.detail}`);

  const rows = await db
    .select()
    .from(campaigns)
    .where(and(
      isNotNull(campaigns.salesFunnelCampaignId),
      isNotNull(campaigns.salesFunnelId),
      isNull(campaigns.workflowSlug),
      opts.orgId ? sql`${campaigns.orgId}::text = ${opts.orgId}` : undefined,
    ));
  const candidates = rows.filter((r) => (catalogue.operatorBySlug.get(r.featureSlug ?? "") ?? "platform") === "platform");

  const out: UnitWorkflowAdoption[] = [];
  for (const unit of candidates) {
    const entry: UnitWorkflowAdoption = {
      campaignId: unit.id,
      orgId: unit.orgId,
      salesFunnelCampaignId: unit.salesFunnelCampaignId!,
      featureSlug: unit.featureSlug!,
      legKey: unit.legKey,
      status: unit.status,
      pipeId: null,
      workflowSlug: null,
    };
    out.push(entry);

    const funnel = await (opts.deps?.salesFunnel ?? fetchSalesFunnel)(unit.salesFunnelId!);
    if (!funnel.ok) throw new Error(`sales funnel ${unit.salesFunnelId} unreadable: ${funnel.detail}`);
    // The unit's pipe: the funnel's pipe on its leg whose CHANNEL (the pipe detail's, never parsed off its id) is
    // the unit's.
    let pipe: Extract<Awaited<ReturnType<typeof fetchPipe>>, { ok: true }> | null = null;
    for (const leg of funnel.value.legs) {
      if (!leg.pipe || !sameLeg(unit.featureSlug, leg.legKey, unit.legKey)) continue;
      const read = await (opts.deps?.pipe ?? fetchPipe)(leg.pipe.id);
      if (!read.ok) throw new Error(`pipe ${leg.pipe.id} unreadable: ${read.detail}`);
      if (read.value.channelSlug === unit.featureSlug) {
        pipe = read;
        entry.pipeId = leg.pipe.id;
        break;
      }
    }
    if (!pipe) {
      entry.skipped = "pipe_not_in_funnel";
      continue;
    }
    const play = pipe.value.play ?? null;
    if (play && play.allowedActiveWorkflowCount === 0) {
      entry.skipped = "play_allows_no_workflow";
      continue;
    }
    const workflow = await (opts.deps?.workflow ?? fetchStartableWorkflowSlug)(
      unit.featureSlug!,
      opts.identity,
      play?.excludedWorkflowDynastySlugs ?? [],
    );
    if (!workflow.ok) throw new Error(`workflows of ${unit.featureSlug} unreadable: ${workflow.detail}`);
    if (workflow.workflowSlug === null) {
      entry.skipped = "no_workflow";
      continue;
    }
    entry.workflowSlug = workflow.workflowSlug;

    if (opts.apply) {
      await db
        .update(campaigns)
        .set({
          workflowSlug: workflow.workflowSlug,
          ...(unit.status === "ongoing" ? { nextRunAt: new Date() } : {}),
          updatedAt: new Date(),
        })
        // Guarded on the NULL it read: a unit that took a workflow meanwhile is left alone.
        .where(and(eq(campaigns.id, unit.id), isNull(campaigns.workflowSlug)));
    }
  }

  const skipped = out.filter((e) => e.skipped).length;
  return {
    applied: opts.apply,
    units: out,
    counts: { candidates: out.length, adopted: opts.apply ? out.length - skipped : 0, skipped },
  };
}
