import { and, arrayContains, desc, eq } from "drizzle-orm";
import { getStatsBudget, listRuns, type IdentityHeaders } from "@distribute/runs-client";
import { db } from "../db/index.js";
import { campaigns } from "../db/schema.js";
import { fetchFunnelBudgets, fundedFunnels, type FunnelBudget } from "./funnel-budget-client.js";
import { fetchDeclaredSalesFunnels, type DeclaredSalesFunnel } from "./brand-sales-funnels-client.js";
import { isSalesOutreachFeature } from "./sales-outreach-campaign.js";
import { toFunnelKey } from "./sales-funnel-vocabulary.js";
import { campaignIdentityColumns } from "./campaign-identity.js";

// A campaign that did not get this brand's turn re-checks on the next active tick. The turn is
// re-ranked from scratch every tick, so this is a "wait your turn", not a backoff. EVERY alive
// campaign of the brand is in the running every tick: none is ever held out because another one
// covers its funnel.
export const FUNNEL_TURN_DEFER_MS = 60_000; // 1 min

/**
 * The campaign columns the turn planner reads. Structurally a subset of what the scheduler's
 * claim already returns, so the planner never needs its own query.
 */
export interface ClaimedFunnelCampaign {
  id: string;
  orgId: string;
  createdByUserId: string | null;
  workflowSlug: string;
  brandIds: string[] | null;
  featureSlug: string | null;
  funnelKey: string | null;
}

/** One funnel campaign in the running to take the brand's next turn. */
export interface FunnelTurnCandidate {
  campaignId: string;
  funnelKey: string;
  /** Committed spend today for THIS campaign — i.e. for this funnel — in cents. */
  spentCents: number;
  /** This funnel's own daily ceiling, in cents. Always > 0 (a zero ceiling is not funded). */
  ceilingCents: number;
}

/**
 * Which funded funnel goes next: the one with the lowest ratio of what it has already spent
 * today to what it is allowed to spend today.
 *
 * NOT a fixed order and NOT "the primary funnel first". A fixed order starves whatever sits
 * last — if the first funnel can absorb the whole day, the others never run, and that shows up
 * in no log at all, only in a funnel that mysteriously never spends. Ranking on the ratio fills
 * every funnel at the same pace RELATIVE to what it can absorb, and a funnel at its ceiling
 * yields its turn with no special case: its ratio is >= 1, so it is simply not a candidate.
 *
 * Returns null when every funded funnel is at its ceiling — nothing runs until they reset.
 * Ties break on funnelKey so the choice is deterministic rather than insertion-ordered.
 */
export function selectLowestFillRatio(candidates: FunnelTurnCandidate[]): string | null {
  let bestId: string | null = null;
  let bestRatio = Infinity;
  let bestKey = "";

  for (const c of candidates) {
    if (!(c.ceilingCents > 0)) continue; // not funded — never run
    const ratio = c.spentCents / c.ceilingCents;
    if (ratio >= 1) continue; // at its ceiling: stops and yields to another funded funnel
    if (ratio < bestRatio || (ratio === bestRatio && c.funnelKey < bestKey)) {
      bestRatio = ratio;
      bestKey = c.funnelKey;
      bestId = c.campaignId;
    }
  }

  return bestId;
}

/**
 * Plan which of the claimed campaigns may fire this tick.
 *
 * Returns the campaigns that must NOT fire, each with the time it should be re-checked. A
 * campaign absent from the map fires — so every non-sales campaign, and every brand with no
 * per-funnel funding, is untouched and behaves exactly as it does today.
 *
 * Three things happen per brand, in this order:
 *   1. Provision — every funded funnel of the brand gets its own campaign (created on the spot,
 *      due immediately, so the next tick can claim it).
 *   2. Serialize — at most ONE run in flight per brand ACROSS ITS SALES CAMPAIGNS. This is the
 *      deliberate constraint that keeps funnels from running concurrently; removing it is what
 *      unlocks parallelism later, and nothing else has to be undone for that. It is not a lock:
 *      the same runs-service liveness read the per-campaign guard already uses, asked of each of
 *      the brand's sales campaigns. It deliberately does NOT count the brand's PR / AI-visibility
 *      / hiring / VC runs — those share neither leads nor sending accounts, and counting them
 *      stopped a brand's sales outreach outright (see hasLiveSalesRunForBrand).
 *   3. Rank — the funded funnel with the lowest spent/ceiling ratio takes the turn.
 *
 * Fail-SOFT throughout: any unreadable budget, funnel set or spend leaves the brand on today's
 * behaviour rather than blocking it. The per-funnel CEILING is enforced fail-CLOSED in
 * gate-check, which is where spend control belongs — this is turn-taking, an optimization.
 */
