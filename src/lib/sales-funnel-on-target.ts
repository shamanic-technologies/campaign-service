import { and, asc, eq, inArray, isNotNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { campaigns, salesFunnelCampaigns, type Campaign } from "../db/schema.js";
import { moveSalesFunnelCampaignOnTarget, type OnTargetUnitChange } from "./campaign-status-history.js";
import { engineUnitWorkflowSlug } from "./engine-dispatch.js";
import { runsOnItsTarget } from "./target-only-campaign.js";

/**
 * A FUNNEL CAMPAIGN RUNS ON ITS TARGET (owner go 2026-11-24, PLAN-RECURSIVE-PER-ENGINE-1124-CS).
 *
 * A funnel campaign runs as ONE unit on its Target's Engine instead of one fixed unit per pipe: the shape a campaign
 * launched on its target alone already has (lib/target-only-campaign.ts; scheduler and lib/engine-dispatch.ts run such
 * a unit on its Engine). EXISTING funnel campaigns are MOVED onto it by a staff call
 * (`POST /internal/sales-funnel-campaigns/target-move`), as DATA: which campaigns move, and in what order, is the
 * call's scope, never a rule in code.
 *
 *   - IDENTITY KEPT: the campaign's id, status and `sales_funnel_id` never move (billing's caps are keyed on it), and
 *     the Engine unit carries that same `sales_funnel_id`, so its caps read is unchanged.
 *   - Its units per pipe are never stopped: `plan_role = 'draining'` (the existing rule: a draining unit answers the
 *     people it owes and trigger events, takes no new people).
 *   - It stops following a plan of pipes (`follows_plan` false, running funnel home), and nothing moves it back: the
 *     plan check answers `on_target`, the switch-off restore and the unit completion skip it (`runsOnItsTarget`).
 */
export { runsOnItsTarget };

export interface OnTargetMove {
  salesFunnelCampaignId: string;
  orgId: string;
  brandId: string;
  salesFunnelName: string;
  status: string;
  target: string;
  followsPlan: boolean;
  /** Its ongoing units taking new people before the move, as `<featureSlug>|<legKey>`, sorted. */
  pipesBefore: string[];
  pipesAfter: string[];
  units: OnTargetUnitChange[];
  error?: string;
}

export interface OnTargetSkip {
  salesFunnelCampaignId: string;
  orgId: string;
  reason: "already_on_target" | "no_target";
}

export interface OnTargetScope {
  orgId?: string;
  salesFunnelCampaignIds?: string[];
  followsPlanOnly?: boolean;
}

const pipeOf = (u: Pick<Campaign, "featureSlug" | "legKey">) => `${u.featureSlug}|${u.legKey}`;

/**
 * Move every funnel campaign of the scope (no scope field = every row) onto its Target's Engine. Dry run (default)
 * writes NOTHING and answers what the move would do. Apply never throws for one campaign: a failure is that row's
 * `error`. A born ongoing unit is due now; the caller wakes the scheduler.
 */
export async function moveOnTarget(
  scope: OnTargetScope,
  opts: { apply: boolean },
): Promise<{ applied: boolean; moves: OnTargetMove[]; skipped: OnTargetSkip[] }> {
  const conditions = [];
  if (scope.orgId) conditions.push(eq(salesFunnelCampaigns.orgId, scope.orgId));
  if (scope.salesFunnelCampaignIds) conditions.push(inArray(salesFunnelCampaigns.id, scope.salesFunnelCampaignIds));
  if (scope.followsPlanOnly) conditions.push(eq(salesFunnelCampaigns.followsPlan, true));
  const parents = await db
    .select()
    .from(salesFunnelCampaigns)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(asc(salesFunnelCampaigns.createdAt));
  const unitRows = parents.length
    ? await db
        .select()
        .from(campaigns)
        .where(and(isNotNull(campaigns.salesFunnelCampaignId), inArray(campaigns.salesFunnelCampaignId, parents.map((p) => p.id))))
        .orderBy(asc(campaigns.createdAt))
    : [];
  const unitsByParent = new Map<string, Campaign[]>();
  for (const u of unitRows) {
    const list = unitsByParent.get(u.salesFunnelCampaignId!) ?? [];
    list.push(u);
    unitsByParent.set(u.salesFunnelCampaignId!, list);
  }

  const moves: OnTargetMove[] = [];
  const skipped: OnTargetSkip[] = [];
  for (const parent of parents) {
    const units = (unitsByParent.get(parent.id) ?? []).filter((u) => u.orgId === parent.orgId);
    const skip = (reason: OnTargetSkip["reason"]) => skipped.push({ salesFunnelCampaignId: parent.id, orgId: parent.orgId, reason });
    if (parent.target === null) {
      skip("no_target");
      continue;
    }
    if (runsOnItsTarget(parent, units)) {
      skip("already_on_target");
      continue;
    }
    const engine = engineUnitWorkflowSlug(parent.target);
    const move: OnTargetMove = {
      salesFunnelCampaignId: parent.id,
      orgId: parent.orgId,
      brandId: parent.brandId,
      salesFunnelName: parent.salesFunnelName,
      status: parent.status,
      target: parent.target,
      followsPlan: parent.followsPlan,
      pipesBefore: units.filter((u) => u.status === "ongoing" && u.planRole !== "draining").map(pipeOf).sort(),
      pipesAfter: [engine],
      units: [
        ...units.filter((u) => u.planRole !== "draining").map((u) => ({ campaignId: u.id, pipeId: pipeOf(u), action: "draining" as const })),
        { campaignId: null, pipeId: engine, action: "born" as const },
      ],
    };
    if (!opts.apply) {
      moves.push(move);
      continue;
    }
    try {
      const applied = await moveSalesFunnelCampaignOnTarget({ salesFunnelCampaignId: parent.id, orgId: parent.orgId });
      if (!applied.applied) {
        // Decided again on the rows the transaction locked: another call moved it first, or it lost its target.
        if (applied.reason === "not_found") moves.push({ ...move, error: "not_found" });
        else skip(applied.reason);
        continue;
      }
      move.units = applied.changeUnits;
      moves.push(move);
      console.log(
        `[campaign-service] Funnel campaign ${parent.id} (${parent.salesFunnelName}, org ${parent.orgId}) now runs on its Target: ` +
          `${move.pipesBefore.join(", ") || "no running pipe"} -> ${engine} (unit ${applied.unit.id}, ${applied.changeUnits.filter((u) => u.action === "draining").length} draining)`,
      );
    } catch (err) {
      move.error = err instanceof Error ? err.message : String(err);
      console.error(`[campaign-service] Funnel campaign ${parent.id} not moved onto its Target ${parent.target}: ${move.error}`);
      moves.push(move);
    }
  }
  return { applied: opts.apply, moves, skipped };
}
