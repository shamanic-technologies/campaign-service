import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  fetchWorkflowProjectionRows,
  selectAudienceFromProjection,
  hasServeableAudienceInProjection,
  type ProjectionRow,
  type ProjectionAudienceEvidence,
} from "../../src/lib/features-workflow-projection-client.js";
import type { Rng } from "../../src/lib/bandit.js";

// Deterministic RNG (always samples 0.5) — Thompson still explores, so tests are written so the
// ANSWER is deterministic regardless of the draw (single candidate, or set membership).
const fixedRng: Rng = () => 0.5;

function ev(overrides: Partial<ProjectionAudienceEvidence> = {}): ProjectionAudienceEvidence {
  return {
    spentUsd: 10,
    observedContacted: 100,
    observedClicks: 20,
    observedPositiveReplies: 5,
    resolvedOutcomeCount: 5,
    ...overrides,
  };
}

function row(
  audienceId: string | null,
  slug = "wf-a",
  audienceEvidence: ProjectionAudienceEvidence | null = null,
): ProjectionRow {
  return {
    audienceId,
    workflow: { workflowDynastySlug: slug, workflowDynastyName: slug },
    audienceEvidence,
    resolved: { grain: audienceEvidence ? "audience" : "brand", costPerOutcomeUsd: 10 },
  };
}

describe("selectAudienceFromProjection — workflow scoping", () => {
  it("picks only from the chosen workflow's audience rows", () => {
    const rows = [row("aud-1", "wf-a", ev()), row("aud-2", "wf-b", ev())];
    expect(selectAudienceFromProjection(rows, "wf-a", { rng: fixedRng })).toBe("aud-1");
  });

  it("ignores the brand-level (audienceId=null) rows", () => {
    const rows = [row(null, "wf-a", null), row("aud-1", "wf-a", ev())];
    expect(selectAudienceFromProjection(rows, "wf-a", { rng: fixedRng })).toBe("aud-1");
  });

  it("falls back to all audiences when the chosen workflow has no rows (cold/fallback slug)", () => {
    const rows = [row("aud-2", "wf-b", ev())];
    expect(selectAudienceFromProjection(rows, "wf-a", { rng: fixedRng })).toBe("aud-2");
  });

  it("selects a floored audience (no audience-grain evidence) as a cold arm", () => {
    const rows = [row("aud-fresh", "wf-a", null)];
    expect(selectAudienceFromProjection(rows, "wf-a", { rng: fixedRng })).toBe("aud-fresh");
  });

  it("de-duplicates repeated audienceIds into a single candidate", () => {
    const rows = [row("aud-1", "wf-a", null), row("aud-1", "wf-a", ev())];
    expect(selectAudienceFromProjection(rows, "wf-a", { rng: fixedRng })).toBe("aud-1");
  });

  it("returns null when there are no audience rows at all", () => {
    expect(selectAudienceFromProjection([row(null, "wf-a")], "wf-a", { rng: fixedRng })).toBeNull();
  });
});

describe("selectAudienceFromProjection — hard targeting subset (requiredAudienceIds)", () => {
  it("only picks an audience inside the targeted subset", () => {
    const rows = [row("aud-a", "wf-a", ev()), row("aud-z", "wf-a", ev())];
    const picked = selectAudienceFromProjection(rows, "wf-a", {
      requiredAudienceIds: ["aud-a", "aud-b"],
      rng: fixedRng,
    });
    expect(picked).toBe("aud-a"); // aud-z is untargeted; aud-b is absent
  });

  it("returns null (contacts none) when no targeted audience is present — NO fallback", () => {
    const rows = [row("aud-z", "wf-a", ev())];
    const picked = selectAudienceFromProjection(rows, "wf-a", {
      requiredAudienceIds: ["aud-a", "aud-b"],
      rng: fixedRng,
    });
    expect(picked).toBeNull();
  });
});

describe("selectAudienceFromProjection — exhausted-audience exclusion", () => {
  it("never picks an excluded (exhausted) audience", () => {
    const rows = [row("aud-a", "wf-a", ev()), row("aud-b", "wf-a", ev())];
    const picked = selectAudienceFromProjection(rows, "wf-a", {
      excludedAudienceIds: ["aud-a"],
      rng: fixedRng,
    });
    expect(picked).toBe("aud-b");
  });

  it("returns null when every audience is excluded (all exhausted → stop signal)", () => {
    const rows = [row("aud-a", "wf-a", ev()), row("aud-b", "wf-a", ev())];
    const picked = selectAudienceFromProjection(rows, "wf-a", {
      excludedAudienceIds: ["aud-a", "aud-b"],
      rng: fixedRng,
    });
    expect(picked).toBeNull();
  });

  it("applies exclusion WITHIN the targeted subset (one exhausted of two targeted → picks the other)", () => {
    const rows = [row("aud-a", "wf-a", ev()), row("aud-b", "wf-a", ev()), row("aud-z", "wf-a", ev())];
    const picked = selectAudienceFromProjection(rows, "wf-a", {
      requiredAudienceIds: ["aud-a", "aud-b"],
      excludedAudienceIds: ["aud-a"],
      rng: fixedRng,
    });
    expect(picked).toBe("aud-b");
  });
});

