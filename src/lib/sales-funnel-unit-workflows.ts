import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { campaigns } from "../db/schema.js";
import { fetchChannelCatalogue } from "./channel-operator-client.js";
import { fetchLegAssignedWorkflows } from "./features-workflow-projection-client.js";
import { sameLeg } from "./leg-identity.js";
import { fetchLegSeedWorkflowSlug, legSeedFrom } from "./leg-seed-workflow.js";
import { fetchPipe, fetchSalesFunnel } from "./sales-funnel-catalogue-client.js";
import { fetchWorkflowDynastyBySlug } from "./startable-workflow-client.js";

type UnitRow = typeof campaigns.$inferSelect;
type PipeRead = Extract<Awaited<ReturnType<typeof fetchPipe>>, { ok: true }>;

/**
 * The unit's pipe: its funnel's pipe on its leg whose CHANNEL (the pipe detail's, never parsed off its id) is the
 * unit's. null = the funnel names no such pipe. Unreadable throws.
 */
async function unitPipe(
  unit: UnitRow,
  deps: { salesFunnel?: typeof fetchSalesFunnel; pipe?: typeof fetchPipe },
): Promise<{ id: string; read: PipeRead } | null> {
  const funnel = await (deps.salesFunnel ?? fetchSalesFunnel)(unit.salesFunnelId!);
  if (!funnel.ok) throw new Error(`sales funnel ${unit.salesFunnelId} unreadable: ${funnel.detail}`);
  for (const leg of funnel.value.legs) {
    if (!leg.pipe || !sameLeg(unit.featureSlug, leg.legKey, unit.legKey)) continue;
    const read = await (deps.pipe ?? fetchPipe)(leg.pipe.id);
    if (!read.ok) throw new Error(`pipe ${leg.pipe.id} unreadable: ${read.detail}`);
    if (read.value.channelSlug === unit.featureSlug) return { id: leg.pipe.id, read };
  }
  return null;
}

/**
 * The identity a unit's leg read is asked under: the unit's OWN org, owner and root run (never a minted id); a
 * unit with none of its own (stopped before anchors existed) borrows the staff caller's user/run.
 */
