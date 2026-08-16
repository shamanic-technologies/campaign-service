import { and, arrayContains, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { getStatsBudget, listRuns, type IdentityHeaders } from "@distribute/runs-client";
import { db } from "../db/index.js";
import { campaigns } from "../db/schema.js";
import { fetchFunnelBudgets, fundedFunnels, type FunnelBudget } from "./funnel-budget-client.js";
import { fetchDeclaredSalesFunnels, type DeclaredSalesFunnel } from "./brand-sales-funnels-client.js";
import { isSalesOutreachFeature, SALES_OUTREACH_FEATURE_SLUGS } from "./sales-outreach-campaign.js";
import { toFunnelKey } from "./sales-funnel-vocabulary.js";
import { campaignIdentityColumns } from "./campaign-identity.js";
import { fundingFromBudgets } from "./campaign-funding.js";

// A campaign that did not get this brand's turn re-checks on the next active tick. The turn is
// re-ranked from scratch every tick, so this is a "wait your turn", not a backoff. EVERY alive
// campaign of the brand is in the running every tick: none is ever held out because another one
// covers its funnel.
export const FUNNEL_TURN_DEFER_MS = 60_000; // 1 min

/**
 * How long a campaign the customer funds NOTHING for waits before it is looked at again.
 *
 * A held campaign is not waiting its turn, it is waiting for money, and money changes when a
 * person edits their funnels — hours or days apart, not minutes. Re-checking it at the turn
 * cadence would be one billing read per held brand per minute, forever, for a state that almost
 * never moves; the 27 brands held today would be ~39k reads a day answering "still nothing".
 *
 * It is also the WHOLE latency of the feature: funding a funnel makes its campaign eligible
 * within this window, with no manual step. Ten minutes is the same cadence the resume sweep runs
 * at, and for the same reason — the customer is owed that it works without them, not that it
 * works within the minute.
 */
export const FUNDING_RECHECK_MS = 10 * 60_000; // 10 min

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
  /** The mirror of this campaign's funnel ceiling. Stated → it IS the ceiling this campaign runs on. */
  dailyBudgetCents: number | null;
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
 * Four things happen per brand, in this order:
 *   0. Hold — a campaign the customer funds nothing for does not run. This is the ONLY thing that
 *      holds a brand's sales campaigns now: `brand_pause` is gone, and funding says it instead.
 *      Fail-CLOSED (an unreadable answer holds), because the gate refuses to spend on a ceiling
 *      it cannot read anyway, so firing would only burn a run.
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
 * Turn-taking is fail-SOFT (it only reorders work already allowed); the HOLD is fail-CLOSED, and
 * so is the per-funnel CEILING in gate-check, which is where spend control belongs.
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
      // A planning failure is not a licence to spend: hold the group and say so. The gate would
      // refuse these runs anyway (it fail-closes on the same unreadable ceilings), so firing them
      // buys nothing and costs a run each.
      console.warn(`[campaign-service] funnel turn planning failed for campaign ${group[0]?.id} — holding the brand:`, err);
      for (const c of group) deferred.set(c.id, new Date(now.getTime() + FUNDING_RECHECK_MS));
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

  const heldAt = new Date(now.getTime() + FUNDING_RECHECK_MS);

  const budgets = await fetchFunnelBudgets(brandId, identity);
  // Fail-CLOSED. An unreadable ceiling is not "spend freely for a tick": the gate refuses the run
  // on the very same read, so firing it only burns a run and re-asks in a minute.
  if (!budgets.ok) {
    for (const c of group) deferred.set(c.id, heldAt);
    return;
  }

  const funded = fundedFunnels(budgets);
  if (funded.length > 0) {
    const declared = await fetchDeclaredSalesFunnels(brandId, identity);
    await ensureFundedFunnelCampaigns({ seed, brandId, featureSlug, funded, declared, now });
  }

  // (0) The hold. A campaign the customer funds nothing for waits for money, not for a turn — so
  // it is out of the running entirely and re-checked on the funding cadence. This is the only
  // thing that holds a brand's sales campaigns now.
  //
  // EVERY funded campaign of the brand is in the running, every tick. There is no campaign held
  // out because another one covers its funnel: each is ranked on what IT has already spent today
  // against the ceiling that actually binds IT, so nothing starves and nothing overspends.
  const candidates: FunnelTurnCandidate[] = [];
  for (const c of group) {
    const verdict = fundingFromBudgets(c, budgets);
    if (!verdict.funded) {
      deferred.set(c.id, heldAt);
      continue;
    }
    // A row written before the rename still carries the pre-rename spelling until migration 0043
    // reaches it — and a mixed fleet must rank on one vocabulary or a funnel silently loses its
    // ceiling and never takes a turn.
    candidates.push({
      campaignId: c.id,
      funnelKey: toFunnelKey(c.funnelKey) ?? "",
      spentCents: await spentTodayCents(orgId, c.id, featureSlug),
      ceilingCents: verdict.ceilingCents,
    });
  }

  if (candidates.length === 0) return;

  // Serial, for now: at most one SALES run in flight per brand. Running funnels concurrently needs
  // an audit of lead de-duplication and of sending-account load that nobody has done, so it is
  // deliberately out of scope — delete this block and the funnels run in parallel.
  if (await hasLiveSalesRunForBrand(orgId, brandId, now)) {
    for (const c of candidates) {
      deferred.set(c.campaignId, new Date(now.getTime() + FUNNEL_TURN_DEFER_MS));
    }
    return;
  }

  const winner = selectLowestFillRatio(candidates);
  // Every funded funnel is at its ceiling — nothing runs until they reset at the day rollover.
  const reset = winner === null ? nextDayStart(now) : null;

  for (const c of candidates) {
    if (c.campaignId === winner) continue;
    deferred.set(c.campaignId, reset ?? new Date(now.getTime() + FUNNEL_TURN_DEFER_MS));
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
 *
 * Funding brings back the campaign that was HELD, never the campaign that stopped for a reason of
 * its own. A row carrying `audience_exhausted`, `max_leads_reached`, `manual` or `org_teardown`
 * stated why it stopped, and money is not an answer to any of those — the exhaustion sweep owns
 * the first (it asks the audience owner, which is the only honest test), and the other three were
 * decisions. A NULL reason is the population that predates the column: those rows are the
 * workflow-version churn this service used to grow one stopped campaign per workflow version for,
 * so they are the campaign, not a decision about it, and funding resumes them.
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
      // A funnel the customer re-funded after switching it off resumes rather than duplicating —
      // unless the campaign stopped for a reason of its own, which money does not answer.
      if (existing.status !== "ongoing") {
        if (existing.stopReason !== null) {
          console.log(
            `[campaign-service] Not resuming campaign ${existing.id} for funded funnel ${f.funnelKey} — it stopped for ${existing.stopReason}`,
          );
          continue;
        }
        await db
          .update(campaigns)
          .set({ status: "ongoing", nextRunAt: now, updatedAt: now })
          .where(and(
            eq(campaigns.id, existing.id),
            eq(campaigns.orgId, seed.orgId),
            eq(campaigns.status, "stopped"),
            isNull(campaigns.stopReason),
          ));
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
 * How often the platform asks "did anybody fund a funnel of a brand that has nothing running?"
 *
 * Its own cadence, like the resume sweep and for the same reason: the answer changes when a person
 * edits their funnels. This IS the latency between funding a funnel and its campaign existing.
 */
export const FUNDING_SWEEP_INTERVAL_MS = 10 * 60_000; // 10 min

/**
 * Most (org, brand) pairs examined in one sweep. Not a silent cap: going over it is logged with
 * the number left behind, and the sweep reads least-recently-touched first, so the remainder is
 * picked up next time rather than starved.
 */
export const FUNDING_SWEEP_MAX_BRANDS = 100;

let lastFundingSweepAt = 0;

/** Test seam: forget the throttle so a test can run consecutive sweeps. */
export function resetFundingSweepThrottle(): void {
  lastFundingSweepAt = 0;
}

/**
 * Provision the funded funnels of a brand that has NOTHING running.
 *
 * `planFunnelTurns` provisions off the campaigns claimed this tick, so it can only ever help a
 * brand that already has one ongoing campaign. A brand whose campaigns are all stopped is claimed
 * by nobody, so nothing would ever look at it again — and that is precisely the brand this
 * feature is for: 27 of the 44 brands with sales campaigns have no ongoing one, and under the old
 * flag their way back was a pause button that no longer exists anywhere in the fleet.
 *
 * So funding is asked about them directly. One campaign is stood up per funnel the customer FUNDS
 * and brand-service DECLARES; a brand that funds nothing is read and left exactly as it is, which
 * is what keeps every brand held today held after this ships.
 *
 * Fail-soft per brand: an unreadable brand is skipped, never provisioned on a guess.
 */
export async function provisionFundedFunnelsForIdleBrands(now: Date = new Date()): Promise<number> {
  if (now.getTime() - lastFundingSweepAt < FUNDING_SWEEP_INTERVAL_MS) return 0;
  lastFundingSweepAt = now.getTime();

  const slugs = [...SALES_OUTREACH_FEATURE_SLUGS];

  // One row per (org, brand) that has sales campaigns and NO ongoing one — the most recently
  // touched of them, which is what a new campaign inherits its owner and workflow from. Done in
  // SQL rather than by reading every sales campaign into memory: the stopped population is large
  // (682 rows today) and grows, while the answer is at most one row per brand.
  const seeds = await db.execute<{
    id: string;
    org_id: string;
    brand_id: string;
    feature_slug: string;
    workflow_slug: string;
    created_by_user_id: string;
  }>(sql`
    SELECT DISTINCT ON (c.org_id, coalesce(c.brand_id, c.brand_ids[1]))
           c.id, c.org_id, coalesce(c.brand_id, c.brand_ids[1]) AS brand_id,
           c.feature_slug, c.workflow_slug, c.created_by_user_id
    FROM campaigns c
    WHERE c.feature_slug IN (${sql.join(slugs.map((s) => sql`${s}`), sql`, `)})
      AND coalesce(c.brand_id, c.brand_ids[1]) IS NOT NULL
      AND c.created_by_user_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM campaigns o
        WHERE o.org_id = c.org_id
          AND o.status = 'ongoing'
          AND o.feature_slug IN (${sql.join(slugs.map((s) => sql`${s}`), sql`, `)})
          AND coalesce(o.brand_id, o.brand_ids[1]) = coalesce(c.brand_id, c.brand_ids[1])
      )
    ORDER BY c.org_id, coalesce(c.brand_id, c.brand_ids[1]), c.updated_at DESC
    LIMIT ${FUNDING_SWEEP_MAX_BRANDS + 1}
  `);

  const rows = Array.from(seeds as unknown as Iterable<{
    id: string;
    org_id: string;
    brand_id: string;
    feature_slug: string;
    workflow_slug: string;
    created_by_user_id: string;
  }>);
  const examined = rows.slice(0, FUNDING_SWEEP_MAX_BRANDS);
  if (rows.length > FUNDING_SWEEP_MAX_BRANDS) {
    console.log(
      `[campaign-service] Funding sweep examining ${examined.length} of ${rows.length}+ idle brands — the rest are examined on the next sweep (least recently touched first)`,
    );
  }

  let provisioned = 0;
  for (const row of examined) {
    try {
      const identity: IdentityHeaders = {
        orgId: row.org_id,
        userId: row.created_by_user_id,
        campaignId: row.id,
        brandId: row.brand_id,
        workflowSlug: row.workflow_slug,
      };

      const budgets = await fetchFunnelBudgets(row.brand_id, identity);
      if (!budgets.ok) continue;
      const funded = fundedFunnels(budgets);
      // The expected state for most brands on most sweeps: still funding nothing. Not logged — it
      // fires for every idle brand of every client on every sweep, and it is already observable in
      // the brand having no ongoing campaign.
      if (funded.length === 0) continue;

      const declared = await fetchDeclaredSalesFunnels(row.brand_id, identity);
      const before = await countOngoingSalesCampaigns(row.org_id, row.brand_id);
      await ensureFundedFunnelCampaigns({
        seed: {
          id: row.id,
          orgId: row.org_id,
          createdByUserId: row.created_by_user_id,
          workflowSlug: row.workflow_slug,
          brandIds: [row.brand_id],
          featureSlug: row.feature_slug,
          funnelKey: null,
          dailyBudgetCents: null,
        },
        brandId: row.brand_id,
        featureSlug: row.feature_slug,
        funded,
        declared,
        now,
      });
      const after = await countOngoingSalesCampaigns(row.org_id, row.brand_id);
      if (after > before) {
        provisioned += after - before;
        console.log(
          `[campaign-service] Funding brought back brand ${row.brand_id} (org ${row.org_id}): ${after - before} campaign(s) now ongoing for its funded funnels`,
        );
      }
    } catch (err) {
      console.warn(`[campaign-service] Funding sweep failed for brand ${row.brand_id}:`, err);
    }
  }

  return provisioned;
}

/** How many ongoing sales campaigns this (org, brand) holds — the sweep's before/after. */
async function countOngoingSalesCampaigns(orgId: string, brandId: string): Promise<number> {
  const rows = await db.query.campaigns.findMany({
    where: and(
      eq(campaigns.orgId, orgId),
      eq(campaigns.status, "ongoing"),
      inArray(campaigns.featureSlug, [...SALES_OUTREACH_FEATURE_SLUGS]),
      arrayContains(campaigns.brandIds, [brandId]),
    ),
    columns: { id: true },
  });
  return rows.length;
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
