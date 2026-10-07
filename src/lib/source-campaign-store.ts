import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { getStatsBudget } from "@distribute/runs-client";
import { db } from "../db/index.js";
import { campaigns, campaignStatusTransitions } from "../db/schema.js";
import { fetchChannelCatalogue, type ChannelCatalogueRead } from "./channel-operator-client.js";
import { campaignIdentityColumns, derivedCampaignName } from "./campaign-identity.js";
import { campaignBirthTransition, TRANSITION_SOURCES, type DbTransaction } from "./campaign-status-history.js";
import { isEntryLeg } from "./single-proactive.js";
import { STOP_REASONS } from "./stop-reason.js";
import {
  DEFAULT_SOURCE_ORIGIN_BY_CHANNEL,
  LIVE_SOURCE_ORIGIN_SLUGS,
  RETIRED_SOURCE_ORIGIN_SLUGS,
  SOURCE_LEG_KEY,
  SOURCING_ORIGINS_BY_CHANNEL,
  isLiveSourceOrigin,
  isSourcedChannel,
  sourceCampaignKey,
} from "./source-campaigns.js";

/**
 * Reads and writes of SOURCE CAMPAIGNS (rules in lib/source-campaigns.ts).
 *
 * Everything here keys on (org, brand, offer): a source campaign belongs to the offer it finds leads
 * for, and an outreach campaign is fed by the source campaigns of ITS offer whose origin serves its
 * channel (SOURCING_ORIGINS_BY_CHANNEL).
 */

type CampaignRow = typeof campaigns.$inferSelect;

const ALL_ORIGINS: string[] = [...LIVE_SOURCE_ORIGIN_SLUGS, ...RETIRED_SOURCE_ORIGIN_SLUGS];

function brandOf(c: Pick<CampaignRow, "brandId" | "brandIds">): string | null {
  return c.brandId ?? (c.brandIds?.length === 1 ? c.brandIds[0] : null);
}

export interface FeedingSourceCampaign {
  id: string;
  featureSlug: string;
  status: string;
}

/**
 * The source campaigns that feed one OUTREACH campaign: same org, brand and offer, an origin that
 * serves the outreach channel, any status (a source stopped at noon still spent this morning).
 * [] when the campaign is not an outreach campaign of a sourced channel or states no offer.
 */
export async function sourceCampaignsFeeding(campaignId: string, featureSlug: string): Promise<FeedingSourceCampaign[]> {
  const origins = SOURCING_ORIGINS_BY_CHANNEL[featureSlug];
  if (!origins || origins.length === 0) return [];
  const outreach = await db.query.campaigns.findFirst({ where: eq(campaigns.id, campaignId) });
  if (!outreach || !outreach.offerId) return [];
  const brandId = brandOf(outreach);
  if (!brandId) return [];
  const rows = await db
    .select({ id: campaigns.id, featureSlug: campaigns.featureSlug, status: campaigns.status })
    .from(campaigns)
    .where(
      and(
        eq(campaigns.orgId, outreach.orgId),
        eq(campaigns.brandId, brandId),
        eq(campaigns.offerId, outreach.offerId),
        eq(campaigns.legKey, SOURCE_LEG_KEY),
        inArray(campaigns.featureSlug, [...origins]),
      ),
    );
  return rows.map((r) => ({ id: r.id, featureSlug: r.featureSlug!, status: r.status }));
}

/** One origin of an offer, as served to the dashboard and to sibling services. */
export interface OfferSourceCampaign {
  featureSlug: string;
  legKey: typeof SOURCE_LEG_KEY;
  /** features-service's row key (`campaign:<origin>|start_to_lead_found`). */
  campaignKey: string;
  /** False for a retired origin (listed only when the offer has a row on it). */
  live: boolean;
  /** null = no campaign yet: the origin is OFF and its first On creates it. */
  campaignId: string | null;
  name: string | null;
  /** `ongoing` | `stopped`, or null when no campaign exists yet (= off). */
  status: string | null;
  running: boolean;
  stopReason: string | null;
}

/**
 * Every origin of an offer with its campaign, live origins always listed (absent = OFF), retired
 * ones only when the offer has a row. When an origin has several rows (history), the live one wins,
 * else the latest.
 */
