import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockFetchBrandRuntimeContext = vi.hoisted(() => vi.fn());

vi.mock("../../src/lib/brand-runtime-client.js", () => ({
  fetchBrandRuntimeContext: mockFetchBrandRuntimeContext,
}));

import {
  fetchGoalArbitration,
  resolveWorkflowSlugForTrigger,
} from "../../src/lib/features-workflow-projection-client.js";
import type { DownstreamIdentity } from "../../src/lib/downstream-headers.js";

const ROTATING_FEATURE = "sales-cold-email-outreach";
const BRAND_ID = "brand-1";
const identity: DownstreamIdentity = {
  orgId: "org-1",
  userId: "user-1",
  runId: "11111111-1111-4111-8111-111111111111",
  campaignId: "camp-1",
  brandId: BRAND_ID,
  workflowSlug: "wf-configured",
  featureSlug: ROTATING_FEATURE,
};

/** A features-service row in the raw (estimatesByGrain) wire shape both endpoints serve. */
function rawRow(audienceId: string | null, slug: string, costPerOutcomeUsd: number | null = 10) {
  return {
    audienceId,
    workflow: { workflowDynastySlug: slug, workflowDynastyName: slug },
    estimatesByGrain: audienceId
      ? {
          audience: {
            evidence: { spentUsd: 10, observedContacted: 100, observedClicks: 20, observedPositiveReplies: 5 },
            resolvedOutcomeCount: 5,
          },
        }
      : undefined,
    resolved: { grain: audienceId ? "audience" : "brand", costPerOutcomeUsd },
  };
}

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
}

function errorResponse(status: number, body: unknown) {
  return { ok: false, status, json: async () => body, text: async () => JSON.stringify(body) };
}

/** Route the mocked fetch by path so one test can serve both endpoints. */
function routeFetch(handlers: { arbitration?: unknown; projection?: unknown }) {
  return vi.fn(async (url: URL | string) => {
    const href = url.toString();
    if (href.includes("/goal-arbitration")) {
      if (!handlers.arbitration) throw new Error("unexpected goal-arbitration call");
      return handlers.arbitration;
    }
    if (href.includes("/workflow-projection")) {
      if (!handlers.projection) throw new Error("unexpected workflow-projection call");
      return handlers.projection;
    }
    throw new Error(`unexpected fetch: ${href}`);
  });
}

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.resetAllMocks();
  process.env.FEATURES_SERVICE_URL = "http://features-service";
  process.env.FEATURES_SERVICE_API_KEY = "test-key";
  mockFetchBrandRuntimeContext.mockResolvedValue({ brand: {}, currentGoal: "signup", brandProfile: null });
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
});

describe("fetchGoalArbitration", () => {
  it("returns the elected goal, its workflow and the pairing's rows", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch({
        arbitration: jsonResponse({
          arbitration: { status: "resolved", goal: "positiveReply" },
          workflow: { workflowDynastySlug: "wf-elected" },
          rows: [rawRow(null, "wf-elected"), rawRow("aud-1", "wf-elected")],
        }),
      }),
    );

    const result = await fetchGoalArbitration({ featureSlug: ROTATING_FEATURE, brandId: BRAND_ID, identity });

    expect(result).not.toBeNull();
    expect(result!.goal).toBe("positiveReply");
    expect(result!.workflowSlug).toBe("wf-elected");
    // Rows arrive normalised exactly like /workflow-projection's, so the audience bandit
    // cannot behave differently depending on which endpoint fed it.
    expect(result!.rows).toHaveLength(2);
    expect(result!.rows[1].audienceEvidence).toMatchObject({ observedContacted: 100, resolvedOutcomeCount: 5 });
    expect(result!.rows[0].audienceEvidence).toBeNull();
  });

  it("returns null when nothing could be ranked (a real 200 answer, not an error)", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch({
        arbitration: jsonResponse({
          arbitration: { status: "unrankable", goal: null, reason: "no_rankable_goal" },
          workflow: null,
          rows: [],
        }),
      }),
    );

    await expect(
      fetchGoalArbitration({ featureSlug: ROTATING_FEATURE, brandId: BRAND_ID, identity }),
    ).resolves.toBeNull();
  });

  it("returns null WITHOUT throwing when the brand has no authorized goal set yet", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch({
        arbitration: errorResponse(502, {
          error: "brand-service states no authorized goal set for this brand",
          reason: "authorized_goals_unavailable",
        }),
      }),
    );

    await expect(
      fetchGoalArbitration({ featureSlug: ROTATING_FEATURE, brandId: BRAND_ID, identity }),
    ).resolves.toBeNull();
  });

  it("throws on any OTHER failure — that is a real anomaly, not an expected business state", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch({ arbitration: errorResponse(502, { error: "Failed to arbitrate goals" }) }),
    );

    await expect(
      fetchGoalArbitration({ featureSlug: ROTATING_FEATURE, brandId: BRAND_ID, identity }),
    ).rejects.toThrow(/goal-arbitration failed/);
  });

  it("throws when the producer says resolved but names no goal or workflow", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch({
        arbitration: jsonResponse({ arbitration: { status: "resolved", goal: "signup" }, workflow: null, rows: [] }),
      }),
    );

    await expect(
      fetchGoalArbitration({ featureSlug: ROTATING_FEATURE, brandId: BRAND_ID, identity }),
    ).rejects.toThrow(/without a goal or workflow/);
  });
});

