import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { campaigns, salesFunnelCampaigns } from "../db/schema.js";
import { fetchChannelCatalogue, type ChannelCatalogueRead, type CatalogueLeg } from "./channel-operator-client.js";
import { fetchOfferName, type OfferNameRead } from "./brand-offers-client.js";
import { targetLabelOf } from "./target-only-campaign.js";

/**
 * EVERY CAMPAIGN IS BORN WITH A BRIEF (2026-11-11, CAMPAIGN-BORN-WITH-BRIEF-1111).
 *
 * The strategy judge (features-service) reads a campaign's brief to pick, per Engine, the tactics to keep, and every
 * run's LLM steps read it too (ONE-BRIEF-1105). A campaign born with NO brief gives them nothing (prod 2026-11-11:
 * 3cfc2aaa, an onboarding launch through the API with no brief; 6ad3483c, a Copilot launch). So a launch that states
 * no brief is born with one written from what its client ALREADY stated, read from the producers that hold it:
 *   - its TARGET: the outcome's label as features-service publishes it ("Paid client"), never its key;
 *   - its OFFER: the name the (org, brand) gave it at brand-service;
 *   - its CHANNELS: the name of every channel its units run (features-service's), in leg order, as the line features-service's
 *     own prefill wrote ("Use only these channels:", FACTORY-P1-BRIEF-PREFILL), so the judge keeps it on them. A campaign
 *     on its target alone (its Engine, no channel) names none.
 * ONE rule for every campaign, never a branch on an outcome, channel or caller. A stated brief is never touched.
 *
 * A source that cannot be read at birth never blocks the launch: the campaign is born without, `console.error`, and the
 * REPAIR (same composer) fills it: at boot, every 10 min, and on `POST /internal/sales-funnel-campaigns/brief-repair`. It
 * only fills a brief nobody ever stated nor cleared (`brief IS NULL AND brief_updated_at IS NULL`): a person who cleared
 * their brief keeps it cleared.
 */

/** No em or en dash in client copy (owner rule): a dash between words becomes a comma. */
const withoutDashes = (text: string): string => text.replace(/\s*[—–]\s*/g, ", ");

/** PURE: the brief a campaign is born with. */
export function composeBirthBrief(input: { targetLabel: string; offerName: string; channelNames: readonly string[] }): string {
  const lines = [`Goal: ${input.targetLabel} for ${input.offerName}.`];
  if (input.channelNames.length > 0) lines.push(`Use only these channels: ${input.channelNames.join(", ")}.`);
  return withoutDashes(lines.join("\n"));
}

/**
 * PURE: the channel slugs of a campaign's units in LEG order (a leg from Start first, then the leg leaving the step the
 * previous one reached), each once. Steps come from the catalogue's leg vocabulary, never parsed off a key; a unit whose
 * leg the catalogue does not place keeps its stored order after the placed ones.
 */
export function channelSlugsInLegOrder(
  units: ReadonlyArray<{ featureSlug: string | null; legKey: string | null }>,
  legs: readonly CatalogueLeg[],
): string[] {
  const legOf = new Map(legs.map((l) => [l.legKey, l]));
  const depth = new Map<string, number>();
  let frontier: Array<string | null> = [null];
  for (let d = 0; d < units.length && frontier.length > 0; d++) {
    const next: Array<string | null> = [];
    for (const u of units) {
      const leg = u.legKey ? legOf.get(u.legKey) : undefined;
      if (!u.legKey || !leg || depth.has(u.legKey) || !frontier.includes(leg.fromStepKey)) continue;
      depth.set(u.legKey, d);
      next.push(leg.toStepKey);
    }
    frontier = next;
  }
  const order = (u: { legKey: string | null }) => (u.legKey && depth.has(u.legKey) ? depth.get(u.legKey)! : Number.MAX_SAFE_INTEGER);
  const sorted = units.map((u, i) => ({ u, i })).sort((a, b) => order(a.u) - order(b.u) || a.i - b.i);
  return [...new Set(sorted.map(({ u }) => u.featureSlug).filter((s): s is string => !!s))];
}

export type BirthBriefRead =
  | { ok: true; brief: string }
  | { ok: false; reason: "no_target" | "target_label_missing" | "channel_name_missing" | "catalogue_unavailable" | "offer_not_found" | "offer_unavailable"; detail: string };

export interface BirthBriefDeps {
  catalogue?: () => Promise<ChannelCatalogueRead>;
  offerName?: typeof fetchOfferName;
}

/** The brief a campaign is born with, read from what its client stated (see the module header). */
export async function birthBriefFor(
  campaign: {
    orgId: string;
    brandId: string;
    offerId: string;
    target: string | null;
    units: ReadonlyArray<{ featureSlug: string | null; legKey: string | null }>;
  },
  identity: { userId?: string | null; runId?: string | null },
  deps: BirthBriefDeps = {},
): Promise<BirthBriefRead> {
  if (!campaign.target) return { ok: false, reason: "no_target", detail: "the campaign states no target" };
  const catalogue = await (deps.catalogue ?? fetchChannelCatalogue)();
  if (!catalogue.ok) return { ok: false, reason: "catalogue_unavailable", detail: catalogue.detail };
  const targetLabel = targetLabelOf(catalogue, campaign.target);
  if (!targetLabel) return { ok: false, reason: "target_label_missing", detail: `the catalogue publishes no label for ${campaign.target}` };
  const slugs = channelSlugsInLegOrder(campaign.units, catalogue.legs);
  const unnamed = slugs.filter((s) => !catalogue.nameBySlug?.get(s));
  if (unnamed.length > 0) return { ok: false, reason: "channel_name_missing", detail: `the catalogue publishes no name for ${unnamed.join(", ")}` };
  const offer: OfferNameRead = await (deps.offerName ?? fetchOfferName)(campaign.brandId, campaign.offerId, {
    orgId: campaign.orgId,
    userId: identity.userId,
    runId: identity.runId,
  });
  if (!offer.ok) return { ok: false, reason: offer.reason === "offer_not_found" ? "offer_not_found" : "offer_unavailable", detail: offer.detail };
  return { ok: true, brief: composeBirthBrief({ targetLabel, offerName: offer.name, channelNames: slugs.map((s) => catalogue.nameBySlug!.get(s)!) }) };
}

