import type { IdentityHeaders } from "@distribute/runs-client";
import { toFunnelKey, type SalesFunnelKey } from "./sales-funnel-vocabulary.js";

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
 * Contract (features-service): GET /features/{slug} (x-api-key + identity)
 *   -> { slug, ..., salesFunnels: string[] }
 *
 * ALWAYS PRESENT on the wire: a feature that sells through no sales funnel states `[]` and one that
 * sells through every declared chain states all four keys. So an EMPTY list is a real answer —
 * "this feature sells through no sales funnel" — and never means "all of them".
 *
 * Returns null when the statement could not be read (missing config, network error, non-2xx,
 * unparseable payload, or the field absent because features-service predates it). The caller treats
 * that exactly as it treats an unreadable brand funnel declaration: provision nothing rather than
 * guess a pair a customer may not be able to sell through.
 */
export async function fetchFeatureSalesFunnels(
  featureSlug: string,
  identity: IdentityHeaders,
): Promise<Set<SalesFunnelKey> | null> {
  const baseUrl = process.env.FEATURES_SERVICE_URL;
  const apiKey = process.env.FEATURES_SERVICE_API_KEY;
  if (!baseUrl || !apiKey) return null;

  const headers: Record<string, string> = {
    "x-api-key": apiKey,
    "x-org-id": identity.orgId,
  };
  if (identity.userId) headers["x-user-id"] = identity.userId;
  if (identity.runId) headers["x-run-id"] = identity.runId;
  if (identity.campaignId) headers["x-campaign-id"] = identity.campaignId;
  if (identity.brandId) headers["x-brand-id"] = identity.brandId;
  if (identity.workflowSlug) headers["x-workflow-slug"] = identity.workflowSlug;

  try {
    const res = await fetch(
      `${baseUrl.replace(/\/$/, "")}/features/${encodeURIComponent(featureSlug)}`,
      { headers },
    );
    if (!res.ok) return null;

    const data = await res.json() as { salesFunnels?: unknown };
    if (!Array.isArray(data.salesFunnels)) return null;

    const keys = new Set<SalesFunnelKey>();
    for (const raw of data.salesFunnels) {
      // Any spelling in, one canonical token out — the same tolerance every other funnel read
      // here has. A key no catalogue names is skipped rather than worked.
      const key = typeof raw === "string" ? toFunnelKey(raw) : null;
      if (key) keys.add(key);
    }
    return keys;
  } catch {
    return null;
  }
}
