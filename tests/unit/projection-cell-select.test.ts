import { describe, it, expect } from "vitest";
import {
  selectCellFromProjection,
  selectAudiencePooled,
  selectWorkflowGreedy,
  type ProjectionRow,
  type ProjectionAudienceEvidence,
} from "../../src/lib/features-workflow-projection-client.js";
import type { Rng } from "../../src/lib/bandit.js";

// Deterministic RNG (always samples 0.5). Every arm therefore draws the same rate for the same
// (trials, successes), so a test that differs the arms only by COST has one answer.
const fixedRng: Rng = () => 0.5;

function cell(
  audienceId: string | null,
  slug: string,
  costPerOutcomeUsd: number | null,
  audienceEvidence: ProjectionAudienceEvidence | null = null,
): ProjectionRow {
  return {
    audienceId,
    workflow: { workflowDynastySlug: slug, workflowDynastyName: slug },
    audienceEvidence,
    resolved: { grain: audienceEvidence ? "audience" : "brand", costPerOutcomeUsd },
  };
}

function ev(
  overrides: Partial<ProjectionAudienceEvidence> = {},
): ProjectionAudienceEvidence {
  return {
    spentUsd: 10,
    observedContacted: 100,
    observedClicks: 20,
    observedPositiveReplies: 5,
    resolvedOutcomeCount: 5,
    ...overrides,
  };
}

describe("selectCellFromProjection — the run serves a CELL, not a ROW", () => {
  // The shape measured in prod (brand 75d7e3e8, campaign f7b1b610): one workflow is spectacular
  // on ONE audience and terrible everywhere else, and its single cheap cell used to win the
  // global argmin and then run on every audience.
  const grid: ProjectionRow[] = [
    cell("aud-A", "wf-D", 20, ev()),
    cell("aud-B", "wf-D", 185, ev()),
    cell("aud-A", "wf-E", 21, ev()),
    cell("aud-B", "wf-E", 21, ev()),
  ];

  it("DIVERGES from the row pick: on audience B the cheapest cell is E, not the globally cheapest D", () => {
    // What the replaced implementation answers, over the same rows and the same parameters.
    expect(selectWorkflowGreedy(grid)).toBe("wf-D");

    // What the cell pick answers once the audience is chosen first.
    const chosen = selectCellFromProjection(grid, {
      requiredAudienceIds: ["aud-B"],
      rng: fixedRng,
    });
    expect(chosen.audienceId).toBe("aud-B");
    expect(chosen.workflowSlug).toBe("wf-E");
  });

  it("still answers the globally cheapest workflow when the chosen audience IS the one it is cheap on", () => {
    const chosen = selectCellFromProjection(grid, {
      requiredAudienceIds: ["aud-A"],
      rng: fixedRng,
    });
    expect(chosen).toEqual({ audienceId: "aud-A", workflowSlug: "wf-D" });
  });
});

describe("selectAudiencePooled — the audience is judged on its WHOLE column", () => {
  // aud-spiky is the lithium shape: one brilliant cell, eleven awful ones. aud-steady is
  // uniformly decent. Conditioned on the spiky workflow, aud-spiky looks best; pooled over the
  // column — which is what the customer's money actually buys — aud-steady is better on both
  // cost per lead and outcome rate, so it wins under any draw.
  const pooled: ProjectionRow[] = [
    cell("aud-spiky", "wf-spiky", 5, ev({ spentUsd: 10, observedContacted: 100, resolvedOutcomeCount: 10 })),
    ...Array.from({ length: 11 }, (_, i) =>
      cell("aud-spiky", `wf-${i}`, 200, ev({ spentUsd: 100, observedContacted: 100, resolvedOutcomeCount: 1 })),
    ),
    ...Array.from({ length: 12 }, (_, i) =>
      cell("aud-steady", `wf-${i}`, 40, ev({ spentUsd: 20, observedContacted: 100, resolvedOutcomeCount: 5 })),
    ),
  ];

  it("prefers the audience whose pooled column is cheaper per outcome", () => {
    expect(selectAudiencePooled(pooled, { rng: fixedRng })).toBe("aud-steady");
  });

  it("enumerates an audience with no evidence anywhere as a COLD arm rather than dropping it", () => {
    const rows = [cell("aud-never-run", "wf-a", null, null)];
    expect(selectAudiencePooled(rows, { rng: fixedRng })).toBe("aud-never-run");
  });

  it("ignores the brand-level (audienceId=null) rows", () => {
    const rows = [cell(null, "wf-a", 3, null), cell("aud-1", "wf-a", 9, ev())];
    expect(selectAudiencePooled(rows, { rng: fixedRng })).toBe("aud-1");
  });
});

describe("the campaign's constraints apply to the audience chosen at the TRIGGER", () => {
  const rows = [
    cell("aud-1", "wf-a", 10, ev()),
    cell("aud-2", "wf-a", 10, ev()),
    cell("aud-3", "wf-a", 10, ev()),
  ];

  it("never chooses an audience outside the HARD targeting subset", () => {
    for (let i = 0; i < 50; i++) {
      expect(selectCellFromProjection(rows, { requiredAudienceIds: ["aud-2"] }).audienceId).toBe("aud-2");
    }
  });

  it("never chooses a freshly-exhausted audience", () => {
    for (let i = 0; i < 50; i++) {
      const chosen = selectCellFromProjection(rows, { excludedAudienceIds: ["aud-1", "aud-3"] });
      expect(chosen.audienceId).toBe("aud-2");
    }
  });

  it("chooses NO audience when the two constraints leave nothing — and still names a workflow", () => {
    const chosen = selectCellFromProjection(rows, {
      requiredAudienceIds: ["aud-1"],
      excludedAudienceIds: ["aud-1"],
    });
    expect(chosen.audienceId).toBeNull();
    // The run still dispatches: the workflow falls back to the global argmin, which is what the
    // trigger answered before an audience was chosen here at all.
    expect(chosen.workflowSlug).toBe("wf-a");
  });

  it("keeps the chosen audience when its column carries no rankable economics", () => {
    const unpriced = [cell("aud-1", "wf-a", null, ev()), cell("aud-2", "wf-b", 7, ev())];
    const chosen = selectCellFromProjection(unpriced, { requiredAudienceIds: ["aud-1"] });
    expect(chosen.audienceId).toBe("aud-1");
    expect(chosen.workflowSlug).toBe("wf-b");
  });

  it("names no workflow at all when nothing in the grid is rankable", () => {
    expect(selectCellFromProjection([cell("aud-1", "wf-a", null, ev())]).workflowSlug).toBeNull();
  });
});
