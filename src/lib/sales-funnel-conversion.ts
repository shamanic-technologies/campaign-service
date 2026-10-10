import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "../db/index.js";
import { campaigns, salesFunnelCampaigns } from "../db/schema.js";
import { ceilingEntriesOf, fetchCampaignBudgets, type CampaignBudgetEntry } from "./campaign-budget-client.js";
import { fetchChannelCatalogue } from "./channel-operator-client.js";
import { combinationIdentity, legIsReactive, sameLeg } from "./leg-identity.js";
import { fetchOfferCatalogueSalesPaths, fetchOfferSelectedSalesPaths } from "./reactive-defaults.js";
import { fetchPipe, fetchSalesFunnel, searchSalesFunnelIds, searchSalesPaths } from "./sales-funnel-catalogue-client.js";
import { isSalesFamilyFeature } from "./sales-outreach-campaign.js";
import { isSourceOriginSlug } from "./source-campaigns.js";
import { fetchBrandSalesBudget } from "./brand-sales-budget-client.js";

/**
 * CONVERT THE LIVE (leg x channel) CAMPAIGNS INTO SALES FUNNEL CAMPAIGNS (owner GO 2026-10-10).
 *
 * Owner design, per offer: never mix proactive and reactive pipes in one funnel.
 *   1. ONE PROACTIVE funnel campaign = the offer's live lead SOURCES + its live proactive pipes. Its
 *      MAX BUDGET is DAILY = the sum of those campaigns' current daily ceilings at billing (sourcing
 *      included: the all-inclusive figure gate-check already paced the outreach campaign on). The
 *      funnel is the offer's ticked sales path starting with that pipe (brand-service selected), else
 *      the best-ROI catalogue path starting with it.
 *   2. ONE REACTIVE funnel campaign per live reactive pipe = the catalogue funnel STARTING at that
 *      pipe whose pipes are all reactive. Its MAX BUDGET is "up to" that campaign's current daily
 *      ceiling. A reactive campaign with NO ceiling stays exactly as it is, and is listed.
 *
 * Nothing changes a status, nothing new starts, nobody is emailed: the old rows BECOME the units
 * (they keep their ids, history, workflow and audiences), every funnel campaign is born `ongoing`
 * like the rows it owns. Per group, all or nothing: the rows are linked inside a transaction that
 * also makes billing's ATOMIC swap (the cap written, the per-pipe ceilings it replaces deleted:
 * billing v0.83.12) and commits only when billing said yes. What billing would refuse (a global
 * or items sales budget, a positive ceiling stating no offer) is said in the plan, never forced.
 * Dry run by default; idempotent (linked rows are not live candidates).
 */

type Row = typeof campaigns.$inferSelect;

export interface ConversionGroup {
  orgId: string;
  brandId: string;
  offerId: string;
  kind: "proactive" | "reactive";
  campaignIds: string[];
  pipes: string[];
  /** The per-pipe ceilings standing behind these rows today (deduplicated). */
  ceilings: Array<{ offerId: string | null; legKey: string | null; featureSlug: string; dailyBudgetCents: number }>;
  /** The funnel's max budget, DAILY, in cents (null = no ceiling stood behind them). */
  maxBudgetDailyCents: number | null;
  salesFunnelId: string | null;
  salesFunnelName: string | null;
  /** How the funnel was chosen. */
  basis: "selected_path" | "best_roi_path" | "reactive_funnel" | null;
  /** Why this group is NOT converted (null = converted / convertible). */
  skipped: string | null;
  /** Filled on apply. */
  salesFunnelCampaignId?: string;
  capWritten?: boolean;
  error?: string;
}

export interface ConversionReport {
  applied: boolean;
  groups: ConversionGroup[];
  counts: { campaigns: number; converted: number; skipped: number };
}

const live = (r: Row) => r.status === "ongoing" && !r.salesFunnelCampaignId;

