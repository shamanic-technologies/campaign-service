import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockFetchBrandRuntimeContext = vi.hoisted(() => vi.fn());

vi.mock("../../src/lib/brand-runtime-client.js", () => ({
  fetchBrandRuntimeContext: mockFetchBrandRuntimeContext,
}));

import {
  readLegModelEligibility,
  resolveSelectionForTrigger,
} from "../../src/lib/features-workflow-projection-client.js";
import type { DownstreamIdentity } from "../../src/lib/downstream-headers.js";

// A brand selling SEVERAL OFFERS does not make the funnel-keyed pricing read FAIL: features-service
// serves 200, states `declaredFunnelsUnresolved`, and reads every projected figure null. So every
// row is present, nothing errors, and NOTHING is rankable — the pick collapses to the configured
// workflow with no sign that selection stopped happening. The leg-keyed body fetched in the same
// round trip names the campaign, so features-service resolved its offer transitively and priced it
// fully. These pin that it is used exactly there, and nowhere else.

const ROTATING_FEATURE = "sales-cold-email-outreach";
const BRAND_ID = "f4d73dab-1f9d-49b2-b16e-63ecde76a5eb";
const CAMPAIGN_ID = "647572d9-729e-4731-9456-28fa351be92c";
const LEG = "start_to_website_visit";

const identity: DownstreamIdentity = {
  orgId: "f0420eb5-8f72-4f0a-a150-f473746df1e6",
  userId: "user-1",
  runId: "11111111-1111-4111-8111-111111111111",
  campaignId: CAMPAIGN_ID,
  brandId: BRAND_ID,
  workflowSlug: "wf-configured",
  featureSlug: ROTATING_FEATURE,
};

const SEVERAL_OFFERS = {
  reason: "several_offers",
  message: "Brand f4d73dab sells 2 offers (Product-led, Sales-led)",
  offers: [
    { offerId: "832126f3-f3f1-4601-885d-bc8e101e5680", name: "Product-led" },
    { offerId: "9b1c0f2a-1111-4c2d-9f3e-4a5b6c7d8e90", name: "Sales-led" },
  ],
};

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
}

/** One row of the shape BOTH bodies serve — the leg-keyed one carries the verdict on top. */
function projectionRow(audienceId: string, slug: string, costPerOutcomeUsd: number | null) {
  return {
    audienceId,
    workflow: { workflowDynastySlug: slug, workflowDynastyName: slug },
    estimatesByGrain: {
      audience: {
        evidence: { spentUsd: 10, observedContacted: 100, observedClicks: 0, observedPositiveReplies: 0 },
        resolvedOutcomeCount: costPerOutcomeUsd == null ? null : 5,
      },
    },
    resolved: { grain: "audience", costPerOutcomeUsd },
  };
}

const baseArgs = {
  featureSlug: ROTATING_FEATURE,
  primaryBrandId: BRAND_ID,
  identity,
  fallbackSlug: "wf-configured",
  funnelKey: "website_purchases",
  campaignId: CAMPAIGN_ID,
  offerId: "832126f3-f3f1-4601-885d-bc8e101e5680",
};

/** The funnel-keyed body, degraded or priced; the leg-keyed body always priced. */
function routeFetch(opts: { funnelUnresolved: boolean }) {
  return vi.fn(async (url: URL | string) => {
    const u = new URL(String(url));
    if (u.searchParams.has("leg")) {
      return jsonResponse({
        rows: [
          projectionRow("aud-A", "leg-cheap-wf", 12),
          projectionRow("aud-A", "leg-dear-wf", 400),
        ],
      });
    }
    return jsonResponse({
      rows: opts.funnelUnresolved
        ? [projectionRow("aud-A", "funnel-wf", null), projectionRow("aud-A", "funnel-wf-2", null)]
        : [projectionRow("aud-A", "funnel-wf", 3), projectionRow("aud-A", "funnel-wf-2", 90)],
      ...(opts.funnelUnresolved ? { declaredFunnelsUnresolved: SEVERAL_OFFERS } : {}),
    });
  });
}

const originalFetch = global.fetch;

