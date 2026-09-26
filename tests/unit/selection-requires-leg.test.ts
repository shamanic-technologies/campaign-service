import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { resolveSelectionForTrigger } from "../../src/lib/features-workflow-projection-client.js";
import type { DownstreamIdentity } from "../../src/lib/downstream-headers.js";

// Wave C2: features-service's funnel- and goal-keyed reads (and /goal-arbitration) are gone, so
// the leg-keyed body is the ONLY thing a pick is priced on. A campaign that states no leg is not
// selected at all — it runs its configured workflow and says so; nothing is invented to ask with.

const ROTATING_FEATURE = "sales-cold-email-outreach";
const BRAND_ID = "brand-1";
const LEG = "start_to_conversation";
const identity: DownstreamIdentity = {
  orgId: "org-1",
  userId: "user-1",
  runId: "11111111-1111-4111-8111-111111111111",
  campaignId: "camp-1",
  brandId: BRAND_ID,
  workflowSlug: "wf-configured",
  featureSlug: ROTATING_FEATURE,
};

function rawRow(audienceId: string, slug: string, costPerOutcomeUsd: number) {
  return {
    audienceId,
    workflow: { workflowDynastySlug: slug, workflowDynastyName: slug },
    estimatesByGrain: {
      audience: {
        evidence: { spentUsd: 10, observedContacted: 100, observedClicks: 20, observedPositiveReplies: 5 },
        resolvedOutcomeCount: 5,
      },
    },
    resolved: { grain: "audience", costPerOutcomeUsd },
  };
}

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
}

const baseArgs = {
  featureSlug: ROTATING_FEATURE,
  primaryBrandId: BRAND_ID,
  identity,
  fallbackSlug: "wf-configured",
  campaignId: "camp-1",
};

let errSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  process.env.FEATURES_SERVICE_URL = "http://features-service";
  process.env.FEATURES_SERVICE_API_KEY = "test-key";
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("resolveSelectionForTrigger — the leg is the only pricing key", () => {
  it("a campaign stating NO leg makes no features-service call and runs its configured workflow, loudly", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(resolveSelectionForTrigger(baseArgs)).resolves.toEqual({
      workflowSlug: "wf-configured",
      audienceId: null,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(String(errSpy.mock.calls[0]?.[0])).toContain("states NO leg");
  });

  it("returns the CELL — the audience it chose and the cheapest workflow in that audience's column", async () => {
    // wf-D is the globally cheapest cell ($20 on aud-A) and terrible on aud-B; wf-E is $21 on
    // both. Constrained to aud-B, the answer must be wf-E.
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        rows: [
          rawRow("aud-A", "wf-D", 20),
          rawRow("aud-B", "wf-D", 185),
          rawRow("aud-A", "wf-E", 21),
          rawRow("aud-B", "wf-E", 21),
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      resolveSelectionForTrigger({ ...baseArgs, legKey: LEG, requiredAudienceIds: ["aud-B"] }),
    ).resolves.toEqual({ workflowSlug: "wf-E", audienceId: "aud-B" });
    // ONE read, leg-keyed, naming neither a funnel nor a goal, and never the arbitration route.
    const urls = fetchMock.mock.calls.map((c) => new URL(String((c as unknown[])[0])));
    expect(urls).toHaveLength(1);
    expect(urls[0]?.pathname).toContain("/workflow-projection");
    expect(urls[0]?.searchParams.get("leg")).toBe(LEG);
    expect(urls[0]?.searchParams.has("funnel")).toBe(false);
    expect(urls[0]?.searchParams.has("goal")).toBe(false);
  });

  it("chooses no audience and keeps the configured slug when features-service is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 503, text: async () => "down", json: async () => ({}) })),
    );

    await expect(resolveSelectionForTrigger({ ...baseArgs, legKey: LEG })).resolves.toEqual({
      workflowSlug: "wf-configured",
      audienceId: null,
    });
    expect(warnSpy).toHaveBeenCalled();
  });

  it("does not call features-service at all for a non-rotating feature", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      resolveSelectionForTrigger({ ...baseArgs, featureSlug: "pr-expert-quote-outreach" }),
    ).resolves.toEqual({ workflowSlug: "wf-configured", audienceId: null });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(errSpy).not.toHaveBeenCalled();
  });
});