export async function planFunnelTurns(
  claimed: ClaimedFunnelCampaign[],
  now: Date = new Date(),
): Promise<Map<string, Date>> {
  const deferred = new Map<string, Date>();

  // Only the sales-outreach family funds per funnel. Everything else keeps its own pacing and
  // its own per-campaign serialization, untouched.
  const groups = new Map<string, ClaimedFunnelCampaign[]>();
  for (const c of claimed) {
    if (!isSalesOutreachFeature(c.featureSlug)) continue;
    const brandId = c.brandIds?.[0];
    if (!brandId) continue;
    const key = `${c.orgId}::${brandId}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(c);
    else groups.set(key, [c]);
  }

  for (const group of groups.values()) {
    try {
      await planOneBrand(group, now, deferred);
    } catch (err) {
      // A planning failure must never strand a brand: leave the group to fire on today's
      // behaviour (per-campaign serialization + the gate's own ceiling enforcement).
      console.warn(`[campaign-service] funnel turn planning failed for campaign ${group[0]?.id}:`, err);
    }
  }

  return deferred;
}

async function planOneBrand(
  group: ClaimedFunnelCampaign[],
  now: Date,
  deferred: Map<string, Date>,
): Promise<void> {
  const seed = group[0];
  const orgId = seed.orgId;
  const brandId = seed.brandIds![0];
  const featureSlug = seed.featureSlug!;

  const identity: IdentityHeaders = {
    orgId,
    userId: seed.createdByUserId ?? undefined,
    campaignId: seed.id,
    brandId,
    workflowSlug: seed.workflowSlug,
  };

  const budgets = await fetchFunnelBudgets(brandId, identity);
  // Unreadable ceilings → today's behaviour. gate-check fail-closes on the same read, so an
  // outage cannot turn into overspend; it just cannot improve turn-taking either.
  if (!budgets.ok) return;

  const funded = fundedFunnels(budgets);
  // A brand that has never set per-funnel ceilings behaves EXACTLY as it does today: billing
  // still answers its brand-level budget and the pre-funnel campaign paces on it.
  if (funded.length === 0) return;

  const declared = await fetchDeclaredSalesFunnels(brandId, identity);
  await ensureFundedFunnelCampaigns({ seed, brandId, featureSlug, funded, declared, now });

  // Serial, for now: at most one SALES run in flight per brand. Running funnels concurrently needs
  // an audit of lead de-duplication and of sending-account load that nobody has done, so it is
  // deliberately out of scope — delete this block and the funnels run in parallel.
  if (await hasLiveSalesRunForBrand(orgId, brandId, now)) {
    for (const c of group) deferred.set(c.id, new Date(now.getTime() + FUNNEL_TURN_DEFER_MS));
    return;
  }

  const ceilingByFunnel = new Map(funded.map((f) => [f.funnelKey, f.dailyBudgetCents]));

  // The ceiling a campaign that states no funnel is paced on: the brand-level daily budget,
  // which is exactly what gate-check enforces for it. Billing answers that total as the SUM of
  // the per-funnel ceilings, so the sum is the honest stand-in when the total cannot be read.
  const brandCeilingCents =
    budgets.brandDailyBudgetCents ?? funded.reduce((sum, f) => sum + f.dailyBudgetCents, 0);

  // EVERY alive campaign of the brand is in the running, every tick. There is no campaign held
  // out because another one covers its funnel: each is ranked on what IT has already spent today
  // against the ceiling that actually binds IT, so nothing starves and nothing overspends.
  const candidates: FunnelTurnCandidate[] = [];
  for (const c of group) {
    // A row written before the rename still carries the pre-rename spelling until migration 0043
    // reaches it — and a mixed fleet must rank on one vocabulary or a funnel silently loses its
    // ceiling and never takes a turn.
    const canonical = toFunnelKey(c.funnelKey);
    candidates.push({
      campaignId: c.id,
      funnelKey: canonical ?? "",
      spentCents: await spentTodayCents(orgId, c.id, featureSlug),
      // A campaign on a funnel the customer does not fund gets a zero ceiling and yields its
      // turn — that is the customer's funding decision, enforced fail-closed in the gate, and
      // it re-checks every tick because funding can change at any minute.
      ceilingCents: canonical ? (ceilingByFunnel.get(canonical) ?? 0) : brandCeilingCents,
    });
  }

  const winner = selectLowestFillRatio(candidates);
  // Every funded funnel is at its ceiling — nothing runs until they reset at the day rollover.
  const reset = winner === null ? nextDayStart(now) : null;

  for (const c of candidates) {
    if (c.campaignId === winner) continue;
    const at =
      reset && c.ceilingCents > 0 ? reset : new Date(now.getTime() + FUNNEL_TURN_DEFER_MS);
    deferred.set(c.campaignId, at);
  }
}

/**
 * Make sure every funded funnel of the brand HAS a campaign.
 *
 * The campaign STATES its funnel, and that statement is the whole vocabulary for what it sells.
 * Nothing here reads a goal to work out which funnel an existing campaign is on: every campaign
 * states its funnel from birth (creation refuses a sales campaign that does not), so there is
 * nothing left to attribute and nothing that can be unattributable. A brand that funds a funnel
 * gets a campaign for that funnel, full stop — no campaign of the brand can hold provisioning
 * back any more.
 *
 * A funnel billing funds but brand-service does not declare (or declares inactive) is skipped: a
 * switched-off funnel must never be worked, whatever ceiling billing still holds for it.
 */
async function ensureFundedFunnelCampaigns({
  seed,
  brandId,
  featureSlug,
  funded,
  declared,
  now,
}: {
  seed: ClaimedFunnelCampaign;
  brandId: string;
  featureSlug: string;
  funded: FunnelBudget[];
  declared: DeclaredSalesFunnel[] | null;
  now: Date;
}): Promise<void> {
  // No readable funnel declaration → nothing says the brand still sells through these funnels.
  // Provisioning waits; whatever campaigns already exist keep running.
  if (!declared || declared.length === 0) return;
  if (!seed.createdByUserId) return; // no recipient/owner to attribute a new campaign to

  const declaredKeys = new Set(declared.map((f) => f.funnelKey));

  for (const f of funded) {
    if (!declaredKeys.has(f.funnelKey)) continue;

    const existing = await db.query.campaigns.findFirst({
      where: and(
        eq(campaigns.orgId, seed.orgId),
        eq(campaigns.featureSlug, featureSlug),
        eq(campaigns.funnelKey, f.funnelKey),
        arrayContains(campaigns.brandIds, [brandId]),
      ),
      orderBy: [desc(campaigns.createdAt)],
    });

    if (existing) {
      // A funnel the customer re-funded after switching it off resumes rather than duplicating.
      if (existing.status !== "ongoing") {
        await db
          .update(campaigns)
          .set({ status: "ongoing", nextRunAt: now, updatedAt: now })
          .where(and(eq(campaigns.id, existing.id), eq(campaigns.orgId, seed.orgId)));
      }
      continue;
    }

    // Deterministic name: uniq_campaigns_org_name is the only uniqueness Postgres can enforce
    // here (brand_ids is a text[], so no unique index can span it), which makes a duplicate
    // provision a constraint violation rather than a second campaign for the same funnel.
    const name = funnelCampaignName(featureSlug, brandId, f.funnelKey);

    try {
      await db.insert(campaigns).values({
        orgId: seed.orgId,
        createdByUserId: seed.createdByUserId,
        name,
        workflowSlug: seed.workflowSlug,
        brandIds: [brandId],
        ...campaignIdentityColumns({ brandIds: [brandId], featureSlug }),
        featureSlug,
        // The funnel says what this campaign sells, and it is the only word for it. `goal` is
        // NOT written any more: it could not tell the two meeting funnels apart, and a consumer
        // reading it reads a poorer statement of the same thing.
        funnelKey: f.funnelKey,
        featureInputs: null,
        status: "ongoing",
        nextRunAt: now,
        updatedAt: now,
      });
    } catch (err) {
      // Two ticks (or two instances) racing the same funnel both SELECT nothing and both
      // INSERT; the unique name index rejects the loser. That is the intended outcome, not a
      // fault — the winner's campaign is the one campaign for this funnel.
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes("uniq_campaigns_org_name")) throw err;
    }
  }
}

export function funnelCampaignName(featureSlug: string, brandId: string, funnelKey: string): string {
  return `${featureSlug} - ${brandId} - ${funnelKey}`;
}

/**
 * Committed spend today for ONE campaign — which, for a funnel campaign, IS that funnel's spend
 * today. The cost ledger is already keyed on campaignId, so no per-funnel spend figure is
 * invented here.
 *
 * Same net-committed basis the gate paces on: actual + provisioned, post-usage-discount. A
 * failed read reports 0 so an unreadable spend never silently parks a funnel; the gate is what
 * refuses to spend past an unreadable ceiling.
 */
async function spentTodayCents(orgId: string, campaignId: string, featureSlug: string): Promise<number> {
  try {
    const budget = await getStatsBudget({
      orgId,
      campaignId,
      featureSlug,
      windows: [{ label: "today", since: startOfToday().toISOString() }],
    });
    const today = budget.windows.find((w) => w.label === "today");
    if (!today) return 0;
    return parseFloat(today.netTotalCostInUsdCents ?? today.totalCostInUsdCents) || 0;
  } catch {
    return 0;
  }
}

// Same "alive" definition the per-campaign guard uses (any running run within the freshness
// window, whichever service owns it), widened from the campaign to the brand's SALES campaigns.
const LIVE_RUN_FRESHNESS_MS = 15 * 60_000;

/**
 * Is one of this brand's SALES campaigns running right now?
 *
 * Asked campaign by campaign, and that is the whole point: a brand-wide `listRuns({ brandId })`
 * also counts the runs of the brand's PR, AI-visibility, hiring and VC campaigns, which are tagged
 * with the same brand. A brand whose PR outreach ticks continuously — 736 completed runs in one
 * morning, one always in flight — then reads as permanently busy, so EVERY sales campaign of that
 * brand is deferred 60s, every tick, forever. That is not a slowdown: it is a full stop, and it
 * shows up in no log at all because the defer is the routine path. It halted brand
 * f4d73dab-1f9d-49b2-b16e-63ecde76a5eb outright (prod, 2026-08-02).
 *
 * The constraint this serialization exists for is about SALES funnels sharing leads and sending
 * accounts. A PR pitch shares neither, so it was never meant to hold a sales funnel back.
 *
 * The candidate set is read from the DB rather than from the campaigns claimed this tick: the one
 * that is actually running is precisely the one NOT claimed (its nextRunAt is null while in
 * flight), so a group-scoped check would be blind to it.
 */
async function hasLiveSalesRunForBrand(orgId: string, brandId: string, now: Date): Promise<boolean> {
  const alive = await db.query.campaigns.findMany({
    where: and(
      eq(campaigns.orgId, orgId),
      eq(campaigns.status, "ongoing"),
      arrayContains(campaigns.brandIds, [brandId]),
    ),
    columns: { id: true, featureSlug: true },
  });

  const startedAfter = new Date(now.getTime() - LIVE_RUN_FRESHNESS_MS).toISOString();
  for (const c of alive) {
    if (!isSalesOutreachFeature(c.featureSlug)) continue;
    const { runs } = await listRuns({
      orgId,
      campaignId: c.id,
      status: "running",
      startedAfter,
      limit: 1,
    });
    if (runs.length > 0) return true;
  }
  return false;
}

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function nextDayStart(now: Date): Date {
  const d = new Date(now.getTime());
  d.setDate(d.getDate() + 1);
  d.setHours(0, 0, 0, 0);
  return d;
}