describe("selectAudienceFromProjection — ranks on the goal-resolved outcome, not clicks/replies", () => {
  it("prefers the audience with the better goal-resolved cost-per-outcome", () => {
    // Identical raw clicks/replies, but features resolved very different outcome counts +
    // spend → very different cost-per-outcome. If the bandit still used clicks/replies (old
    // CPC/CPPR) the two would tie; ranking on resolvedOutcomeCount makes `good` win decisively.
    const good = ev({ observedContacted: 100, observedClicks: 5, observedPositiveReplies: 5, spentUsd: 10, resolvedOutcomeCount: 50 });
    const bad = ev({ observedContacted: 100, observedClicks: 5, observedPositiveReplies: 5, spentUsd: 100, resolvedOutcomeCount: 1 });
    const rows = [row("aud-good", "wf-a", good), row("aud-bad", "wf-a", bad)];
    expect(selectAudienceFromProjection(rows, "wf-a", { rng: fixedRng })).toBe("aud-good");
  });
});

describe("hasServeableAudienceInProjection", () => {
  it("true when at least one non-exhausted audience remains", () => {
    const rows = [row("aud-a", "wf-a"), row("aud-b", "wf-b")];
    expect(hasServeableAudienceInProjection(rows, { excludedAudienceIds: ["aud-a"] })).toBe(true);
  });

  it("false when every audience is exhausted", () => {
    const rows = [row("aud-a", "wf-a"), row("aud-b", "wf-a")];
    expect(hasServeableAudienceInProjection(rows, { excludedAudienceIds: ["aud-a", "aud-b"] })).toBe(false);
  });

  it("false when there are no audience rows", () => {
    expect(hasServeableAudienceInProjection([row(null, "wf-a")], {})).toBe(false);
  });

  it("intersects the targeted subset before checking exhaustion", () => {
    const rows = [row("aud-a", "wf-a"), row("aud-z", "wf-a")];
    // Only aud-a is targeted, and it's exhausted → no serveable targeted audience.
    expect(
      hasServeableAudienceInProjection(rows, {
        requiredAudienceIds: ["aud-a"],
        excludedAudienceIds: ["aud-a"],
      }),
    ).toBe(false);
  });

  it("counts an audience under ANY workflow (workflow-agnostic)", () => {
    const rows = [row("aud-a", "wf-a"), row("aud-b", "wf-b")];
    expect(hasServeableAudienceInProjection(rows, {})).toBe(true);
  });
});

// ── What the projection is PRICED on: the funnel a campaign states, else the brand's goal ──
describe("fetchWorkflowProjectionRows pricing key", () => {
  const identity = {
    orgId: "org-1",
    userId: "user-1",
    runId: "11111111-1111-4111-8111-111111111111",
    campaignId: "camp-1",
    brandId: "brand-1",
    workflowSlug: "wf-1",
    featureSlug: "sales-cold-email-outreach",
  };

  function stubOk() {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ rows: [] }),
      text: async () => "{}",
    }));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  beforeEach(() => {
    process.env.FEATURES_SERVICE_URL = "http://features-service";
    process.env.FEATURES_SERVICE_API_KEY = "test-key";
  });

  it("sends the FUNNEL when the campaign states one — it wins over a goal at features-service", async () => {
    const fetchMock = stubOk();
    await fetchWorkflowProjectionRows({
      featureSlug: "sales-cold-email-outreach",
      brandId: "brand-1",
      funnelKey: "sales_meetings_from_website",
      goal: null,
      identity,
    });
    const href = fetchMock.mock.calls[0][0].toString();
    expect(href).toContain("funnel=sales_meetings_from_website");
    expect(href).not.toContain("goal=");
  });

  it("sends the brand's GOAL for a campaign that states no funnel — a feature with no sales funnel", async () => {
    const fetchMock = stubOk();
    await fetchWorkflowProjectionRows({
      featureSlug: "pr-cold-email-outreach",
      brandId: "brand-1",
      funnelKey: null,
      goal: "positiveReply",
      identity,
    });
    const href = fetchMock.mock.calls[0][0].toString();
    expect(href).toContain("goal=positiveReply");
    expect(href).not.toContain("funnel=");
  });

  it("THROWS when given neither — features-service reads an absent goal as a silent meeting-booked default", async () => {
    stubOk();
    await expect(
      fetchWorkflowProjectionRows({
        featureSlug: "sales-cold-email-outreach",
        brandId: "brand-1",
        funnelKey: null,
        goal: null,
        identity,
      }),
    ).rejects.toThrow(/needs the funnel/);
  });
});