export async function listOfferSourceCampaigns(scope: {
  orgId: string;
  brandId: string;
  offerId: string;
}): Promise<OfferSourceCampaign[]> {
  const rows = await db
    .select()
    .from(campaigns)
    .where(
      and(
        eq(campaigns.orgId, scope.orgId),
        eq(campaigns.brandId, scope.brandId),
        eq(campaigns.offerId, scope.offerId),
        eq(campaigns.legKey, SOURCE_LEG_KEY),
        inArray(campaigns.featureSlug, ALL_ORIGINS),
      ),
    );
  const byOrigin = new Map<string, CampaignRow>();
  for (const r of rows) {
    const cur = byOrigin.get(r.featureSlug!);
    const better =
      !cur ||
      (r.status === "ongoing" && cur.status !== "ongoing") ||
      (r.status === cur.status && (r.createdAt?.getTime() ?? 0) > (cur.createdAt?.getTime() ?? 0));
    if (better) byOrigin.set(r.featureSlug!, r);
  }
  return ALL_ORIGINS.filter((o) => isLiveSourceOrigin(o) || byOrigin.has(o)).map((origin) => {
    const c = byOrigin.get(origin) ?? null;
    return {
      featureSlug: origin,
      legKey: SOURCE_LEG_KEY,
      campaignKey: sourceCampaignKey(origin),
      live: isLiveSourceOrigin(origin),
      campaignId: c?.id ?? null,
      name: c?.name ?? null,
      status: c?.status ?? null,
      running: c?.status === "ongoing",
      stopReason: c?.stopReason ?? null,
    };
  });
}

/** The row a source campaign is born as. No workflow, never scheduled. */
function sourceCampaignValues(input: {
  orgId: string;
  brandId: string;
  offerId: string;
  origin: string;
  status: "ongoing" | "stopped";
  stopReason: string | null;
  createdByUserId: string | null;
  parentRunId: string | null;
}) {
  const now = new Date();
  return {
    ...campaignIdentityColumns({ brandIds: [input.brandId], featureSlug: input.origin }),
    orgId: input.orgId,
    createdByUserId: input.createdByUserId,
    parentRunId: input.parentRunId,
    name: derivedCampaignName(input.origin, input.brandId, input.offerId, SOURCE_LEG_KEY),
    workflowSlug: null,
    brandIds: [input.brandId],
    featureSlug: input.origin,
    offerId: input.offerId,
    legKey: SOURCE_LEG_KEY,
    featureInputs: null,
    status: input.status,
    stopReason: input.status === "stopped" ? input.stopReason : null,
    nextRunAt: null,
    updatedAt: now,
  };
}

/**
 * A PERSON turned ON an outreach campaign of a sourced channel on an ENTRY leg, and its offer has
 * NO source campaign at all (none ever, any origin, any status): the channel's default origin is
 * born ON in the same transaction, so a brand-new offer finds leads exactly as before sources were
 * campaigns. An offer that has any source row is left alone: a person's Off stays off.
 *
 * Never reached by a tick. The catalogue is read only when a source would be created; unreadable =
 * nothing created, logged loud (a start is never refused for this).
 */
export async function ensureDefaultSourceOnStart(
  tx: DbTransaction,
  started: CampaignRow,
  deps: { catalogue?: () => Promise<ChannelCatalogueRead> } = {},
): Promise<CampaignRow | null> {
  if (started.status !== "ongoing" || !isSourcedChannel(started.featureSlug)) return null;
  const brandId = brandOf(started);
  if (!started.offerId || !started.legKey || !brandId) return null;
  const origin = DEFAULT_SOURCE_ORIGIN_BY_CHANNEL[started.featureSlug!];
  if (!origin) return null;

  const existing = await tx
    .select({ id: campaigns.id })
    .from(campaigns)
    .where(
      and(
        eq(campaigns.orgId, started.orgId),
        eq(campaigns.brandId, brandId),
        eq(campaigns.offerId, started.offerId),
        eq(campaigns.legKey, SOURCE_LEG_KEY),
        inArray(campaigns.featureSlug, ALL_ORIGINS),
      ),
    )
    .limit(1);
  if (existing.length > 0) return null;

  const catalogue = await (deps.catalogue ?? fetchChannelCatalogue)();
  if (!catalogue.ok) {
    console.error(
      `[campaign-service] Default source campaign NOT created for offer ${started.offerId} (campaign ${started.id} started): catalogue unreadable (${catalogue.detail})`,
    );
    return null;
  }
  if (!isEntryLeg(catalogue, started.legKey)) return null;

  const [inserted] = await tx
    .insert(campaigns)
    .values(
      sourceCampaignValues({
        orgId: started.orgId,
        brandId,
        offerId: started.offerId,
        origin,
        status: "ongoing",
        stopReason: null,
        createdByUserId: started.createdByUserId ?? null,
        parentRunId: started.parentRunId ?? null,
      }),
    )
    .returning();
  await tx
    .insert(campaignStatusTransitions)
    .values(campaignBirthTransition(inserted.id, inserted.orgId, inserted.status, TRANSITION_SOURCES.SOURCE_DEFAULT));
  console.log(
    `[campaign-service] Default source campaign ${inserted.id} (${origin}) born ON for offer ${started.offerId} with campaign ${started.id}`,
  );
  return inserted;
}

