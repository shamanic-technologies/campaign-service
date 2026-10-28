import { and, asc, eq, inArray, isNull, or } from "drizzle-orm";
import { db } from "../db/index.js";
import { campaigns, salesFunnelCampaigns } from "../db/schema.js";
import { fetchChannelCatalogue, type ChannelCatalogueRead, type CatalogueLeg } from "./channel-operator-client.js";
import { fetchSalesFunnel, type SalesFunnelFromCatalogue } from "./sales-funnel-catalogue-client.js";

/**
 * A FUNNEL CAMPAIGN'S TARGET AND BRIEF (owner 2026-10-28, FACTORY-P1-CAMPAIGN-TARGET-BRIEF, GTM Factory v10 phase 1).
 *
 * A campaign is defined by the OUTCOME it targets, not by a frozen sales funnel:
 *   - `target`: the final step it aims at (a catalogue step key, features-service's vocabulary, carried verbatim:
 *     `positive_reply`, `meeting_booked`, `paid_client`...). Born = the LAST step of the funnel it runs (the last
 *     leg's `toStep` as the catalogue publishes it, never parsed off a leg key or a funnel id); settable by the org.
 *   - `brief`: the strategy in plain language ("Cold email only, never write to someone who asked to stop"). Read
 *     later by a judge (Jev) choosing the play per pipe. NOT `instruction` (that one is what the writer's message
 *     follows). Every edit is dated + attributed (`brief_updated_at`, `brief_updated_by_user_id`) so a judge knows
 *     when to re-judge.
 *   - `mode` (proactive | reactive) + `triggerId`: what the funnel STARTS from, features-service's statement (the
 *     funnel's head trigger, else its head pipe's mode), copied at birth so every read serves it without a catalogue
 *     call. A funnel id never changes its head.
 *
 * Step 1 is purely ADDITIVE: nothing here decides who is served, what runs, or what is spent.
 */

export type SalesFunnelMode = "proactive" | "reactive";

export interface SalesFunnelShape {
  /** The funnel's last step; null when the catalogue does not publish its last leg (`reason` says so). */
  target: string | null;
  reason: TargetBackfillFailure["reason"] | null;
  mode: SalesFunnelMode;
  triggerId: string | null;
}

/**
 * What a funnel starts from and ends at, from features-service's two statements (the funnel read + the leg
 * vocabulary). Pure.
 */
export function salesFunnelShapeOf(
  funnel: Pick<SalesFunnelFromCatalogue, "legs" | "triggerId">,
  legs: readonly CatalogueLeg[],
): SalesFunnelShape {
  const head = funnel.legs[0];
  const mode: SalesFunnelMode = funnel.triggerId || head?.pipe?.mode === "reactive" ? "reactive" : "proactive";
  const last = funnel.legs[funnel.legs.length - 1];
  if (!last) return { target: null, reason: "funnel_has_no_legs", mode, triggerId: funnel.triggerId ?? null };
  const published = legs.find((l) => l.legKey === last.legKey);
  if (!published?.toStepKey) return { target: null, reason: "last_leg_unpublished", mode, triggerId: funnel.triggerId ?? null };
  return { target: published.toStepKey, reason: null, mode, triggerId: funnel.triggerId ?? null };
}

/**
 * A RETIRED funnel (features-service 404s its id) is no longer published, but the campaign's own units still name
 * the legs it ran, in birth order (= the funnel's leg order): the target is the catalogue's `toStep` of its last
 * unit's leg; the mode is its head unit's (a unit running on a trigger = reactive on it, else the catalogue's
 * reading of that (channel, leg)). Pure.
 */
export function shapeFromUnits(
  units: ReadonlyArray<{ featureSlug: string | null; legKey: string | null; runsOnTriggerId: string | null }>,
  catalogue: Pick<Extract<ChannelCatalogueRead, { ok: true }>, "legs" | "reactiveBySlug">,
): SalesFunnelShape {
  const head = units[0];
  const last = units[units.length - 1];
  const headReactive =
    !!head?.runsOnTriggerId ||
    (!!head?.featureSlug && !!head.legKey && catalogue.reactiveBySlug?.get(head.featureSlug)?.get(head.legKey) === true);
  const mode: SalesFunnelMode = headReactive ? "reactive" : "proactive";
  const triggerId = head?.runsOnTriggerId ?? null;
  if (!last?.legKey) return { target: null, reason: "funnel_retired", mode, triggerId };
  const toStep = catalogue.legs.find((l) => l.legKey === last.legKey)?.toStepKey ?? null;
  return { target: toStep, reason: toStep ? null : "funnel_retired", mode, triggerId };
}