export async function convertToSalesFunnelCampaigns(opts: {
  apply: boolean;
  orgId?: string;
  brandId?: string;
  actingEmail?: string | null;
  /**
   * Convert a reactive campaign with NO ceiling too, into its reactive funnel with no cap (held,
   * unfunded). Owner decision 2026-10-10 for AI Instant Call, which never ran in prod.
   */
  includeUnfundedReactive?: boolean;
  /**
   * DEPRECATED, ignored: billing v0.83.14 replaces a positive ceiling stating no offer when it is
   * the only one for that channel + leg (409 `ceiling_ambiguous` / `ceiling_not_found` otherwise),
   * so it is always sent and billing decides.
   */
  allowOfferLessCeilings?: boolean;
}): Promise<ConversionReport> {
  const rows = (await db
    .select()
    .from(campaigns)
    .where(and(
      eq(campaigns.status, "ongoing"),
      isNull(campaigns.salesFunnelCampaignId),
      isNotNull(campaigns.offerId),
      isNotNull(campaigns.brandId),
      isNotNull(campaigns.legKey),
      opts.orgId ? eq(campaigns.orgId, opts.orgId) : undefined,
      opts.brandId ? eq(campaigns.brandId, opts.brandId) : undefined,
    )))
    .filter((r) => live(r) && (isSalesFamilyFeature(r.featureSlug) || isSourceOriginSlug(r.featureSlug)));

  const catalogue = await fetchChannelCatalogue();
  if (!catalogue.ok) throw new Error(`channel catalogue unreadable: ${catalogue.detail}`);

  const byOffer = new Map<string, Row[]>();
  for (const r of rows) {
    const key = `${r.orgId}|${r.brandId}|${r.offerId}`;
    byOffer.set(key, [...(byOffer.get(key) ?? []), r]);
  }

  const groups: ConversionGroup[] = [];
  for (const offerRows of byOffer.values()) {
    const { orgId, brandId, offerId } = offerRows[0] as Row & { brandId: string; offerId: string };
    const owner = offerRows.find((r) => r.createdByUserId && r.parentRunId) ?? offerRows[0];
    const identity = { orgId, userId: owner.createdByUserId ?? undefined, runId: owner.parentRunId ?? undefined, brandId };
    const budgets = await fetchCampaignBudgets(brandId, identity);
    // billing refuses a funnel cap for a brand on one global sales budget (and items mode is a
    // subscriber's): said in the plan, never forced.
    const salesBudget = await fetchBrandSalesBudget(brandId, identity);
    const modeRefusal = !salesBudget.ok
      ? "billing_sales_budget_unreadable"
      : salesBudget.mode !== "campaigns" ? `brand_in_${salesBudget.mode}_sales_budget_mode` : null;
    // billing replaces ceilings named by (channel, leg) under the offer; an offer-less one is
    // replaced when it is the only one for that channel + leg (billing v0.83.14, else 409, nothing
    // written). A positive ceiling stating NO LEG cannot be named at all: planned, never forced.
    const unnameable = (cs: ConversionGroup["ceilings"]) =>
      cs.some((c) => c.dailyBudgetCents > 0 && !c.legKey) ? "positive_leg_less_ceiling_billing_cannot_replace" : null;

    const sources = offerRows.filter((r) => isSourceOriginSlug(r.featureSlug));
    const pipes = offerRows.filter((r) => !isSourceOriginSlug(r.featureSlug));
    const proactive = pipes.filter((r) => legIsReactive(catalogue, r.featureSlug, r.legKey) === false);
    const reactive = pipes.filter((r) => legIsReactive(catalogue, r.featureSlug, r.legKey) === true);
    const unknown = pipes.filter((r) => legIsReactive(catalogue, r.featureSlug, r.legKey) === null);

    const base = { orgId, brandId, offerId };
    const ceilingsOf = (members: Row[]) => {
      if (!budgets.ok) return null;
      const seen = new Map<string, CampaignBudgetEntry>();
      for (const m of members) for (const e of ceilingEntriesOf(budgets, m)) seen.set(`${e.offerId}|${e.legKey}|${e.featureSlug}`, e);
      return [...seen.values()].map((e) => ({ offerId: e.offerId, legKey: e.legKey, featureSlug: e.featureSlug, dailyBudgetCents: e.dailyBudgetCents }));
    };
    const describe = (members: Row[]) => members.map((m) => `${m.featureSlug}|${m.legKey}`);

    for (const r of unknown) {
      groups.push({ ...base, kind: "proactive", campaignIds: [r.id], pipes: describe([r]), ceilings: [], maxBudgetDailyCents: null, salesFunnelId: null, salesFunnelName: null, basis: null, skipped: "leg_not_in_catalogue" });
    }

    // (1) PROACTIVE: sources + proactive pipes.
    if (proactive.length > 0) {
      const members = [...sources, ...proactive];
      const ceilings = ceilingsOf(members);
      const group: ConversionGroup = {
        ...base, kind: "proactive", campaignIds: members.map((m) => m.id), pipes: describe(members),
        ceilings: ceilings ?? [], maxBudgetDailyCents: ceilings ? (ceilings.length ? ceilings.reduce((s, c) => s + c.dailyBudgetCents, 0) : null) : null,
        salesFunnelId: null, salesFunnelName: null, basis: null, skipped: null,
      };
      if (!budgets.ok) group.skipped = "billing_unreadable";
      else if (budgets.campaigns.length === 0) group.skipped = "brand_pot_not_per_campaign";
      else if (proactive.length > 1) group.skipped = "several_proactive_pipes";
      else {
        const funnel = await proactiveFunnelOf(proactive[0], identity, catalogue.operatorBySlug);
        if (!funnel.ok) group.skipped = funnel.reason;
        else {
          Object.assign(group, { salesFunnelId: funnel.id, salesFunnelName: funnel.name, basis: funnel.basis });
          group.skipped = modeRefusal ?? unnameable(group.ceilings);
        }
      }
      groups.push(group);
    } else if (sources.length > 0) {
      groups.push({ ...base, kind: "proactive", campaignIds: sources.map((s) => s.id), pipes: describe(sources), ceilings: ceilingsOf(sources) ?? [], maxBudgetDailyCents: null, salesFunnelId: null, salesFunnelName: null, basis: null, skipped: "sources_with_no_proactive_pipe" });
    }

    // (2) REACTIVE: one funnel campaign per reactive pipe.
    for (const r of reactive) {
      const ceilings = ceilingsOf([r]);
      const group: ConversionGroup = {
        ...base, kind: "reactive", campaignIds: [r.id], pipes: describe([r]),
        ceilings: ceilings ?? [], maxBudgetDailyCents: ceilings && ceilings.length ? ceilings.reduce((s, c) => s + c.dailyBudgetCents, 0) : null,
        salesFunnelId: null, salesFunnelName: null, basis: null, skipped: null,
      };
      if (!budgets.ok) group.skipped = "billing_unreadable";
      else if ((!ceilings || ceilings.length === 0) && !opts.includeUnfundedReactive) group.skipped = "reactive_without_ceiling_kept_as_is";
      else {
        const funnel = await reactiveFunnelOf(r, catalogue.operatorBySlug);
        if (!funnel.ok) group.skipped = funnel.reason;
        else {
          Object.assign(group, { salesFunnelId: funnel.id, salesFunnelName: funnel.name, basis: "reactive_funnel" });
          group.skipped = modeRefusal ?? unnameable(group.ceilings);
        }
      }
      groups.push(group);
    }
  }

  if (opts.apply) {
    for (const g of groups) {
      if (g.skipped || !g.salesFunnelId) continue;
      try {
        await applyGroup(g, rows, opts.actingEmail ?? null);
      } catch (err) {
        g.error = err instanceof Error ? err.message : String(err);
        console.error(`[campaign-service] Sales funnel conversion failed for ${g.kind} group of offer ${g.offerId}: ${g.error}`);
      }
    }
  }

  const converted = groups.filter((g) => !g.skipped && !g.error && (opts.apply ? !!g.salesFunnelCampaignId : true));
  return {
    applied: opts.apply,
    groups,
    counts: {
      campaigns: rows.length,
      converted: converted.reduce((s, g) => s + g.campaignIds.length, 0),
      skipped: groups.filter((g) => g.skipped || g.error).reduce((s, g) => s + g.campaignIds.length, 0),
    },
  };
}

