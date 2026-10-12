import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchOfferSteps, missingOfferSteps } from "../../src/lib/sales-funnel-offer-steps.js";

const identity = { orgId: "org-1", userId: "user-1", runId: "run-1" };

function answer(status: number, body: unknown) {
  return vi.fn(async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status }));
}

describe("fetchOfferSteps — brand-service's statement of an offer's steps", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("asks the ORG-scoped route with the identity, and reads a stated list", async () => {
    const fetchMock = answer(200, { offerId: "o", stated: true, steps: ["conversation", "website_visit"], statedAt: "2026-10-08T00:00:00Z" });
    vi.stubGlobal("fetch", fetchMock);
    expect(await fetchOfferSteps("b", "o", identity)).toEqual({ ok: true, stated: true, steps: ["conversation", "website_visit"] });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://brand.test.local/orgs/brands/b/offers/o/steps");
    expect(init.headers).toMatchObject({ "x-api-key": "test-brand-key", "x-org-id": "org-1", "x-user-id": "user-1", "x-run-id": "run-1" });
  });

  it("reads an offer that never stated as not stated", async () => {
    vi.stubGlobal("fetch", answer(200, { offerId: "o", stated: false, steps: null, statedAt: null }));
    expect(await fetchOfferSteps("b", "o", identity)).toEqual({ ok: true, stated: false });
  });

  it("names a 404 apart, and every other failure as unreadable", async () => {
    vi.stubGlobal("fetch", answer(404, { error: "Offer not found" }));
    expect(await fetchOfferSteps("b", "o", identity)).toMatchObject({ ok: false, notFound: true });
    vi.stubGlobal("fetch", answer(503, "down"));
    expect(await fetchOfferSteps("b", "o", identity)).toMatchObject({ ok: false, notFound: false });
    vi.stubGlobal("fetch", answer(200, { stated: true, steps: null }));
    expect(await fetchOfferSteps("b", "o", identity)).toMatchObject({ ok: false, notFound: false });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    expect(await fetchOfferSteps("b", "o", identity)).toMatchObject({ ok: false, notFound: false });
  });
});

describe("missingOfferSteps", () => {
  it("lists the unstated steps once, in order; lead found and paid client always count as present", () => {
    expect(missingOfferSteps(["lead_found", "website_visit", "website_visit", "purchase", "purchase", "paid_client"], ["website_visit"]))
      .toEqual(["purchase"]);
    expect(missingOfferSteps(["website_visit", "meeting_booked"], ["meeting_booked", "website_visit"])).toEqual([]);
  });
});
