import { getStatsBudget, type BudgetWindowResult, type StatsBudgetParams, type StatsBudgetResponse } from "@distribute/runs-client";
import { SOURCING_ORIGINS_BY_CHANNEL } from "./source-campaigns.js";
import { sourceCampaignsFeeding, type FeedingSourceCampaign } from "./source-campaign-store.js";

/**
 * A CHANNEL'S SPEND INCLUDES THE SOURCING THAT FOUND ITS LEADS (2026-10-07).
 *
 * Finding a lead (lead-service `lead-serve` and everything bought under it: screening, reveal,
 * enrichment, email finding and verification) used to carry the OUTREACH channel's feature slug.
 * lead-service now opens it under the SOURCING ORIGIN's slug instead (same campaign id, same brand
 * ids, same amounts). Every budget read here that scopes runs-service spend by feature slug must
 * count the same money in both states, so a channel that sources leads is read under its own slug
 * PLUS the origin slugs it serves from.
 *
 * Counted once: a run carries exactly ONE feature slug, so the per-slug figures are disjoint and
 * their sum is the channel's whole spend. runs-service `POST /v1/stats/budget` filters on a single
 * slug, hence one read per slug, in parallel; a channel that sources nothing is ONE read, byte-
 * identical to before.
 *
 * Which origins source for which channel is features-service's statement
 * (`lib/sourcing-origins.ts` SOURCING_ORIGINS_BY_CHANNEL; its public `GET /public/sourcing-origins`
 * lists the origins and the sourcing channels but not the pairing). The table (lib/source-campaigns.ts) mirrors it: a
 * channel that starts serving another origin must be listed in BOTH places, or its spend reads lose
 * that sourcing cost. Read statically on purpose: it sits on gate-check's money path, where an
 * unreadable catalogue must never change what a budget counts.
 *
 * Residual (brand-scoped reads only, no campaign id): two channels sharing an origin under one brand
 * (sales and feedback-request cold email) would count each other's sourcing. feedback-request has
 * served nothing since 2026-08-25; campaign-scoped reads are exact.
 */
export { SOURCING_ORIGINS_BY_CHANNEL };

/** The slugs a spend read about `featureSlug` must count: itself, then the origins it sources from. */
export function spendFeatureSlugs(featureSlug: string): string[] {
  return [featureSlug, ...(SOURCING_ORIGINS_BY_CHANNEL[featureSlug] ?? []).filter((s) => s !== featureSlug)];
}

const SCALE = 10;

/** Exact sum of runs-service decimal strings ("123.4567890000"), rendered at its 10 decimals. */
export function addDecimalStrings(values: readonly string[]): string {
  let total = 0n;
  for (const v of values) {
    const s = v.trim();
    const neg = s.startsWith("-");
    const [int, frac = ""] = (neg ? s.slice(1) : s).split(".");
    if (!/^\d*$/.test(int) || !/^\d*$/.test(frac) || frac.length > SCALE) {
      throw new Error(`runs-service returned an unreadable amount: ${v}`);
    }
    const scaled = BigInt((int || "0") + frac.padEnd(SCALE, "0"));
    total += neg ? -scaled : scaled;
  }
  const neg = total < 0n;
  const digits = (neg ? -total : total).toString().padStart(SCALE + 1, "0");
  return `${neg ? "-" : ""}${digits.slice(0, -SCALE)}.${digits.slice(-SCALE)}`;
}

const AMOUNT_FIELDS = [
  "totalCostInUsdCents",
  "actualCostInUsdCents",
  "provisionedCostInUsdCents",
  "netTotalCostInUsdCents",
  "netActualCostInUsdCents",
  "netProvisionedCostInUsdCents",
] as const;

/**
 * `getStatsBudget`, counting a sourcing channel's origins too. Same params, same answer shape.
 * No feature slug, or one that sources nothing = exactly the single read it always was.
 */
export async function getChannelStatsBudget(
  params: StatsBudgetParams,
  deps: { feeding?: (campaignId: string, featureSlug: string) => Promise<FeedingSourceCampaign[]> } = {},
): Promise<StatsBudgetResponse> {
  const slugs = params.featureSlug ? spendFeatureSlugs(params.featureSlug) : [];
  if (slugs.length <= 1) return getStatsBudget(params);

  const reads: StatsBudgetParams[] = slugs.map((featureSlug) => ({ ...params, featureSlug }));
  // SOURCE CAMPAIGNS (lib/source-campaigns.ts): once lead-service files the sourcing under the
  // SOURCE campaign's id instead of this outreach campaign's, a campaign-scoped read under this id
  // alone would lose it and the outreach campaign would spend more than today. So the offer's source
  // campaigns that feed this channel are read too, each under its own origin slug. Before the
  // relabel they hold no spend (zero added); after it, this campaign's own sourcing reads zero. The
  // sum never moves. Brand-scoped reads already see every campaign of the brand: nothing to add.
  if (params.campaignId && params.featureSlug) {
    const feeding = await (deps.feeding ?? sourceCampaignsFeeding)(params.campaignId, params.featureSlug);
    for (const s of feeding) reads.push({ ...params, campaignId: s.id, featureSlug: s.featureSlug });
  }

  const answers = await Promise.all(reads.map((p) => getStatsBudget(p)));
  const windows: BudgetWindowResult[] = params.windows.map((w) => {
    const parts = answers.map((r) => r.windows.find((x) => x.label === w.label));
    const present = parts.filter((p): p is BudgetWindowResult => !!p);
    const out = { label: w.label } as BudgetWindowResult;
    // An amount is summed only when every part states it; otherwise it is omitted, exactly as a
    // single read that omits it (the net twins of an older runs-service: callers fall back to gross).
    for (const f of AMOUNT_FIELDS) {
      if (present.every((p) => p[f] !== undefined)) out[f] = addDecimalStrings(present.map((p) => p[f]!));
    }
    return out;
  });
  return { windows };
}