/**
 * The catalogue funnel STARTING at `pipe` whose every other leg is worked by NO platform pipe (the
 * customer's own team), so the funnel's pipes are exactly this one: never mix proactive and
 * reactive pipes (owner), and billing measures the funnel's spend on its pipes, so a funnel naming
 * another live pipe would count that pipe's spend twice. Sales paths are tried in the order given
 * (the offer's ticked one, then its best ROI ones), then any path; the catalogue lists by ROI.
 */
async function pureFunnelStartingAt(
  pipe: Row,
  salesPathIds: string[],
  operatorBySlug: ReadonlyMap<string, string>,
): Promise<{ ok: true; id: string; name: string } | { ok: false; reason: string }> {
  // A leg is "nobody on the platform" when it has no pipe, or its pipe's channel is one the
  // CUSTOMER operates (the channel catalogue's operator, e.g. your-team-meeting-attendance).
  const offPlatform = async (leg: { pipe: { id: string } | null }): Promise<boolean | null> => {
    if (leg.pipe === null) return true;
    const read = await fetchPipe(leg.pipe.id);
    if (!read.ok) return read.notFound ? false : null;
    return operatorBySlug.get(read.value.channelSlug) === "customer";
  };
  const pipeId = `${pipe.featureSlug}|${pipe.legKey}`;
  for (const pathId of [...salesPathIds, undefined]) {
    const found = await searchSalesFunnelIds(`${pipe.legKey}@${pipe.featureSlug}`, pipe.featureSlug!, pathId);
    if (!found.ok) return { ok: false, reason: `catalogue_unreadable: ${found.detail}` };
    for (const id of found.value) {
      const funnel = await fetchSalesFunnel(id);
      if (!funnel.ok) {
        if (!funnel.notFound) return { ok: false, reason: `catalogue_unreadable: ${funnel.detail}` };
        continue;
      }
      const [first, ...rest] = funnel.value.legs;
      if (first?.pipe?.id !== pipeId) continue;
      const verdicts = await Promise.all(rest.map(offPlatform));
      if (verdicts.some((v) => v === null)) return { ok: false, reason: "catalogue_unreadable: a pipe of the funnel could not be read" };
      if (verdicts.every((v) => v === true)) return { ok: true, id: funnel.value.id, name: funnel.value.name };
    }
  }
  return { ok: false, reason: "no_catalogue_funnel_with_only_this_pipe" };
}

