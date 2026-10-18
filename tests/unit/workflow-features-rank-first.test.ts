import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { resolveSelectionForTrigger } from "../../src/lib/features-workflow-projection-client.js";
import type { DownstreamIdentity } from "../../src/lib/downstream-headers.js";

// WF-ORDER-EXPLORE-1018: which workflow a campaign runs on its leg is features-service's decision.
// Every run takes its rank 1 among the workflows the campaign may run, priced or not; the cost
// argmin only answers when features ranks nothing runnable.

const identity: DownstreamIdentity = {
  orgId: "org-1",
  userId: "user-1",
  runId: "11111111-1111-4111-8111-111111111111",
  campaignId: "camp-1",
  brandId: "brand-1",
  workflowSlug: "wf-configured",
  featureSlug: "sales-cold-email-outreach",
};

const args = {
  featureSlug: "sales-cold-email-outreach",
  primaryBrandId: "brand-1",
  identity,
  fallbackSlug: "wf-configured",
  campaignId: "camp-1",
  legKey: "lead_found_to_website_visit",
};

function brandRow(slug: string, rank: number | undefined, cpo: number | null, opts: { selectable?: boolean; eligible?: boolean } = {}) {
  return {
    audienceId: null,
    workflow: { workflowDynastySlug: slug, workflowDynastyName: slug },
    resolved: { grain: "brand", costPerOutcomeUsd: cpo },
    ...(rank === undefined ? {} : { rank, legAssignment: { state: "active", selectable: opts.selectable ?? true } }),
    ...(opts.eligible === false ? { modelEligibility: { eligible: false, ineligibleReason: "tier" } } : {}),
  };
}

function audienceRow(audienceId: string, slug: string, cpo: number | null) {
  return {
    audienceId,
    workflow: { workflowDynastySlug: slug, workflowDynastyName: slug },
    estimatesByGrain: {
      audience: {
        evidence: { spentUsd: 10, observedContacted: 100, observedClicks: 20, observedPositiveReplies: 5 },
        resolvedOutcomeCount: 5,
      },
    },
    resolved: { grain: "audience", costPerOutcomeUsd: cpo },
  };
}

function serve(rows: unknown[]) {
  const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ rows }), text: async () => "" }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  process.env.FEATURES_SERVICE_URL = "http://features-service";
  process.env.FEATURES_SERVICE_API_KEY = "test-key";
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("resolveSelectionForTrigger — features-service's rank 1 runs", () => {
  it("runs rank 1 even with NO price yet (a new workflow is never skipped)", async () => {
    serve([
      brandRow("aldhanab", 1, null),
      brandRow("lithium", 2, 5),
      audienceRow("aud-1", "aldhanab", null),
      audienceRow("aud-1", "lithium", 5),
    ]);
    const sel = await resolveSelectionForTrigger(args);
    expect(sel.workflowSlug).toBe("aldhanab");
    expect(sel.audienceId).toBe("aud-1");
  });

  it("never picks another workflow than rank 1, even a far cheaper one", async () => {
    serve([
      brandRow("cheap", 3, 1),
      brandRow("expensive", 1, 500),
      brandRow("mid", 2, 50),
      audienceRow("aud-1", "cheap", 1),
      audienceRow("aud-1", "expensive", 500),
    ]);
    for (let i = 0; i < 20; i++) expect((await resolveSelectionForTrigger(args)).workflowSlug).toBe("expensive");
  });

  it("skips a rank the campaign may not run (not selectable, or ineligible) and takes the next", async () => {
    serve([
      brandRow("ruled-out", 1, null, { selectable: false }),
      brandRow("wrong-tier", 2, null, { eligible: false }),
      brandRow("hamal", 3, null),
      brandRow("cheap", 4, 1),
    ]);
    expect((await resolveSelectionForTrigger(args)).workflowSlug).toBe("hamal");
  });

  it("features ranks nothing runnable: the pre-existing cost pick is unchanged", async () => {
    serve([
      brandRow("cheap", undefined, 1),
      brandRow("dear", undefined, 9),
      audienceRow("aud-1", "cheap", 1),
      audienceRow("aud-1", "dear", 9),
    ]);
    expect((await resolveSelectionForTrigger(args)).workflowSlug).toBe("cheap");
  });
});
