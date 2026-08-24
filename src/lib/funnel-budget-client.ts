import type { IdentityHeaders } from "@distribute/runs-client";
import { toFunnelKey, type SalesFunnelKey } from "./sales-funnel-vocabulary.js";

/**
 * Per-funnel daily spend ceilings, as billing-service holds them for ONE org's view of a brand.
 *
 * A customer funds each sales funnel of a brand separately, so "the brand's daily budget" is no
 * longer a single pot: it is the SUM of these ceilings, and billing keeps serving that sum on
 * GET /internal/brands/{brandId}/daily-budget. Nothing that reads the brand total changes.
 *
 * Contract (billing-service): GET /internal/brands/{brandId}/funnel-budgets (x-api-key + x-org-id)
 *   -> { brandId, dailyBudgetCents: string|null, funnels: [{ funnelKey, dailyBudgetCents, updatedAt }] }
 *
 * A brand that has never set per-funnel ceilings returns `funnels: []` plus its brand-level
 * value — billing never fabricates a split, and neither do we.
 */
export interface FunnelBudget {
  /**
   * Canonical funnel key. billing-service still names these funnels the pre-rename way
   * (`reply_meeting`, `visit_meeting`, `visit_signup`, `visit_form`) while brand-service has moved
   * to the canonical four — so this read canonicalises, and the two sets intersect again. Without
   * that, every funnel would read as unfunded and the gate would stop the whole fleet.
   */
  funnelKey: SalesFunnelKey;
  /** This funnel's own daily ceiling, in CENTS (directly comparable to runs *CostInUsdCents). */
  dailyBudgetCents: number;
}

/**
 * One (sales funnel, ACQUISITION-CHANNEL feature) ceiling — the finer grain billing serves
 * ALONGSIDE the per-funnel figure above.
 *
 * A funnel can be worked through two offers at once (a straight sales pitch and a feedback-request
 * pitch). Each is a campaign of its own, measured and funded on its own, so each must be paced on
 * its own money: ranking both against the funnel TOTAL lets one consume what the other was funded
 * for. `funnels` above is the per-funnel SUM of these, so nothing here is ever added up by a
 * consumer.
 *
 * A CHANNEL IS A FEATURE SLUG. There is no channel table, enum or vocabulary in this service and
 * none should be introduced — billing stores whatever feature slug the customer funds, and which
 * feature may be sold through which funnel is features-service's statement, read per feature.
 */
export interface FunnelChannelBudget {
  /** Canonical funnel key, same canonicalisation as `FunnelBudget.funnelKey`. */
  funnelKey: SalesFunnelKey;
  /** The acquisition channel this ceiling funds, as a features-service feature slug. */
  featureSlug: string;
  /** This PAIR's own daily ceiling, in CENTS. */
  dailyBudgetCents: number;
}

/**
 * One (sales funnel, ACQUISITION CHANNEL, OFFER) ceiling — the STORED grain, one row per campaign.
 *
 * A brand sells several OFFERS, and one offer can be worked through the same funnel and the same
 * channel as another. `channels` above is the per-PAIR SUM of these rows, so two offers sharing a
 * (funnel, channel) collapse into one figure there — and pacing both campaigns on that sum is
 * exactly the failure the pair grain was introduced to close, one level down: each offer is free
 * to consume what the other was funded for.
 *
 * billing OWNS the offer entity's id (brand-service's UUID, carried by both services and derived
 * by neither). `offerId` is null for a ceiling written before offers existed — the pre-offer
 * world, whose rules are billing's and are mirrored in `offerCeilingCents`.
 */
export interface FunnelOfferBudget {
  /** Canonical funnel key, same canonicalisation as `FunnelBudget.funnelKey`. */
  funnelKey: SalesFunnelKey;
  /** The acquisition channel this ceiling funds, as a features-service feature slug. */
  featureSlug: string;
  /** The offer this ceiling funds, or null for an UNSCOPED (pre-offer) ceiling. */
  offerId: string | null;
  /** This ROW's own daily ceiling, in CENTS. */
  dailyBudgetCents: number;
}