// === Migration of today's state ===

/** How far back a sourcing spend counts as "this offer finds leads from that origin today". */
export const OBSERVED_SOURCING_WINDOW_MS = 14 * 24 * 60 * 60_000;

export interface MirrorPlanItem {
  orgId: string;
  brandId: string;
  offerId: string;
  featureSlug: string;
  status: "ongoing" | "stopped";
  stopReason: string | null;
  /** `default` = the channel's origin before sources existed; `observed` = it spent in the window. */
  basis: "default" | "observed";
  /** The outreach campaigns whose state it mirrors. */
  mirrors: string[];
  campaignId?: string;
}

export interface MirrorResult {
  applied: boolean;
  offers: number;
  plan: MirrorPlanItem[];
  alreadyPresent: number;
  counts: { ongoing: number; stopped: number; observed: number };
}

export class MirrorCatalogueUnavailableError extends Error {}

/**
 * MIGRATION OF TODAY'S STATE (owner 2026-10-07): every offer whose outreach campaign of a sourced
 * channel exists on an ENTRY leg gets the source campaigns it finds leads from today, each MIRRORING
 * the outreach campaign's status, so nothing the customer sees changes and nothing stops finding
 * leads:
 *   - the channel's default origin (Apollo Cold Filters for cold email, Your CRM Contacts for CRM);
 *   - any other live origin that spent under one of the offer's outreach campaigns in the last 14
 *     days (lead-serve runs labelled with the origin's slug, runs-service budget read).
 * Status: ON iff an outreach campaign of the offer that this origin serves is ON; else OFF with that
 * campaign's own stop reason. Never starts spend that was not running.
 *
 * Idempotent: an origin that already has a row on the offer is never touched. Dry run unless
 * `apply`. Re-runnable. Exposed as `POST /internal/source-campaigns/mirror`.
 */
