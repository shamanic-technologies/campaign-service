import { combinationIdentity } from "./leg-identity.js";
import type { IdentityHeaders } from "@distribute/runs-client";
import { buildServiceHeaders } from "./downstream-headers.js";

/**
 * REACTIVE CAMPAIGNS ARE ON BY DEFAULT (owner, 2026-10-05).
 *
 * A REACTIVE campaign works a leg OUT of a step a lead already reached (it fires on that step, its
 * spend follows the leads earlier legs deliver). A reactive campaign that a TICKED sales path of
 * the offer uses is ON unless a person turned it off.
 *
 * WHICH PATHS ARE TICKED is the customer's statement, held by brand-service
 * (`GET /internal/offers/:offerId/selected-sales-paths`: features-service combinationKeys, `stated`
 * false = never stated). Never stated = the paths whose ROI is above 1 in features-service's
 * `GET /offers/:offerId/sales-paths?scope=catalogue` (the same default the dashboard pre-ticks).
 * Each path row serves its legs with `reactive` and the channel THAT row works each leg on, so the
 * reactive (leg, channel) pairs are read off the row verbatim: nothing is parsed out of a key.
 *
 * WHEN it is applied (never by a tick, never by ROI moving on its own):
 *   - a PERSON turns a proactive campaign of the offer ON (fire-and-forget after the start), and
 *   - a PERSON saves the offer's sales paths (`POST /offers/:offerId/reactive-defaults`).
 *
 * WHAT it does: a pair with NO campaign row is created ON (source `reactive_default`, billing
 * signalled with the person as actor). A pair whose campaign is ON stays. A pair whose campaign
 * is STOPPED stays stopped, whatever stopped it: a person's off is final, and a payment hold or a
 * teardown is never resumed by anything automatic either. Nothing is ever stopped here.
 *
 * This module only READS and PLANS; the write lives in routes/campaigns.ts (the one insert site
 * allowed beside campaign-status-history, see tests/unit/no-legacy.test.ts).
 */

export interface SelectedSalesPathsRead {
  stated: boolean;
  combinationKeys: string[] | null;
}

export interface CatalogueSalesPathLeg {
  legKey: string;
  reactive: boolean;
  workedBy: "platform" | "human" | null;
  channelSlug: string | null;
  /** The row's `channel.managed`: we run this channel today. */
  channelManaged: boolean;
}

export interface CatalogueSalesPath {
  combinationKey: string;
  roi: number | null;
  legs: CatalogueSalesPathLeg[];
}

export type Read<T> = { ok: true; value: T } | { ok: false; detail: string };

/** One reactive (leg, channel) a ticked path uses: the campaign that should be on by default. */
export interface ReactivePair {
  legKey: string;
  featureSlug: string;
  /** The ticked combinations that use it (for the answer, never for a decision). */
  combinationKeys: string[];
}

export interface ReactivePlan {
  /** Where the ticked set came from. */
  basis: "stated" | "roi_above_1";
  tickedCombinationKeys: string[];
  pairs: ReactivePair[];
}

/**
 * Pure: the reactive (leg, channel) pairs the offer's ticked paths use. A leg counts when the row
 * says it is reactive AND a platform channel we run works it there; a leg the customer's team works
 * (your-team-*, or no channel) has nothing for us to switch on.
 */
export function planReactiveDefaults(
  selected: SelectedSalesPathsRead,
  paths: readonly CatalogueSalesPath[],
): ReactivePlan {
  const basis: ReactivePlan["basis"] = selected.stated ? "stated" : "roi_above_1";
  // brand-service and features-service may spell an outbound leg differently mid-rename
  // (lib/leg-identity.ts): a ticked path is matched on the combination's identity.
  const stated = new Set((selected.combinationKeys ?? []).map(combinationIdentity));
  const ticked = paths.filter((p) =>
    selected.stated ? stated.has(combinationIdentity(p.combinationKey)) : p.roi !== null && p.roi > 1,
  );

  const byPair = new Map<string, ReactivePair>();
  for (const path of ticked) {
    for (const leg of path.legs) {
      if (!leg.reactive || leg.workedBy !== "platform" || !leg.channelSlug) continue;
      if (!leg.channelManaged) continue;
      const key = `${leg.legKey}@${leg.channelSlug}`;
      const pair = byPair.get(key) ?? { legKey: leg.legKey, featureSlug: leg.channelSlug, combinationKeys: [] };
      pair.combinationKeys.push(path.combinationKey);
      byPair.set(key, pair);
    }
  }
  return { basis, tickedCombinationKeys: ticked.map((p) => p.combinationKey), pairs: [...byPair.values()] };
}

