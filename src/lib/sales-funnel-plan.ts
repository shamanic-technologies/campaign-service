import { and, asc, eq, gte, inArray, isNotNull, ne, or } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/index.js";
import { campaigns, planFollowingDays, salesFunnelCampaigns, salesFunnelPlanChanges, type Campaign, type SalesFunnelCampaign } from "../db/schema.js";
import { applySalesFunnelPlanChange, type PlanUnitDecision, type SalesFunnelUnitBirth } from "./campaign-status-history.js";
import { acquisitionChannelForFeature, derivedCampaignName } from "./campaign-identity.js";
import { sameLeg } from "./leg-identity.js";
import { ensureSourcesOnStart } from "./source-campaign-store.js";
import { briefNamedUnits, type BriefGuardDeps } from "./sales-funnel-plan-brief.js";
import { resolveSalesFunnelPlan, type SalesFunnelUnitPlan } from "./startable-pair.js";

/**
 * A FUNNEL CAMPAIGN THAT FOLLOWS ITS PLAN (owner 2026-10-28, FACTORY-P1-FOLLOW-PLAN, GTM Factory v10 phase 1).
 *
 * "A campaign no longer runs a FROZEN funnel; at each tick it runs the best path to its Target." Opt-in, per funnel
 * campaign, as DATA (`sales_funnel_campaigns.follows_plan`, default false: every campaign before runs its fixed
 * funnel, byte-identical). features-service computes and stores the plan (`GET /brands/:b/sales-funnel-campaigns/:id/
 * factory-shadow`, recomputed every 3 h): the best straight line from Start (or the trigger) to the campaign's Target,
 * each pipe on the play its brief picked, as ONE catalogue funnel id (`plan.shadow.funnelId`). This module READS it and,
 * for a campaign following its plan, makes what it runs equal to it:
 *
 *   - IDENTITY KEPT: the funnel campaign's id, status and `sales_funnel_id` never move. `sales_funnel_id` is the key
 *     billing's caps are stated under (lib/sales-funnel-cap-key.ts reads every unit's caps under it), so a plan change
 *     never leaves the campaign uncapped nor counts it under another funnel. `running_sales_funnel_id` = the plan
 *     applied last.
 *   - A pipe IN the plan: its existing unit is kept and carries the plan's funnel id (`campaigns.sales_funnel_id`), so
 *     features-service reads the plan's PLAY for it on every run; none = a unit is born in the campaign's status.
 *   - A pipe LEAVING the plan is NEVER stopped (owner rule 2026-10-06: stopping never pauses follow-ups; a reactive
 *     successor keeps the replies it earned): `plan_role = 'draining'`. It answers the people it already owes (a
 *     reactive pipe, a trigger event) and takes NO new people: the scheduler and a person's start never dispatch a
 *     draining unit that answers no trigger (lib/scheduler.ts, lib/selected-dispatch.ts).
 *   - CAPS: billing (v0.83.67, FACTORY-P1-FOLLOW-PLAN-BILLING) counts EVERY unit of a funnel campaign held to a cap,
 *     whatever pipe the plan put it on, once each, and serves those pipes' modes (`pipes[].outsideFunnel`). A unit's
 *     caps read keys on the campaign's own `sales_funnel_id`, so a plan change is never uncapped nor double-capped.
 *   - No plan, an unreadable or failed plan, a plan we cannot run: nothing changes, loud log, red on Monitoring
 *     (`GET /internal/ops/plan-following`). Never stops, never runs uncapped. Never an email.
 *   - Every change applied is recorded (`sales_funnel_plan_changes`: when, from which funnel to which, each unit).
 *   - A channel the BRIEF names is never drained by a plan (lib/sales-funnel-plan-brief.ts): kept running, red
 *     `plan_contradicts_brief` with the plan's id (until a plan keeps it).
 *   - SWITCHED OFF (PLAN-SWITCH-OFF-1029): the campaign goes back to its OWN funnel (`sales_funnel_id`) through the same
 *     reconciliation: its funnel's units run again (out of draining, back on its funnel), units the plan bore that its
 *     funnel does not name drain (never stopped: they owe follow-ups), `running_sales_funnel_id` = its funnel, a
 *     history row `reason: 'switched_off'`. At once on the switch, retried by every pass until it is home.
 *
 * Cadence: an in-process pass (first ~60 s after boot, then every 10 min, single flight) over every ONGOING funnel
 * campaign following its plan, plus one at once when the switch is turned on or the campaign started.
 */

