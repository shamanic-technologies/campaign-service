import { buildServiceHeaders } from "./downstream-headers.js";
import type { ProvisioningIdentity } from "./provisioning-identity.js";

/**
 * One sales path of an offer, narrowed to what the global-budget allocation reads: which ENTRY
 * (leg, channel) a budget behind this path buys, and its ROI. Every figure is features-service's —
 * this service ranks nothing itself beyond the order it is served in.
 */
export interface SalesPathEntry {
  rank: number;
  pathKey: string;
  /** The entry leg (from nothing) — joined VERBATIM against `campaigns.leg_key`. */
  entryLegKey: string;
  /** The channel chosen for the entry leg, or null when none of ours is priced for it. */
  entryChannelSlug: string | null;
  /** lifetimeRevenue ÷ costPerPayingClient. Null when unavailable (sorts last, still funded last). */
  roi: number | null;
}

export type OfferSalesPathsRead =
  | { ok: true; status: "ok" | "not_stated" | "no_legs_selected" | "no_complete_path"; paths: SalesPathEntry[] }
  | { ok: false; detail: string };

const STATUSES = new Set(["ok", "not_stated", "no_legs_selected", "no_complete_path"]);

/**
 * GET /offers/{offerId}/sales-paths?brandId= on features-service.
 *
 * ok:false on missing config, network error, non-2xx or an unparseable payload. The caller falls
 * back to fill-ratio pacing capped by the global budget — never to spending past it.
 */
export async function fetchOfferSalesPaths(
  offerId: string,
  brandId: string,
  identity: ProvisioningIdentity,
): Promise<OfferSalesPathsRead> {
  const baseUrl = process.env.FEATURES_SERVICE_URL;
  const apiKey = process.env.FEATURES_SERVICE_API_KEY;
  if (!baseUrl || !apiKey) return { ok: false, detail: "FEATURES_SERVICE_URL or FEATURES_SERVICE_API_KEY not configured" };

  const url = new URL(`${baseUrl.replace(/\/$/, "")}/offers/${encodeURIComponent(offerId)}/sales-paths`);
  url.searchParams.set("brandId", brandId);

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: buildServiceHeaders(apiKey, {
        orgId: identity.orgId,
        userId: identity.userId,
        runId: identity.runId,
        campaignId: identity.campaignId ?? "",
        brandId,
        workflowSlug: identity.workflowSlug ?? null,
        featureSlug: identity.featureSlug ?? "",
      }),
    });
    if (!res.ok) {
      let body = "";
      try {
        body = (await res.text()).slice(0, 200);
      } catch {
        body = "";
      }
      return { ok: false, detail: `HTTP ${res.status}${body ? ` ${body}` : ""}` };
    }
    const data = (await res.json()) as { status?: unknown; paths?: unknown };
    if (typeof data.status !== "string" || !STATUSES.has(data.status)) {
      return { ok: false, detail: `unknown status ${String(data.status)}` };
    }
    if (!Array.isArray(data.paths)) return { ok: false, detail: "response states no paths array" };
    const paths: SalesPathEntry[] = [];
    for (const raw of data.paths as Array<Record<string, unknown>>) {
      if (typeof raw?.entryLegKey !== "string" || raw.entryLegKey.length === 0) {
        return { ok: false, detail: "a path states no entryLegKey" };
      }
      const roi = raw.roi;
      if (roi !== null && (typeof roi !== "number" || !Number.isFinite(roi))) {
        return { ok: false, detail: `a path states an unreadable roi (${String(roi)})` };
      }
      paths.push({
        rank: typeof raw.rank === "number" ? raw.rank : Number.MAX_SAFE_INTEGER,
        pathKey: typeof raw.pathKey === "string" ? raw.pathKey : raw.entryLegKey,
        entryLegKey: raw.entryLegKey,
        entryChannelSlug:
          typeof raw.entryChannelSlug === "string" && raw.entryChannelSlug.length > 0 ? raw.entryChannelSlug : null,
        roi: roi as number | null,
      });
    }
    return { ok: true, status: data.status as "ok", paths };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}