/** The proactive funnel: the offer's ticked sales path starting with the pipe first, else best ROI. */
async function proactiveFunnelOf(
  pipe: Row,
  identity: { orgId: string; userId?: string; runId?: string; brandId: string },
  operatorBySlug: ReadonlyMap<string, string>,
): Promise<{ ok: true; id: string; name: string; basis: "selected_path" | "best_roi_path" } | { ok: false; reason: string }> {
  const [selected, paths] = await Promise.all([
    fetchOfferSelectedSalesPaths(pipe.offerId!, identity.brandId, identity),
    fetchOfferCatalogueSalesPaths(pipe.offerId!, identity.brandId, identity),
  ]);
  if (!paths.ok) return { ok: false, reason: `sales_paths_unreadable: ${paths.detail}` };
  const startsWithPipe = paths.value
    .filter((p) => p.legs[0] && p.legs[0].channelSlug === pipe.featureSlug && sameLeg(pipe.featureSlug, p.legs[0].legKey, pipe.legKey))
    .sort((a, b) => (b.roi ?? -Infinity) - (a.roi ?? -Infinity));
  const ticked = selected.ok && selected.value.combinationKeys
    ? new Set(selected.value.combinationKeys.map(combinationIdentity))
    : new Set<string>();
  const tickedPath = startsWithPipe.find((p) => ticked.has(combinationIdentity(p.combinationKey)));
  // A sales path's id is its legs in order (the catalogue's own spelling of a path).
  const pathIdOf = (p: (typeof startsWithPipe)[number]) => p.legs.map((l) => l.legKey).join("+");
  const ordered = [...new Set([...(tickedPath ? [pathIdOf(tickedPath)] : []), ...startsWithPipe.map(pathIdOf)])];
  const funnel = await pureFunnelStartingAt(pipe, ordered, operatorBySlug);
  if (!funnel.ok) return funnel;
  return { ...funnel, basis: tickedPath ? "selected_path" : "best_roi_path" };
}

/** The reactive funnel: the catalogue funnel starting at this reactive pipe and naming no other. */
async function reactiveFunnelOf(
  pipe: Row,
  operatorBySlug: ReadonlyMap<string, string>,
): Promise<{ ok: true; id: string; name: string } | { ok: false; reason: string }> {
  // The REACTIVE sales paths through this leg (the catalogue's served `type`): the funnel list is
  // ranked by ROI and capped at 25, so a reactive-only funnel is looked for on its own path first.
  const paths = await searchSalesPaths(pipe.legKey!);
  if (!paths.ok) return { ok: false, reason: `catalogue_unreadable: ${paths.detail}` };
  const reactivePathIds = paths.value.filter((p) => p.type === "reactive").map((p) => p.id);
  const funnel = await pureFunnelStartingAt(pipe, reactivePathIds, operatorBySlug);
  if (!funnel.ok && funnel.reason === "no_catalogue_funnel_with_only_this_pipe") {
    return { ok: false, reason: "no_reactive_funnel_in_catalogue" };
  }
  return funnel;
}