export const PLAN_FOLLOWER_FIRST_TICK_MS = 60_000;
export const PLAN_FOLLOWER_INTERVAL_MS = 10 * 60_000;
export { PLAN_DRAINING_RECHECK_MS } from "./sales-funnel-plan-constants.js";

export type PlanCheckState =
  | "following"
  | "applied"
  | "stopped"
  | "switched_off"
  | "plan_contradicts_brief"
  | "restore_failed"
  | "no_plan"
  | "plan_unreadable"
  | "plan_not_ready"
  | "plan_not_runnable"
  | "apply_failed";

/** States that are a problem a person must see (red on Monitoring). */
export const RED_PLAN_STATES: ReadonlySet<PlanCheckState> = new Set([
  "no_plan",
  "plan_unreadable",
  "plan_not_ready",
  "plan_not_runnable",
  "apply_failed",
  "plan_contradicts_brief",
  "restore_failed",
]);

export interface PlanCheck {
  state: PlanCheckState;
  detail: string;
  checkedAt: string;
  /** The plan's funnel when one was read. */
  planSalesFunnelId?: string;
  planComputedAt?: string;
}

// ── features-service's plan read ─────────────────────────────────────────────────────────────────────

const PlanLeg = z.object({ legKey: z.string(), pipeId: z.string().nullable(), channelSlug: z.string().nullable(), playId: z.string().nullable() }).passthrough();
const PlanLine = z.object({ funnelId: z.string(), line: z.string().optional(), legs: z.array(PlanLeg) }).passthrough();
const FactoryShadowBody = z
  .object({
    status: z.string(),
    failure: z.string().nullable().optional(),
    computedAt: z.string(),
    plan: z
      .object({
        shadow: PlanLine.nullable(),
        shadowUnavailableReason: z.string().nullable().optional(),
      })
      .passthrough()
      .nullable(),
  })
  .passthrough();
export type FactoryShadow = z.infer<typeof FactoryShadowBody>;

export type PlanRead =
  | { ok: true; plan: FactoryShadow }
  | { ok: false; notComputed: true; detail: string }
  | { ok: false; notComputed: false; detail: string };

/**
 * features-service `GET /brands/:brandId/sales-funnel-campaigns/:id/factory-shadow` (x-api-key + identity; 404
 * `factory_shadow_not_computed` = no plan stored yet). A READ of a stored row, nothing computed or spent.
 */
