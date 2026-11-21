import { describe, expect, it } from "vitest";
import { billingCapsPath } from "../../src/lib/sales-funnel-campaigns.js";

// billing-service madison-v9 (DISTRY-CALL-IS-CAMPAIGN-1121), contract locked: an offer-less campaign's caps live
// at /internal/brands/{b}/sales-funnels/{sf}/campaigns/{sfc}/caps (GET|PUT|DELETE), same body, `offerId: null`.
describe("billingCapsPath", () => {
  it("keeps the offered path byte for byte", () => {
    expect(billingCapsPath({ brandId: "b", offerId: "o", salesFunnelId: "sf", salesFunnelCampaignId: "c" })).toBe(
      "/internal/brands/b/offers/o/sales-funnels/sf/campaigns/c/caps",
    );
    expect(billingCapsPath({ brandId: "b", offerId: "o", salesFunnelId: "sf" })).toBe(
      "/internal/brands/b/offers/o/sales-funnels/sf/caps",
    );
  });

  it("drops the offer segment for a campaign naming no offer", () => {
    expect(billingCapsPath({ brandId: "b", offerId: null, salesFunnelId: "sf", salesFunnelCampaignId: "c" })).toBe(
      "/internal/brands/b/sales-funnels/sf/campaigns/c/caps",
    );
  });
});
