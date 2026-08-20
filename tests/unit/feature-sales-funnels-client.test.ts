import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { fetchFeatureSalesFunnels } from "../../src/lib/feature-sales-funnels-client.js";
import type { ProvisioningIdentity } from "../../src/lib/provisioning-identity.js";

/**
 * THE PAYLOAD IS READ WHERE THE DEPLOYED SERVICE PUTS IT.
 *
 * features-service answers `GET /features/{slug}` with the feature ENVELOPED under `feature` — the
 * contract it publishes and the body it served when this was reproduced from inside the running
 * container. The client read `salesFunnels` at the top level instead, found nothing on a 200 that
 * carried the statement, and reported that the service had stated none; every funded pair was then
 * passed over as unevaluatable, fleet-wide, for the whole life of the feature.
 *
 * Nothing contradicted it because every test mocked the same shape the client expected: a client
 * agreeing with itself and with nothing else. So these tests state the deployed envelope, and one
 * of them asserts that a TOP-LEVEL payload is NOT accepted — a shape features-service does not
 * serve must not be a shape that works here, or the assumption can drift back silently.
 */

const IDENTITY: ProvisioningIdentity = {
  orgId: "11111111-1111-4111-8111-111111111111",
  userId: "22222222-2222-4222-8222-222222222222",
  runId: "33333333-3333-4333-8333-333333333333",
};

const FEEDBACK = "feedback-request-cold-email-outreach";

let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  process.env.FEATURES_SERVICE_URL = "https://features.example";
  process.env.FEATURES_SERVICE_API_KEY = "features-key";
  mockFetch = vi.fn();
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("fetchFeatureSalesFunnels", () => {
  it("reads the statement nested under the feature, the way the deployed service serves it", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        feature: {
          id: "44444444-4444-4444-8444-444444444444",
          slug: FEEDBACK,
          name: "Feedback request cold email",
          status: "active",
          salesFunnels: ["sales_meetings_from_conversation"],
          supersededBySlug: null,
        },
      }),
    });

    const read = await fetchFeatureSalesFunnels(FEEDBACK, IDENTITY);

    expect(read.ok).toBe(true);
    expect(read.ok && [...read.funnels]).toEqual(["sales_meetings_from_conversation"]);
  });

  it("REFUSES a top-level salesFunnels payload — a shape features-service does not serve", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ slug: FEEDBACK, salesFunnels: ["sales_meetings_from_conversation"] }),
    });

    const read = await fetchFeatureSalesFunnels(FEEDBACK, IDENTITY);

    expect(read.ok).toBe(false);
    expect(read.ok === false && read.detail).toContain("feature.salesFunnels");
  });

  it("states an EMPTY declaration as a real answer, not as a failure", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ feature: { slug: "pr-expert-quote-outreach", salesFunnels: [] } }),
    });

    const read = await fetchFeatureSalesFunnels("pr-expert-quote-outreach", IDENTITY);

    expect(read.ok).toBe(true);
    expect(read.ok && read.funnels.size).toBe(0);
  });

  it("normalises every spelling onto one canonical token", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        feature: { slug: "sales-cold-email-outreach", salesFunnels: ["reply_meeting", "visit_meeting"] },
      }),
    });

    const read = await fetchFeatureSalesFunnels("sales-cold-email-outreach", IDENTITY);

    expect(read.ok).toBe(true);
    expect(read.ok && [...read.funnels].sort()).toEqual([
      "sales_meetings_from_conversation",
      "sales_meetings_from_website",
    ]);
  });

  it("says a refusal is a refusal, carrying the body that names what was missing", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => "Missing required headers: x-run-id",
    });

    const read = await fetchFeatureSalesFunnels(FEEDBACK, IDENTITY);

    expect(read.ok).toBe(false);
    expect(read.ok === false && read.detail).toContain("400");
    expect(read.ok === false && read.detail).toContain("x-run-id");
  });

  it("states the FULL identity on the wire — the read is refused without a run id", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ feature: { slug: FEEDBACK, salesFunnels: [] } }),
    });

    await fetchFeatureSalesFunnels(FEEDBACK, IDENTITY);

    const headers = (mockFetch.mock.calls[0]![1] as { headers: Record<string, string> }).headers;
    expect(headers["x-org-id"]).toBe(IDENTITY.orgId);
    expect(headers["x-user-id"]).toBe(IDENTITY.userId);
    expect(headers["x-run-id"]).toBe(IDENTITY.runId);
    expect(headers["x-api-key"]).toBe("features-key");
  });
});
