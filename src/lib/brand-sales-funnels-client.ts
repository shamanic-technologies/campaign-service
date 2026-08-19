import type { IdentityHeaders } from "@distribute/runs-client";
import { toFunnelKey, type SalesFunnelKey } from "./sales-funnel-vocabulary.js";

/**
 * One sales funnel a brand has declared it sells through, as brand-service reports it.
 *
 * A funnel is one chain from the first signal outreach can buy (a positive reply, or a click
 * onto the site) down to a paid client. The KEY is the only field this service needs: it names
 * what the campaign sells, it is what the campaign states on its own row, and it is what billing
 * holds that funnel's ceiling under.
 *
 * There is no goal here any more. brand-service retired the goal set (#434) because it was the
 * poorer of its two words — both meeting funnels collapsed onto one `meetingBooked` — and it now
 * emits the funnel and nothing else. Reading a goal off this payload is what would have stopped
 * every funnel campaign being provisioned the moment that shipped.
 */
export interface DeclaredSalesFunnel {
  /**
   * Canonical: sales_meetings_from_conversation | sales_meetings_from_website | website_purchases
   * | form_magnet. A pre-rename spelling on the wire is resolved to its canonical key here, so no
   * caller downstream ever sees two names for one funnel.
   */
  funnelKey: SalesFunnelKey;
  active: boolean;
}

/**
 * The answer to "which funnels are sold through here?", with the three outcomes kept apart.
 *
 * They used to be one `null`, and that is what made the offer level dangerous: brand-service
 * REFUSES a brand-keyed read on a brand holding several offers rather than guessing which one the
 * caller meant, and a refusal collapsed onto `null` is indistinguishable from the service being
 * unreachable and from the org having declared nothing at all. The consequence was silent — the
 * day a customer creates their second offer, the brand simply looks like it declares no funnels
 * and its campaigns stop being provisioned, with nothing logged about an offer anywhere.
 *
 *  - `ok` + funnels — a truthful answer. An EMPTY list is one of them: the org has declared
 *    nothing yet, and per brand-service's own contract we never substitute a plausible set for it.
 *  - `ambiguous` — brand-service will not answer at this grain because the key names more than one
 *    configuration (several offers on the brand, or several orgs claiming it). This service asked
 *    the wrong question; it is never treated as an empty set, and it is LOUD.
 *  - `unavailable` — missing config, transport failure, non-2xx, unparseable payload. Nothing is
 *    known this tick.
 *  - `unknown_offer` — the offer id names nothing brand-service holds (404 on the offer read).
 *    Distinct from `unavailable` because it does not fix itself by retrying.
 */
export type SalesFunnelsRead =
  | { ok: true; funnels: DeclaredSalesFunnel[] }
  | { ok: false; reason: "ambiguous" | "unavailable" | "unknown_offer"; detail: string };

/**
 * The refusal codes that mean "your key names more than one configuration, so there is no single
 * answer" — whatever status brand-service dresses them in. Status 409 alone is enough; these are
 * matched as well because a refusal must never be read as an empty set if it arrives as a 400.
 */
const AMBIGUITY_CODES = new Set([
  "OFFER_REQUIRED",
  "MULTIPLE_OFFERS",
  "AMBIGUOUS_OFFER",
  "ORG_REQUIRED",
]);

function headersFor(identity: IdentityHeaders, apiKey: string, brandId?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "x-api-key": apiKey,
    // Per-brand configuration belongs to the (org, brand) pair — name the org rather than let
    // brand-service pick one for a brand several orgs claim. An offer belongs to that same pair,
    // so the org is named on the offer read too.
    "x-org-id": identity.orgId,
  };
  if (brandId) headers["x-brand-id"] = brandId;
  if (identity.userId) headers["x-user-id"] = identity.userId;
  if (identity.runId) headers["x-run-id"] = identity.runId;
  if (identity.campaignId) headers["x-campaign-id"] = identity.campaignId;
  if (identity.workflowSlug) headers["x-workflow-slug"] = identity.workflowSlug;
  return headers;
}

