import { describe, it, expect } from "vitest";
import { launchedNamedUnits } from "../../src/lib/sales-funnel-plan.js";

// MON-PLAN-FOLLOWING-1122: the backstop keeps only units on a LAUNCHED pipe the brief names (features-service's judgment).
const unit = (id: string, featureSlug: string, legKey: string, status: "ongoing" | "stopped" = "ongoing") => ({ id, featureSlug, legKey, status });

describe("launchedNamedUnits", () => {
  it("keeps a running unit on a launched named pipe, never a unit a previous plan added on another leg of the same channel", () => {
    const drain = [
      unit("u-followup-signup", "ai-follow-up-email", "signup_to_paid_client"),
      unit("u-cold", "sales-cold-email-outreach", "lead_found_to_website_visit"),
      unit("u-threads", "threads-post", "start_to_threads_post_published"),
    ];
    const named = ["ai-follow-up-email|lead_found_to_conversation", "threads-post|start_to_threads_post_published"];
    expect(launchedNamedUnits(drain, named, (id) => (id.startsWith("threads") ? "Threads posts" : undefined))).toEqual([
      { unitId: "u-threads", featureSlug: "threads-post", channelName: "Threads posts" },
    ]);
  });

  it("reads both spellings of an outbound leg as one, and skips a stopped unit", () => {
    const drain = [unit("u1", "sales-cold-email-outreach", "start_to_conversation"), unit("u2", "sales-cold-email-outreach", "lead_found_to_conversation", "stopped")];
    expect(launchedNamedUnits(drain, ["sales-cold-email-outreach|lead_found_to_conversation"]).map((k) => k.unitId)).toEqual(["u1"]);
  });

  it("nothing named = nothing kept", () => {
    expect(launchedNamedUnits([unit("u1", "threads-post", "start_to_threads_post_published")], [])).toEqual([]);
  });
});