function unitIdentity(unit: UnitRow, staff: { userId: string; runId: string }) {
  return {
    orgId: unit.orgId,
    userId: unit.createdByUserId ?? staff.userId,
    runId: unit.anchorRunId ?? staff.runId,
    brandId: unit.brandId ?? unit.brandIds?.[0] ?? "",
    offerId: unit.offerId,
    // A unit stating no offer is priced through itself (features-service resolves its offer).
    campaignId: unit.offerId ? null : unit.id,
  };
}

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
 *   - the seed is the same read a launch makes: features-service's first choice on the unit's LEG outside
 *     what its funnel's play rules out (`fetchLegSeedWorkflowSlug`); a play allowing none, or no workflow
 *     assigned to the leg, is listed `skipped`, never written.
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
    workflow?: typeof fetchLegSeedWorkflowSlug;
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

    const found = await unitPipe(unit, opts.deps ?? {});
    if (!found) {
      entry.skipped = "pipe_not_in_funnel";
      continue;
    }
    entry.pipeId = found.id;
    const pipe = found.read;
    const play = pipe.value.play ?? null;
    if (play && play.allowedActiveWorkflowCount === 0) {
      entry.skipped = "play_allows_no_workflow";
      continue;
    }
    const workflow = await (opts.deps?.workflow ?? fetchLegSeedWorkflowSlug)(
      unit.featureSlug!,
      unit.legKey ?? pipe.value.legKey,
      unitIdentity(unit, opts.identity),
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

/**
 * EVERY PLATFORM UNIT STORES A WORKFLOW FEATURES-SERVICE ASSIGNS TO ITS LEG (CAMPAIGN-FALLBACK-WORKFLOW-LEG-1015).
 *
 * Units born before the seed read the leg stored the channel's newest workflow whatever the leg (prod 2026-10-15:
 * "Merrily"'s positive-reply unit stored `denebola`, a website-visit workflow). For every unit of a sales funnel
 * campaign with a stored workflow on a PLATFORM channel: its workflow's dynasty (workflow-service's, a stored version
 * slug included) must be `active` on the unit's leg (features-service) and not ruled out by its pipe's play; else it
 * takes the seed a launch gives that pipe today (`legSeedFrom`, features-service's first choice). Status and
 * `next_run_at` are never touched; the write is guarded on the value read. Dry run by default; idempotent.
 * A channel features-service does not rank (`channel_not_ranked`) or a leg with nothing left (`no_eligible_workflow`)
 * is listed, never written.
 */
export interface UnitLegWorkflowRepair {
  campaignId: string;
  orgId: string;
  featureSlug: string;
  legKey: string | null;
  campaignStatus: string;
  storedWorkflowSlug: string;
  eligible: boolean | null;
  workflowSlug: string | null;
  skipped?: string;
}

export async function repairSalesFunnelUnitLegWorkflows(opts: {
  apply: boolean;
  orgId?: string;
  identity: { orgId: string; userId: string; runId: string };
  deps?: {
    catalogue?: typeof fetchChannelCatalogue;
    salesFunnel?: typeof fetchSalesFunnel;
    pipe?: typeof fetchPipe;
    assigned?: typeof fetchLegAssignedWorkflows;
    dynasties?: typeof fetchWorkflowDynastyBySlug;
  };
}): Promise<{
  applied: boolean;
  units: UnitLegWorkflowRepair[];
  counts: { checked: number; eligible: number; ineligible: number; ineligibleOngoing: number; repaired: number; skipped: number };
}> {
  const catalogue = await (opts.deps?.catalogue ?? fetchChannelCatalogue)();
  if (!catalogue.ok) throw new Error(`channel catalogue unreadable: ${catalogue.detail}`);

  const rows = await db
    .select()
    .from(campaigns)
    .where(and(
      isNotNull(campaigns.salesFunnelCampaignId),
      isNotNull(campaigns.salesFunnelId),
      isNotNull(campaigns.workflowSlug),
      opts.orgId ? sql`${campaigns.orgId}::text = ${opts.orgId}` : undefined,
    ));
  const candidates = rows.filter((r) => (catalogue.operatorBySlug.get(r.featureSlug ?? "") ?? "platform") === "platform");

  // One read per channel (dynasty of every version) and per (channel, leg, brand, offer|unit) (the leg's order).
  const dynastiesByChannel = new Map<string, Map<string, string>>();
  const assignedByScope = new Map<string, string[] | null>();
  const out: UnitLegWorkflowRepair[] = [];
  for (const unit of candidates) {
    const stored = unit.workflowSlug!;
    const entry: UnitLegWorkflowRepair = {
      campaignId: unit.id,
      orgId: unit.orgId,
      featureSlug: unit.featureSlug!,
      legKey: unit.legKey,
      campaignStatus: unit.status,
      storedWorkflowSlug: stored,
      eligible: null,
      workflowSlug: null,
    };
    out.push(entry);
    if (!unit.legKey) {
      entry.skipped = "no_leg";
      continue;
    }
    const found = await unitPipe(unit, opts.deps ?? {});
    if (!found) {
      entry.skipped = "pipe_not_in_funnel";
      continue;
    }
    const excluded = found.read.value.play?.excludedWorkflowDynastySlugs ?? [];

    const identity = unitIdentity(unit, opts.identity);
    const scope = [unit.featureSlug, unit.legKey, identity.brandId, identity.offerId ?? `campaign:${unit.id}`].join("|");
    if (!assignedByScope.has(scope)) {
      assignedByScope.set(scope, await (opts.deps?.assigned ?? fetchLegAssignedWorkflows)({
        featureSlug: unit.featureSlug!,
        brandId: identity.brandId,
        legKey: unit.legKey,
        campaignId: identity.campaignId,
        offerId: identity.campaignId ? null : identity.offerId,
        identity: { ...identity, campaignId: identity.campaignId ?? "", featureSlug: unit.featureSlug!, workflowSlug: null },
      }));
    }
    const assigned = assignedByScope.get(scope)!;
    if (assigned === null) {
      entry.skipped = "channel_not_ranked";
      continue;
    }

    if (!dynastiesByChannel.has(unit.featureSlug!)) {
      const read = await (opts.deps?.dynasties ?? fetchWorkflowDynastyBySlug)(unit.featureSlug!, opts.identity);
      if (!read.ok) throw new Error(`workflows of ${unit.featureSlug} unreadable: ${read.detail}`);
      dynastiesByChannel.set(unit.featureSlug!, read.dynastyBySlug);
    }
    const dynasty = dynastiesByChannel.get(unit.featureSlug!)!.get(stored) ?? stored;
    entry.eligible = assigned.includes(dynasty) && !excluded.includes(dynasty);
    if (entry.eligible) continue;

    const seed = legSeedFrom(assigned, excluded);
    if (!seed) {
      entry.skipped = "no_eligible_workflow";
      continue;
    }
    entry.workflowSlug = seed;
    if (opts.apply) {
      await db
        .update(campaigns)
        .set({ workflowSlug: seed, updatedAt: new Date() })
        // Guarded on the value it read: a unit whose workflow moved meanwhile is left alone.
        .where(and(eq(campaigns.id, unit.id), eq(campaigns.workflowSlug, stored)));
    }
  }

  const ineligible = out.filter((e) => e.eligible === false);
  return {
    applied: opts.apply,
    units: out,
    counts: {
      checked: out.length,
      eligible: out.filter((e) => e.eligible === true).length,
      ineligible: ineligible.length,
      ineligibleOngoing: ineligible.filter((e) => e.campaignStatus === "ongoing").length,
      repaired: opts.apply ? ineligible.filter((e) => e.workflowSlug).length : 0,
      skipped: out.filter((e) => e.skipped).length,
    },
  };
}
