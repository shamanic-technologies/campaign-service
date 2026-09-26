import type { IdentityHeaders } from "@distribute/runs-client";

/**
 * Per-CAMPAIGN daily spend ceilings, as billing-service holds them for ONE org's view of a brand.
 *
 * A campaign is (offer x leg x acquisition channel), and that is the grain a customer funds. billing
 * serves every ceiling of a brand at that grain, plus the brand total they add up to:
 *
 *   GET /internal/brands/{brandId}/campaign-budgets (x-api-key + x-org-id)
 *     -> { brandId, dailyBudgetCents: string|null,
 *          campaigns: [{ offerId|null, legKey|null, featureSlug, dailyBudgetCents, updatedAt }] }
 *
 * An entry whose `offerId` / `legKey` is null is a ceiling written before that dimension existed;
 * WHICH campaign such an entry funds is billing's rule, mirrored in `ceilingEntriesOf`. A brand with
 * no entries at all answers its brand-level pot (or null when nothing was ever configured) — billing
 * never fabricates a split, and neither do we.
 */
export interface CampaignBudgetEntry {
  /** brand-service offer UUID, or null for a ceiling written before offers existed. */
  offerId: string | null;
  /** features-service leg id, carried opaque, or null for a ceiling written before legs existed. */
  legKey: string | null;
  /** The acquisition channel this ceiling funds — a features-service feature slug. */
  featureSlug: string;
  /** This entry's daily ceiling, in CENTS (directly comparable to runs *CostInUsdCents). */
  dailyBudgetCents: number;
}

export type CampaignBudgetsRead =
  | {
      ok: true;
      /** The brand total (the sum of every entry), or its brand-level pot when there are none. */
      brandDailyBudgetCents: number | null;
      campaigns: CampaignBudgetEntry[];
    }
  | { ok: false };

/**
 * Read this org's per-campaign daily ceilings for a brand.
 *
 * Returns ok:false on missing config, network error, non-2xx or an unparseable payload. The caller
 * decides what that means: the gate and the funding hold treat it as fail-CLOSED (spend control
 * must never read an unreadable cap as "unbounded").
 *
 * `x-org-id` is load-bearing, not tracking: funding belongs to the (org, brand) pair and billing
 * 400s rather than guess an org for a brand several orgs claim.
 */
export async function fetchCampaignBudgets(
  brandId: string,
  identity: IdentityHeaders,
): Promise<CampaignBudgetsRead> {
  const url = process.env.BILLING_SERVICE_URL;
  const apiKey = process.env.BILLING_SERVICE_API_KEY;
  if (!url || !apiKey) return { ok: false };

  const headers: Record<string, string> = {
    "x-api-key": apiKey,
    "x-org-id": identity.orgId,
    "x-brand-id": brandId,
  };
  if (identity.userId) headers["x-user-id"] = identity.userId;
  if (identity.runId) headers["x-run-id"] = identity.runId;
  if (identity.campaignId) headers["x-campaign-id"] = identity.campaignId;
  if (identity.workflowSlug) headers["x-workflow-slug"] = identity.workflowSlug;

  try {
    const res = await fetch(
      `${url.replace(/\/$/, "")}/internal/brands/${encodeURIComponent(brandId)}/campaign-budgets`,
      { headers },
    );
    if (!res.ok) return { ok: false };

    const data = (await res.json()) as {
      dailyBudgetCents?: string | null;
      campaigns?: Array<{
        offerId?: string | null;
        legKey?: string | null;
        featureSlug?: string;
        dailyBudgetCents?: string;
      }>;
    };

    let brandDailyBudgetCents: number | null = null;
    if (data.dailyBudgetCents !== null && data.dailyBudgetCents !== undefined) {
      const total = parseFloat(data.dailyBudgetCents);
      if (!Number.isFinite(total)) return { ok: false };
      brandDailyBudgetCents = total;
    }

    if (!Array.isArray(data.campaigns)) return { ok: false };
    const campaigns: CampaignBudgetEntry[] = [];
    for (const raw of data.campaigns) {
      if (!raw?.featureSlug) return { ok: false };
      if (raw.offerId !== null && raw.offerId !== undefined && typeof raw.offerId !== "string") {
        return { ok: false };
      }
      if (raw.legKey !== null && raw.legKey !== undefined && typeof raw.legKey !== "string") {
        return { ok: false };
      }
      const cents = parseFloat(raw.dailyBudgetCents ?? "");
      // An unparseable ceiling is not "no ceiling" — refuse the whole read rather than let one
      // campaign silently pace on nothing.
      if (!Number.isFinite(cents)) return { ok: false };
      campaigns.push({
        offerId: raw.offerId ?? null,
        legKey: raw.legKey ?? null,
        featureSlug: raw.featureSlug,
        dailyBudgetCents: cents,
      });
    }

    return { ok: true, brandDailyBudgetCents, campaigns };
  } catch {
    return { ok: false };
  }
}

