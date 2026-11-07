import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COARSE_POST_PUBLISHED_PATTERN, FINE_POST_PUBLISHED_REPLACEMENT_SQL, fineOutcomeSpelling } from "../../src/lib/fine-outcome-spelling.js";
import { fineSpelledPlanLine } from "../../src/lib/sales-funnel-plan.js";
import { legIdentity, sameLeg, storedLegKey } from "../../src/lib/leg-identity.js";

/** DELETE-POST-PUBLISHED-1107: the coarse `post_published` token becomes `threads_post_published`; fine keys untouched. */
describe("fine outcome spelling", () => {
  it("rewrites every coarse token of a leg key, pipe id and funnel id", () => {
    expect(fineOutcomeSpelling("start_to_post_published")).toBe("start_to_threads_post_published");
    expect(fineOutcomeSpelling("post_published_to_website_visit")).toBe("threads_post_published_to_website_visit");
    expect(fineOutcomeSpelling("post_published_to_paid_client")).toBe("threads_post_published_to_paid_client");
    expect(fineOutcomeSpelling("organic-market|post_published_to_website_visit")).toBe("organic-market|threads_post_published_to_website_visit");
    expect(fineOutcomeSpelling("start_to_post_published@threads-post+post_published_to_paid_client")).toBe(
      "start_to_threads_post_published@threads-post+threads_post_published_to_paid_client",
    );
    expect(fineOutcomeSpelling("start_to_post_published@threads-post+post_published_to_website_visit+website_visit_to_signup+signup_to_paid_client")).toBe(
      "start_to_threads_post_published@threads-post+threads_post_published_to_website_visit+website_visit_to_signup+signup_to_paid_client",
    );
    expect(fineOutcomeSpelling("post_published")).toBe("threads_post_published");
  });

  it("leaves fine keys, other keys and prose words untouched", () => {
    for (const k of [
      "start_to_threads_post_published",
      "threads_post_published_to_website_visit",
      "start_to_x_post_published",
      "linkedin_post_published_to_website_visit",
      "x_post_published",
      "start_to_conversation",
      "lead_found_to_website_visit",
      "Threads Post Post Published",
      "repost_published",
      "post_published_count",
    ]) {
      expect(fineOutcomeSpelling(k)).toBe(k);
    }
    expect(fineOutcomeSpelling(null)).toBeNull();
    expect(fineOutcomeSpelling(undefined)).toBeUndefined();
  });

  it("is idempotent", () => {
    const once = fineOutcomeSpelling("start_to_post_published@threads-post+post_published_to_paid_client");
    expect(fineOutcomeSpelling(once)).toBe(once);
  });

  it("is the exact pattern migration 0088 re-keyed the stored rows with", () => {
    const sql = readFileSync(join(process.cwd(), "drizzle", "0088_fine_threads_post_published_keys.sql"), "utf8");
    const rewrites = sql.split("regexp_replace(").length - 1;
    expect(rewrites).toBeGreaterThan(0);
    expect(sql.split(`'${COARSE_POST_PUBLISHED_PATTERN}', '${FINE_POST_PUBLISHED_REPLACEMENT_SQL}', 'g')`).length - 1).toBe(rewrites);
  });

  it("makes a leg spelled with the coarse key the same leg, written in the fine spelling", () => {
    expect(sameLeg("threads-post", "start_to_post_published", "start_to_threads_post_published")).toBe(true);
    expect(legIdentity("organic-market", "post_published_to_website_visit")).toBe("threads_post_published_to_website_visit");
    expect(storedLegKey("your-team-closing-calls", "post_published_to_paid_client")).toBe("threads_post_published_to_paid_client");
    // the outbound rename still applies
    expect(storedLegKey("sales-cold-email-outreach", "start_to_conversation")).toBe("lead_found_to_conversation");
  });

  it("reads a plan still naming the coarse legs in the fine spelling, so it never moves the campaign back", () => {
    const line = fineSpelledPlanLine({
      funnelId: "start_to_post_published@threads-post+post_published_to_paid_client",
      legs: [
        { legKey: "start_to_post_published", pipeId: "threads-post|start_to_post_published", channelSlug: "threads-post", playId: "threads-post|start_to_post_published" },
        { legKey: "post_published_to_paid_client", pipeId: null, channelSlug: null, playId: null },
      ],
    });
    expect(line?.funnelId).toBe("start_to_threads_post_published@threads-post+threads_post_published_to_paid_client");
    expect(line?.legs[0]).toEqual({ legKey: "start_to_threads_post_published", pipeId: "threads-post|start_to_threads_post_published", channelSlug: "threads-post", playId: "threads-post|start_to_threads_post_published" });
    expect(line?.legs[1]).toEqual({ legKey: "threads_post_published_to_paid_client", pipeId: null, channelSlug: null, playId: null });
    expect(fineSpelledPlanLine(null)).toBeNull();
  });
});
