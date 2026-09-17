import { describe, it, expect } from "vitest";
import { RUN_LIVENESS_THRESHOLD_MS } from "../../src/lib/run-liveness.js";
import { STUCK_RUN_FRESHNESS_THRESHOLD_MS } from "../../src/lib/scheduler.js";

describe("run liveness", () => {
  it("is ONE threshold, shared by the scheduler's sweep and gate-check's stale cleanup", async () => {
    expect(STUCK_RUN_FRESHNESS_THRESHOLD_MS).toBe(RUN_LIVENESS_THRESHOLD_MS);
    // gate-check holds no threshold of its own any more. Three hours there against fifteen minutes
    // in the scheduler is a 2h45m window in which every re-fired run is refused with
    // "A run is already in progress" for a run nothing will ever close.
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../../src/lib/gate-check.ts", import.meta.url), "utf8"),
    );
    expect(src).toContain("const STALE_THRESHOLD_MS = RUN_LIVENESS_THRESHOLD_MS;");
    expect(src).not.toMatch(/STALE_THRESHOLD_MS\s*=\s*\d/);
  });
});
