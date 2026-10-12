/**
 * THE LEAD SOURCING SWITCH (owner GO 2026-10-11, "Migration A"): a sales funnel is a straight line, ONE channel per
 * leg. A funnel campaign running SEVERAL lead sources today (Apollo Cold Filters + Apollo Buying Signals + LinkedIn
 * Engagement Signals on Start -> Lead found) switches to ONE "Lead Sourcing" unit, keeping the sources the brand
 * already has on. Nothing changes for the client: same caps (billing keys them on the funnel id, which does not
 * move: its stored id resolves to the Lead Sourcing funnel at features-service), same on/off (the funnel campaign's
 * status is untouched), same volume (human-service keeps exactly the sources that were on; lead-service files their
 * serves under Lead Sourcing). No client email.
 *
 * Per funnel campaign, ONE transaction:
 *   - a `lead-sourcing` unit is born in the funnel's status, with the workflow features-service's pipe holds (like
 *     every unit; who dispatches it is lib/on-demand-mode.ts), source
 *     `lead_sourcing_switch`;
 *   - every ONGOING old source unit of it is stopped, reason `replaced_by_lead_sourcing`, same source. A funnel
 *     start never brings them back (`ensureSourcesOnStart` only revives a stop nobody chose on the source).
 * In the same pass (the same rule, every pipe runs a workflow): a source unit still carrying NO workflow gets its
 * pipe's, and a single-source funnel campaign stored under a LEGACY id (it starts out of Lead found: the sourcing
 * leg was a pool outside the id, so features-service answers it with the Lead Sourcing funnel's id) moves to the funnel
 * of the same pipes with its one source on the sourcing leg (an id features-service mints), so its path reads the
 * source it runs, unless billing holds a cap under that id (then reported, never moved).
 *
 * Dry run unless `apply`; idempotent (a funnel campaign with a Lead Sourcing unit is skipped). Exposed as
 * `POST /internal/sales-funnel-campaigns/lead-sourcing-switch`. The status writes live in
 * `campaign-status-history.ts` (`stopSourceUnitsReplacedByLeadSourcing`), the one place that writes a status.
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { campaigns, salesFunnelCampaigns } from "../db/schema.js";
import { insertSalesFunnelUnits, stopSourceUnitsReplacedByLeadSourcing, TRANSITION_SOURCES } from "./campaign-status-history.js";
import { acquisitionChannelForFeature, derivedCampaignName } from "./campaign-identity.js";
import { fetchSalesFunnelCaps } from "./sales-funnel-campaigns.js";
import { declareSalesFunnel, fetchSalesFunnel } from "./sales-funnel-catalogue-client.js";
import { LEAD_SOURCING_SLUG, SOURCE_LEG_KEY, isLiveSourceOrigin, isSourceOriginSlug } from "./source-campaigns.js";

type CampaignRow = typeof campaigns.$inferSelect;
type FunnelRow = typeof salesFunnelCampaigns.$inferSelect;

export interface SwitchPlanItem {
  salesFunnelCampaignId: string;
  orgId: string;
  brandId: string;
  offerId: string;
  salesFunnelId: string;
  salesFunnelName: string;
  status: string;
  /** The ongoing source units replaced, by channel. */
  replaces: Array<{ campaignId: string; featureSlug: string }>;
  leadSourcingCampaignId?: string;
  error?: string;
}

export interface RespellPlanItem {
  salesFunnelCampaignId: string;
  orgId: string;
  brandId: string;
  from: string;
  to: string;
  skipped?: string;
}

export interface WorkflowBackfillItem {
  campaignId: string;
  featureSlug: string;
  workflowSlug: string;
}

export interface LeadSourcingSwitchResult {
  applied: boolean;
  switches: SwitchPlanItem[];
  respelled: RespellPlanItem[];
  workflowBackfill: WorkflowBackfillItem[];
}

/** PURE: the source units of a funnel campaign that are ON. */
export function ongoingSourceUnits<T extends Pick<CampaignRow, "id" | "featureSlug" | "status" | "legKey">>(units: readonly T[]): T[] {
  return units.filter((u) => u.status === "ongoing" && isSourceOriginSlug(u.featureSlug) && u.legKey === SOURCE_LEG_KEY);
}

/**
 * Run the switch (see the header). `workflowOf(channelSlug)` = the active workflow features-service's pipe holds for
 * that sourcing channel (workflow-service's newest active one, the launch's own read); null = none: that channel's
 * units are left without one and the funnel switch is refused for it (reported).
 */