export type TargetCheck =
  | { ok: true }
  | { ok: false; status: 400 | 502; body: { error: string; reason: "unknown_target_step" | "catalogue_unavailable"; target?: string } };

/** A stated target must be a step the catalogue publishes (features-service's vocabulary), else a named 400. */
export async function checkTargetStep(
  target: string,
  deps: { catalogue?: () => Promise<ChannelCatalogueRead> } = {},
): Promise<TargetCheck> {
  const catalogue = await (deps.catalogue ?? fetchChannelCatalogue)();
  if (!catalogue.ok) {
    console.error(`[campaign-service] Target ${target} not checked: channel catalogue unreadable: ${catalogue.detail}`);
    return {
      ok: false,
      status: 502,
      body: { error: "We couldn't read the list of outcomes just now. Please try again in a minute.", reason: "catalogue_unavailable" },
    };
  }
  if (!catalogue.stepKeys.has(target)) {
    return {
      ok: false,
      status: 400,
      body: { error: `"${target}" is not an outcome we know. Pick one of the steps of the catalogue.`, reason: "unknown_target_step", target },
    };
  }
  return { ok: true };
}

export interface TargetBackfillFailure {
  salesFunnelCampaignId: string;
  salesFunnelId: string;
  reason: "funnel_retired" | "catalogue_unavailable" | "funnel_has_no_legs" | "last_leg_unpublished";
  detail?: string;
}

export interface TargetBackfillReport {
  apply: boolean;
  /** Rows missing a target or a mode before this pass. */
  scanned: number;
  /** Rows written (apply) or that would be (dry run). */
  filled: number;
  /** Rows on a RETIRED funnel filled from their own units' legs (`shapeFromUnits`). */
  fromUnits: Array<{ salesFunnelCampaignId: string; salesFunnelId: string; target: string | null }>;
  /** Every funnel campaign's target after this pass (dry run: as it would be), `null` = still none. */
  byTarget: Record<string, number>;
  failures: TargetBackfillFailure[];
}

/**
 * Fills `target` (the funnel's last step), `mode` and `trigger_id` on every funnel campaign missing them, from
 * features-service (one funnel read per distinct funnel + one catalogue read). Never overwrites a target someone
 * stated. Dry run unless `apply`; idempotent. Run at boot (after listen, background) and by staff on
 * `POST /internal/sales-funnel-campaigns/target-backfill`.
 */