/**
 * billing v0.83.12 `PUT /internal/brands/:b/offers/:o/sales-funnels/:id/caps` {maxBudget, maxVolume,
 * replacesCeilings}: writes the cap AND deletes the named per-pipe ceilings atomically; 409 (nothing
 * written) when the cap/day differs from their sum, a named ceiling is missing, the brand runs on
 * one global sales budget, or the org is a subscriber.
 */
async function putCapReplacingCeilings(g: ConversionGroup, headers: Record<string, string>): Promise<void> {
  const url = process.env.BILLING_SERVICE_URL;
  const apiKey = process.env.BILLING_SERVICE_API_KEY;
  if (!url || !apiKey) throw new Error("billing-service not configured");
  const path =
    `/internal/brands/${encodeURIComponent(g.brandId)}/offers/${encodeURIComponent(g.offerId)}` +
    `/sales-funnels/${encodeURIComponent(g.salesFunnelId!)}/caps`;
  const res = await fetch(`${url.replace(/\/$/, "")}${path}`, {
    method: "PUT",
    headers: { "content-type": "application/json", "x-api-key": apiKey, ...headers },
    body: JSON.stringify({
      maxBudget: { amountCents: String(g.maxBudgetDailyCents), period: "daily" },
      maxVolume: null,
      replacesCeilings: g.ceilings
        .filter((c) => c.dailyBudgetCents > 0)
        .map((c) => ({ featureSlug: c.featureSlug, legKey: c.legKey })),
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`billing PUT ${path} answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

/**
 * One group, all or nothing: the funnel campaign and its units are written in a transaction that
 * also makes billing's atomic cap-for-ceilings swap, and commits only if billing said yes. So the
 * rows are units exactly when their money is the cap (no tick sees units without a cap, or pipes
 * without their ceilings, beyond the commit itself). A group funded at 0 has no cap to write: its
 * ceilings stay as they are (0), and its units stay unfunded, as the pipes were.
 */
async function applyGroup(g: ConversionGroup, rows: Row[], actingEmail: string | null): Promise<void> {
  const members = rows.filter((r) => g.campaignIds.includes(r.id));
  const owner = members.find((r) => r.createdByUserId && r.parentRunId) ?? members[0];
  const headers: Record<string, string> = {
    "x-org-id": g.orgId,
    ...(owner?.createdByUserId ? { "x-user-id": owner.createdByUserId } : {}),
    ...(actingEmail ? { "x-email": actingEmail } : {}),
  };
  const id = randomUUID();
  await db.transaction(async (tx) => {
    const now = new Date();
    await tx.insert(salesFunnelCampaigns).values({
      id,
      orgId: g.orgId,
      brandId: g.brandId,
      offerId: g.offerId,
      salesFunnelId: g.salesFunnelId!,
      salesFunnelName: g.salesFunnelName!,
      status: "ongoing",
      stopReason: null,
      createdByUserId: owner?.createdByUserId ?? null,
      parentRunId: owner?.parentRunId ?? null,
      createdAt: now,
      updatedAt: now,
    });
    const linked = await tx
      .update(campaigns)
      .set({ salesFunnelId: g.salesFunnelId!, salesFunnelCampaignId: id, updatedAt: now })
      .where(and(inArray(campaigns.id, g.campaignIds), eq(campaigns.status, "ongoing"), isNull(campaigns.salesFunnelCampaignId)))
      .returning({ id: campaigns.id });
    if (linked.length !== g.campaignIds.length) {
      throw new Error(`expected to link ${g.campaignIds.length} rows, linked ${linked.length} (a row moved meanwhile): rolled back`);
    }
    if (g.maxBudgetDailyCents !== null && g.maxBudgetDailyCents > 0) {
      await putCapReplacingCeilings(g, headers);
      g.capWritten = true;
    } else {
      g.capWritten = false;
    }
  });
  g.salesFunnelCampaignId = id;
}