export type FunnelBudgetsRead =
  | {
      ok: true;
      brandDailyBudgetCents: number | null;
      funnels: FunnelBudget[];
      /**
       * ADDITIVE grain. Empty for a brand that has never set per-funnel ceilings — and also for a
       * billing deploy that predates the pair grain, which is why an ABSENT `channels` field is
       * read as "no finer grain" rather than as "nothing is funded": every consumer then falls
       * through to the funnel figure and behaves exactly as it did before.
       */
      channels: FunnelChannelBudget[];
      /**
       * ADDITIVE grain, one level below `channels`. Empty for a brand that funds nothing per
       * funnel — and, exactly as for `channels`, an ABSENT `offers` field is read as "no offer
       * grain" rather than "nothing is funded", so a billing deploy that predates it leaves every
       * consumer on the pair figure and behaves byte for byte as it did.
       */
      offers: FunnelOfferBudget[];
    }
  | { ok: false };

/**
 * Read this org's per-funnel daily ceilings for a brand.
 *
 * Returns ok:false on missing config, network error, non-2xx or an unparseable payload. The
 * caller decides what that means: the gate treats it as fail-CLOSED (spend control must never
 * read an unreadable cap as "unbounded"), while the scheduler's turn-taking treats it as
 * fail-SOFT (a selection optimization must never block a run — the gate still holds the line).
 *
 * `x-org-id` is load-bearing, not tracking: per-funnel funding belongs to the (org, brand) pair
 * and billing 400s rather than guess an org for a brand several orgs claim.
 */
export async function fetchFunnelBudgets(
  brandId: string,
  identity: IdentityHeaders,
): Promise<FunnelBudgetsRead> {
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
      `${url.replace(/\/$/, "")}/internal/brands/${encodeURIComponent(brandId)}/funnel-budgets`,
      { headers },
    );
    if (!res.ok) return { ok: false };

    const data = await res.json() as {
      dailyBudgetCents?: string | null;
      funnels?: Array<{ funnelKey?: string; dailyBudgetCents?: string }>;
      channels?: Array<{ funnelKey?: string; featureSlug?: string; dailyBudgetCents?: string }>;
      offers?: Array<{
        funnelKey?: string;
        featureSlug?: string;
        offerId?: string | null;
        dailyBudgetCents?: string;
      }>;
    };

    let brandDailyBudgetCents: number | null = null;
    if (data.dailyBudgetCents !== null && data.dailyBudgetCents !== undefined) {
      const total = parseFloat(data.dailyBudgetCents);
      if (!Number.isFinite(total)) return { ok: false };
      brandDailyBudgetCents = total;
    }

    if (!Array.isArray(data.funnels)) return { ok: false };

    const funnels: FunnelBudget[] = [];
    for (const raw of data.funnels) {
      if (!raw?.funnelKey) return { ok: false };
      const cents = parseFloat(raw.dailyBudgetCents ?? "");
      // An unparseable ceiling is not "no ceiling" — refuse the whole read rather than let one
      // funnel silently pace on nothing.
      if (!Number.isFinite(cents)) return { ok: false };
      // A funnel neither catalogue names is one no campaign of ours can be on, so it is dropped
      // rather than refused: refusing would fail the read CLOSED and stop the funnels we DO run
      // because billing named a fifth one we have not heard of yet.
      const funnelKey = toFunnelKey(raw.funnelKey);
      if (!funnelKey) continue;
      funnels.push({ funnelKey, dailyBudgetCents: cents });
    }

    // The pair grain is ADDITIVE and arrived after this consumer: an absent field is a billing
    // deploy that does not serve it yet, which is "no finer grain", NOT "nothing is funded". A
    // present-but-unparseable one is refused like the funnel figures — a ceiling we cannot read
    // must never be read as no ceiling.
    const channels: FunnelChannelBudget[] = [];
    if (data.channels !== undefined) {
      if (!Array.isArray(data.channels)) return { ok: false };
      for (const raw of data.channels) {
        if (!raw?.funnelKey || !raw?.featureSlug) return { ok: false };
        const cents = parseFloat(raw.dailyBudgetCents ?? "");
        if (!Number.isFinite(cents)) return { ok: false };
        const funnelKey = toFunnelKey(raw.funnelKey);
        if (!funnelKey) continue; // a funnel no catalogue names — same treatment as above
        channels.push({ funnelKey, featureSlug: raw.featureSlug, dailyBudgetCents: cents });
      }
    }

    // The offer grain, read exactly as the pair grain above and for the same reasons: absent is
    // "no finer grain" (an older billing deploy), unparseable is refused, a funnel no catalogue
    // names is dropped. `offerId` is nullable ON THE WIRE — a ceiling written before offers
    // existed states none, and that null is a VALUE (see `offerCeilingCents`), not a missing
    // field, so it is carried rather than refused.
    const offers: FunnelOfferBudget[] = [];
    if (data.offers !== undefined) {
      if (!Array.isArray(data.offers)) return { ok: false };
      for (const raw of data.offers) {
        if (!raw?.funnelKey || !raw?.featureSlug) return { ok: false };
        if (raw.offerId !== null && raw.offerId !== undefined && typeof raw.offerId !== "string") {
          return { ok: false };
        }
        const cents = parseFloat(raw.dailyBudgetCents ?? "");
        if (!Number.isFinite(cents)) return { ok: false };
        const funnelKey = toFunnelKey(raw.funnelKey);
        if (!funnelKey) continue; // a funnel no catalogue names — same treatment as above
        offers.push({
          funnelKey,
          featureSlug: raw.featureSlug,
          offerId: raw.offerId ?? null,
          dailyBudgetCents: cents,
        });
      }
    }

    return { ok: true, brandDailyBudgetCents, funnels, channels, offers };
  } catch {
    return { ok: false };
  }
}

