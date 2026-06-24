import { describe, it, expect } from "vitest";
import { thompsonArgminCost, greedyArgminCost, sampleBeta, type Arm, type Rng } from "../../src/lib/bandit.js";
import {
  selectWorkflowGreedy,
  audienceIdsForWorkflow,
  type Candidate,
} from "../../src/lib/features-candidates-client.js";

// Deterministic PRNG so the probabilistic assertions are reproducible.
function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function distribution(arms: Arm[], seed: number, draws = 2000): number[] {
  const rng = mulberry32(seed);
  const counts = new Array(arms.length).fill(0);
  for (let i = 0; i < draws; i++) counts[thompsonArgminCost(arms, rng)!]++;
  return counts.map((c) => c / draws);
}

describe("thompsonArgminCost", () => {
  it("returns null for an empty arm list", () => {
    expect(thompsonArgminCost([])).toBeNull();
  });

  it("returns the only arm with no exploration", () => {
    expect(thompsonArgminCost([{ trials: 0, successes: 0, costPerTrial: null }])).toBe(0);
  });

  it("picks the strong low-cost-per-success arm the vast majority of the time", () => {
    // Arm 0: lots of evidence, cheap per success (high rate, same cost).
    // Arm 1: lots of evidence, expensive per success (low rate, same cost).
    const arms: Arm[] = [
      { trials: 1000, successes: 300, costPerTrial: 100 }, // ~0.33/contact → cheap
      { trials: 1000, successes: 30, costPerTrial: 100 }, //  ~0.03/contact → 10x dearer
    ];
    const [p0] = distribution(arms, 1);
    expect(p0).toBeGreaterThan(0.95);
  });

  it("still explores a zero-evidence arm sometimes (not shadowed by a strong arm)", () => {
    // The known arm must be genuinely good (rate 0.6 > the uniform prior's 0.5),
    // otherwise an unexplored arm SHOULD win most of the time — optimism under
    // uncertainty beating a known-mediocre arm is correct, not a bug.
    const arms: Arm[] = [
      { trials: 1000, successes: 600, costPerTrial: 100 }, // strong AND good (0.6)
      { trials: 0, successes: 0, costPerTrial: null }, //     brand new — wide posterior
    ];
    const [, p1] = distribution(arms, 7);
    expect(p1).toBeGreaterThan(0); // explored
    expect(p1).toBeLessThan(0.5); // but not dominant
  });

  it("splits ~uniformly when every arm is cold (no evidence)", () => {
    const arms: Arm[] = [
      { trials: 0, successes: 0, costPerTrial: null },
      { trials: 0, successes: 0, costPerTrial: null },
      { trials: 0, successes: 0, costPerTrial: null },
    ];
    const probs = distribution(arms, 3);
    for (const p of probs) expect(Math.abs(p - 1 / 3)).toBeLessThan(0.08);
  });

  it("converges on the truth as evidence grows (exploitation dominates)", () => {
    const arms: Arm[] = [
      { trials: 100000, successes: 50000, costPerTrial: 100 }, // overwhelmingly best
      { trials: 100000, successes: 10000, costPerTrial: 100 },
    ];
    const [p0] = distribution(arms, 5, 1000);
    expect(p0).toBeGreaterThan(0.99);
  });
});

describe("greedyArgminCost", () => {
  it("returns null for an empty arm list", () => {
    expect(greedyArgminCost([])).toBeNull();
  });

  it("returns the only arm", () => {
    expect(greedyArgminCost([{ trials: 0, successes: 0, costPerTrial: null }])).toBe(0);
  });

  it("always picks the cheapest expected-cost-per-success arm (deterministic)", () => {
    const arms: Arm[] = [
      { trials: 1000, successes: 300, costPerTrial: 100 }, // ~0.33/contact → cheap
      { trials: 1000, successes: 30, costPerTrial: 100 }, //  ~0.03/contact → 10x dearer
    ];
    // Same answer every call — no exploration.
    for (let i = 0; i < 50; i++) expect(greedyArgminCost(arms)).toBe(0);
  });

  it("never explores a zero-evidence arm when a known arm is better (prior mean 0.5)", () => {
    const arms: Arm[] = [
      { trials: 1000, successes: 600, costPerTrial: 100 }, // rate 0.6 > prior 0.5
      { trials: 0, successes: 0, costPerTrial: 100 }, //      cold → scores at 0.5
    ];
    for (let i = 0; i < 50; i++) expect(greedyArgminCost(arms)).toBe(0);
  });

  it("prefers a cheaper arm at equal rate", () => {
    const arms: Arm[] = [
      { trials: 1000, successes: 500, costPerTrial: 200 }, // 0.5 rate, dear
      { trials: 1000, successes: 500, costPerTrial: 100 }, // 0.5 rate, cheap
    ];
    expect(greedyArgminCost(arms)).toBe(1);
  });

  it("resolves ties to the first index", () => {
    const arms: Arm[] = [
      { trials: 1000, successes: 500, costPerTrial: 100 },
      { trials: 1000, successes: 500, costPerTrial: 100 },
    ];
    expect(greedyArgminCost(arms)).toBe(0);
  });

  it("uses the pooled median cost for an arm with no cost signal", () => {
    // Cold arm has no cost → fallback median (100). Its prior-mean rate 0.5 makes its
    // expected cost 200, beating the known arm's 100/0.3≈333 → cold arm wins.
    const arms: Arm[] = [
      { trials: 1000, successes: 300, costPerTrial: 100 },
      { trials: 0, successes: 0, costPerTrial: null },
    ];
    expect(greedyArgminCost(arms)).toBe(1);
  });
});