export async function fetchFactoryPlan(
  row: Pick<SalesFunnelCampaign, "id" | "orgId" | "brandId">,
  identity: { userId: string; runId: string },
): Promise<PlanRead> {
  const baseUrl = process.env.FEATURES_SERVICE_URL;
  const apiKey = process.env.FEATURES_SERVICE_API_KEY;
  if (!baseUrl || !apiKey) return { ok: false, notComputed: false, detail: "features-service not configured" };
  const path = `/brands/${encodeURIComponent(row.brandId)}/sales-funnel-campaigns/${encodeURIComponent(row.id)}/factory-shadow`;
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, {
      headers: { "x-api-key": apiKey, "x-org-id": row.orgId, "x-user-id": identity.userId, "x-run-id": identity.runId },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 404) return { ok: false, notComputed: true, detail: `features-service has no plan stored for ${row.id} yet` };
    if (!res.ok) return { ok: false, notComputed: false, detail: `features-service HTTP ${res.status} on ${path}` };
    const parsed = FactoryShadowBody.safeParse(await res.json());
    if (!parsed.success) return { ok: false, notComputed: false, detail: `plan answer unparseable: ${parsed.error.message.slice(0, 200)}` };
    return { ok: true, plan: parsed.data };
  } catch (err) {
    return { ok: false, notComputed: false, detail: `${path}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ── The rules (pure) ─────────────────────────────────────────────────────────────────────────────────

type UnitView = Pick<Campaign, "id" | "featureSlug" | "legKey" | "status" | "planRole" | "createdAt">;

/**
 * PURE: what a plan does to a funnel campaign's units. A planned pipe takes its existing unit (same channel, same
 * leg; the ongoing one first, else the newest), else a unit is born. Every other unit not yet draining starts
 * draining. A unit already draining that the plan does not name is left as it is.
 */
export function planReconciliation(
  units: readonly UnitView[],
  planned: readonly SalesFunnelUnitPlan[],
): { decisions: PlanUnitDecision[]; births: SalesFunnelUnitPlan[] } {
  const taken = new Set<string>();
  const decisions: PlanUnitDecision[] = [];
  const births: SalesFunnelUnitPlan[] = [];
  for (const p of planned) {
    const match = units
      .filter((u) => !taken.has(u.id) && u.featureSlug === p.featureSlug && sameLeg(p.featureSlug, u.legKey, p.legKey))
      .sort((a, b) => Number(b.status === "ongoing") - Number(a.status === "ongoing") || b.createdAt.getTime() - a.createdAt.getTime())[0];
    if (!match) {
      births.push(p);
      continue;
    }
    taken.add(match.id);
    decisions.push({ unitId: match.id, pipeId: p.pipeId, action: "kept", runsOnTriggerId: p.runsOnTriggerId });
  }
  for (const u of units) {
    if (taken.has(u.id) || u.planRole === "draining") continue;
    decisions.push({ unitId: u.id, pipeId: `${u.featureSlug}|${u.legKey}`, action: "draining" });
  }
  return { decisions, births };
}

// ── One campaign ─────────────────────────────────────────────────────────────────────────────────────

export interface PlanCheckResult {
  salesFunnelCampaignId: string;
  orgId: string;
  brandId: string;
  check: PlanCheck;
  /** The funnel it runs (before the check). */
  runningSalesFunnelId: string;
  /** Pipes it runs before / would run after (ongoing units not draining), `<channel>|<leg>`. */
  pipesBefore: string[];
  pipesAfter: string[] | null;
  /** What the plan does (or would do on a dry run) to each unit, + the pipes born. */
  units: Array<{ campaignId: string | null; pipeId: string; action: string }> | null;
}

export interface PlanDeps extends BriefGuardDeps {
  plan?: typeof fetchFactoryPlan;
  resolve?: typeof resolveSalesFunnelPlan;
}

const pipeOf = (u: Pick<Campaign, "featureSlug" | "legKey">) => `${u.featureSlug}|${u.legKey}`;
const runningPipes = (units: readonly Campaign[]) =>
  units.filter((u) => u.status === "ongoing" && u.planRole !== "draining").map(pipeOf).sort();

/**
 * Check ONE funnel campaign against its plan and, when `apply` and the campaign follows its plan, apply a changed
 * plan. Never throws: every failure is the check's state (red), the campaign keeps running what it ran.
 * `apply: false` = a dry run (what the switch WOULD do), for any campaign, writing nothing.
 */
export async function checkSalesFunnelCampaignPlan(
  row: SalesFunnelCampaign,
  opts: { apply: boolean; now?: Date },
  deps: PlanDeps = {},
): Promise<PlanCheckResult> {
  const now = opts.now ?? new Date();
  const running = row.runningSalesFunnelId ?? row.salesFunnelId;
  const units = await db
    .select()
    .from(campaigns)
    .where(and(eq(campaigns.orgId, row.orgId), eq(campaigns.salesFunnelCampaignId, row.id)))
    .orderBy(asc(campaigns.createdAt));
  const base = { salesFunnelCampaignId: row.id, orgId: row.orgId, brandId: row.brandId, runningSalesFunnelId: running, pipesBefore: runningPipes(units) };
  const done = (state: PlanCheckState, detail: string, extra: Partial<PlanCheckResult> & { plan?: Pick<PlanCheck, "planSalesFunnelId" | "planComputedAt"> } = {}): PlanCheckResult => {
    const { plan, ...rest } = extra;
    if (RED_PLAN_STATES.has(state)) {
      console.error(`[campaign-service] Funnel campaign ${row.id} plan: ${state}: ${detail} — keeps running ${running}`);
    }
    return { ...base, pipesAfter: null, units: null, ...rest, check: { state, detail, checkedAt: now.toISOString(), ...(plan ?? {}) } };
  };

  if (row.status !== "ongoing" && opts.apply) return done("stopped", "The campaign is stopped: its plan is checked once it runs.");
  const userId = row.createdByUserId;
  const runId = units.find((u) => u.anchorRunId)?.anchorRunId ?? row.parentRunId;
  if (!userId || !runId) return done("plan_unreadable", "The campaign states no creator or run to read its plan under.");

  const read = await (deps.plan ?? fetchFactoryPlan)(row, { userId, runId });
  if (!read.ok) {
    return read.notComputed
      ? done("no_plan", "No plan is served for this campaign yet (features-service plans every 3 hours).")
      : done("plan_unreadable", `Its plan could not be read: ${read.detail}`);
  }
  const shadow = read.plan.plan?.shadow ?? null;
  const planMeta = { planComputedAt: read.plan.computedAt, ...(shadow ? { planSalesFunnelId: shadow.funnelId } : {}) };
  if (read.plan.status !== "ok" || !shadow) {
    return done(
      "plan_not_ready",
      `features-service has no usable plan: ${read.plan.status}${read.plan.failure ? ` (${read.plan.failure})` : ""}${read.plan.plan?.shadowUnavailableReason ? ` (${read.plan.plan.shadowUnavailableReason})` : ""}.`,
      { plan: planMeta },
    );
  }
  if (shadow.funnelId === running) {
    // A unit kept because the brief names it stays red while the plan still leaves it out.
    const prev = row.planCheck as PlanCheck | null;
    if (row.followsPlan && prev?.state === "plan_contradicts_brief" && prev.planSalesFunnelId === shadow.funnelId) {
      return done("plan_contradicts_brief", prev.detail, { plan: planMeta, pipesAfter: base.pipesBefore });
    }
    return done("following", `It runs its plan ${running}.`, { plan: planMeta, pipesAfter: base.pipesBefore });
  }

  const resolved = await (deps.resolve ?? resolveSalesFunnelPlan)(shadow.funnelId, { orgId: row.orgId, userId, runId, brandId: row.brandId, offerId: row.offerId });
  if (!resolved.ok) {
    const r = resolved.refusal;
    return done(r.status === 502 ? "plan_unreadable" : "plan_not_runnable", `Its plan ${shadow.funnelId} cannot be run: ${r.code}: ${r.message}`, { plan: planMeta });
  }
  const planned = resolved.plan.units;
  const { decisions, births } = planReconciliation(units, planned);
  const preview = [
    ...decisions.map((d) => ({ campaignId: d.unitId as string | null, pipeId: d.pipeId, action: d.action as string })),
    ...births.map((b) => ({ campaignId: null, pipeId: b.pipeId, action: "born" })),
  ];
  const pipesAfter = planned.map((p) => `${p.featureSlug}|${p.legKey}`).sort();

  if (!opts.apply || !row.followsPlan) {
    return done("following", `Dry run: it would move from ${running} to ${shadow.funnelId}.`, { plan: planMeta, pipesAfter, units: preview });
  }

  // The backstop: a running unit the plan would drain whose channel the brief names is kept running.
  const drainIds = new Set(decisions.filter((d) => d.action === "draining").map((d) => d.unitId));
  const guard = await briefNamedUnits(row, units.filter((u) => drainIds.has(u.id)), deps);
  if (!guard.ok) {
    return done("apply_failed", `Its plan ${shadow.funnelId} was not applied: ${guard.detail}`, { plan: planMeta, pipesAfter, units: preview });
  }
  const keptByBrief = new Set(guard.keep.map((k) => k.unitId));
  const contradiction = guard.keep.length
    ? `Its plan ${shadow.funnelId} leaves out ${[...new Set(guard.keep.map((k) => k.channelName))].join(", ")}, which its brief names: kept running.`
    : null;

  try {
    const applied = await applySalesFunnelPlanChange({
      salesFunnelCampaignId: row.id,
      orgId: row.orgId,
      fromSalesFunnelId: running,
      toSalesFunnelId: shadow.funnelId,
      planComputedAt: new Date(read.plan.computedAt),
      decide: (parent, fresh) => {
        const r = planReconciliation(fresh, planned);
        const d = {
          ...r,
          decisions: r.decisions.map((x) => (x.action === "draining" && keptByBrief.has(x.unitId) ? { ...x, action: "kept_by_brief" as const } : x)),
        };
        const idTag = parent.id.slice(0, 8);
        const unitBirths: Array<SalesFunnelUnitBirth & { pipeId: string }> = d.births.map((b) => ({
          pipeId: b.pipeId,
          featureSlug: b.featureSlug,
          legKey: b.legKey,
          workflowSlug: b.workflowSlug,
          runsOnTriggerId: b.runsOnTriggerId,
          acquisitionChannel: acquisitionChannelForFeature(b.featureSlug)!,
          name: `${parent.salesFunnelName} ${idTag} - ${derivedCampaignName(b.featureSlug, parent.brandId, parent.offerId, b.legKey)}`,
        }));
        return { decisions: d.decisions, births: unitBirths };
      },
      onUnitStarted: async (tx, unit) => {
        await ensureSourcesOnStart(tx, unit);
      },
    });
    if (!applied.applied) return done("following", `Not applied: ${applied.reason} (another check moved it first).`, { plan: planMeta });
    console.log(
      `[campaign-service] Funnel campaign ${row.id} follows its plan: ${running} -> ${shadow.funnelId} (${applied.changeUnits.map((u) => `${u.pipeId} ${u.action}`).join(", ")})`,
    );
    if (contradiction) {
      return done("plan_contradicts_brief", contradiction, { plan: planMeta, pipesAfter, units: applied.changeUnits });
    }
    return done("applied", `It moved from ${running} to ${shadow.funnelId}.`, { plan: planMeta, pipesAfter, units: applied.changeUnits });
  } catch (err) {
    return done("apply_failed", `Its plan ${shadow.funnelId} could not be applied: ${err instanceof Error ? err.message : String(err)}`, { plan: planMeta, pipesAfter, units: preview });
  }
}

// ── Switched off: back to its own funnel ─────────────────────────────────────────────────────────────

/** Is a campaign that no longer follows its plan still carrying the plan's behaviour? */
export function awayFromOwnFunnel(
  row: Pick<SalesFunnelCampaign, "salesFunnelId" | "runningSalesFunnelId">,
  units: ReadonlyArray<Pick<Campaign, "salesFunnelId" | "planRole">>,
): boolean {
  const own = row.salesFunnelId;
  if ((row.runningSalesFunnelId ?? own) !== own) return true;
  // A unit of its funnel draining, or a running unit on another funnel (a plan's play).
  return units.some((u) => (u.planRole === "draining" ? (u.salesFunnelId ?? own) === own : (u.salesFunnelId ?? own) !== own));
}

/**
 * The switch is OFF: put the campaign back on its OWN funnel (`sales_funnel_id`) with the plan's reconciliation, its
 * funnel as the plan. Its funnel's units run again (kept: out of draining, back on its funnel and trigger), a unit a
 * plan bore that its funnel does not name drains (never stopped), the running funnel returns home, recorded with
 * `reason: 'switched_off'`. Already home = nothing written. Never throws: a failure is red `restore_failed`, retried
 * by the next pass.
 */
export async function switchOffPlan(row: SalesFunnelCampaign, deps: PlanDeps = {}, now: Date = new Date()): Promise<PlanCheckResult | null> {
  const own = row.salesFunnelId;
  const running = row.runningSalesFunnelId ?? own;
  const units = await db
    .select()
    .from(campaigns)
    .where(and(eq(campaigns.orgId, row.orgId), eq(campaigns.salesFunnelCampaignId, row.id)))
    .orderBy(asc(campaigns.createdAt));
  if (row.followsPlan || !awayFromOwnFunnel(row, units)) return null;
  const base = { salesFunnelCampaignId: row.id, orgId: row.orgId, brandId: row.brandId, runningSalesFunnelId: running, pipesBefore: runningPipes(units) };
  const fail = (detail: string): PlanCheckResult => {
    console.error(`[campaign-service] Funnel campaign ${row.id} switched off but not back on its funnel ${own}: ${detail}`);
    return { ...base, pipesAfter: null, units: null, check: { state: "restore_failed", detail, checkedAt: now.toISOString() } };
  };
  const userId = row.createdByUserId;
  const runId = units.find((u) => u.anchorRunId)?.anchorRunId ?? row.parentRunId;
  if (!userId || !runId) return fail("The campaign states no creator or run to read its funnel under.");
  try {
    const resolved = await (deps.resolve ?? resolveSalesFunnelPlan)(own, { orgId: row.orgId, userId, runId, brandId: row.brandId, offerId: row.offerId });
    if (!resolved.ok) return fail(`Its funnel ${own} could not be read: ${resolved.refusal.code}: ${resolved.refusal.message}`);
    const planned = resolved.plan.units;
    const applied = await applySalesFunnelPlanChange({
      salesFunnelCampaignId: row.id,
      orgId: row.orgId,
      fromSalesFunnelId: running,
      toSalesFunnelId: own,
      planComputedAt: null,
      reason: "switched_off",
      decide: (parent, fresh) => {
        const d = planReconciliation(fresh, planned);
        const idTag = parent.id.slice(0, 8);
        return {
          decisions: d.decisions,
          births: d.births.map((b) => ({
            pipeId: b.pipeId,
            featureSlug: b.featureSlug,
            legKey: b.legKey,
            workflowSlug: b.workflowSlug,
            runsOnTriggerId: b.runsOnTriggerId,
            acquisitionChannel: acquisitionChannelForFeature(b.featureSlug)!,
            name: `${parent.salesFunnelName} ${idTag} - ${derivedCampaignName(b.featureSlug, parent.brandId, parent.offerId, b.legKey)}`,
          })),
        };
      },
      onUnitStarted: async (tx, unit) => {
        await ensureSourcesOnStart(tx, unit);
      },
    });
    if (!applied.applied) return null;
    console.log(
      `[campaign-service] Funnel campaign ${row.id} switched off: ${running} -> its funnel ${own} (${applied.changeUnits.map((u) => `${u.pipeId} ${u.action}`).join(", ")})`,
    );
    return {
      ...base,
      pipesAfter: planned.map((p) => `${p.featureSlug}|${p.legKey}`).sort(),
      units: applied.changeUnits,
      check: { state: "switched_off", detail: `Switched off: back to its funnel ${own}.`, checkedAt: now.toISOString() },
    };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

/** Switch-off restore of one campaign now (the PATCH), storing its verdict. Never throws. */
export async function runSwitchOffFor(salesFunnelCampaignId: string, deps: PlanDeps = {}): Promise<PlanCheckResult | null> {
  try {
    const row = await db.query.salesFunnelCampaigns.findFirst({ where: eq(salesFunnelCampaigns.id, salesFunnelCampaignId) });
    if (!row || row.followsPlan) return null;
    const result = await switchOffPlan(row, deps);
    if (result) await storeCheck(row.id, result.check);
    return result;
  } catch (err) {
    console.error(`[campaign-service] Switch-off of funnel campaign ${salesFunnelCampaignId} failed:`, err);
    return null;
  }
}

async function storeCheck(id: string, check: PlanCheck): Promise<void> {
  await db.update(salesFunnelCampaigns).set({ planCheck: check }).where(eq(salesFunnelCampaigns.id, id));
}

/** Check (and apply) one campaign now, storing its verdict. Fire-and-forget callers: never throws. */
export async function runPlanCheckFor(salesFunnelCampaignId: string): Promise<PlanCheckResult | null> {
  try {
    const row = await db.query.salesFunnelCampaigns.findFirst({ where: eq(salesFunnelCampaigns.id, salesFunnelCampaignId) });
    if (!row || !row.followsPlan) return null;
    const result = await checkSalesFunnelCampaignPlan(row, { apply: true });
    await storeCheck(row.id, result.check);
    return result;
  } catch (err) {
    console.error(`[campaign-service] Plan check of funnel campaign ${salesFunnelCampaignId} failed:`, err);
    return null;
  }
}

// ── The pass ─────────────────────────────────────────────────────────────────────────────────────────

let passRunning = false;

/** One pass over every ongoing funnel campaign following its plan; today's Monitoring row rewritten. */
export async function runPlanFollowerPass(now: Date = new Date(), deps: PlanDeps = {}): Promise<{ checked: number; red: number; applied: number } | null> {
  if (passRunning) return null;
  passRunning = true;
  try {
    const rows = await db
      .select()
      .from(salesFunnelCampaigns)
      .where(and(eq(salesFunnelCampaigns.followsPlan, true), eq(salesFunnelCampaigns.status, "ongoing")));
    let red = 0;
    let applied = 0;
    for (const row of rows) {
      const result = await checkSalesFunnelCampaignPlan(row, { apply: true, now }, deps);
      await storeCheck(row.id, result.check);
      if (RED_PLAN_STATES.has(result.check.state)) red += 1;
      if (result.check.state === "applied") applied += 1;
    }
    const day = now.toISOString().slice(0, 10);
    const [existing] = await db.select().from(planFollowingDays).where(eq(planFollowingDays.day, day));
    // Switched off but still on a plan's funnel (the PATCH's restore failed): retried here until home.
    const away = await db
      .select()
      .from(salesFunnelCampaigns)
      .where(
        and(
          eq(salesFunnelCampaigns.followsPlan, false),
          isNotNull(salesFunnelCampaigns.runningSalesFunnelId),
          ne(salesFunnelCampaigns.runningSalesFunnelId, salesFunnelCampaigns.salesFunnelId),
        ),
      );
    for (const row of away) {
      const result = await switchOffPlan(row, deps, now);
      if (!result) continue;
      await storeCheck(row.id, result.check);
      if (RED_PLAN_STATES.has(result.check.state)) red += 1;
    }
    const changesApplied = (existing?.changesApplied ?? 0) + applied;
    await db
      .insert(planFollowingDays)
      .values({ day, following: rows.length, red, changesApplied, checkedAt: now })
      .onConflictDoUpdate({ target: planFollowingDays.day, set: { following: rows.length, red, changesApplied, checkedAt: now } });
    if (rows.length > 0) {
      console.log(`[campaign-service] plan follower pass: following=${rows.length} red=${red} applied=${applied}`);
    }
    return { checked: rows.length, red, applied };
  } finally {
    passRunning = false;
  }
}

export function startPlanFollower(): () => void {
  const tick = () => {
    void runPlanFollowerPass().catch((err) => console.error("[campaign-service] plan follower pass error:", err));
  };
  let interval: ReturnType<typeof setInterval> | null = null;
  const first = setTimeout(() => {
    tick();
    interval = setInterval(tick, PLAN_FOLLOWER_INTERVAL_MS);
  }, PLAN_FOLLOWER_FIRST_TICK_MS);
  return () => {
    clearTimeout(first);
    if (interval) clearInterval(interval);
  };
}

// ── Reads ────────────────────────────────────────────────────────────────────────────────────────────

/** The plan changes applied to one funnel campaign, newest first (the dashboard's history). */
export async function readPlanChanges(salesFunnelCampaignId: string) {
  const rows = await db
    .select()
    .from(salesFunnelPlanChanges)
    .where(eq(salesFunnelPlanChanges.salesFunnelCampaignId, salesFunnelCampaignId))
    .orderBy(asc(salesFunnelPlanChanges.appliedAt));
  return rows.reverse().map((r) => ({
    id: r.id,
    fromSalesFunnelId: r.fromSalesFunnelId,
    toSalesFunnelId: r.toSalesFunnelId,
    planComputedAt: r.planComputedAt ? r.planComputedAt.toISOString() : null,
    appliedAt: r.appliedAt.toISOString(),
    reason: r.reason,
    units: r.units as Array<{ campaignId: string; pipeId: string; action: string }>,
  }));
}

/**
 * Monitoring (dashboard v2): `status` red when a campaign following its plan is on a red state, or the last pass is
 * older than 30 min while someone follows a plan. Never an email.
 */
export async function readPlanFollowing(days: number, now: Date = new Date()) {
  const since = new Date(now.getTime() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  const watched = await db
    .select()
    .from(salesFunnelCampaigns)
    .where(
      or(
        eq(salesFunnelCampaigns.followsPlan, true),
        and(isNotNull(salesFunnelCampaigns.runningSalesFunnelId), ne(salesFunnelCampaigns.runningSalesFunnelId, salesFunnelCampaigns.salesFunnelId)),
      ),
    );
  const following = watched.filter((r) => r.followsPlan);
  // Red: a campaign following its plan on a red state, or one switched off that is not back on its funnel yet.
  const red = watched
    .filter((r) => (r.followsPlan ? r.status === "ongoing" : true) && r.planCheck && RED_PLAN_STATES.has((r.planCheck as PlanCheck).state))
    .map((r) => ({
      salesFunnelCampaignId: r.id,
      orgId: r.orgId,
      brandId: r.brandId,
      salesFunnelName: r.salesFunnelName,
      runningSalesFunnelId: r.runningSalesFunnelId ?? r.salesFunnelId,
      ...(r.planCheck as PlanCheck),
    }));
  const byDay = await db.select().from(planFollowingDays).where(gte(planFollowingDays.day, since)).orderBy(asc(planFollowingDays.day));
  const last = byDay[byDay.length - 1];
  const stale = following.some((r) => r.status === "ongoing") && (!last || now.getTime() - last.checkedAt.getTime() > 30 * 60_000);
  return {
    status: red.length > 0 || stale ? ("red" as const) : ("ok" as const),
    staleReason: stale ? "The plan follower has not checked for more than 30 minutes." : null,
    following: following.length,
    red,
    byDay: byDay.map((d) => ({ day: d.day, following: d.following, red: d.red, changesApplied: d.changesApplied, checkedAt: d.checkedAt.toISOString() })),
  };
}

/** Dry run for every funnel campaign of an org (optionally one brand): what following its plan would do. */
export async function dryRunPlans(scope: { orgId: string; brandId?: string; salesFunnelCampaignId?: string }, deps: PlanDeps = {}): Promise<PlanCheckResult[]> {
  const conditions = [eq(salesFunnelCampaigns.orgId, scope.orgId), eq(salesFunnelCampaigns.status, "ongoing")];
  if (scope.brandId) conditions.push(eq(salesFunnelCampaigns.brandId, scope.brandId));
  if (scope.salesFunnelCampaignId) conditions.push(inArray(salesFunnelCampaigns.id, [scope.salesFunnelCampaignId]));
  const rows = await db.select().from(salesFunnelCampaigns).where(and(...conditions));
  const out: PlanCheckResult[] = [];
  for (const row of rows) out.push(await checkSalesFunnelCampaignPlan(row, { apply: false }, deps));
  return out;
}