/**
 * brand-service: GET /internal/offers/{offerId}/selected-sales-paths (x-api-key + x-org-id)
 *   -> { offerId, stated, combinationKeys: string[] | null, statedAt, statedByUserId }
 */
export async function fetchOfferSelectedSalesPaths(
  offerId: string,
  brandId: string,
  identity: IdentityHeaders,
): Promise<Read<SelectedSalesPathsRead>> {
  const baseUrl = process.env.BRAND_SERVICE_URL;
  const apiKey = process.env.BRAND_SERVICE_API_KEY;
  if (!baseUrl || !apiKey) return { ok: false, detail: "brand-service not configured" };
  const headers: Record<string, string> = { "x-api-key": apiKey, "x-org-id": identity.orgId, "x-brand-id": brandId };
  if (identity.userId) headers["x-user-id"] = identity.userId;
  if (identity.runId) headers["x-run-id"] = identity.runId;
  try {
    const res = await fetch(
      `${baseUrl.replace(/\/$/, "")}/internal/offers/${encodeURIComponent(offerId)}/selected-sales-paths`,
      { headers, signal: AbortSignal.timeout(10_000) },
    );
    if (!res.ok) return { ok: false, detail: `brand-service HTTP ${res.status}` };
    const data = (await res.json()) as { stated?: unknown; combinationKeys?: unknown };
    if (typeof data.stated !== "boolean") return { ok: false, detail: "brand-service states no `stated`" };
    if (data.stated && !Array.isArray(data.combinationKeys)) {
      return { ok: false, detail: "brand-service states paths but no combinationKeys array" };
    }
    const combinationKeys = Array.isArray(data.combinationKeys)
      ? data.combinationKeys.filter((k): k is string => typeof k === "string" && k.length > 0)
      : null;
    return { ok: true, value: { stated: data.stated, combinationKeys } };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * features-service: GET /offers/{offerId}/sales-paths?brandId=&scope=catalogue
 *   -> { status, paths: [{ combinationKey, roi, legs: [{ legKey, reactive, workedBy,
 *        channel: { slug, managed } | null }] }] }
 */
export async function fetchOfferCatalogueSalesPaths(
  offerId: string,
  brandId: string,
  identity: IdentityHeaders,
): Promise<Read<CatalogueSalesPath[]>> {
  const baseUrl = process.env.FEATURES_SERVICE_URL;
  const apiKey = process.env.FEATURES_SERVICE_API_KEY;
  if (!baseUrl || !apiKey) return { ok: false, detail: "features-service not configured" };
  const url = new URL(`${baseUrl.replace(/\/$/, "")}/offers/${encodeURIComponent(offerId)}/sales-paths`);
  url.searchParams.set("brandId", brandId);
  url.searchParams.set("scope", "catalogue");
  try {
    const res = await fetch(url, {
      headers: buildServiceHeaders(apiKey, {
        orgId: identity.orgId,
        userId: identity.userId ?? "",
        runId: identity.runId ?? "",
        campaignId: "",
        brandId,
        workflowSlug: null,
        featureSlug: "",
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return { ok: false, detail: `features-service HTTP ${res.status}` };
    const data = (await res.json()) as { paths?: unknown };
    if (!Array.isArray(data.paths)) return { ok: false, detail: "features-service states no paths array" };
    const paths: CatalogueSalesPath[] = [];
    for (const raw of data.paths as Array<Record<string, any>>) {
      if (typeof raw?.combinationKey !== "string" || !Array.isArray(raw.legs)) {
        return { ok: false, detail: "a path states no combinationKey or legs" };
      }
      const roi = typeof raw.roi === "number" && Number.isFinite(raw.roi) ? raw.roi : null;
      const legs: CatalogueSalesPathLeg[] = [];
      for (const leg of raw.legs as Array<Record<string, any>>) {
        if (typeof leg?.legKey !== "string" || typeof leg.reactive !== "boolean") {
          return { ok: false, detail: `path ${raw.combinationKey}: a leg states no legKey or reactive` };
        }
        const channel = leg.channel && typeof leg.channel === "object" ? leg.channel : null;
        legs.push({
          legKey: leg.legKey,
          reactive: leg.reactive,
          workedBy: leg.workedBy === "platform" || leg.workedBy === "human" ? leg.workedBy : null,
          channelSlug: typeof channel?.slug === "string" && channel.slug.length > 0 ? channel.slug : null,
          channelManaged: channel?.managed === true,
        });
      }
      paths.push({ combinationKey: raw.combinationKey, roi, legs });
    }
    return { ok: true, value: paths };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}
