import type { Campaign, SalesFunnelCampaign } from "../db/schema.js";
import { z } from "zod";
import { legIdentity, sameLeg } from "./leg-identity.js";

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
 *   A unit's money is its FUNNEL's caps at billing (max budget + max volume, each one-off / daily /
 *   weekly / monthly, keyed brand x offer x sales funnel; `salesFunnelUnitMoney`), never the
 *   per-(offer, leg, channel) ceilings of the pre-funnel model and never the brand pot. No max
 *   budget stated = unfunded. Owner 2026-10-10, "we should always respect the user budget": max
 *   budget reached = EVERY pipe of the funnel stops spending, reactive included; max volume
 *   reached = proactive pipes make no new first touch and reactive pipes take no new event. Held,
 *   status untouched (a system condition never changes a status). An unmeasured consumption holds
 *   every pipe, loudly. Nothing about what anything costs changes.
 *
 * POLL READS: a unit may pay a metered poll-trigger read (`salesFunnelPollRoom`): funnel max budget
 *   stated, consumption measured, consumed + the read's worst case under it. Billed like any payer.
 *
 * NOT DONE HERE: making a funnel coherent (a proactive pipe feeding the reactive one) is the agent's
 * job; one-proactive-per-offer (lib/single-proactive.ts) does not apply to funnels (several funnels
 * of one offer may run), and a funnel start stops no pre-funnel campaign.
 */

/** How often a unit held for its funnel's money is re-checked (the funding cadence). */
export const SALES_FUNNEL_MONEY_RECHECK_MS = 10 * 60_000;

/** How long one read of a funnel's caps answers for every unit of it (a tick reads it once). */
const CAPS_READ_TTL_MS = 30_000;

/** A unit, as much of it as its money question needs. */
export interface SalesFunnelUnitRef {
  id: string;
  orgId: string;
  brandId: string | null;
  offerId: string | null;
  featureSlug: string | null;
  legKey: string | null;
  salesFunnelCampaignId: string | null;
  salesFunnelId: string | null;
}

export type SalesFunnelMoneyVerdict =
  | {
      run: true;
      /**
       * What the turn planner ranks it on: the funnel's consumed vs its max budget (a proactive
       * pipe), or 0 of 1 for a reactive pipe, which answers people already contacted and takes its
       * cohort's turn first (bottom of the funnel first).
       */
      pace: { spentCents: number; ceilingCents: number };
    }
  | {
      run: false;
      kind: "unfunded" | "unreadable" | "cap_reached";
      reason: string;
      detail: string;
      nextRunAt: Date;
    };

const CapPeriod = z.enum(["one_off", "daily", "weekly", "monthly"]);
const Figure = z.union([z.string(), z.number()]).nullable().transform((v) => (v === null ? null : Number(v)));
const SalesFunnelCapsResponse = z.object({
  stated: z.boolean(),
  maxBudget: z
    .object({
      amountCents: Figure,
      period: CapPeriod,
      consumedCents: Figure,
      reached: z.boolean().nullable(),
      consumedUnavailableReason: z.string().nullable(),
      consumedUnavailableDetail: z.string().nullable().optional(),
    })
    .nullable(),
  maxVolume: z
    .object({
      count: z.number(),
      period: CapPeriod,
      unit: z.string(),
      consumed: z.number().nullable(),
      reached: z.boolean().nullable(),
      consumedUnavailableReason: z.string().nullable(),
      consumedUnavailableDetail: z.string().nullable().optional(),
    })
    .nullable(),
  pipes: z
    .array(z.object({ channelSlug: z.string(), legKey: z.string(), mode: z.enum(["proactive", "reactive"]) }))
    .nullable(),
});
export type SalesFunnelCaps = z.infer<typeof SalesFunnelCapsResponse>;

type CapsRead = { ok: true; caps: SalesFunnelCaps } | { ok: false; detail: string };
const capsCache = new Map<string, { at: number; read: Promise<CapsRead> }>();

/** Test hook: forget every cached caps read. */
export function resetSalesFunnelCapsCache(): void {
  capsCache.clear();
}

/**
 * billing-service `GET /internal/brands/:brandId/offers/:offerId/sales-funnels/:salesFunnelId/caps`
 * (x-api-key + x-org-id; LOCKED, billing v0.83.6): the funnel's max budget and max volume with
 * what each has consumed in its current period, and billing's own `reached` verdict. Read, never
 * recomputed here.
 */
