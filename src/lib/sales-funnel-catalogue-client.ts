import { z } from "zod";
import { isSourceOriginSlug } from "./source-campaigns.js";

/**
 * features-service's AGENT CATALOGUE, read for what a sales funnel campaign is made of (owner
 * 2026-10-10, "chat first"). Two reads, both internal (api-key), both LOCKED on its side:
 *
 *   GET /internal/catalogue/sales-funnels/{id}  → name + legs[]: each leg names the PIPE that works
 *                                                 it, or null when nobody on the platform does (the
 *                                                 customer's own team works that leg).
 *   GET /internal/catalogue/pipes/{id}          → the pipe's channel slug, leg key and mode.
 *
 * A pipe id is `<channel slug>|<leg key>` and a funnel id is its `combinationKey`; both are carried
 * VERBATIM and URL-encoded (a funnel id holds `+` and `@`, a pipe id `|`). Neither is parsed here:
 * the pipe read states its channel and leg, so nothing splits an id.
 *
 * Every non-2xx is a failure the caller turns into a refusal, except a 404, which is a TRUE answer
 * ("features-service does not publish this id") and is named apart so the customer is told so.
 */

export type CatalogueRead<T> =
  | { ok: true; value: T }
  | { ok: false; notFound: true; detail: string }
  | { ok: false; notFound: false; detail: string };

export interface SalesFunnelFromCatalogue {
  id: string;
  name: string;
  /** Pipe ids, in leg order, of the legs a platform channel works. Legs with no pipe are skipped. */
  pipeIds: string[];
  /**
   * Every leg in order, with its pipe and the channels the catalogue lists on it. A leg names no
   * pipe either because several lead SOURCES feed it (Start → Lead found) or because nothing works
   * it: the second is a funnel with a hole (`legsWithoutChannel`), never launched or converted.
   */
  legs: Array<{ legKey: string; pipe: { id: string; mode: "proactive" | "reactive" } | null; channelIds: string[] }>;
}

export interface PipeFromCatalogue {
  id: string;
  name: string | null;
  channelSlug: string;
  legKey: string;
  mode: "proactive" | "reactive";
}

const SalesFunnelResponse = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  legs: z.array(
    z.object({
      legKey: z.string().min(1),
      pipe: z.object({ id: z.string().min(1), mode: z.enum(["proactive", "reactive"]) }).nullable(),
      channels: z.array(z.object({ id: z.string().min(1) })),
    }),
  ),
});

const PipeResponse = z.object({
  id: z.string().min(1),
  name: z.string().nullable(),
  channelSlug: z.string().min(1),
  legKey: z.string().min(1),
  mode: z.enum(["proactive", "reactive"]),
});