describe("sampleBeta", () => {
  it("has mean ≈ alpha/(alpha+beta)", () => {
    const rng = mulberry32(42);
    const n = 20000;
    let sum = 0;
    for (let i = 0; i < n; i++) sum += sampleBeta(3, 7, rng);
    expect(Math.abs(sum / n - 3 / 10)).toBeLessThan(0.02);
  });
});

describe("selectWorkflowGreedy", () => {
  const mk = (
    slug: string,
    contacted: number,
    replies: number,
    clicks: number,
    cpl: number,
    audienceId: string | null = null,
    grain: Candidate["grain"] = "brand-goal",
  ): Candidate => ({
    audienceId,
    workflow: { workflowDynastySlug: slug, workflowDynastyName: slug },
    goal: "meetingBooked",
    grain,
    costPerOutcomeUsd: null,
    cost: { costPerLeadUsd: cpl, clickUsd: null, replyUsd: null },
    sampleSize: { runs: 1, contacted, clicks, replies },
  });

  it("returns null for no candidates", () => {
    expect(selectWorkflowGreedy([], "meetingBooked")).toBeNull();
  });

  it("returns null when the brand has NO own evidence (all candidates grain 'goal-global')", () => {
    // Cold-start: features-service hands back every active workflow at the cross-org
    // fallback grain. The bandit must NOT pick from it — caller falls back to the
    // configured slug. (Regression: a fresh brand saw its workflow jump run-to-run.)
    const candidates = [
      mk("wf-a", 1000, 200, 5, 100, null, "goal-global"),
      mk("wf-b", 1000, 20, 300, 100, null, "goal-global"),
    ];
    expect(selectWorkflowGreedy(candidates, "meetingBooked")).toBeNull();
  });

  it("picks only among BRAND-LEVEL rows, ignoring 'goal-global' fallback rows", () => {
    // wf-bad looks cheapest cross-org but has no brand evidence; wf-good has the
    // brand's own evidence and must win even though a goal-global row is present.
    const candidates = [
      mk("wf-good", 1000, 200, 5, 100, "aud-1", "audience"),
      mk("wf-cheap-global", 1000, 999, 5, 1, null, "goal-global"),
    ];
    expect(selectWorkflowGreedy(candidates, "meetingBooked")).toBe("wf-good");
  });

  it("always picks the cheaper-per-reply workflow (cppr goal → replies), deterministically", () => {
    const candidates = [
      mk("wf-good", 1000, 200, 5, 100), // 0.2 reply rate
      mk("wf-bad", 1000, 20, 300, 100), //  0.02 reply rate (lots of clicks — irrelevant for this goal)
    ];
    for (let i = 0; i < 50; i++) expect(selectWorkflowGreedy(candidates, "meetingBooked")).toBe("wf-good");
  });

  it("uses CLICKS as the success for the signup goal (flips the winner)", () => {
    const candidates = [
      mk("wf-replies", 1000, 300, 10, 100), // great replies, poor clicks
      mk("wf-clicks", 1000, 10, 300, 100), //  poor replies, great clicks
    ];
    expect(selectWorkflowGreedy(candidates, "signup")).toBe("wf-clicks");
  });

  it("aggregates a workflow's evidence across its (audience,workflow) rows", () => {
    // Same workflow appears twice (two audiences). Combined it has strong replies.
    const candidates = [
      mk("wf-split", 500, 100, 5, 100),
      mk("wf-split", 500, 100, 5, 100),
      mk("wf-weak", 1000, 20, 5, 100),
    ];
    expect(selectWorkflowGreedy(candidates, "meetingBooked")).toBe("wf-split");
  });
});

describe("audienceIdsForWorkflow", () => {
  const mk = (slug: string, audienceId: string | null): Candidate => ({
    audienceId,
    workflow: { workflowDynastySlug: slug, workflowDynastyName: slug },
    goal: "meetingBooked",
    grain: audienceId ? "audience" : "brand-goal",
    costPerOutcomeUsd: null,
    cost: { costPerLeadUsd: 100, clickUsd: null, replyUsd: null },
    sampleSize: { runs: 1, contacted: 100, clicks: 5, replies: 10 },
  });

  it("returns only the audience-grain rows (audienceId non-null) for the chosen workflow", () => {
    const candidates = [
      mk("wf-a", "aud-1"),
      mk("wf-a", "aud-2"),
      mk("wf-a", null), //   coarse fallback row — excluded
      mk("wf-b", "aud-3"), // other workflow — excluded
    ];
    expect(audienceIdsForWorkflow(candidates, "wf-a").sort()).toEqual(["aud-1", "aud-2"]);
  });

  it("de-duplicates repeated audienceIds", () => {
    const candidates = [mk("wf-a", "aud-1"), mk("wf-a", "aud-1")];
    expect(audienceIdsForWorkflow(candidates, "wf-a")).toEqual(["aud-1"]);
  });

  it("returns empty for a workflow with no audience-attributed couples", () => {
    const candidates = [mk("wf-a", null), mk("wf-b", "aud-1")];
    expect(audienceIdsForWorkflow(candidates, "wf-a")).toEqual([]);
  });
});