// ── Repair: a campaign born without one (a source unreadable at birth, or born before this rule) ─────────────────────

export interface BriefRepairRow {
  salesFunnelCampaignId: string;
  orgId: string;
  outcome: "written" | "would_write" | "skipped";
  brief: string | null;
  reason: Extract<BirthBriefRead, { ok: false }>["reason"] | "brief_stated_meanwhile" | null;
  detail: string | null;
}

/**
 * Every funnel campaign whose brief nobody ever stated nor cleared gets the brief it would be born with now. Dry run
 * unless `apply`; idempotent; the write is guarded on the same condition (a brief stated meanwhile is never overwritten).
 */
export async function repairMissingBriefs(input: { apply: boolean; orgId?: string }, deps: BirthBriefDeps = {}): Promise<{ scanned: number; rows: BriefRepairRow[] }> {
  const never = and(isNull(salesFunnelCampaigns.brief), isNull(salesFunnelCampaigns.briefUpdatedAt));
  const rows = await db
    .select({
      id: salesFunnelCampaigns.id,
      orgId: salesFunnelCampaigns.orgId,
      brandId: salesFunnelCampaigns.brandId,
      offerId: salesFunnelCampaigns.offerId,
      target: salesFunnelCampaigns.target,
      createdByUserId: salesFunnelCampaigns.createdByUserId,
    })
    .from(salesFunnelCampaigns)
    .where(input.orgId ? and(never, eq(salesFunnelCampaigns.orgId, input.orgId)) : never)
    .orderBy(asc(salesFunnelCampaigns.createdAt));
  if (rows.length === 0) return { scanned: 0, rows: [] };

  const unitRows = await db
    .select({ parent: campaigns.salesFunnelCampaignId, featureSlug: campaigns.featureSlug, legKey: campaigns.legKey })
    .from(campaigns)
    .where(inArray(campaigns.salesFunnelCampaignId, rows.map((r) => r.id)))
    .orderBy(asc(campaigns.createdAt), asc(campaigns.id));
  const unitsOf = new Map<string, Array<{ featureSlug: string | null; legKey: string | null }>>();
  for (const u of unitRows) unitsOf.set(u.parent!, [...(unitsOf.get(u.parent!) ?? []), { featureSlug: u.featureSlug, legKey: u.legKey }]);

  const out: BriefRepairRow[] = [];
  for (const r of rows) {
    const base = { salesFunnelCampaignId: r.id, orgId: r.orgId };
    const read = await birthBriefFor({ ...r, units: unitsOf.get(r.id) ?? [] }, { userId: r.createdByUserId }, deps);
    if (!read.ok) {
      out.push({ ...base, outcome: "skipped", brief: null, reason: read.reason, detail: read.detail });
      continue;
    }
    if (!input.apply) {
      out.push({ ...base, outcome: "would_write", brief: read.brief, reason: null, detail: null });
      continue;
    }
    const written = await db
      .update(salesFunnelCampaigns)
      .set({ brief: read.brief, briefUpdatedAt: new Date(), briefUpdatedByUserId: null, updatedAt: new Date() })
      .where(and(eq(salesFunnelCampaigns.id, r.id), never))
      .returning({ id: salesFunnelCampaigns.id });
    out.push(
      written.length > 0
        ? { ...base, outcome: "written", brief: read.brief, reason: null, detail: null }
        : { ...base, outcome: "skipped", brief: null, reason: "brief_stated_meanwhile", detail: null },
    );
  }
  return { scanned: rows.length, rows: out };
}

/** A state the catalogue or the client never gave (no target, an unnamed offer) is known, said at info; an unreadable source is the anomaly. */
const UNREADABLE: ReadonlySet<BriefRepairRow["reason"]> = new Set(["catalogue_unavailable", "offer_unavailable"]);

export async function runBriefRepairPass(): Promise<void> {
  const report = await repairMissingBriefs({ apply: true });
  const written = report.rows.filter((r) => r.outcome === "written");
  for (const r of written) console.log(`[campaign-service] Funnel campaign ${r.salesFunnelCampaignId} given its birth brief`);
  for (const r of report.rows.filter((r) => UNREADABLE.has(r.reason))) {
    console.error(`[campaign-service] Funnel campaign ${r.salesFunnelCampaignId} still has no brief: ${r.reason} (${r.detail})`);
  }
}

const BRIEF_REPAIR_FIRST_TICK_MS = 60_000;
export const BRIEF_REPAIR_INTERVAL_MS = 10 * 60_000;

/** Boot (~60 s after) then every 10 min, one pass at a time. */
export function startBriefRepair(): () => void {
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    void runBriefRepairPass()
      .catch((err) => console.error("[campaign-service] brief repair pass error:", err))
      .finally(() => {
        running = false;
      });
  };
  let interval: ReturnType<typeof setInterval> | null = null;
  const first = setTimeout(() => {
    tick();
    interval = setInterval(tick, BRIEF_REPAIR_INTERVAL_MS);
  }, BRIEF_REPAIR_FIRST_TICK_MS);
  return () => {
    clearTimeout(first);
    if (interval) clearInterval(interval);
  };
}