export async function runLeadSourcingSwitch(opts: {
  apply: boolean;
  orgId?: string;
  workflowOf: (channelSlug: string) => Promise<string | null>;
  capsOf?: typeof fetchSalesFunnelCaps;
  catalogue?: { fetchSalesFunnel?: typeof fetchSalesFunnel; declareSalesFunnel?: typeof declareSalesFunnel };
}): Promise<LeadSourcingSwitchResult> {
  const parents = await db
    .select()
    .from(salesFunnelCampaigns)
    .where(opts.orgId ? eq(salesFunnelCampaigns.orgId, opts.orgId) : undefined);
  const unitsByParent = new Map<string, CampaignRow[]>();
  if (parents.length > 0) {
    const units = await db.select().from(campaigns).where(inArray(campaigns.salesFunnelCampaignId, parents.map((p) => p.id)));
    for (const u of units) unitsByParent.set(u.salesFunnelCampaignId!, [...(unitsByParent.get(u.salesFunnelCampaignId!) ?? []), u]);
  }
  const workflowCache = new Map<string, string | null>();
  const workflowOf = async (slug: string) => {
    if (!workflowCache.has(slug)) workflowCache.set(slug, await opts.workflowOf(slug));
    return workflowCache.get(slug)!;
  };

  const result: LeadSourcingSwitchResult = { applied: opts.apply, switches: [], respelled: [], workflowBackfill: [] };
  const lsWorkflow = await workflowOf(LEAD_SOURCING_SLUG);

  for (const parent of parents) {
    const units = unitsByParent.get(parent.id) ?? [];
    const sources = ongoingSourceUnits(units);
    const hasLeadSourcing = units.some((u) => u.featureSlug === LEAD_SOURCING_SLUG);

    // 1. SEVERAL sources ON -> one Lead Sourcing unit.
    if (sources.length >= 2 && !hasLeadSourcing && sources.every((s) => s.featureSlug !== LEAD_SOURCING_SLUG)) {
      const item: SwitchPlanItem = {
        salesFunnelCampaignId: parent.id,
        orgId: parent.orgId,
        brandId: parent.brandId,
        offerId: parent.offerId,
        salesFunnelId: parent.salesFunnelId,
        salesFunnelName: parent.salesFunnelName,
        status: parent.status,
        replaces: sources.map((s) => ({ campaignId: s.id, featureSlug: s.featureSlug! })).sort((a, b) => a.featureSlug.localeCompare(b.featureSlug)),
      };
      if (!lsWorkflow) item.error = "no_workflow: no active Lead Sourcing workflow (workflow-service)";
      else if (opts.apply) {
        try {
          item.leadSourcingCampaignId = await applySwitch(parent, sources, lsWorkflow);
        } catch (err) {
          item.error = err instanceof Error ? err.message : String(err);
          console.error(`[campaign-service] Lead Sourcing switch of sales funnel campaign ${parent.id} failed: ${item.error}`);
        }
      }
      result.switches.push(item);
      continue;
    }

    // 2. ONE source ON under a funnel id the catalogue answers with ANOTHER id (a legacy id: it resolves to the
    //    Lead Sourcing funnel) -> the funnel of the same pipes with ITS source on the sourcing leg (features-service
    //    mints that id), so its path reads the source it runs.
    if (sources.length === 1 && !hasLeadSourcing) {
      const funnel = await (opts.catalogue?.fetchSalesFunnel ?? fetchSalesFunnel)(parent.salesFunnelId);
      if (!funnel.ok) {
        result.respelled.push({ salesFunnelCampaignId: parent.id, orgId: parent.orgId, brandId: parent.brandId, from: parent.salesFunnelId, to: "", skipped: `funnel_unreadable: ${funnel.detail}` });
        continue;
      }
      if (funnel.value.id === parent.salesFunnelId) continue;
      const own = `${sources[0].featureSlug}|${SOURCE_LEG_KEY}`;
      const sourcing = funnel.value.legs.findIndex((l) => l.channelIds.length > 0 && l.channelIds.every(isSourceOriginSlug));
      if (sourcing < 0 || funnel.value.legs.some((l) => !l.pipe)) {
        result.respelled.push({ salesFunnelCampaignId: parent.id, orgId: parent.orgId, brandId: parent.brandId, from: parent.salesFunnelId, to: "", skipped: "funnel_has_no_sourcing_leg" });
        continue;
      }
      const pipeIds = funnel.value.legs.map((l, i) => (i === sourcing ? own : l.pipe!.id));
      const declared = await (opts.catalogue?.declareSalesFunnel ?? declareSalesFunnel)(pipeIds, "campaign-service lead sourcing switch (owner 2026-10-11)");
      if (!declared.ok) {
        result.respelled.push({ salesFunnelCampaignId: parent.id, orgId: parent.orgId, brandId: parent.brandId, from: parent.salesFunnelId, to: "", skipped: `funnel_undeclarable: ${declared.detail}` });
        continue;
      }
      const to = declared.value.id;
      const item: RespellPlanItem = { salesFunnelCampaignId: parent.id, orgId: parent.orgId, brandId: parent.brandId, from: parent.salesFunnelId, to };
      const caps = await (opts.capsOf ?? fetchSalesFunnelCaps)({ orgId: parent.orgId, brandId: parent.brandId, offerId: parent.offerId, salesFunnelId: parent.salesFunnelId });
      if (!caps.ok) item.skipped = `caps_unreadable: ${caps.detail}`;
      else if (caps.caps.stated) item.skipped = "billing_cap_on_this_id";
      else if (opts.apply) await respellFunnelId(parent.id, to);
      result.respelled.push(item);
    }
  }

  // 3. Every ongoing source unit with no workflow takes its pipe's (never due: it answers an inline trigger).
  const bare = await db
    .select({ id: campaigns.id, featureSlug: campaigns.featureSlug, status: campaigns.status, legKey: campaigns.legKey, orgId: campaigns.orgId })
    .from(campaigns)
    .where(and(eq(campaigns.status, "ongoing"), eq(campaigns.legKey, SOURCE_LEG_KEY), isNull(campaigns.workflowSlug)));
  for (const u of bare) {
    if (opts.orgId && u.orgId !== opts.orgId) continue;
    if (!isLiveSourceOrigin(u.featureSlug)) continue;
    const wf = await workflowOf(u.featureSlug!);
    if (!wf) continue;
    result.workflowBackfill.push({ campaignId: u.id, featureSlug: u.featureSlug!, workflowSlug: wf });
    if (opts.apply) {
      await db
        .update(campaigns)
        // Due now: the scheduler parks it while its leg answers on demand (lib/on-demand-mode.ts).
        .set({ workflowSlug: wf, nextRunAt: new Date(), updatedAt: new Date() })
        .where(and(eq(campaigns.id, u.id), isNull(campaigns.workflowSlug)));
    }
  }
  return result;
}

