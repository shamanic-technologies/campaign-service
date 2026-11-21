/**
 * ONE-CAMPAIGN-VOLUME-1122 (owner 2026-11-22: « un volume d'outcome par jour / week ou mois ... Dessous, mettre un
 * budget max »): a client states, on the ONE campaign they create or edit, the volume they want per period and the max
 * budget per period. Both are billing's caps of THAT funnel campaign (billing `PUT .../sales-funnels/:id/campaigns/
 * :salesFunnelCampaignId/caps`, the per-campaign cap every unit of it is held to, migration 0083 there): written here
 * in the same request, never stored here, never recomputed here. What a max volume counts (meetings booked for a
 * campaign targeting them) is billing's.
 *
 * Both halves are one billing statement (its body requires both keys): a half the caller leaves out keeps the
 * campaign's OWN cap billing holds now (a funnel-wide cap is never copied onto the campaign), else none.
 */
import type { SalesFunnelCampaign } from "../db/schema.js";
import { billingCapsPath, resetSalesFunnelCapsCache } from "./sales-funnel-campaigns.js";

export type CapPeriod = "one_off" | "daily" | "weekly" | "monthly";
export interface MaxBudgetStatement {
  amountCents: number;
  period: CapPeriod;
}
export interface MaxVolumeStatement {
  count: number;
  period: CapPeriod;
}
/** undefined = not stated (kept), null = cleared. */
export interface StatedCampaignCaps {
  maxBudget?: MaxBudgetStatement | null;
  maxVolume?: MaxVolumeStatement | null;
}

export type CapsWrite = { ok: true; caps: unknown } | { ok: false; detail: string };

/** True when the request states at least one cap. Pure. */
export function statesCaps(stated: StatedCampaignCaps): boolean {
  return stated.maxBudget !== undefined || stated.maxVolume !== undefined;
}

/**
 * The body billing takes: each stated half as stated, each unstated half the campaign's OWN current cap (`own`, null
 * when billing holds none for this campaign). Pure.
 */
export function capsBody(
  stated: StatedCampaignCaps,
  own: { maxBudget: MaxBudgetStatement | null; maxVolume: MaxVolumeStatement | null } | null,
): { maxBudget: MaxBudgetStatement | null; maxVolume: MaxVolumeStatement | null } {
  return {
    maxBudget: stated.maxBudget !== undefined ? stated.maxBudget : (own?.maxBudget ?? null),
    maxVolume: stated.maxVolume !== undefined ? stated.maxVolume : (own?.maxVolume ?? null),
  };
}

function billingConfig(): { url: string; apiKey: string } | null {
  const url = process.env.BILLING_SERVICE_URL;
  const apiKey = process.env.BILLING_SERVICE_API_KEY;
  return url && apiKey ? { url: url.replace(/\/$/, ""), apiKey } : null;
}

/** The campaign's OWN caps at billing (null when it is held to the funnel-wide one, or to none). */
async function readOwnCaps(
  path: string,
  headers: Record<string, string>,
  base: string,
): Promise<{ ok: true; own: { maxBudget: MaxBudgetStatement | null; maxVolume: MaxVolumeStatement | null } | null } | { ok: false; detail: string }> {
  const res = await fetch(`${base}${path}`, { headers, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) return { ok: false, detail: `billing HTTP ${res.status} on GET ${path}` };
  const body = (await res.json()) as {
    capScope?: string;
    maxBudget?: { amountCents: string | number | null; period: CapPeriod } | null;
    maxVolume?: { count: number; period: CapPeriod } | null;
  };
  if (body.capScope !== "sales_funnel_campaign") return { ok: true, own: null };
  const amount = body.maxBudget?.amountCents;
  return {
    ok: true,
    own: {
      maxBudget: body.maxBudget && amount !== null && amount !== undefined ? { amountCents: Number(amount), period: body.maxBudget.period } : null,
      maxVolume: body.maxVolume ? { count: body.maxVolume.count, period: body.maxVolume.period } : null,
    },
  };
}

/**
 * Write the caps the caller stated on ONE funnel campaign, at billing, with the caller's identity (billing reports the
 * budget change itself). Never throws: an outage or a refusal is `{ ok: false }` with billing's words.
 */
export async function writeSalesFunnelCampaignCaps(
  parent: Pick<SalesFunnelCampaign, "id" | "orgId" | "brandId" | "offerId" | "salesFunnelId">,
  stated: StatedCampaignCaps,
  identity: { userId?: string | null; runId?: string | null },
): Promise<CapsWrite> {
  const config = billingConfig();
  if (!config) return { ok: false, detail: "billing-service not configured" };
  const path = billingCapsPath({
    brandId: parent.brandId,
    offerId: parent.offerId,
    salesFunnelId: parent.salesFunnelId,
    salesFunnelCampaignId: parent.id,
  });
  const headers: Record<string, string> = { "x-api-key": config.apiKey, "x-org-id": parent.orgId };
  if (identity.userId) headers["x-user-id"] = identity.userId;
  if (identity.runId) headers["x-run-id"] = identity.runId;
  try {
    let own = null;
    if (stated.maxBudget === undefined || stated.maxVolume === undefined) {
      const read = await readOwnCaps(path, headers, config.url);
      if (!read.ok) return read;
      own = read.own;
    }
    const res = await fetch(`${config.url}${path}`, {
      method: "PUT",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(capsBody(stated, own)),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, detail: `billing HTTP ${res.status} on PUT ${path}: ${text.slice(0, 500)}` };
    // The money path reads the new caps at once (a cached "not funded" would hold the first run).
    resetSalesFunnelCapsCache();
    return { ok: true, caps: text ? JSON.parse(text) : null };
  } catch (err) {
    return { ok: false, detail: `${path}: ${err instanceof Error ? err.message : String(err)}` };
  }
}
