import type { Campaign, SalesFunnelCampaign } from "../db/schema.js";
import { legIdentity } from "./leg-identity.js";

/**
 * SALES FUNNEL CAMPAIGNS — the rules (owner 2026-10-10, "chat first").
 *
 *   "Ce n'est plus basé sur un (leg x channel), mais maintenant sur un Sales Funnel, c'est-à-dire un
 *    ENSEMBLE de (leg x channel). [...] Campaign service fait tourner comme aujourd'hui l'ensemble des
 *    (leg x channel) du Sales Funnel, indépendamment les uns des autres sans se soucier de leurs
 *    connexions. [...] Il est possible de run ou de mettre en pause toute campaign au niveau Sales
 *    Funnel, mais pas au niveau (leg x channel) granulaire. Si deux Sales Funnels partagent par hasard
 *    le même (Channel x leg) alors je pense qu'il faut les dupliquer car l'unicité est
 *    brand x offer x sales funnel x channel x leg."
 *
 * THE SHAPE
 *   - A FUNNEL CAMPAIGN (`sales_funnel_campaigns`) = brand x offer x sales funnel (features-service's
 *     sales funnel id, its `combinationKey`). Unique WHATEVER its status: it is handed back, never
 *     created twice.
 *   - It owns one UNIT per pipe of the funnel: an ordinary `campaigns` row stating
 *     `sales_funnel_id` + `sales_funnel_campaign_id`. A unit runs exactly like every campaign
 *     (scheduler, selection, gate-check, step trigger). The campaign identity index includes the
 *     funnel, so a pipe two funnels share is two units, one per funnel.
 *   - STATUS lives at the funnel. Its row and every unit move together in one transaction
 *     (`setSalesFunnelCampaignStatus`, source `sales_funnel`); an org-wide stop (payment hold,
 *     teardown) that reaches a unit stops its funnel campaign too. PATCH/DELETE /campaigns/:id
 *     refuse a unit's status and identity (409 `sales_funnel_unit`).
 *   - Pre-funnel (leg x channel) campaigns are untouched: no funnel stated, same identity, same
 *     money, same routes. Nothing migrates them; they keep running as the customer left them.
 *
 * WHO ANSWERS A SHARED REACTIVE PIPE (the hazard the owner left open, decided here)
 *   Two funnels sharing a REACTIVE pipe must not both act on one event (one reply answered twice).
 *     1. An EVENT (step reached, trigger event, delay/poll detector) dispatches AT MOST ONE campaign
 *        per pipe: the OLDEST live one of the (brand, offer, channel, leg) that can run now
 *        (`orderForSharedPipes`); the others are skipped `pipe_handled_by_another_campaign`, naming
 *        the one that ran. A lead an event carries is therefore worked once.
 *     2. A scheduled (time-based) run of a reactive unit claims people from its PREDECESSOR's queue,
 *        and a unit's predecessor is resolved INSIDE its own funnel campaign first
 *        (lib/predecessor-campaign.ts), so two funnels' reactive units drain two different queues
 *        and lead-service's atomic claim already makes a person claimable once.
 *   Proactive pipes are simply duplicated (owner): each funnel's unit prospects on its own.
 *
 * MONEY
 *   A unit's money is its FUNNEL's caps at billing (max budget + max volume per one-off / day / week
 *   / month, keyed brand x offer x sales funnel), never the per-(offer, leg, channel) ceilings of the
 *   pre-funnel model and never the brand pot. Until billing serves those caps a unit is UNFUNDED:
 *   held on the funding cadence, spends nothing (`salesFunnelUnitMoney`). Fail-CLOSED, like every
 *   unreadable ceiling. Nothing about what anything costs changes.
 *
 * NOT DONE HERE: making a funnel coherent (a proactive pipe feeding the reactive one) is the agent's
 * job; one-proactive-per-offer (lib/single-proactive.ts) does not apply to funnels (several funnels
 * of one offer may run), and a funnel start stops no pre-funnel campaign.
 */

/** How often a unit held for its funnel's money is re-checked (the funding cadence). */
export const SALES_FUNNEL_MONEY_RECHECK_MS = 10 * 60_000;

export type SalesFunnelMoneyVerdict =
  | { run: true }
  | { run: false; kind: "unfunded"; reason: string; detail: string; nextRunAt: Date };