export async function backfillSalesFunnelCampaignTargets(
  input: { apply: boolean },
  deps: { catalogue?: () => Promise<ChannelCatalogueRead>; salesFunnel?: typeof fetchSalesFunnel } = {},
): Promise<TargetBackfillReport> {
  const missing = await db
    .select({ id: salesFunnelCampaigns.id, salesFunnelId: salesFunnelCampaigns.salesFunnelId, target: salesFunnelCampaigns.target })
    .from(salesFunnelCampaigns)
    .where(or(isNull(salesFunnelCampaigns.target), isNull(salesFunnelCampaigns.mode)));

  const failures: TargetBackfillFailure[] = [];
  const fromUnits: TargetBackfillReport["fromUnits"] = [];
  const planned = new Map<string, SalesFunnelShape>();
  let filled = 0;

  if (missing.length > 0) {
    const catalogue = await (deps.catalogue ?? fetchChannelCatalogue)();
    const funnelIds = [...new Set(missing.map((r) => r.salesFunnelId))];
    const shapes = new Map<string, SalesFunnelShape | TargetBackfillFailure["reason"]>();
    const details = new Map<string, string>();
    for (const funnelId of funnelIds) {
      if (!catalogue.ok) {
        shapes.set(funnelId, "catalogue_unavailable");
        details.set(funnelId, catalogue.detail);
        continue;
      }
      const read = await (deps.salesFunnel ?? fetchSalesFunnel)(funnelId);
      if (!read.ok) {
        shapes.set(funnelId, read.notFound ? "funnel_retired" : "catalogue_unavailable");
        details.set(funnelId, read.detail);
        continue;
      }
      shapes.set(funnelId, salesFunnelShapeOf(read.value, catalogue.legs));
    }

    // Retired funnels: read from the campaign's own units (birth order).
    const retiredRows = missing.filter((r) => shapes.get(r.salesFunnelId) === "funnel_retired");
    const unitsByParent = new Map<string, Array<{ featureSlug: string | null; legKey: string | null; runsOnTriggerId: string | null }>>();
    if (retiredRows.length > 0 && catalogue.ok) {
      const unitRows = await db
        .select({
          parent: campaigns.salesFunnelCampaignId,
          featureSlug: campaigns.featureSlug,
          legKey: campaigns.legKey,
          runsOnTriggerId: campaigns.runsOnTriggerId,
        })
        .from(campaigns)
        .where(inArray(campaigns.salesFunnelCampaignId, retiredRows.map((r) => r.id)))
        .orderBy(asc(campaigns.createdAt), asc(campaigns.id));
      for (const u of unitRows) {
        const list = unitsByParent.get(u.parent!) ?? [];
        list.push(u);
        unitsByParent.set(u.parent!, list);
      }
    }

    for (const row of missing) {
      let shape = shapes.get(row.salesFunnelId)!;
      if (shape === "funnel_retired" && catalogue.ok && unitsByParent.has(row.id)) {
        shape = shapeFromUnits(unitsByParent.get(row.id)!, catalogue);
        fromUnits.push({ salesFunnelCampaignId: row.id, salesFunnelId: row.salesFunnelId, target: shape.target });
      }
      if (typeof shape === "string") {
        failures.push({ salesFunnelCampaignId: row.id, salesFunnelId: row.salesFunnelId, reason: shape, detail: details.get(row.salesFunnelId) });
        continue;
      }
      if (shape.target === null && row.target === null) {
        failures.push({ salesFunnelCampaignId: row.id, salesFunnelId: row.salesFunnelId, reason: shape.reason! });
      }
      planned.set(row.id, shape);
      filled++;
      if (!input.apply) continue;
      // A target someone stated is never overwritten; the mode is the funnel's.
      await db
        .update(salesFunnelCampaigns)
        .set({ mode: shape.mode, triggerId: shape.triggerId })
        .where(and(eq(salesFunnelCampaigns.id, row.id), isNull(salesFunnelCampaigns.mode)));
      if (shape.target !== null) {
        await db
          .update(salesFunnelCampaigns)
          .set({ target: shape.target })
          .where(and(eq(salesFunnelCampaigns.id, row.id), isNull(salesFunnelCampaigns.target)));
      }
    }
  }

  const all = await db.select({ id: salesFunnelCampaigns.id, target: salesFunnelCampaigns.target }).from(salesFunnelCampaigns);
  const byTarget: Record<string, number> = {};
  for (const row of all) {
    const target = row.target ?? (input.apply ? null : planned.get(row.id)?.target ?? null);
    const key = target ?? "null";
    byTarget[key] = (byTarget[key] ?? 0) + 1;
  }
  return { apply: input.apply, scanned: missing.length, filled, fromUnits, byTarget, failures };
}

/** Boot pass (after listen, never awaited): every funnel campaign born before targets existed gets one. */
export async function backfillTargetsAtBoot(): Promise<void> {
  try {
    const report = await backfillSalesFunnelCampaignTargets({ apply: true });
    if (report.scanned === 0) return;
    // A row the catalogue cannot answer (retired funnel AND leg) stays without a target: a known state, said once per
    // boot at info. Only an unreadable catalogue is an anomaly.
    const unreadable = report.failures.filter((f) => f.reason === "catalogue_unavailable");
    console.log(
      `[campaign-service] Funnel campaign targets: ${report.scanned} without target or mode, ${report.failures.length} left without a target ` +
        `(${report.failures.map((f) => `${f.salesFunnelCampaignId} ${f.reason}`).join(", ") || "none"}); by target ${JSON.stringify(report.byTarget)}`,
    );
    for (const f of unreadable) {
      console.error(`[campaign-service] Funnel campaign ${f.salesFunnelCampaignId} has no target: catalogue unreadable (${f.salesFunnelId}) ${f.detail ?? ""}`);
    }
  } catch (err) {
    console.error("[campaign-service] Funnel campaign target backfill failed:", err);
  }
}
