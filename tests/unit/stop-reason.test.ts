import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { STOP_REASONS } from "../../src/lib/stop-reason.js";

const srcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../src");

function everySrcFile(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return everySrcFile(full);
    return e.name.endsWith(".ts") ? [full] : [];
  });
}

describe("stop reasons", () => {
  it("names ONLY the reasons a person decided — a system condition never stops a campaign", () => {
    expect(STOP_REASONS).toEqual({
      MANUAL: "manual",
      ORG_TEARDOWN: "org_teardown",
    });
  });

  it("has no vocabulary for a system condition, and no code that writes one", () => {
    // A campaign's STATUS is the customer's statement of intent. Out of credit, audience
    // exhausted, budget spent, lead cap reached: each of those blocks the RUN and re-checks
    // later. Re-introducing either retired value would mean a condition is being encoded as a
    // status again — and it would need a resume sweep back to undo it.
    const offenders: string[] = [];
    for (const file of everySrcFile(srcDir)) {
      const content = fs.readFileSync(file, "utf-8");
      content.split("\n").forEach((line, i) => {
        if (/["']audience_exhausted["']|["']max_leads_reached["']/.test(line)) {
          offenders.push(`${path.relative(srcDir, file)}:${i + 1}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it("never resumes anything, because nothing systemic ever stopped a campaign", () => {
    const offenders: string[] = [];
    for (const file of everySrcFile(srcDir)) {
      const content = fs.readFileSync(file, "utf-8");
      content.split("\n").forEach((line, i) => {
        if (/isResumableStopReason|resumeServeableCampaigns|provisionFundedPairsForQuietBrands/.test(line)) {
          offenders.push(`${path.relative(srcDir, file)}:${i + 1}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
