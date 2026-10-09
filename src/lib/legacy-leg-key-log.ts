import type { Request, Response, NextFunction } from "express";
import { isLegacyOutboundSpelling } from "./leg-identity.js";

/**
 * THE SIGNAL THE LEGACY SWITCH-OFF WAITS ON (owner, 2026-10-09).
 *
 * The outbound leg keys were renamed (`leg-identity.ts`); this service still ACCEPTS the legacy
 * spelling on every input. The owner switches that tolerance off once we MEASURE that nobody sends
 * it any more: 7 days with zero `legacy-outbound-leg-key` lines in the container log. So every
 * request carrying a legacy outbound spelling (query, body, or a combination key embedding one)
 * writes ONE `warn` line naming the keys, the route and the caller's identity headers (`x-run-id`
 * names the calling service in runs-service). Logging only: the request is handled unchanged.
 *
 * Which channel a key belongs to: a combination part's own `@<channel>`; else the `featureSlug`
 * of the object holding the key, of the body/query, or the `x-feature-slug` header. A stated
 * non-outbound channel (google-ads) never logs; no stated channel logs (the channel-less filter
 * still widens to outbound rows, so the tolerance is in use).
 */
export const LEGACY_LEG_KEY_MARKER = "legacy-outbound-leg-key";

export interface LegacyLegKeyHit {
  path: string;
  legKey: string;
  featureSlug: string | null;
}

function featureOf(node: unknown): string | null {
  if (node && typeof node === "object" && !Array.isArray(node)) {
    const slug = (node as Record<string, unknown>).featureSlug;
    if (typeof slug === "string" && slug) return slug;
  }
  return null;
}

function hitsInString(value: string, path: string, featureSlug: string | null, out: LegacyLegKeyHit[]): void {
  for (const piece of value.split(/[+,]/)) {
    const at = piece.lastIndexOf("@");
    const leg = at > 0 ? piece.slice(0, at) : piece;
    const channel = at > 0 ? piece.slice(at + 1) : featureSlug;
    if (isLegacyOutboundSpelling(channel, leg)) out.push({ path, legKey: leg, featureSlug: channel || null });
  }
}

function walk(node: unknown, path: string, featureSlug: string | null, out: LegacyLegKeyHit[], depth: number): void {
  if (depth > 8 || node === null || node === undefined) return;
  if (typeof node === "string") return hitsInString(node, path, featureSlug, out);
  if (Array.isArray(node)) {
    node.forEach((item, i) => walk(item, `${path}[${i}]`, featureSlug, out, depth + 1));
    return;
  }
  if (typeof node === "object") {
    const own = featureOf(node) ?? featureSlug;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === "featureSlug") continue;
      walk(value, path ? `${path}.${key}` : key, own, out, depth + 1);
    }
  }
}

/** Every legacy outbound leg spelling in a request's query and body (pure, for tests). */
export function findLegacyOutboundLegKeys(
  input: { query?: unknown; body?: unknown },
  headerFeatureSlug: string | null,
): LegacyLegKeyHit[] {
  const out: LegacyLegKeyHit[] = [];
  walk(input.query, "query", featureOf(input.query) ?? featureOf(input.body) ?? headerFeatureSlug, out, 0);
  walk(input.body, "body", featureOf(input.body) ?? featureOf(input.query) ?? headerFeatureSlug, out, 0);
  return out;
}

function header(req: Request, name: string): string | null {
  const value = req.headers[name];
  return typeof value === "string" && value ? value : null;
}

/** Express middleware: one `warn` line per request carrying a legacy outbound spelling. Never throws. */
export function logLegacyOutboundLegKeys(req: Request, _res: Response, next: NextFunction): void {
  try {
    const hits = findLegacyOutboundLegKeys({ query: req.query, body: req.body }, header(req, "x-feature-slug"));
    if (hits.length > 0) {
      console.warn(`[campaign-service] ${LEGACY_LEG_KEY_MARKER}`, JSON.stringify({
        method: req.method,
        route: req.path,
        keys: hits,
        caller: {
          runId: header(req, "x-run-id"),
          orgId: header(req, "x-org-id"),
          userId: header(req, "x-user-id"),
          featureSlug: header(req, "x-feature-slug"),
          userAgent: header(req, "user-agent"),
        },
      }));
    }
  } catch (err) {
    console.error(`[campaign-service] ${LEGACY_LEG_KEY_MARKER} scan failed`, err);
  }
  next();
}
