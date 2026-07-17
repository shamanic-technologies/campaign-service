import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { selectAudienceForRun } from "../../src/lib/features-audience-client.js";
import type { Rng } from "../../src/lib/bandit.js";

// Deterministic RNG so Thompson sampling is reproducible: always sample the mean.
const fixedRng: Rng = () => 0.5;

function audience(id: string, status: "active" | "paused" | "archived" = "active") {
  return {
    audienceId: id,
    brandProfileId: null,
    audience: { id, name: id, status, filters: null },
    evidence: {
      totalCostInUsdCents: 1000,
      completedRuns: 5,
      firstRunAt: null,
      lastRunAt: null,
      contacted: 100,
      opened: 40,
      websiteClicks: 20,
      positiveReplies: 5,
    },
    metrics: { cpcCents: 500, cpprCents: 2000 },
  };
}

function mockStats(audiences: ReturnType<typeof audience>[], sortMetric = "cpc") {
  return vi.fn(async () => ({
    ok: true,
    json: async () => ({ sortMetric, audiences }),
  })) as unknown as typeof fetch;
}

const baseInput = {
  featureSlug: "sales-cold-email-outreach",
  brandId: "brand-1",
  goal: "signup" as const,
  identity: {
    orgId: "org-1",
    userId: "user-1",
    runId: "run-1",
    campaignId: "camp-1",
    brandId: "brand-1",
    workflowSlug: "wf-1",
    featureSlug: "sales-cold-email-outreach",
  },
  rng: fixedRng,
};

describe("selectAudienceForRun — Campaign v2 hard targeting subset", () => {
  beforeEach(() => {
    process.env.FEATURES_SERVICE_URL = "http://features.test";
    process.env.FEATURES_SERVICE_API_KEY = "test-key";
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("restricts the pick to the campaign's targeted audiences (never contacts outside the subset)", async () => {
    global.fetch = mockStats([audience("aud-a"), audience("aud-b"), audience("aud-c")]);
    const picked = await selectAudienceForRun({
      ...baseInput,
      requiredAudienceIds: ["aud-a", "aud-b"],
    });
    expect(picked).not.toBeNull();
    expect(["aud-a", "aud-b"]).toContain(picked!.audienceId);
  });

  it("returns null (contacts none) when none of the targeted audiences is active — NO fallback", async () => {
    // Targeted audiences are paused/absent; an untargeted 'aud-z' is active. The campaign
    // must NOT fall back to aud-z.
    global.fetch = mockStats([audience("aud-a", "paused"), audience("aud-z", "active")]);
    const picked = await selectAudienceForRun({
      ...baseInput,
      requiredAudienceIds: ["aud-a", "aud-b"],
    });
    expect(picked).toBeNull();
  });

  it("inherits the brand (all active audiences) when no subset is targeted", async () => {
    global.fetch = mockStats([audience("aud-z")]);
    const picked = await selectAudienceForRun(baseInput);
    expect(picked?.audienceId).toBe("aud-z");
  });

  it("intersects the soft workflow-conditioning filter WITHIN the hard subset", async () => {
    // Subset = {a, b, c}; workflow-conditioning eligible = {b, d}. Only b is in both.
    global.fetch = mockStats([audience("aud-a"), audience("aud-b"), audience("aud-c")]);
    const picked = await selectAudienceForRun({
      ...baseInput,
      requiredAudienceIds: ["aud-a", "aud-b", "aud-c"],
      eligibleAudienceIds: ["aud-b", "aud-d"],
    });
    expect(picked?.audienceId).toBe("aud-b");
  });
});
