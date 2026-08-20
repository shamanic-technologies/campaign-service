import { toFunnelKey, type SalesFunnelKey } from "./sales-funnel-vocabulary.js";
import type { ProvisioningIdentity } from "./provisioning-identity.js";

/**
 * WHICH SALES FUNNELS AN ACQUISITION CHANNEL MAY BE SOLD THROUGH — features-service's statement,
 * asked rather than held.
 *
 * Not every channel can sell every funnel: the feedback-request offer buys a CONVERSATION, while
 * three of the four funnels start with a click onto the brand's website it has no way to sell. That
 * is a product fact about the feature, and features-service owns it — it states `salesFunnels` on
 * the feature row every consumer already reads. Hardcoding the matrix here would be a second copy
 * of one fact, drifting the day a channel gains or loses a chain.
 *
 * Contract (features-service): GET /features/{slug} (x-api-key + FULL identity)
 *   -> { slug, ..., salesFunnels: string[] }
 *
 * The identity is not tracking: features-service answers `400 Missing required headers: x-run-id`
 * to a request that does not state one, whatever the caller is doing. So the header is always sent
 * and the run id is one runs-service can resolve — see provisioning-identity.ts for why that took
 * this feature out of production for its whole life.
 *
 * ALWAYS PRESENT on the wire: a feature that sells through no sales funnel states `[]` and one that
 * sells through every declared chain states all four keys. So an EMPTY list is a real answer —
 * "this feature sells through no sales funnel" — and never means "all of them".
 *
 * A failure is NEVER laundered into an empty declaration: `{ ok: false }` says the statement could
 * not be READ, which the caller passes over LOUDLY. A pair the customer is paying for that we
 * cannot evaluate is not the same thing as a pair we evaluated and rejected, and telling them apart
 * is the difference between a feature that has never worked and one that has never said so.
 */
export type FeatureSalesFunnelsRead =
  | { ok: true; funnels: Set<SalesFunnelKey> }
  | { ok: false; detail: string };

export async function fetchFeatureSalesFunnels(
  featureSlug: string,
  identity: ProvisioningIdentity,
): Promise<FeatureSalesFunnelsRead> {
  const baseUrl = process.env.FEATURES_SERVICE_URL;
  const apiKey = process.env.FEATURES_SERVICE_API_KEY;
  if (!baseUrl || !apiKey) {
    return { ok: false, detail: "FEATURES_SERVICE_URL / FEATURES_SERVICE_API_KEY not configured" };
  }

  const headers: Record<string, string> = {
    "x-api-key": apiKey,
    "x-org-id": identity.orgId,
    "x-user-id": identity.userId,
    "x-run-id": identity.runId,
  };
  if (identity.campaignId) headers["x-campaign-id"] = identity.campaignId;
  if (identity.brandId) headers["x-brand-id"] = identity.brandId;
  if (identity.workflowSlug) headers["x-workflow-slug"] = identity.workflowSlug;

  try {
    const res = await fetch(
      `${baseUrl.replace(/\/$/, "")}/features/${encodeURIComponent(featureSlug)}`,
      { headers },
    );
    if (!res.ok) {
      // The BODY is what says which header was missing (`Missing required headers: x-run-id`), so
      // it is carried into the log line rather than a bare status nobody can act on.
      let body = "";
      try {
        body = (await res.text()).slice(0, 200);
      } catch {
        body = "";
      }
      return { ok: false, detail: `HTTP ${res.status}${body ? ` ${body}` : ""}` };
    }

    const data = await res.json() as { salesFunnels?: unknown };
    if (!Array.isArray(data.salesFunnels)) {
      return { ok: false, detail: "response states no salesFunnels array" };
    }

    const funnels = new Set<SalesFunnelKey>();
    for (const raw of data.salesFunnels) {
      // Any spelling in, one canonical token out — the same tolerance every other funnel read
      // here has. A key no catalogue names is skipped rather than worked.
      const key = typeof raw === "string" ? toFunnelKey(raw) : null;
      if (key) funnels.add(key);
    }
    return { ok: true, funnels };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}