describe("a brand selling several offers still gets a PRICED pick", () => {
  beforeEach(() => {
    process.env.FEATURES_SERVICE_URL = "https://features.test";
    process.env.FEATURES_SERVICE_API_KEY = "k";
  });
  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("a campaign stating a leg is priced on the LEG-keyed body — the funnel one is never read", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const f = routeFetch({ funnelUnresolved: true });
    global.fetch = f as unknown as typeof fetch;

    // The funnel-keyed body is unpriced for this brand; the leg body names the campaign and is.
    await expect(resolveSelectionForTrigger({ ...baseArgs, legKey: LEG })).resolves.toEqual({
      workflowSlug: "leg-cheap-wf",
      audienceId: "aud-A",
    });
    expect(f.mock.calls).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
    expect(err).not.toHaveBeenCalled();
  });

  it("a leg campaign ranks on its LEG's outcome even when the funnel body is priced and disagrees", async () => {
    global.fetch = routeFetch({ funnelUnresolved: false }) as unknown as typeof fetch;

    // funnel-wf is cheapest per booked meeting; leg-cheap-wf is cheapest per leg outcome. The
    // campaign is bought for the leg, and the dashboard ranks on the leg body — so leg-cheap-wf.
    await expect(resolveSelectionForTrigger({ ...baseArgs, legKey: LEG })).resolves.toEqual({
      workflowSlug: "leg-cheap-wf",
      audienceId: "aud-A",
    });
  });

  it("a campaign stating no leg keeps the PRICED funnel body — its pick does not move", async () => {
    const f = routeFetch({ funnelUnresolved: false });
    global.fetch = f as unknown as typeof fetch;

    await expect(resolveSelectionForTrigger(baseArgs)).resolves.toEqual({
      workflowSlug: "funnel-wf",
      audienceId: "aud-A",
    });
    const u = new URL(String(f.mock.calls[0]?.[0]));
    expect(f.mock.calls).toHaveLength(1);
    expect(u.searchParams.get("funnel")).toBe("website_purchases");
    expect(u.searchParams.has("pricing")).toBe(false);
  });

  it("a leg read that FAILS runs the configured workflow, loudly — never the funnel-keyed body (wave C1)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = vi.fn(async (url: URL | string) => {
      const u = new URL(String(url));
      if (u.searchParams.has("leg")) return { ok: false, status: 502, text: async () => "boom" };
      return routeFetch({ funnelUnresolved: false })(url);
    });
    global.fetch = f as unknown as typeof fetch;

    await expect(resolveSelectionForTrigger({ ...baseArgs, legKey: LEG })).resolves.toEqual({
      workflowSlug: "wf-configured",
      audienceId: null,
    });
    expect(f.mock.calls.every(([u]) => !new URL(String(u)).searchParams.has("funnel"))).toBe(true);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("asks the leg body on the NET basis the dashboard ranks it on", async () => {
    const f = routeFetch({ funnelUnresolved: false });
    global.fetch = f as unknown as typeof fetch;
    await resolveSelectionForTrigger({ ...baseArgs, legKey: LEG });
    const u = new URL(String(f.mock.calls[0]?.[0]));
    expect(u.searchParams.get("leg")).toBe(LEG);
    expect(u.searchParams.get("campaignId")).toBe(CAMPAIGN_ID);
    expect(u.searchParams.get("pricing")).toBe("net");
  });

  it("says so LOUDLY when nothing priced it — an unpriced grid is not a channel with no history", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    global.fetch = routeFetch({ funnelUnresolved: true }) as unknown as typeof fetch;

    // No leg stated → no leg-keyed body exists to price it, so no workflow is rankable and the
    // configured one runs. The audience is still drawn (its arms are cold, not absent).
    await expect(resolveSelectionForTrigger(baseArgs)).resolves.toEqual({
      workflowSlug: "wf-configured",
      audienceId: "aud-A",
    });
    expect(err).toHaveBeenCalledTimes(1);
    expect(String(err.mock.calls[0]?.[0])).toContain("UNPRICED");
  });

  it("names the unanswerable verdict read at ERROR level — a 409 several_offers is not an outage", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 409,
      text: async () => JSON.stringify({ error: "…", reason: "several_offers" }),
    })) as unknown as typeof fetch;

    // An offer-less campaign on a multi-offer brand: nothing downstream can fix it, no retry will.
    await expect(
      readLegModelEligibility({ featureSlug: ROTATING_FEATURE, brandId: BRAND_ID, legKey: LEG, identity }),
    ).resolves.toBeNull();
    expect(err).toHaveBeenCalledTimes(1);
    expect(String(err.mock.calls[0]?.[0])).toContain("UNANSWERABLE");
    expect(warn).not.toHaveBeenCalled();
  });

  it("carries the leg body's own rows so the substitution has something to price with", async () => {
    global.fetch = routeFetch({ funnelUnresolved: true }) as unknown as typeof fetch;
    const verdict = await readLegModelEligibility({
      featureSlug: ROTATING_FEATURE,
      brandId: BRAND_ID,
      legKey: LEG,
      campaignId: CAMPAIGN_ID,
      identity,
    });
    expect(verdict?.rows.map((r) => r.workflow.workflowDynastySlug)).toEqual(["leg-cheap-wf", "leg-dear-wf"]);
    expect(verdict?.rows[0]?.resolved.costPerOutcomeUsd).toBe(12);
  });
});