describe("resolveWorkflowSlugForTrigger — goal arbitration", () => {
  const baseArgs = {
    featureSlug: ROTATING_FEATURE,
    primaryBrandId: BRAND_ID,
    identity,
    fallbackSlug: "wf-configured",
  };

  it("launches the elected goal's workflow", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch({
        arbitration: jsonResponse({
          arbitration: { status: "resolved", goal: "positiveReply" },
          workflow: { workflowDynastySlug: "wf-elected" },
          rows: [rawRow(null, "wf-elected")],
        }),
      }),
    );

    await expect(resolveWorkflowSlugForTrigger(baseArgs)).resolves.toBe("wf-elected");
    // The elected goal already ranked its own workflows — no second projection call.
    expect(mockFetchBrandRuntimeContext).not.toHaveBeenCalled();
  });

  it("falls back to the brand goal's greedy pick when nothing is arbitrated", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch({
        arbitration: errorResponse(502, { reason: "authorized_goals_unavailable" }),
        projection: jsonResponse({ rows: [rawRow(null, "wf-greedy", 3), rawRow(null, "wf-pricey", 30)] }),
      }),
    );

    await expect(resolveWorkflowSlugForTrigger(baseArgs)).resolves.toBe("wf-greedy");
    expect(mockFetchBrandRuntimeContext).toHaveBeenCalled();
  });

  it("does NOT warn on the no-authorized-set path — it fires every tick for every campaign", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch({
        arbitration: errorResponse(502, { reason: "authorized_goals_unavailable" }),
        projection: jsonResponse({ rows: [rawRow(null, "wf-greedy", 3)] }),
      }),
    );

    await resolveWorkflowSlugForTrigger(baseArgs);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("DOES warn when arbitration fails for any other reason", async () => {
    vi.stubGlobal("fetch", routeFetch({ arbitration: errorResponse(500, { error: "boom" }) }));

    await expect(resolveWorkflowSlugForTrigger(baseArgs)).resolves.toBe("wf-configured");
    expect(warnSpy).toHaveBeenCalled();
  });

  it("never arbitrates a campaign that states its OWN goal — that is a manual override", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch({ projection: jsonResponse({ rows: [rawRow(null, "wf-own-goal", 3)] }) }),
    );

    await expect(
      resolveWorkflowSlugForTrigger({ ...baseArgs, goalOverride: "websiteVisit" }),
    ).resolves.toBe("wf-own-goal");
    // routeFetch throws on an unexpected goal-arbitration call, so reaching here proves none was made.
  });

  it("does not call features-service at all for a non-rotating feature", async () => {
    const fetchMock = routeFetch({});
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      resolveWorkflowSlugForTrigger({ ...baseArgs, featureSlug: "pr-expert-quote-outreach" }),
    ).resolves.toBe("wf-configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