export async function mirrorSourceCampaigns(
  opts: { apply: boolean; now?: Date },
  deps: {
    catalogue?: () => Promise<ChannelCatalogueRead>;
    observed?: (c: { orgId: string; campaignId: string }, origin: string, since: Date) => Promise<boolean>;
  } = {},
): Promise<MirrorResult> {
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - OBSERVED_SOURCING_WINDOW_MS);
  const observed = deps.observed ?? observedSourcing;

  const outreach = await db
    .select()
    .from(campaigns)
    .where(
      and(
        inArray(campaigns.featureSlug, Object.keys(SOURCING_ORIGINS_BY_CHANNEL)),
        isNotNull(campaigns.offerId),
        isNotNull(campaigns.legKey),
      ),
    );
  if (outreach.length === 0) return { applied: opts.apply, offers: 0, plan: [], alreadyPresent: 0, counts: { ongoing: 0, stopped: 0, observed: 0 } };

  const catalogue = await (deps.catalogue ?? fetchChannelCatalogue)();
  if (!catalogue.ok) throw new MirrorCatalogueUnavailableError(catalogue.detail);

  const groups = new Map<string, { orgId: string; brandId: string; offerId: string; rows: CampaignRow[] }>();
  for (const c of outreach) {
    const brandId = brandOf(c);
    if (!brandId || !isEntryLeg(catalogue, c.legKey!)) continue;
    const key = `${c.orgId}|${brandId}|${c.offerId}`;
    const g = groups.get(key) ?? { orgId: c.orgId, brandId, offerId: c.offerId!, rows: [] };
    g.rows.push(c);
    groups.set(key, g);
  }

  const existing = groups.size === 0 ? [] : await db
    .select({ orgId: campaigns.orgId, brandId: campaigns.brandId, offerId: campaigns.offerId, featureSlug: campaigns.featureSlug })
    .from(campaigns)
    .where(and(eq(campaigns.legKey, SOURCE_LEG_KEY), inArray(campaigns.featureSlug, ALL_ORIGINS)));
  const present = new Set(existing.map((e) => `${e.orgId}|${e.brandId}|${e.offerId}|${e.featureSlug}`));

  const plan: MirrorPlanItem[] = [];
  let alreadyPresent = 0;
  for (const g of groups.values()) {
    const origins = new Map<string, "default" | "observed">();
    for (const c of g.rows) {
      const d = DEFAULT_SOURCE_ORIGIN_BY_CHANNEL[c.featureSlug!];
      if (d) origins.set(d, "default");
    }
    // Only a campaign that could have run in the window is asked.
    const recent = g.rows.filter((c) => c.status === "ongoing" || (c.updatedAt?.getTime() ?? 0) >= since.getTime());
    for (const c of recent) {
      for (const origin of SOURCING_ORIGINS_BY_CHANNEL[c.featureSlug!] ?? []) {
        if (!isLiveSourceOrigin(origin) || origins.has(origin)) continue;
        if (await observed({ orgId: c.orgId, campaignId: c.id }, origin, since)) origins.set(origin, "observed");
      }
    }
    for (const [origin, basis] of origins) {
      if (present.has(`${g.orgId}|${g.brandId}|${g.offerId}|${origin}`)) {
        alreadyPresent++;
        continue;
      }
      const served = g.rows.filter((c) => (SOURCING_ORIGINS_BY_CHANNEL[c.featureSlug!] ?? []).includes(origin));
      const live = served.filter((c) => c.status === "ongoing");
      const latest = [...served].sort((a, b) => (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0))[0];
      plan.push({
        orgId: g.orgId,
        brandId: g.brandId,
        offerId: g.offerId,
        featureSlug: origin,
        status: live.length > 0 ? "ongoing" : "stopped",
        stopReason: live.length > 0 ? null : (latest?.stopReason ?? STOP_REASONS.MANUAL),
        basis,
        mirrors: (live.length > 0 ? live : latest ? [latest] : []).map((c) => c.id),
      });
    }
  }

  if (opts.apply) {
    for (const item of plan) {
      const first = groups.get(`${item.orgId}|${item.brandId}|${item.offerId}`)!.rows.find((c) => c.id === item.mirrors[0]);
      await db.transaction(async (tx) => {
        const [inserted] = await tx
          .insert(campaigns)
          .values(
            sourceCampaignValues({
              orgId: item.orgId,
              brandId: item.brandId,
              offerId: item.offerId,
              origin: item.featureSlug,
              status: item.status,
              stopReason: item.stopReason,
              createdByUserId: first?.createdByUserId ?? null,
              parentRunId: first?.parentRunId ?? null,
            }),
          )
          .returning();
        await tx
          .insert(campaignStatusTransitions)
          .values({
            ...campaignBirthTransition(inserted.id, inserted.orgId, inserted.status, TRANSITION_SOURCES.SOURCE_MIRROR),
            reason: inserted.stopReason ?? null,
          });
        item.campaignId = inserted.id;
      });
    }
  }

  return {
    applied: opts.apply,
    offers: groups.size,
    plan,
    alreadyPresent,
    counts: {
      ongoing: plan.filter((p) => p.status === "ongoing").length,
      stopped: plan.filter((p) => p.status === "stopped").length,
      observed: plan.filter((p) => p.basis === "observed").length,
    },
  };
}

/** Did this outreach campaign spend under `origin` since `since`? A failed read throws (fail loud). */
async function observedSourcing(c: { orgId: string; campaignId: string }, origin: string, since: Date): Promise<boolean> {
  const r = await getStatsBudget({
    orgId: c.orgId,
    campaignId: c.campaignId,
    featureSlug: origin,
    windows: [{ label: "window", since: since.toISOString() }],
  });
  const w = r.windows.find((x) => x.label === "window");
  return !!w && (parseFloat(w.totalCostInUsdCents) || 0) > 0;
}
