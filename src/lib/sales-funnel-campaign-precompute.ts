/**
 * Tell features-service the moment a SALES FUNNEL CAMPAIGN is born, so it computes that brand's
 * Campaigns rows (invested, ROI) before anyone reads them (owner 2026-10-13: the customer dashboard
 * is instant everywhere). features-service keys those cells on the campaign's unit ids and cannot
 * see a creation happen: only this service can. Contract (features-service v0.179.190, LOCKED):
 *
 *   POST /internal/brands/:brandId/sales-funnel-campaigns/precompute
 *   (x-api-key, x-org-id, x-user-id, x-run-id = the identity of the request that created it)
 *   { offerId }  -> 202 { brandId, offerId, accepted: true }
 *
 * Every birth notifies, whoever launched it (customer, Copilot, staff), whatever the funnel or
 * channel. A re-activation creates no unit (the funnel's units already exist), so it sends nothing.
 *
 * FIRE-AND-FORGET, the documented exception to fail-loud: it runs after the birth has committed and
 * must never change the create route's response, status code or latency. Every failure is logged
 * loudly and swallowed; nothing awaits it.
 */
export interface SalesFunnelCampaignBirth {
  salesFunnelCampaignId: string;
  orgId: string;
  brandId: string;
  offerId: string;
  userId: string;
  runId: string;
}

export async function notifySalesFunnelCampaignPrecompute(b: SalesFunnelCampaignBirth): Promise<void> {
  try {
    const url = process.env.FEATURES_SERVICE_URL;
    const apiKey = process.env.FEATURES_SERVICE_API_KEY;
    if (!url || !apiKey) {
      console.error(
        `[campaign-service] FEATURES_SERVICE_URL or FEATURES_SERVICE_API_KEY not configured — sales funnel campaign ${b.salesFunnelCampaignId} not precomputed`,
      );
      return;
    }
    const res = await fetch(
      `${url.replace(/\/$/, "")}/internal/brands/${encodeURIComponent(b.brandId)}/sales-funnel-campaigns/precompute`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "x-org-id": b.orgId,
          "x-user-id": b.userId,
          "x-run-id": b.runId,
        },
        body: JSON.stringify({ offerId: b.offerId }),
        signal: AbortSignal.timeout(5_000),
      },
    );
    if (!res.ok) {
      console.error(
        `[campaign-service] features-service refused the sales funnel campaign precompute (campaign=${b.salesFunnelCampaignId}, brand=${b.brandId}, offer=${b.offerId}): ${res.status} ${await res.text()}`,
      );
    }
  } catch (err) {
    console.error(
      `[campaign-service] sales funnel campaign precompute failed (campaign=${b.salesFunnelCampaignId}, brand=${b.brandId}, offer=${b.offerId}):`,
      err,
    );
  }
}
