import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchBrandRuntimeContext } from "../../src/lib/brand-runtime-client.js";
import type { DownstreamIdentity } from "../../src/lib/downstream-headers.js";

const BRAND_ID = "11111111-1111-1111-1111-111111111111";

function identity(overrides: Partial<DownstreamIdentity> = {}): DownstreamIdentity {
  return {
    orgId: "org-1",
    userId: "user-1",
    runId: "run-1",
    campaignId: "camp-1",
    brandId: BRAND_ID,
    workflowSlug: "sales-email-cold-outreach",
    featureSlug: "sales-cold-email-outreach",
    ...overrides,
  };
}

const runtimeContext = {
  brand: { id: BRAND_ID },
  currentGoal: "meetingBooked",
  brandProfile: null,
};

/**
 * brand-service resolves per-brand configuration per (org, brand): several orgs claim the
 * same domain and each configures it independently. `x-org-id` is what names whose
 * configuration this read wants — without it brand-service either guesses (the leak it is
 * closing) or 400s. These tests pin that the header is on the wire so it cannot be dropped
 * silently by a future refactor of the shared header builder.
 */
describe("fetchBrandRuntimeContext org scoping", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    process.env.BRAND_SERVICE_URL = "https://brand.test.local";
    process.env.BRAND_SERVICE_API_KEY = "test-brand-key";
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => runtimeContext,
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("sends the org whose configuration is wanted as x-org-id", async () => {
    await fetchBrandRuntimeContext(BRAND_ID, identity({ orgId: "org-abc" }));

    const [url, opts] = (globalThis.fetch as any).mock.calls[0];
    expect(url).toBe(`https://brand.test.local/internal/brands/${BRAND_ID}/runtime-context`);
    expect(opts.headers["x-org-id"]).toBe("org-abc");
    expect(opts.headers["x-brand-id"]).toBe(BRAND_ID);
    expect(opts.headers["x-api-key"]).toBe("test-brand-key");
  });

  it("resolves a brand claimed by several orgs to the org it named", async () => {
    // Same brand, two campaigns owned by different orgs: each read must carry its own org
    // so brand-service answers with that org's configuration rather than refusing.
    await fetchBrandRuntimeContext(BRAND_ID, identity({ orgId: "org-one" }));
    await fetchBrandRuntimeContext(BRAND_ID, identity({ orgId: "org-two" }));

    const calls = (globalThis.fetch as any).mock.calls;
    expect(calls[0][1].headers["x-org-id"]).toBe("org-one");
    expect(calls[1][1].headers["x-org-id"]).toBe("org-two");
  });

  it.each([["", "empty"], ["   ", "blank"], [undefined, "absent"]])(
    "refuses to read org-less rather than let brand-service pick an org (%s org)",
    async (orgId) => {
      await expect(
        fetchBrandRuntimeContext(BRAND_ID, identity({ orgId: orgId as string })),
      ).rejects.toThrow(/requires an org/);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    },
  );

  it("surfaces brand-service's ORG_REQUIRED refusal instead of swallowing it", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ code: "ORG_REQUIRED", error: "claimed by more than one org" }),
    });

    await expect(fetchBrandRuntimeContext(BRAND_ID, identity())).rejects.toThrow(/ORG_REQUIRED/);
  });
});
