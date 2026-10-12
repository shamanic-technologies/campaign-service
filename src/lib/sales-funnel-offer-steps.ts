import { z } from "zod";
import type { IdentityHeaders } from "@distribute/runs-client";

/**
 * THE STEPS AN OFFER'S BUSINESS HAS (owner 2026-10-12): brand-service's statement of which funnel steps the client
 * said its business goes through for one offer (Positive reply, Booking call, Meeting booked, Direct purchase...).
 * Read before a sales funnel campaign is CREATED, so a funnel through a step the business does not have is never
 * born (`resolveSalesFunnelPlan`). Incident: two Doc Dinners funnels went through Direct purchase
 * although Doc Dinners had said on 2026-10-08 it has no purchase step.
 *
 * Contract (brand-service): GET /orgs/brands/{brandId}/offers/{offerId}/steps  (x-api-key + x-org-id)
 *   -> { offerId, stated, steps, statedAt }
 * `stated: false` (steps null) = the offer never said: nothing is known, nothing is filtered.
 * `stated: true` = `steps` is the full list of step keys its business has (empty = it removed every one).
 * The org is load-bearing: an offer belongs to the (org, brand) pair (brand-offers-client.ts).
 *
 * The outcomes are kept apart: a 404 is a TRUE answer (this offer is not on this brand), anything else that is not
 * a 2xx is UNREADABLE and the caller refuses the launch (never a campaign created on a guess).
 */
export type OfferStepsRead =
  | { ok: true; stated: false }
  | { ok: true; stated: true; steps: string[] }
  | { ok: false; notFound: boolean; detail: string };

const OfferStepsResponse = z.object({
  stated: z.boolean(),
  steps: z.array(z.string()).nullable(),
});

export async function fetchOfferSteps(
  brandId: string,
  offerId: string,
  identity: IdentityHeaders,
): Promise<OfferStepsRead> {
  const baseUrl = process.env.BRAND_SERVICE_URL;
  const apiKey = process.env.BRAND_SERVICE_API_KEY;
  if (!baseUrl || !apiKey) return { ok: false, notFound: false, detail: "brand-service not configured" };

  const headers: Record<string, string> = { "x-api-key": apiKey, "x-org-id": identity.orgId, "x-brand-id": brandId };
  if (identity.userId) headers["x-user-id"] = identity.userId;
  if (identity.runId) headers["x-run-id"] = identity.runId;
  const path = `/orgs/brands/${encodeURIComponent(brandId)}/offers/${encodeURIComponent(offerId)}/steps`;
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, { headers, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 300);
      return { ok: false, notFound: res.status === 404, detail: `brand-service HTTP ${res.status} on ${path}: ${body}` };
    }
    const parsed = OfferStepsResponse.safeParse(await res.json());
    if (!parsed.success) return { ok: false, notFound: false, detail: `brand-service ${path}: unparseable payload` };
    if (!parsed.data.stated) return { ok: true, stated: false };
    if (!parsed.data.steps) return { ok: false, notFound: false, detail: `brand-service ${path}: stated with no steps list` };
    return { ok: true, stated: true, steps: parsed.data.steps };
  } catch (err) {
    return { ok: false, notFound: false, detail: `${path}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * The steps EVERY business has by definition, never stated on an offer: a funnel starts at "Start" (no step key, a
 * leg from nothing), every person it works is a lead found, and every funnel terminates in a paying client.
 * Counted as always present, or every funnel would be refused.
 */
export const ALWAYS_PRESENT_STEPS: ReadonlySet<string> = new Set(["lead_found", "paid_client"]);

/**
 * The steps of a funnel the offer's business has NOT stated, in funnel order, without duplicates. `salesFunnelSteps` are
 * the step keys the funnel's legs connect (catalogue `legs[].fromStep/toStep`, read never derived).
 */
export function missingOfferSteps(salesFunnelSteps: readonly string[], statedSteps: readonly string[]): string[] {
  const stated = new Set(statedSteps);
  const missing: string[] = [];
  for (const step of salesFunnelSteps) {
    if (ALWAYS_PRESENT_STEPS.has(step) || stated.has(step) || missing.includes(step)) continue;
    missing.push(step);
  }
  return missing;
}
