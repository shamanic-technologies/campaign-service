import { describe, it, expect } from "vitest";
import { thompsonArgminCost, sampleBeta, type Arm, type Rng } from "../../src/lib/bandit.js";
import { selectWorkflowByThompson, type Candidate } from "../../src/lib/features-candidates-client.js";

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

describe("sampleBeta", () => {
  it("has mean ≈ alpha/(alpha+beta)", () => {
    const rng = mulberry32(42);
    const n = 20000;
    let sum = 0;
    for (let i = 0; i < n; i++) sum += sampleBeta(3, 7, rng);
    expect(Math.abs(sum / n - 3 / 10)).toBeLessThan(0.02);
  });
});

describe("selectWorkflowByThompson", () => {
  const mk = (slug: string, contacted: number, replies: number, clicks: number, cpl: number): Candidate => ({
    audienceId: null,
    workflow: { workflowDynastySlug: slug, workflowDynastyName: slug },
    goal: "meetingBooked",
    costPerOutcomeUsd: null,
    cost: { costPerLeadUsd: cpl, clickUsd: null, replyUsd: null },
    sampleSize: { runs: 1, contacted, clicks, replies },
  });

  it("returns null for no candidates", () => {
    expect(selectWorkflowByThompson([], "meetingBooked")).toBeNull();
  });

  it("picks the cheaper-per-reply workflow most of the time (cppr goal → replies)", () => {
    const candidates = [
      mk("wf-good", 1000, 200, 5, 100), // 0.2 reply rate
      mk("wf-bad", 1000, 20, 300, 100), //  0.02 reply rate (but lots of clicks — irrelevant for this goal)
    ];
    const rng = mulberry32(11);
    let good = 0;
    for (let i = 0; i < 1000; i++) if (selectWorkflowByThompson(candidates, "meetingBooked", rng) === "wf-good") good++;
    expect(good / 1000).toBeGreaterThan(0.9);
  });

  it("uses CLICKS as the success for the signup goal (flips the winner)", () => {
    const candidates = [
      mk("wf-replies", 1000, 300, 10, 100), // great replies, poor clicks
      mk("wf-clicks", 1000, 10, 300, 100), //  poor replies, great clicks
    ];
    const rng = mulberry32(13);
    let clicksWins = 0;
    for (let i = 0; i < 1000; i++) if (selectWorkflowByThompson(candidates, "signup", rng) === "wf-clicks") clicksWins++;
    expect(clicksWins / 1000).toBeGreaterThan(0.9);
  });

  it("aggregates a workflow's evidence across its (audience,workflow) rows", () => {
    // Same workflow appears twice (two audiences). Combined it has strong replies.
    const candidates = [
      mk("wf-split", 500, 100, 5, 100),
      mk("wf-split", 500, 100, 5, 100),
      mk("wf-weak", 1000, 20, 5, 100),
    ];
    const rng = mulberry32(17);
    let split = 0;
    for (let i = 0; i < 1000; i++) if (selectWorkflowByThompson(candidates, "meetingBooked", rng) === "wf-split") split++;
    expect(split / 1000).toBeGreaterThan(0.9);
  });
});