export async function fetchSalesFunnelCaps(
  scope: { orgId: string; brandId: string; offerId: string; salesFunnelId: string },
  nowMs: number = Date.now(),
): Promise<CapsRead> {
  const key = `${scope.orgId}|${scope.brandId}|${scope.offerId}|${scope.salesFunnelId}`;
  const hit = capsCache.get(key);
  if (hit && nowMs - hit.at < CAPS_READ_TTL_MS) return hit.read;
  const read = (async (): Promise<CapsRead> => {
    const url = process.env.BILLING_SERVICE_URL;
    const apiKey = process.env.BILLING_SERVICE_API_KEY;
    if (!url || !apiKey) return { ok: false, detail: "billing-service not configured" };
    const path =
      `/internal/brands/${encodeURIComponent(scope.brandId)}/offers/${encodeURIComponent(scope.offerId)}` +
      `/sales-funnels/${encodeURIComponent(scope.salesFunnelId)}/caps`;
    try {
      const res = await fetch(`${url.replace(/\/$/, "")}${path}`, {
        headers: { "x-api-key": apiKey, "x-org-id": scope.orgId },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) return { ok: false, detail: `billing HTTP ${res.status} on ${path}` };
      const parsed = SalesFunnelCapsResponse.safeParse(await res.json());
      if (!parsed.success) return { ok: false, detail: `billing caps answer unparseable: ${parsed.error.message.slice(0, 200)}` };
      return { ok: true, caps: parsed.data };
    } catch (err) {
      return { ok: false, detail: `${path}: ${err instanceof Error ? err.message : String(err)}` };
    }
  })();
  capsCache.set(key, { at: nowMs, read });
  const result = await read;
  if (!result.ok) capsCache.delete(key); // never remember an outage
  return result;
}

/** One sales funnel's stated caps, as billing lists them for a brand. */
export interface StatedSalesFunnelCap {
  offerId: string;
  salesFunnelId: string;
  /**
   * `dailyBudgetCents` is billing's OWN figure of the cap per day (v0.83.13: daily x1, weekly / 7,
   * monthly / 30, one_off 0, a REACTIVE funnel 0: owner rule, a reactive budget is a ceiling, never
   * a daily spend). Read, never recomputed here, so both services count the same money.
   */
  maxBudget: { amountCents: number; period: z.infer<typeof CapPeriod>; dailyBudgetCents: number } | null;
}

const BrandSalesFunnelCapsResponse = z.object({
  caps: z.array(
    z.object({
      offerId: z.string(),
      salesFunnelId: z.string(),
      maxBudget: z.object({ amountCents: Figure, period: CapPeriod, dailyBudgetCents: Figure }).nullable(),
    }),
  ),
});

/**
 * billing-service `GET /internal/brands/:brandId/sales-funnel-caps` (x-org-id; billing v0.83.6):
 * every funnel cap the customer stated for the brand, figures only (no consumption). One read per
 * brand, for the budget-derived figures (spendable budget, held state). Not cached: a person reads it.
 */
export async function fetchBrandSalesFunnelCaps(
  orgId: string,
  brandId: string,
): Promise<{ ok: true; caps: StatedSalesFunnelCap[] } | { ok: false; detail: string }> {
  const url = process.env.BILLING_SERVICE_URL;
  const apiKey = process.env.BILLING_SERVICE_API_KEY;
  if (!url || !apiKey) return { ok: false, detail: "billing-service not configured" };
  const path = `/internal/brands/${encodeURIComponent(brandId)}/sales-funnel-caps`;
  try {
    const res = await fetch(`${url.replace(/\/$/, "")}${path}`, {
      headers: { "x-api-key": apiKey, "x-org-id": orgId },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return { ok: false, detail: `billing HTTP ${res.status} on ${path}` };
    const parsed = BrandSalesFunnelCapsResponse.safeParse(await res.json());
    if (!parsed.success) return { ok: false, detail: `billing brand caps unparseable: ${parsed.error.message.slice(0, 200)}` };
    const missing = parsed.data.caps.find((c) => c.maxBudget && !Number.isFinite(c.maxBudget.dailyBudgetCents ?? NaN));
    if (missing) return { ok: false, detail: `billing serves no maxBudget.dailyBudgetCents for sales funnel ${missing.salesFunnelId}` };
    return {
      ok: true,
      caps: parsed.data.caps.map((c) => ({
        offerId: c.offerId,
        salesFunnelId: c.salesFunnelId,
        maxBudget: c.maxBudget && c.maxBudget.amountCents !== null && Number.isFinite(c.maxBudget.amountCents)
          ? { amountCents: c.maxBudget.amountCents, period: c.maxBudget.period, dailyBudgetCents: c.maxBudget.dailyBudgetCents ?? NaN }
          : null,
      })),
    };
  } catch (err) {
    return { ok: false, detail: `${path}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * May this UNIT spend now? The ONE money answer for a sales funnel unit: the turn planner, the step
 * trigger and gate-check ask it before any pre-funnel money path (none of which is its money).
 *
 *   - caps unreadable                         → every unit held (`unreadable`, fail-closed, logged)
 *   - no max budget stated                    → every unit held (`unfunded`: money starts nothing)
 *   - REACTIVE pipe (billing's `pipes[].mode`) → runs: it answers people already contacted, and
 *     stopping a funnel stops NEW first touches only (follow-ups go on, the existing rule)
 *   - PROACTIVE pipe (or a pipe billing does not name): held when the max budget OR the max volume
 *     is `reached` (`cap_reached`), and held when either consumption cannot be measured
 *     (`unreadable`, logged with billing's named reason: never read as "not reached")
 */
export async function salesFunnelUnitMoney(
  unit: SalesFunnelUnitRef,
  now: Date = new Date(),
): Promise<SalesFunnelMoneyVerdict> {
  const nextRunAt = new Date(now.getTime() + SALES_FUNNEL_MONEY_RECHECK_MS);
  const held = (kind: "unfunded" | "unreadable" | "cap_reached", reason: string, why: string): SalesFunnelMoneyVerdict => ({
    run: false,
    kind,
    reason,
    detail:
      `Campaign not run — it is a pipe of sales funnel campaign ${unit.salesFunnelCampaignId} (sales funnel ${unit.salesFunnelId ?? "?"}): ` +
      `${why} Re-checked at ${nextRunAt.toISOString()}.`,
    nextRunAt,
  });

  if (!unit.brandId || !unit.offerId || !unit.salesFunnelId) {
    console.error(`[campaign-service] Sales funnel unit ${unit.id} states no brand, offer or sales funnel — held`);
    return held("unreadable", "Sales funnel caps unavailable", "the unit states no brand, offer or sales funnel, so its caps cannot be asked.");
  }
  const read = await fetchSalesFunnelCaps(
    { orgId: unit.orgId, brandId: unit.brandId, offerId: unit.offerId, salesFunnelId: unit.salesFunnelId },
    now.getTime(),
  );
  if (!read.ok) {
    console.error(`[campaign-service] Sales funnel caps unreadable for unit ${unit.id} (${unit.salesFunnelId}): ${read.detail} — held (fail-closed)`);
    return held("unreadable", "Sales funnel caps unavailable", `billing's caps could not be read (${read.detail}). Held rather than spent (fail-closed).`);
  }
  const { caps } = read;
  if (!caps.stated || !caps.maxBudget || caps.maxBudget.amountCents === null || !(caps.maxBudget.amountCents > 0)) {
    return held("unfunded", "Sales funnel not funded", "the customer states no max budget for this sales funnel at billing. It waits for money.");
  }

  // Owner 2026-10-10: "we should always respect the user budget". Every pipe of the funnel,
  // REACTIVE included, stops spending once the max budget is reached, and stops taking new work
  // once the max volume is reached; an unmeasured consumption holds them all (fail-closed).
  const pipe = caps.pipes?.find((p) => p.channelSlug === unit.featureSlug && sameLeg(unit.featureSlug, p.legKey, unit.legKey));
  const reactive = pipe?.mode === "reactive";
  const budget = caps.maxBudget;
  const amountCents = caps.maxBudget.amountCents;
  if (budget.consumedCents === null || budget.reached === null) {
    console.error(
      `[campaign-service] Sales funnel ${unit.salesFunnelId} max budget consumption unmeasured (${budget.consumedUnavailableReason}: ${budget.consumedUnavailableDetail ?? ""}) — unit ${unit.id} held`,
    );
    return held("unreadable", "Sales funnel budget unavailable", `billing could not measure what its max budget consumed (${budget.consumedUnavailableReason}). Held rather than spent (fail-closed).`);
  }
  if (budget.reached) {
    return held("cap_reached", "Sales funnel max budget reached", `its ${budget.period} max budget is reached (${budget.consumedCents} of ${amountCents} cents). Every pipe of the funnel stops spending until the next period or a raise.`);
  }
  const volume = caps.maxVolume;
  if (volume) {
    if (volume.consumed === null || volume.reached === null) {
      console.error(
        `[campaign-service] Sales funnel ${unit.salesFunnelId} max volume consumption unmeasured (${volume.consumedUnavailableReason}: ${volume.consumedUnavailableDetail ?? ""}) — unit ${unit.id} held`,
      );
      return held("unreadable", "Sales funnel volume unavailable", `billing could not measure its max volume (${volume.consumedUnavailableReason}). Held rather than spent (fail-closed).`);
    }
    if (volume.reached) {
      return held("cap_reached", "Sales funnel max volume reached", `its ${volume.period} max volume is reached (${volume.consumed} of ${volume.count} ${volume.unit}). No new first touch and no new event is taken until the next period or a raise.`);
    }
  }
  // A reactive pipe answers people already contacted: it ranks first in its cohort's turn.
  if (reactive) return { run: true, pace: { spentCents: 0, ceilingCents: 1 } };
  return { run: true, pace: { spentCents: budget.consumedCents, ceilingCents: amountCents } };
}

/**
 * May this UNIT pay for one metered poll-trigger read (lib/poll-trigger-detector.ts `pollPayer`)?
 * The read is spend filed under the unit, so it is judged on the unit's money, its funnel's caps:
 * a max budget is stated, its consumption is measured, and the read's worst-case cost still fits
 * under it (consumed + call <= max budget). Volume is not consumed by a read (it counts first
 * contacts). Unreadable or unmeasured = no (fail-closed). Billed exactly as any payer: the unit's
 * own org (= its funnel campaign's), on the unit's ancestor run.
 */
export async function salesFunnelPollRoom(
  unit: SalesFunnelUnitRef,
  callCents: number,
  now: Date = new Date(),
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!unit.brandId || !unit.offerId || !unit.salesFunnelId) {
    return { ok: false, reason: "sales funnel unit states no brand, offer or sales funnel" };
  }
  const read = await fetchSalesFunnelCaps(
    { orgId: unit.orgId, brandId: unit.brandId, offerId: unit.offerId, salesFunnelId: unit.salesFunnelId },
    now.getTime(),
  );
  if (!read.ok) return { ok: false, reason: `sales funnel caps unreadable (${read.detail})` };
  const budget = read.caps.maxBudget;
  if (!read.caps.stated || !budget || budget.amountCents === null || !(budget.amountCents > 0)) {
    return { ok: false, reason: "sales funnel states no max budget" };
  }
  if (budget.consumedCents === null) {
    return { ok: false, reason: `sales funnel budget unmeasured (${budget.consumedUnavailableReason})` };
  }
  if (budget.consumedCents + callCents > budget.amountCents) {
    return { ok: false, reason: `sales funnel ${budget.period} budget: ${budget.consumedCents}c of ${budget.amountCents}c consumed` };
  }
  return { ok: true };
}

/** The money question's view of a campaign row (or a claimed one). */
export function salesFunnelUnitRef(c: {
  id: string;
  orgId: string;
  brandId?: string | null;
  brandIds?: string[] | null;
  offerId?: string | null;
  featureSlug?: string | null;
  legKey?: string | null;
  salesFunnelCampaignId?: string | null;
  salesFunnelId?: string | null;
}): SalesFunnelUnitRef {
  return {
    id: c.id,
    orgId: c.orgId,
    brandId: c.brandId ?? c.brandIds?.[0] ?? null,
    offerId: c.offerId ?? null,
    featureSlug: c.featureSlug ?? null,
    legKey: c.legKey ?? null,
    salesFunnelCampaignId: c.salesFunnelCampaignId ?? null,
    salesFunnelId: c.salesFunnelId ?? null,
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