/** Only ACTIVE funnels reach a caller — a funnel the org switched off must never be worked. */
function parseFunnels(data: unknown): DeclaredSalesFunnel[] | null {
  const payload = data as { funnels?: Array<{ funnelKey?: string; active?: boolean }> };
  if (!Array.isArray(payload?.funnels)) return null;

  const funnels: DeclaredSalesFunnel[] = [];
  for (const raw of payload.funnels) {
    // Any spelling in, one canonical token out. A key neither catalogue names is skipped rather
    // than worked: this service can only run a funnel it has a name for.
    const funnelKey = toFunnelKey(raw?.funnelKey);
    if (!funnelKey) continue;
    if (raw.active === false) continue;
    funnels.push({ funnelKey, active: true });
  }
  return funnels;
}

async function readSalesFunnels(
  path: string,
  headers: Record<string, string>,
  baseUrl: string,
  what: string,
  // What a 404 means at this grain: an offer id that names nothing is a caller error that retrying
  // never fixes; a brand-keyed 404 is just "nothing known this tick".
  notFound: "unknown_offer" | "unavailable",
): Promise<SalesFunnelsRead> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, { headers });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      let code: string | undefined;
      try {
        const parsed = JSON.parse(body) as { code?: string; error?: { code?: string } };
        code = parsed?.code ?? parsed?.error?.code;
      } catch {
        code = undefined;
      }
      if (res.status === 409 || (code && AMBIGUITY_CODES.has(code))) {
        return {
          ok: false,
          reason: "ambiguous",
          detail: `${what}: brand-service refuses this grain (${res.status}${code ? ` ${code}` : ""})`,
        };
      }
      if (res.status === 404) {
        return { ok: false, reason: notFound, detail: `${what}: 404` };
      }
      return { ok: false, reason: "unavailable", detail: `${what}: HTTP ${res.status}` };
    }

    const funnels = parseFunnels(await res.json());
    if (!funnels) return { ok: false, reason: "unavailable", detail: `${what}: unparseable payload` };
    return { ok: true, funnels };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: "unavailable", detail: `${what}: ${message}` };
  }
}

/**
 * Read the funnels ONE OFFER is sold through — the grain that has exactly one answer.
 *
 * Contract (brand-service): GET /internal/offers/{offerId}/sales-funnels (x-api-key)
 *   -> { funnels: [{ funnelKey, active, name, steps, rates, ... }] }
 *
 * A campaign already states the offer it sells, so this is the question this service can always
 * ask unambiguously: a brand selling ten offers has ten answers here and no ambiguity in any of
 * them. A 404 is a caller error (an id that names nothing), NOT an unconfigured brand.
 */
export async function fetchOfferSalesFunnels(
  offerId: string,
  identity: IdentityHeaders,
): Promise<SalesFunnelsRead> {
  const url = process.env.BRAND_SERVICE_URL;
  const apiKey = process.env.BRAND_SERVICE_API_KEY;
  if (!url || !apiKey) {
    return { ok: false, reason: "unavailable", detail: "brand-service not configured" };
  }

  return readSalesFunnels(
    `/internal/offers/${encodeURIComponent(offerId)}/sales-funnels`,
    headersFor(identity, apiKey),
    url,
    `offer ${offerId}`,
    "unknown_offer",
  );
}

/**
 * Read the funnels a BRAND has declared it sells through — the pre-offer grain.
 *
 * Contract (brand-service): GET /internal/brands/{brandId}/sales-funnels (x-api-key [+ x-org-id])
 *   -> { funnels: [...] }
 *
 * Kept for the one population it still answers for: a campaign that states NO offer, which
 * behaves exactly as it did before offers existed. On a brand holding several offers this read is
 * REFUSED (`ambiguous`) — that refusal is the whole reason the offer-grain read above exists, and
 * it must never be laundered into an empty set here.
 */
export async function fetchBrandSalesFunnels(
  brandId: string,
  identity: IdentityHeaders,
): Promise<SalesFunnelsRead> {
  const url = process.env.BRAND_SERVICE_URL;
  const apiKey = process.env.BRAND_SERVICE_API_KEY;
  if (!url || !apiKey) {
    return { ok: false, reason: "unavailable", detail: "brand-service not configured" };
  }

  return readSalesFunnels(
    `/internal/brands/${encodeURIComponent(brandId)}/sales-funnels`,
    headersFor(identity, apiKey, brandId),
    url,
    `brand ${brandId}`,
    "unavailable",
  );
}
