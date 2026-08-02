import { fetchBrandRuntimeContext } from "./brand-runtime-client.js";
import type { DownstreamIdentity } from "./downstream-headers.js";
import { funnelForGoal } from "./sales-funnel-vocabulary.js";

/**
 * Which funnel a campaign that states none is already running.
 *
 * A campaign's goal is its own when it states one, and the brand's otherwise — the same
 * resolution the runtime uses at /start-run. Read once here so the funnel can be WRITTEN onto
 * the campaign row; nothing downstream re-derives it.
 *
 * Returns null when the goal names no single funnel. A campaign whose funnel cannot be
 * determined keeps a NULL funnel: a stated funnel is a fact, never a guess.
 */
export function resolveCampaignFunnelKey(
  campaignGoal: string | null | undefined,
  brandGoal: string | null | undefined,
): string | null {
  return funnelForGoal(campaignGoal ?? brandGoal);
}

/**
 * This org's current goal for the brand, or null when it cannot be read.
 *
 * Fail-SOFT on purpose: both callers (the boot backfill and the scheduler's adoption step) use
 * it to decide whether an existing campaign can be labelled with its funnel. An unreadable
 * brand leaves the campaign exactly as it is and the next pass tries again — it never blocks a
 * run and never invents a goal.
 */
export async function readBrandGoal(
  brandId: string,
  caller: {
    orgId: string;
    userId?: string | null;
    campaignId?: string | null;
    workflowSlug?: string | null;
    featureSlug?: string | null;
  },
): Promise<string | null> {
  // `orgId` is load-bearing on this read — the goal belongs to the (org, brand) pair, and
  // brand-service refuses to pick an org for a brand several orgs claim. Everything else is
  // tracking.
  const identity: DownstreamIdentity = {
    orgId: caller.orgId,
    userId: caller.userId ?? "",
    runId: "",
    campaignId: caller.campaignId ?? "",
    brandId,
    workflowSlug: caller.workflowSlug ?? "",
    featureSlug: caller.featureSlug ?? "",
  };
  try {
    const ctx = await fetchBrandRuntimeContext(brandId, identity);
    return ctx.currentGoal ?? null;
  } catch {
    return null;
  }
}
