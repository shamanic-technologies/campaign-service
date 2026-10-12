import { z } from "zod";

/**
 * WHICH SOURCES FEED WHICH OUTREACH CHANNEL is features-service's fact (owner 2026-10-12, one owner per fact):
 * `lib/sourcing-origins.ts` there, served at its public `GET /public/sourcing-origins`. This service READS it and
 * holds no copy: a hand-kept copy drifted on 2026-10-12 (features added "CRM contacts feed WhatsApp",
 * the copy did not, a live WhatsApp campaign served nobody for ~40 min, hotfix v0.75.42).
 *
 * What is read, verbatim:
 *   - `originsByChannel[channel]`: every SOURCE CAMPAIGN slug that may feed the channel (its origins and, where
 *     features says so, Lead Sourcing);
 *   - `leadSourcing.slug`: the one entry of that list that is not an origin (it picks among the others);
 *   - `origins[]`: each origin's `live` flag and `displayOrder`.
 *
 * Derived here, in code, from that answer only:
 *   - `originsByChannel` (this side) = features' list minus Lead Sourcing, in features' order: the slugs a SPEND
 *     read counts (lib/channel-spend.ts);
 *   - `feedingByChannel` = those origins, then Lead Sourcing when features lists it on the channel;
 *   - `defaultOriginByChannel` = among the channel's origins, the LIVE one with the lowest `displayOrder` (features'
 *     own first-listed live origin). None live = no default (the channel births no source).
 *
 * CACHE AND FAILURE (it sits on gate-check's money path): an answer is fresh for 60s; past that the cached answer is
 * served while ONE background re-read runs, so a features deploy is picked up within about a minute. A failed re-read
 * is logged loud and the last good answer keeps serving for up to an hour (the map changes on deploys only). With
 * nothing good to serve (cold boot, or an hour of failures) the read THROWS: every caller holds, never reads it as
 * "no origins" (that would be zero sourcing spend).
 */

export const SOURCING_MAP_FRESH_MS = 60_000;
export const SOURCING_MAP_STALE_MAX_MS = 60 * 60_000;
const READ_TIMEOUT_MS = 10_000;

export interface SourcingMap {
  /** Channel -> the origins whose spend it counts (no Lead Sourcing). */
  originsByChannel: Readonly<Record<string, readonly string[]>>;
  /** Channel -> every source campaign slug that may feed it (origins, then Lead Sourcing where listed). */
  feedingByChannel: Readonly<Record<string, readonly string[]>>;
  /** Channel -> the origin a new offer starts with. Absent = none. */
  defaultOriginByChannel: Readonly<Record<string, string>>;
}

export class SourcingMapUnavailableError extends Error {
  constructor(detail: string) {
    super(`features-service sourcing origins unreadable: ${detail}`);
    this.name = "SourcingMapUnavailableError";
  }
}

const SourcingOriginsResponse = z.object({
  origins: z.array(z.object({ slug: z.string().min(1), live: z.boolean(), displayOrder: z.number() })),
  originsByChannel: z.record(z.string(), z.array(z.string().min(1))),
  leadSourcing: z.object({ slug: z.string().min(1) }),
});

/** The map this service uses, derived from features-service's answer (rules in the header). */
export function deriveSourcingMap(body: unknown): SourcingMap {
  const parsed = SourcingOriginsResponse.parse(body);
  const leadSourcing = parsed.leadSourcing.slug;
  const order = new Map(parsed.origins.map((o) => [o.slug, o]));
  const originsByChannel: Record<string, string[]> = {};
  const feedingByChannel: Record<string, string[]> = {};
  const defaultOriginByChannel: Record<string, string> = {};
  for (const [channel, listed] of Object.entries(parsed.originsByChannel)) {
    const origins = listed.filter((s) => s !== leadSourcing);
    originsByChannel[channel] = origins;
    feedingByChannel[channel] = listed.includes(leadSourcing) ? [...origins, leadSourcing] : [...origins];
    const live = origins
      .map((s) => order.get(s))
      .filter((o): o is NonNullable<typeof o> => !!o && o.live)
      .sort((a, b) => a.displayOrder - b.displayOrder);
    if (live[0]) defaultOriginByChannel[channel] = live[0].slug;
  }
  return { originsByChannel, feedingByChannel, defaultOriginByChannel };
}

async function fetchSourcingMap(): Promise<SourcingMap> {
  const baseUrl = process.env.FEATURES_SERVICE_URL;
  if (!baseUrl) throw new SourcingMapUnavailableError("FEATURES_SERVICE_URL not set");
  let res: Response;
  try {
    res = await fetch(`${baseUrl.replace(/\/$/, "")}/public/sourcing-origins`, { signal: AbortSignal.timeout(READ_TIMEOUT_MS) });
  } catch (err) {
    throw new SourcingMapUnavailableError(err instanceof Error ? err.message : String(err));
  }
  if (!res.ok) throw new SourcingMapUnavailableError(`HTTP ${res.status}`);
  try {
    return deriveSourcingMap(await res.json());
  } catch (err) {
    throw new SourcingMapUnavailableError(`unexpected answer: ${err instanceof Error ? err.message : String(err)}`);
  }
}

let cached: { map: SourcingMap; readAt: number } | null = null;
let inFlight: Promise<SourcingMap> | null = null;

function refresh(): Promise<SourcingMap> {
  if (!inFlight) {
    inFlight = fetchSourcingMap()
      .then((map) => {
        cached = { map, readAt: Date.now() };
        return map;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

/** features-service's sourcing map (cached, see header). Throws SourcingMapUnavailableError when there is no good answer. */
export async function readSourcingMap(now: number = Date.now()): Promise<SourcingMap> {
  if (cached && now - cached.readAt < SOURCING_MAP_FRESH_MS) return cached.map;
  if (cached && now - cached.readAt < SOURCING_MAP_STALE_MAX_MS) {
    const served = cached;
    refresh().catch((err) =>
      console.error(
        `[campaign-service] features-service sourcing origins re-read FAILED, serving the answer read at ${new Date(served.readAt).toISOString()}: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
    return served.map;
  }
  try {
    return await refresh();
  } catch (err) {
    console.error(`[campaign-service] features-service sourcing origins UNREADABLE and no good answer to serve: every sourced read holds: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }
}

/** Tests only: forget the cached answer. */
export function resetSourcingMapCache(): void {
  cached = null;
  inFlight = null;
}
