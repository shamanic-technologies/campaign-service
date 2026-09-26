import { describe, it, expect } from "vitest";
import {
  selectAudiencePooled,
  selectAudienceFromProjection,
  selectCellFromProjection,
  type ProjectionRow,
  type ProjectionAudienceEvidence,
} from "../../src/lib/features-workflow-projection-client.js";
import type { Rng } from "../../src/lib/bandit.js";

// features-service#1035. Prod 2026-09-26, brand 75d7e3e8 / campaign f7b1b610: audience f703c236 was
// pulled at 05:00 UTC while human-service reported 0 people left in it and 6,111 in 68d1aa78. The
// served-out audience is the CHEAPEST arm here, so the pick without the rule lands on it.
const fixedRng: Rng = () => 0.5;

function ev(spentUsd: number): ProjectionAudienceEvidence {
  return { spentUsd, observedContacted: 100, observedClicks: 10, observedPositiveReplies: 5, resolvedOutcomeCount: 5 };
}

function row(audienceId: string, availableToContactCount: number | null | undefined, spentUsd: number): ProjectionRow {
  return {
    audienceId,
    workflow: { workflowDynastySlug: "wf-A", workflowDynastyName: "wf-A" },
    audienceEvidence: ev(spentUsd),
    availableToContactCount,
    resolved: { grain: "audience", costPerOutcomeUsd: spentUsd / 5 },
  };
}

const dryCheap = row("aud-dry", 0, 5);
const fullDear = row("aud-full", 6111, 50);

describe("a served-out audience is not picked while another still has people", () => {
  it("DIVERGES: without the count the cheap dry audience wins; with it, the one with people does", () => {
    const blind = [{ ...dryCheap, availableToContactCount: null }, fullDear];
    expect(selectAudiencePooled(blind, { rng: fixedRng })).toBe("aud-dry");
    expect(selectAudiencePooled([dryCheap, fullDear], { rng: fixedRng })).toBe("aud-full");
  });

  it("holds on the workflow-scoped selector and the cell pick too", () => {
    expect(selectAudienceFromProjection([dryCheap, fullDear], "wf-A", { rng: fixedRng })).toBe("aud-full");
    expect(selectCellFromProjection([dryCheap, fullDear], { rng: fixedRng }).audienceId).toBe("aud-full");
  });

  it("an UNKNOWN count never excludes: a null or absent count stays in play beside a 0", () => {
    const unknownCheap = row("aud-unknown", null, 5);
    const absentCheap = row("aud-absent", undefined, 5);
    expect(selectAudiencePooled([row("aud-dry", 0, 1), unknownCheap], { rng: fixedRng })).toBe("aud-unknown");
    expect(selectAudiencePooled([row("aud-dry", 0, 1), absentCheap], { rng: fixedRng })).toBe("aud-absent");
  });

  it("when EVERY audience is served out it still picks one, so the serve probes and the exhaustion path fires", () => {
    const allDry = [row("aud-1", 0, 5), row("aud-2", 0, 50)];
    expect(selectAudiencePooled(allDry, { rng: fixedRng })).toBe("aud-1");
    expect(selectAudienceFromProjection(allDry, "wf-A", { rng: fixedRng })).toBe("aud-1");
  });

  it("the fresh-exhausted exclusion and the required subset still apply first", () => {
    // the only audience with people is freshly exhausted → the rule does not resurrect it, and does not
    // invent an empty answer either: the dry one is still probed.
    expect(selectAudiencePooled([dryCheap, fullDear], { excludedAudienceIds: ["aud-full"], rng: fixedRng })).toBe("aud-dry");
    // a required subset naming only the dry audience keeps it
    expect(selectAudiencePooled([dryCheap, fullDear], { requiredAudienceIds: ["aud-dry"], rng: fixedRng })).toBe("aud-dry");
  });
});