/**
 * The ceiling that binds ONE (funnel, acquisition-channel feature) pair.
 *
 * Three answers, and the distinction between the last two is what keeps a single-channel brand
 * behaving exactly as it did:
 *
 *   - `grain: "none"` — billing states no pair for this funnel at all (an older deploy, or a brand
 *     that funds nothing per funnel). The caller falls through to the funnel figure, i.e. today's
 *     behaviour, byte for byte.
 *   - `cents` — this pair is funded at that amount.
 *   - `cents: null` — the funnel IS split across channels and this campaign's channel is not one of
 *     them, so it is unfunded. Never a fallback to the funnel total: that is precisely how one
 *     offer would spend the money the other was funded for.
 *
 * A funnel funded through exactly ONE channel answers with that channel's ceiling WHATEVER feature
 * the campaign states. That mirrors billing's own rule for a write that names no channel ("the
 * funnel's single channel when it funds one"), and it is what guarantees that a brand funding one
 * channel per funnel is unaffected — including the brands whose single ceiling billing's migration
 * attributed to the default channel while their campaign runs another sales feature.
 */
export function channelCeilingCents(
  read: Extract<FunnelBudgetsRead, { ok: true }>,
  funnelKey: SalesFunnelKey,
  featureSlug: string | null | undefined,
): { grain: "none" } | { grain: "pair"; cents: number | null } {
  // Same reading as on the wire: no pair stated is "no finer grain", never "nothing is funded".
  const rows = (read.channels ?? []).filter((c) => c.funnelKey === funnelKey);
  if (rows.length === 0) return { grain: "none" };
  if (rows.length === 1) return { grain: "pair", cents: rows[0]!.dailyBudgetCents };
  const match = featureSlug ? rows.find((c) => c.featureSlug === featureSlug) : undefined;
  return { grain: "pair", cents: match ? match.dailyBudgetCents : null };
}