/** What a campaign states about itself that its money is matched on. */
export interface CampaignBudgetKey {
  featureSlug?: string | null;
  offerId?: string | null;
  legKey?: string | null;
}

/**
 * The stored ceilings that ARE this campaign's money — billing's own rule
 * (`campaignCeilingRows`, billing-service `src/lib/campaign-budgets.ts`), mirrored rather than
 * re-invented so the two services cannot disagree about whose money an entry is:
 *
 *   - an entry on this channel naming this offer and this leg is this campaign's;
 *   - an entry with NO offer counts only while the brand names no OTHER offer;
 *   - an entry with NO leg counts only while this channel names no OTHER leg.
 *
 * A campaign that does not state all three of (offer, leg, channel) names no ceiling at all.
 */
export function ceilingEntriesOf(
  read: Extract<CampaignBudgetsRead, { ok: true }>,
  campaign: CampaignBudgetKey,
): CampaignBudgetEntry[] {
  const { featureSlug, offerId, legKey } = campaign;
  if (!featureSlug || !offerId || !legKey) return [];
  const onChannel = read.campaigns.filter((e) => e.featureSlug === featureSlug);
  const otherOfferNamed = read.campaigns.some((e) => e.offerId !== null && e.offerId !== offerId);
  const otherLegNamed = onChannel.some((e) => e.legKey !== null && e.legKey !== legKey);
  return onChannel.filter(
    (e) =>
      (e.offerId === offerId || (e.offerId === null && !otherOfferNamed))
      && (e.legKey === legKey || (e.legKey === null && !otherLegNamed)),
  );
}

/**
 * The ceiling that binds ONE campaign.
 *
 *   - `grain: "brand"` — billing states no per-campaign ceiling for this brand at all, so the brand
 *     has one pot and every campaign paces on it (`cents` is that pot, null when nothing was ever
 *     configured).
 *   - `grain: "campaign"` — the brand's money IS split per campaign: `cents` is this campaign's sum,
 *     or null when none of it is this campaign's. Never a fallback to the brand total — that is how
 *     one campaign would spend the money another was funded for.
 */
export function campaignCeilingCents(
  read: Extract<CampaignBudgetsRead, { ok: true }>,
  campaign: CampaignBudgetKey,
): { grain: "brand"; cents: number | null } | { grain: "campaign"; cents: number | null } {
  if (read.campaigns.length === 0) return { grain: "brand", cents: read.brandDailyBudgetCents };
  const owned = ceilingEntriesOf(read, campaign);
  if (owned.length === 0) return { grain: "campaign", cents: null };
  return { grain: "campaign", cents: owned.reduce((sum, e) => sum + e.dailyBudgetCents, 0) };
}

/**
 * Every FUNDED ceiling in this read that names no leg — a disagreement between billing and this
 * service about what ONE campaign is. A campaign is bought for a leg; a funded ceiling without one
 * can only be matched through billing's "no other leg on this channel" rule, and it is stated
 * loudly so it gets restated at the grain it should have been set at. Nothing about pacing reads
 * this.
 */
export function legKeylessFundedCeilings(
  read: Extract<CampaignBudgetsRead, { ok: true }>,
): CampaignBudgetEntry[] {
  return read.campaigns.filter((e) => e.dailyBudgetCents > 0 && e.legKey === null);
}
