import { z } from "zod";

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
  /** Every leg in order, with its pipe (null = the customer's own team works it). */
  legs: Array<{ legKey: string; pipe: { id: string; mode: "proactive" | "reactive" } | null }>;
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
      legs: parsed.legs.map((leg) => ({ legKey: leg.legKey, pipe: leg.pipe ? { id: leg.pipe.id, mode: leg.pipe.mode } : null })),
    };
  });
}

export async function fetchPipe(pipeId: string): Promise<CatalogueRead<PipeFromCatalogue>> {
  return readCatalogue(`/internal/catalogue/pipes/${encodeURIComponent(pipeId)}`, (body) => PipeResponse.parse(body));
}

/**
 * Sales funnel ids the catalogue's text search finds for `q` (it searches name, line AND id), at
 * most 25 (the list's cap). A search, not a parse: callers confirm each candidate on its detail.
 */
export async function searchSalesFunnelIds(q: string, containsChannel: string): Promise<CatalogueRead<string[]>> {
  const params = new URLSearchParams({ q, containsChannels: containsChannel, limit: "25" });
  return readCatalogue(`/internal/catalogue/sales-funnels?${params.toString()}`, (body) =>
    z.object({ rows: z.array(z.object({ id: z.string() })) }).parse(body).rows.map((r) => r.id));
}
