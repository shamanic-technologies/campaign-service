// Cost-aware Thompson sampling — the shared selection engine.
//
// Used twice per run by campaign-service: to pick the WORKFLOW (at the trigger,
// over features-service /candidates) and the AUDIENCE (at /start-run, over
// features-service /audience-stats). Both reduce to the same problem: a set of
// arms, each with a count of trials, a count of successes, and a cost per trial;
// pick the arm with the cheapest cost-per-success — but uncertainty-aware, so an
// arm with little evidence still gets explored instead of being permanently
// shadowed by a frozen rank #1.
//
// Mechanism: model each arm's success rate as Beta(successes+1, trials-successes+1)
// (uniform prior). Each call, sample one rate per arm from its posterior and
// pick argmin(costPerTrial / sampledRate) = the cheapest sampled cost-per-success.
// Low-evidence arms have wide posteriors → sometimes sample high → get tried;
// high-evidence arms collapse to their true rate → get exploited. No persistent
// state: the trial/success counts come from the producer's evidence, so this is a
// pure function of (arms, rng).

export type Rng = () => number;

export interface Arm {
  trials: number;
  successes: number;
  // Cost per trial in any consistent unit (USD cents, USD — only the ordering
  // matters). null when this arm has no cost signal yet (e.g. zero trials); the
  // engine substitutes the pooled median cost so it can still be explored.
  costPerTrial: number | null;
}

// Standard normal via Box–Muller.
function sampleNormal(rng: Rng): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Gamma(shape, 1) via Marsaglia–Tsang. Valid for shape >= 1, which always holds
// here because the Beta parameters are successes+1 and (trials-successes)+1, both >= 1.
function sampleGamma(shape: number, rng: Rng): number {
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    const x = sampleNormal(rng);
    const v = (1 + c * x) ** 3;
    if (v <= 0) continue;
    const u = rng();
    if (u < 1 - 0.0331 * x ** 4) return d * v;
    if (Math.log(u) < 0.5 * x ** 2 + d * (1 - v + Math.log(v))) return d * v;
  }
}

// Sample from Beta(alpha, beta) using two Gamma draws.
export function sampleBeta(alpha: number, beta: number, rng: Rng): number {
  const x = sampleGamma(alpha, rng);
  const y = sampleGamma(beta, rng);
  return x / (x + y);
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Cost-aware Thompson sampling. Returns the index of the chosen arm, or null when
 * the arm list is empty. With a single arm, returns 0 (no exploration to do).
 *
 * For each arm: rate ~ Beta(successes+1, trials-successes+1); sampledCost =
 * costPerTrial / rate; pick argmin(sampledCost). Cost for a no-signal arm
 * (costPerTrial null) is the pooled median of the arms that DO have a cost; if no
 * arm has a cost (all cold), cost is treated as a flat constant so selection
 * reduces to pure success-rate exploration.
 */
export function thompsonArgminCost(arms: Arm[], rng: Rng = Math.random): number | null {
  if (arms.length === 0) return null;
  if (arms.length === 1) return 0;

  const knownCosts = arms
    .map((a) => a.costPerTrial)
    .filter((c): c is number => c !== null && c > 0);
  const fallbackCost = median(knownCosts) ?? 1;

  let bestIdx = 0;
  let bestSampledCost = Infinity;

  for (let i = 0; i < arms.length; i++) {
    const n = Math.max(0, arms[i].trials);
    const k = Math.min(Math.max(0, arms[i].successes), n);
    const rate = sampleBeta(k + 1, n - k + 1, rng); // strictly in (0,1) — no /0
    const cost = arms[i].costPerTrial != null && arms[i].costPerTrial! > 0
      ? arms[i].costPerTrial!
      : fallbackCost;
    const sampledCost = cost / rate;
    if (sampledCost < bestSampledCost) {
      bestSampledCost = sampledCost;
      bestIdx = i;
    }
  }

  return bestIdx;
}
