import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type * as Mod from "../../src/lib/sales-funnel-campaign-precompute.js";

const { notifySalesFunnelCampaignPrecompute } = await vi.importActual<typeof Mod>("../../src/lib/sales-funnel-campaign-precompute.js");

const BIRTH = {
  salesFunnelCampaignId: "11111111-1111-1111-1111-111111111111",
  orgId: "22ffb00a-b7da-4453-9bf2-1784c2d2bf9e",
  brandId: "933d4abb-9695-4fcb-b3aa-354d61565798",
  offerId: "e59646e4-e351-462d-a8a7-618098e7e5c1",
  userId: "44444444-4444-4444-4444-444444444444",
  runId: "55555555-5555-5555-5555-555555555555",
};

describe("notifySalesFunnelCampaignPrecompute", () => {
  const fetchMock = vi.fn();
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  beforeEach(() => {
    fetchMock.mockReset();
    errors.mockClear();
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ brandId: BIRTH.brandId, offerId: BIRTH.offerId, accepted: true }), { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    process.env.FEATURES_SERVICE_URL = "http://features.test/";
    process.env.FEATURES_SERVICE_API_KEY = "fk";
  });
  afterEach(() => vi.unstubAllGlobals());

  it("posts the offer to features-service with the creating request's identity (LOCKED contract)", async () => {
    await notifySalesFunnelCampaignPrecompute(BIRTH);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`http://features.test/internal/brands/${BIRTH.brandId}/sales-funnel-campaigns/precompute`);
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      "x-api-key": "fk",
      "x-org-id": BIRTH.orgId,
      "x-user-id": BIRTH.userId,
      "x-run-id": BIRTH.runId,
    });
    expect(JSON.parse(init.body)).toEqual({ offerId: BIRTH.offerId });
    expect(errors).not.toHaveBeenCalled();
  });

  it("never throws and logs loudly, whatever features-service does", async () => {
    fetchMock.mockRejectedValue(new Error("down"));
    await expect(notifySalesFunnelCampaignPrecompute(BIRTH)).resolves.toBeUndefined();
    expect(errors).toHaveBeenCalledTimes(1);
    fetchMock.mockResolvedValue(new Response("nope", { status: 500 }));
    await expect(notifySalesFunnelCampaignPrecompute(BIRTH)).resolves.toBeUndefined();
    expect(errors).toHaveBeenCalledTimes(2);
    delete process.env.FEATURES_SERVICE_API_KEY;
    await expect(notifySalesFunnelCampaignPrecompute(BIRTH)).resolves.toBeUndefined();
    expect(errors).toHaveBeenCalledTimes(3);
  });
});