/**
 * May this UNIT spend now? The ONE money answer for a sales funnel unit: the turn planner, the step
 * trigger, the poll detector's payer and gate-check all ask it, before any pre-funnel money path.
 *
 * billing does not serve sales funnel caps yet, so every unit is unfunded (fail-closed). When it
 * does, this reads them; nothing else changes.
 */
export async function salesFunnelUnitMoney(
  unit: { id: string; salesFunnelCampaignId: string | null; salesFunnelId?: string | null },
  now: Date = new Date(),
): Promise<SalesFunnelMoneyVerdict> {
  const nextRunAt = new Date(now.getTime() + SALES_FUNNEL_MONEY_RECHECK_MS);
  return {
    run: false,
    kind: "unfunded",
    reason: "Sales funnel not funded",
    detail:
      `Campaign not run — it is a pipe of sales funnel campaign ${unit.salesFunnelCampaignId} (sales funnel ${unit.salesFunnelId ?? "?"}), ` +
      `whose money is that sales funnel's caps at billing, and billing serves no sales funnel cap yet. Held rather than spent (fail-closed); re-checked at ${nextRunAt.toISOString()}.`,
    nextRunAt,
  };
}

/** True when the row is a pipe of a sales funnel campaign. */
export function isSalesFunnelUnit(c: { salesFunnelCampaignId?: string | null }): boolean {
  return !!c.salesFunnelCampaignId;
}

/** The pipe a campaign works: channel + leg identity (either outbound spelling is one leg). */
export function pipeKey(c: { featureSlug: string | null; legKey: string | null }): string {
  return `${c.featureSlug ?? ""}|${legIdentity(c.featureSlug, c.legKey) ?? ""}`;
}

/**
 * The pipes an EVENT's live campaigns SHARE across sales funnels: two or more live campaigns on one
 * (channel, leg) of which at least one is a funnel unit. Only those are rationed to one dispatch
 * per event; a brand with no funnel unit is byte-identical to before funnels existed.
 */
export function sharedSalesFunnelPipes<C extends Pick<Campaign, "featureSlug" | "legKey" | "salesFunnelCampaignId">>(
  responsible: C[],
): Set<string> {
  const groups = new Map<string, C[]>();
  for (const c of responsible) {
    const key = pipeKey(c);
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  return new Set(
    [...groups.entries()]
      .filter(([, g]) => g.length > 1 && g.some(isSalesFunnelUnit))
      .map(([key]) => key),
  );
}

/**
 * Order the live campaigns an EVENT resolved to so that, on a shared pipe, the one that answers is
 * tried first: oldest first (then id), deterministic. Every other campaign keeps its place, and a
 * brand with no shared pipe gets its list back untouched. The dispatcher runs at most one per shared
 * pipe (rule 1 above).
 */
export function orderForSharedPipes<
  C extends Pick<Campaign, "id" | "featureSlug" | "legKey" | "createdAt" | "salesFunnelCampaignId">,
>(responsible: C[]): C[] {
  const shared = sharedSalesFunnelPipes(responsible);
  if (shared.size === 0) return responsible;
  const queues = new Map<string, C[]>();
  for (const key of shared) {
    queues.set(
      key,
      responsible
        .filter((c) => pipeKey(c) === key)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id)),
    );
  }
  // Each shared pipe keeps the positions its campaigns held; only who sits in them changes.
  const taken = new Map<string, number>();
  return responsible.map((c) => {
    const key = pipeKey(c);
    const queue = queues.get(key);
    if (!queue) return c;
    const i = taken.get(key) ?? 0;
    taken.set(key, i + 1);
    return queue[i];
  });
}

/** The served shape of a funnel campaign (SalesFunnelCampaignSchema). */
export function serializeSalesFunnelCampaign(row: SalesFunnelCampaign, units: Campaign[]) {
  return {
    id: row.id,
    orgId: row.orgId,
    brandId: row.brandId,
    offerId: row.offerId,
    salesFunnelId: row.salesFunnelId,
    salesFunnelName: row.salesFunnelName,
    status: row.status,
    stopReason: row.stopReason,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    units: units.map((u) => ({
      campaignId: u.id,
      pipeId: `${u.featureSlug}|${u.legKey}`,
      featureSlug: u.featureSlug!,
      legKey: u.legKey!,
      status: u.status,
      workflowSlug: u.workflowSlug,
      name: u.name,
    })),
  };
}