async function applySwitch(parent: FunnelRow, sources: CampaignRow[], workflowSlug: string): Promise<string> {
  return db.transaction(async (tx) => {
    // Locks the funnel row: its status is read inside the transaction that mirrors it.
    const [locked] = await tx.select().from(salesFunnelCampaigns).where(eq(salesFunnelCampaigns.id, parent.id)).for("update");
    const idTag = locked.id.slice(0, 8);
    const [unit] = await insertSalesFunnelUnits(
      tx,
      locked,
      [
        {
          featureSlug: LEAD_SOURCING_SLUG,
          legKey: SOURCE_LEG_KEY,
          workflowSlug,
          acquisitionChannel: acquisitionChannelForFeature(LEAD_SOURCING_SLUG)!,
          // Same name as a launch gives it (names are unique per org; the funnel id keeps funnels apart).
          name: `${locked.salesFunnelName} ${idTag} - ${derivedCampaignName(LEAD_SOURCING_SLUG, locked.brandId, locked.offerId, SOURCE_LEG_KEY)}`,
        },
      ],
      TRANSITION_SOURCES.LEAD_SOURCING_SWITCH,
    );
    const stopped = await stopSourceUnitsReplacedByLeadSourcing(tx, locked.orgId, sources.map((s) => s.id));
    console.log(
      `[campaign-service] Lead Sourcing switch: sales funnel campaign ${locked.id} (${locked.salesFunnelName}) now sources through unit ${unit.id} (${workflowSlug}); stopped ${stopped.join(", ")}`,
    );
    return unit.id;
  });
}

/** The funnel campaign and every unit of it now carry `to` (one transaction; nothing else moves). */
async function respellFunnelId(salesFunnelCampaignId: string, to: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.update(salesFunnelCampaigns).set({ salesFunnelId: to, updatedAt: new Date() }).where(eq(salesFunnelCampaigns.id, salesFunnelCampaignId));
    await tx.update(campaigns).set({ salesFunnelId: to, updatedAt: new Date() }).where(eq(campaigns.salesFunnelCampaignId, salesFunnelCampaignId));
  });
}