async function readCatalogue<T>(path: string, parse: (body: unknown) => T): Promise<CatalogueRead<T>> {
  const baseUrl = process.env.FEATURES_SERVICE_URL;
  const apiKey = process.env.FEATURES_SERVICE_API_KEY;
  if (!baseUrl || !apiKey) return { ok: false, notFound: false, detail: "features-service not configured" };
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, {
      headers: { "x-api-key": apiKey },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 404) return { ok: false, notFound: true, detail: `features-service 404 on ${path}` };
    if (!res.ok) return { ok: false, notFound: false, detail: `features-service HTTP ${res.status} on ${path}` };
    return { ok: true, value: parse(await res.json()) };
  } catch (err) {
    return { ok: false, notFound: false, detail: `${path}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function fetchSalesFunnel(salesFunnelId: string): Promise<CatalogueRead<SalesFunnelFromCatalogue>> {
  return readCatalogue(`/internal/catalogue/sales-funnels/${encodeURIComponent(salesFunnelId)}`, (body) => {
    const parsed = SalesFunnelResponse.parse(body);
    return {
      id: parsed.id,
      name: parsed.name,
      pipeIds: parsed.legs.flatMap((leg) => (leg.pipe ? [leg.pipe.id] : [])),
      legs: parsed.legs.map((leg) => ({
        legKey: leg.legKey,
        pipe: leg.pipe ? { id: leg.pipe.id, mode: leg.pipe.mode } : null,
        channelIds: leg.channels.map((c) => c.id),
      })),
    };
  });
}

/**
 * A leg is a SOURCING leg when every channel it lists is a lead-source origin: the catalogue names
 * no single pipe on it because several sources may feed it at once (lib/source-campaigns.ts).
 */
export function isSourcingLeg(leg: Pick<SalesFunnelFromCatalogue["legs"][number], "channelIds">): boolean {
  return leg.channelIds.length > 0 && leg.channelIds.every(isSourceOriginSlug);
}

/**
 * The legs of a funnel NOTHING works (owner 2026-10-11: "a sales funnel never has a leg without a
 * channel; a human leg is the channel Your team"). A sourcing leg is not one of them. A funnel
 * listing any is refused at launch and never chosen by the conversion.
 */
export function legsWithoutChannel(funnel: Pick<SalesFunnelFromCatalogue, "legs">): string[] {
  return funnel.legs.filter((leg) => leg.pipe === null && !isSourcingLeg(leg)).map((leg) => leg.legKey);
}

/**
 * The funnel id of a chain of pipes, one per leg (features-service `POST /internal/catalogue/sales-funnels`:
 * idempotent, 200 with the existing funnel, 201 when it declares it). The catalogue mints the id; this service
 * never builds one.
 */
export async function declareSalesFunnel(pipeIds: string[], createdBy: string): Promise<CatalogueRead<{ id: string }>> {
  const baseUrl = process.env.FEATURES_SERVICE_URL;
  const apiKey = process.env.FEATURES_SERVICE_API_KEY;
  if (!baseUrl || !apiKey) return { ok: false, notFound: false, detail: "features-service not configured" };
  const path = "/internal/catalogue/sales-funnels";
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, {
      method: "POST",
      headers: { "x-api-key": apiKey, "content-type": "application/json" },
      body: JSON.stringify({ pipeIds, createdBy }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return { ok: false, notFound: res.status === 404, detail: `features-service HTTP ${res.status} on POST ${path}: ${(await res.text()).slice(0, 300)}` };
    return { ok: true, value: z.object({ id: z.string().min(1) }).parse(await res.json()) };
  } catch (err) {
    return { ok: false, notFound: false, detail: `POST ${path}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function fetchPipe(pipeId: string): Promise<CatalogueRead<PipeFromCatalogue>> {
  return readCatalogue(`/internal/catalogue/pipes/${encodeURIComponent(pipeId)}`, (body) => PipeResponse.parse(body));
}

/**
 * Sales funnel ids the catalogue's text search finds for `q` (it searches name, line AND id), at
 * most 25 (the list's cap). A search, not a parse: callers confirm each candidate on its detail.
 */
export async function searchSalesFunnelIds(
  q: string,
  containsChannel: string,
  salesPathId?: string,
): Promise<CatalogueRead<string[]>> {
  const params = new URLSearchParams({ q, containsChannels: containsChannel, limit: "25" });
  if (salesPathId) params.set("paths", salesPathId);
  return readCatalogue(`/internal/catalogue/sales-funnels?${params.toString()}`, (body) =>
    z.object({ rows: z.array(z.object({ id: z.string() })) }).parse(body).rows.map((r) => r.id));
}

/**
 * Sales path ids the catalogue's text search finds for `q`, with each path's served `type`
 * (`proactive` | `reactive`, features-service v0.179.125). At most 25.
 */
export async function searchSalesPaths(q: string): Promise<CatalogueRead<Array<{ id: string; type: string | null }>>> {
  const params = new URLSearchParams({ q, limit: "25" });
  return readCatalogue(`/internal/catalogue/sales-paths?${params.toString()}`, (body) =>
    z.object({ rows: z.array(z.object({ id: z.string(), type: z.string().nullable().optional() })) })
      .parse(body).rows.map((r) => ({ id: r.id, type: r.type ?? null })));
}