/**
 * The ceiling that binds ONE (funnel, acquisition channel, OFFER) triple — the grain BELOW the
 * pair, and the finest billing stores.
 *
 * Two campaigns of one brand can work the same funnel through the same channel for two different
 * OFFERS. billing serves their pair figure as the SUM of both, so pacing either campaign on it
 * hands each the money the other was funded for — the same failure `channelCeilingCents` closed
 * one level up, re-opened one level down.
 *
 * Three answers, and the middle one is what keeps every brand alive today behaving identically:
 *
 *   - `grain: "none"` — there is no offer question to ask here, so the caller falls through to the
 *     pair figure, i.e. today's behaviour byte for byte. That covers a billing deploy that does not
 *     serve `offers` yet, a campaign that states NO offer (the pre-offer population — an offer is
 *     never fabricated for it), a brand whose stored ceilings name no offer AT ALL, and a funnel
 *     billing states no row for.
 *   - `cents` — this triple is funded at that amount.
 *   - `cents: null` — this brand's money IS scoped to offers and none of it is this offer's, so the
 *     campaign is unfunded. Never a fallback to the pair or funnel total: that is the whole point
 *     of the grain.
 *
 * WHICH ROWS AN OFFER MAY CLAIM IS BILLING'S RULE, READ FROM BILLING, NOT INVENTED HERE
 * (`offerBudgetRows` / `resolveEntryOfferId`, billing-service `src/lib/brand-funnel-budgets.ts`):
 * a ceiling that NAMES the offer always counts, and an UNSCOPED ceiling (`offerId: null`, every
 * ceiling written before offers existed) counts only when this offer is the brand's SOLE named
 * one — then the brand's money has exactly one campaign-owner. A brand split across several named
 * offers has no honest owner for an unscoped remainder, so it belongs to none of them.
 *
 * A triple's offer funded through exactly ONE channel binds whatever feature the campaign states,
 * the same rule and the same reason as `channelCeilingCents` one grain up.
 */
export function offerCeilingCents(
  read: Extract<FunnelBudgetsRead, { ok: true }>,
  funnelKey: SalesFunnelKey,
  featureSlug: string | null | undefined,
  offerId: string | null | undefined,
): { grain: "none" } | { grain: "offer"; cents: number | null } {
  const stored = read.offers ?? [];
  if (stored.length === 0) return { grain: "none" };
  // The pre-offer population. Never fabricate an offer for it: it resolves exactly as it always
  // has, on the pair figure.
  if (!offerId) return { grain: "none" };

  // A brand whose ceilings name no offer at all has not entered the offer world, so neither does
  // this read — every such brand keeps pacing on its pair figure. (20 of the fleet's 21 stored
  // ceilings were unscoped the day this shipped.)
  const named = new Set(
    stored.map((o) => o.offerId).filter((id): id is string => id !== null),
  );
  if (named.size === 0) return { grain: "none" };

  const rowsForFunnel = stored.filter((o) => o.funnelKey === funnelKey);
  if (rowsForFunnel.length === 0) return { grain: "none" };

  // billing's rule, verbatim: the unscoped remainder is this offer's only when this offer is the
  // brand's sole named one.
  const soleNamed = named.size === 1 && named.has(offerId);
  const owned = rowsForFunnel.filter(
    (o) => o.offerId === offerId || (soleNamed && o.offerId === null),
  );

  if (owned.length === 0) return { grain: "offer", cents: null };

  const match = featureSlug ? owned.find((o) => o.featureSlug === featureSlug) : undefined;
  if (match) return { grain: "offer", cents: match.dailyBudgetCents };

  // No row for the channel this campaign states. The funnel is worked through exactly ONE channel
  // here, so there is nothing to confuse this ceiling with and it binds whatever feature the
  // campaign states — billing's rule for a write naming no channel, and what keeps a brand whose
  // single ceiling was filed under the DEFAULT channel while its campaign runs another sales
  // feature funded. A funnel SPLIT across channels is a different matter: a channel the split does
  // not fund is unfunded, never the neighbour's money.
  const channelsOfFunnel = new Set(rowsForFunnel.map((o) => o.featureSlug));
  if (channelsOfFunnel.size === 1) return { grain: "offer", cents: owned[0]!.dailyBudgetCents };
  return { grain: "offer", cents: null };
}

/**
 * The funnels this org has actually FUNDED for the brand: a ceiling of zero is a deliberate
 * "do not work this funnel", not a missing value, so it is filtered out here once rather than
 * re-tested at every call site.
 */
export function fundedFunnels(read: Extract<FunnelBudgetsRead, { ok: true }>): FunnelBudget[] {
  return read.funnels.filter((f) => f.dailyBudgetCents > 0);
}

/**
 * The (funnel, acquisition-channel feature) pairs this org actually FUNDS for the brand — the unit
 * one campaign is provisioned per. A ceiling of zero is a deliberate "do not work this pair".
 */
export function fundedChannelPairs(
  read: Extract<FunnelBudgetsRead, { ok: true }>,
): FunnelChannelBudget[] {
  return (read.channels ?? []).filter((c) => c.dailyBudgetCents > 0);
}
