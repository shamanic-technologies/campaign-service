import type { IdentityHeaders } from "@distribute/runs-client";
import { toFunnelKey, type SalesFunnelKey } from "./sales-funnel-vocabulary.js";

/**
 * Per-funnel daily spend ceilings, as billing-service holds them for ONE org's view of a brand.
 *
 * A customer funds each sales funnel of a brand separately, so "the brand's daily budget" is no
 * longer a single pot: it is the SUM of these ceilings, and billing keeps serving that sum on
 * GET /internal/brands/{brandId}/daily-budget. Nothing that reads the brand total changes.
 *
 * Contract (billing-service): GET /internal/brands/{brandId}/funnel-budgets (x-api-key + x-org-id)
 *   -> { brandId, dailyBudgetCents: string|null, funnels: [{ funnelKey, dailyBudgetCents, updatedAt }] }
 *
 * A brand that has never set per-funnel ceilings returns `funnels: []` plus its brand-level
 * value — billing never fabricates a split, and neither do we.
 */
export interface FunnelBudget {
  /**
   * Canonical funnel key. billing-service still names these funnels the pre-rename way
   * (`reply_meeting`, `visit_meeting`, `visit_signup`, `visit_form`) while brand-service has moved
   * to the canonical four — so this read canonicalises, and the two sets intersect again. Without
   * that, every funnel would read as unfunded and the gate would stop the whole fleet.
   */
  funnelKey: SalesFunnelKey;
  /** This funnel's own daily ceiling, in CENTS (directly comparable to runs *CostInUsdCents). */
  dailyBudgetCents: number;
}

export type FunnelBudgetsRead =
  | { ok: true; brandDailyBudgetCents: number | null; funnels: FunnelBudget[] }
  | { ok: false };

/**
 * Read this org's per-funnel daily ceilings for a brand.
 *
 * Returns ok:false on missing config, network error, non-2xx or an unparseable payload. The
 * caller decides what that means: the gate treats it as fail-CLOSED (spend control must never
 * read an unreadable cap as "unbounded"), while the scheduler's turn-taking treats it as
 * fail-SOFT (a selection optimization must never block a run — the gate still holds the line).
 *
 * `x-org-id` is load-bearing, not tracking: per-funnel funding belongs to the (org, brand) pair
 * and billing 400s rather than guess an org for a brand several orgs claim.
 */
export async function fetchFunnelBudgets(
  brandId: string,
  identity: IdentityHeaders,
): Promise<FunnelBudgetsRead> {
  const url = process.env.BILLING_SERVICE_URL;
  const apiKey = process.env.BILLING_SERVICE_API_KEY;
  if (!url || !apiKey) return { ok: false };

  const headers: Record<string, string> = {
    "x-api-key": apiKey,
    "x-org-id": identity.orgId,
    "x-brand-id": brandId,
  };
  if (identity.userId) headers["x-user-id"] = identity.userId;
  if (identity.runId) headers["x-run-id"] = identity.runId;
  if (identity.campaignId) headers["x-campaign-id"] = identity.campaignId;
  if (identity.workflowSlug) headers["x-workflow-slug"] = identity.workflowSlug;

  try {
    const res = await fetch(
      `${url.replace(/\/$/, "")}/internal/brands/${encodeURIComponent(brandId)}/funnel-budgets`,
      { headers },
    );
    if (!res.ok) return { ok: false };

    const data = await res.json() as {
      dailyBudgetCents?: string | null;
      funnels?: Array<{ funnelKey?: string; dailyBudgetCents?: string }>;
    };

    let brandDailyBudgetCents: number | null = null;
    if (data.dailyBudgetCents !== null && data.dailyBudgetCents !== undefined) {
      const total = parseFloat(data.dailyBudgetCents);
      if (!Number.isFinite(total)) return { ok: false };
      brandDailyBudgetCents = total;
    }

    if (!Array.isArray(data.funnels)) return { ok: false };

    const funnels: FunnelBudget[] = [];
    for (const raw of data.funnels) {
      if (!raw?.funnelKey) return { ok: false };
      const cents = parseFloat(raw.dailyBudgetCents ?? "");
      // An unparseable ceiling is not "no ceiling" — refuse the whole read rather than let one
      // funnel silently pace on nothing.
      if (!Number.isFinite(cents)) return { ok: false };
      // A funnel neither catalogue names is one no campaign of ours can be on, so it is dropped
      // rather than refused: refusing would fail the read CLOSED and stop the funnels we DO run
      // because billing named a fifth one we have not heard of yet.
      const funnelKey = toFunnelKey(raw.funnelKey);
      if (!funnelKey) continue;
      funnels.push({ funnelKey, dailyBudgetCents: cents });
    }

    return { ok: true, brandDailyBudgetCents, funnels };
  } catch {
    return { ok: false };
  }
}

/**
 * The funnels this org has actually FUNDED for the brand: a ceiling of zero is a deliberate
 * "do not work this funnel", not a missing value, so it is filtered out here once rather than
 * re-tested at every call site.
 */
export function fundedFunnels(read: Extract<FunnelBudgetsRead, { ok: true }>): FunnelBudget[] {
  return read.funnels.filter((f) => f.dailyBudgetCents > 0);
}
