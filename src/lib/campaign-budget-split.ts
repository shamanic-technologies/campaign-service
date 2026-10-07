import type { IdentityHeaders } from "@distribute/runs-client";
import type { CampaignBudgetEntry } from "./campaign-budget-client.js";

/**
 * A campaign's daily budget in TWO parts (billing v0.82.0, owner-approved 2026-10-07):
 *
 *   max daily spend (dailyBudgetCents) = OUTREACH (fixed $/day) + SOURCING ("on demand, up to $X/day")
 *
 * billing stores the split on the campaign's ceiling row and measures today's spend per part:
 * sourcing = the cost subtrees of the `lead-service:lead-serve` and `apollo-service:audience-companies`
 * runs under the campaign, outreach = the rest. The TOTAL keeps pacing exactly as before (gate-check
 * block a2); this module adds the two PART limits on top, for a split campaign only.
 *
 * THE RULE (gate-check, every run of a split campaign):
 *   - sourcing spent today >= its ceiling  -> refused, "Campaign sourcing budget reached"
 *     (no new lead can be sourced today);
 *   - outreach spent today >= its budget   -> refused, "Campaign outreach budget reached"
 *     (no new outreach today).
 *   Both are checked on every run: a cold-email run serves one lead THEN emails it, so it spends on
 *   both parts, and sourcing a lead nobody can email today is waste. A reactive leg (reply, booking)
 *   does not source, and billing states its sourcing part at $0, which gates nothing (next point).
 *   - A part stated at $0 gates NOTHING: it means the campaign is measured not to spend there (billing's
 *     migration set a 100%-sourcing CRM row to outreach $0, and every reactive channel to sourcing $0).
 *     Refusing at 0 >= 0 would block those campaigns forever. The total still binds them.
 *
 * Unsplit (any owned entry without a sourcing ceiling, mirroring billing's `splitOf`): nothing here
 * runs, no extra read is made, the gate decides exactly as before.
 *
 * Fail-CLOSED: today's split spend that cannot be read (billing non-2xx, its 502 on a runs-service
 * failure, an unparseable body) refuses the run, never "allow".
 */

export const SPLIT_GATE_REASONS = {
  sourcingReached: "Campaign sourcing budget reached",
  outreachReached: "Campaign outreach budget reached",
  unavailable: "Campaign budget split unavailable",
} as const;

/** True when the ceiling that is this campaign's money is split: every owned entry states a sourcing ceiling. */
export function isSplitCeiling(owned: CampaignBudgetEntry[]): boolean {
  return owned.length > 0 && owned.every((e) => e.sourcingCeilingCents !== null);
}

export interface CampaignSplitToday {
  split: boolean;
  outreachDailyBudgetCents: number;
  sourcingCeilingCents: number | null;
  sourcingSpentCents: number;
  outreachSpentCents: number;
}

export type CampaignSplitTodayRead = { ok: true; value: CampaignSplitToday } | { ok: false; detail: string };

/**
 * billing's one-campaign read with today's spend per part:
 *   GET /internal/brands/{brandId}/campaign-budget?offerId=&legKey=&featureSlug=&campaignIds= (x-api-key + x-org-id)
 *   -> { dailyBudgetCents, outreachDailyBudgetCents, sourcingCeilingCents, split,
 *        today: { date, campaignIds, spentCents, sourcingSpentCents, outreachSpentCents } }
 * Cents are decimal strings. `campaignIds` is THIS campaign only: the total is paced on this campaign's
 * own spend (gate-check `campaignSpentToday`), so its parts are too.
 */
export async function fetchCampaignSplitToday(
  brandId: string,
  campaign: { campaignId: string; offerId: string; legKey: string; featureSlug: string },
  identity: IdentityHeaders,
): Promise<CampaignSplitTodayRead> {
  const url = process.env.BILLING_SERVICE_URL;
  const apiKey = process.env.BILLING_SERVICE_API_KEY;
  if (!url || !apiKey) return { ok: false, detail: "billing not configured" };

  const headers: Record<string, string> = {
    "x-api-key": apiKey,
    "x-org-id": identity.orgId,
    "x-brand-id": brandId,
  };
  if (identity.userId) headers["x-user-id"] = identity.userId;
  if (identity.runId) headers["x-run-id"] = identity.runId;
  if (identity.campaignId) headers["x-campaign-id"] = identity.campaignId;
  if (identity.workflowSlug) headers["x-workflow-slug"] = identity.workflowSlug;

  const params = new URLSearchParams({
    offerId: campaign.offerId,
    legKey: campaign.legKey,
    featureSlug: campaign.featureSlug,
    campaignIds: campaign.campaignId,
  });

  try {
    const res = await fetch(
      `${url.replace(/\/$/, "")}/internal/brands/${encodeURIComponent(brandId)}/campaign-budget?${params}`,
      { headers },
    );
    if (!res.ok) return { ok: false, detail: `billing responded ${res.status}` };
    const data = (await res.json()) as {
      split?: unknown;
      outreachDailyBudgetCents?: string | null;
      sourcingCeilingCents?: string | null;
      today?: { sourcingSpentCents?: string; outreachSpentCents?: string } | null;
    };
    if (typeof data.split !== "boolean") return { ok: false, detail: "billing answered without `split`" };
    if (!data.today) return { ok: false, detail: "billing answered without today's spend" };
    const num = (v: unknown): number | null => {
      if (typeof v !== "string" && typeof v !== "number") return null;
      const n = typeof v === "number" ? v : parseFloat(v);
      return Number.isFinite(n) ? n : null;
    };
    const outreach = num(data.outreachDailyBudgetCents);
    const sourcingSpent = num(data.today.sourcingSpentCents);
    const outreachSpent = num(data.today.outreachSpentCents);
    const sourcing = data.sourcingCeilingCents === null ? null : num(data.sourcingCeilingCents);
    if (outreach === null || sourcingSpent === null || outreachSpent === null) {
      return { ok: false, detail: "billing's split figures are unreadable" };
    }
    if (data.split && sourcing === null) return { ok: false, detail: "billing says split but states no sourcing ceiling" };
    return {
      ok: true,
      value: {
        split: data.split,
        outreachDailyBudgetCents: outreach,
        sourcingCeilingCents: sourcing,
        sourcingSpentCents: sourcingSpent,
        outreachSpentCents: outreachSpent,
      },
    };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : "billing call threw" };
  }
}

/** The part limit today's spend has reached, or null. A part stated at $0 gates nothing. */
export function splitPartReached(t: CampaignSplitToday): { reason: string; detail: string } | null {
  if (!t.split || t.sourcingCeilingCents === null) return null;
  const fmt = (c: number) => `$${(c / 100).toFixed(2)}`;
  if (t.sourcingCeilingCents > 0 && t.sourcingSpentCents >= t.sourcingCeilingCents) {
    return {
      reason: SPLIT_GATE_REASONS.sourcingReached,
      detail: `sourcing spent ${fmt(t.sourcingSpentCents)} today of its ${fmt(t.sourcingCeilingCents)}/day ceiling`,
    };
  }
  if (t.outreachDailyBudgetCents > 0 && t.outreachSpentCents >= t.outreachDailyBudgetCents) {
    return {
      reason: SPLIT_GATE_REASONS.outreachReached,
      detail: `outreach spent ${fmt(t.outreachSpentCents)} today of its ${fmt(t.outreachDailyBudgetCents)}/day budget`,
    };
  }
  return null;
}
