import type { IdentityHeaders } from "@distribute/runs-client";
import { buildServiceHeaders } from "./downstream-headers.js";

/**
 * The offer's sales paths as features-service lists them (`GET /offers/:offerId/sales-paths?scope=catalogue`),
 * each row's legs with `reactive` and the channel that row works them on. Read by the funnel conversion
 * (`lib/sales-funnel-conversion.ts`) to pick the best-ROI funnel starting with a live pipe.
 *
 * The reactive DEFAULTS that used to read this beside brand-service's per-offer selected sales paths are
 * RETIRED (owner 2026-10-10: a campaign IS a sales funnel; reactive work runs as a reactive funnel campaign).
 */

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
