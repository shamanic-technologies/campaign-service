import { describe, it, expect } from "vitest";
import { settingChangeRowsOf } from "../../src/lib/sales-funnel-setting-changes.js";

// CAMPAIGN-CHANGE-LOG-1119: a funnel campaign's words are appended to their history on every write that changes them.
const campaign = { id: "sfc-1", orgId: "org-1" };

describe("settingChangeRowsOf", () => {
  it("one row per field the write CHANGES; a field stated unchanged, or not stated, is no row", () => {
    const before = { target: "meeting_booked", brief: "Old words", followsPlan: false };
    const rows = settingChangeRowsOf(campaign, before, { target: "meeting_booked", brief: "New words", followsPlan: true }, "user-1", "edit");
    expect(rows).toEqual([
      { salesFunnelCampaignId: "sfc-1", orgId: "org-1", field: "brief", beforeValue: "Old words", afterValue: "New words", changedByUserId: "user-1", source: "edit" },
      { salesFunnelCampaignId: "sfc-1", orgId: "org-1", field: "follows_plan", beforeValue: "no", afterValue: "yes", changedByUserId: "user-1", source: "edit" },
    ]);
    expect(settingChangeRowsOf(campaign, before, {}, "user-1", "edit")).toEqual([]);
  });

  it("a cleared brief is a row to null", () => {
    expect(settingChangeRowsOf(campaign, { brief: "Words" }, { brief: null }, null, "edit")).toMatchObject([{ field: "brief", beforeValue: "Words", afterValue: null }]);
  });

  it("a birth records every stated word from nothing, and nothing for a word it was born without", () => {
    const rows = settingChangeRowsOf(campaign, null, { target: "reply_positive", brief: null, followsPlan: null }, "user-1", "birth");
    expect(rows).toEqual([{ salesFunnelCampaignId: "sfc-1", orgId: "org-1", field: "target", beforeValue: null, afterValue: "reply_positive", changedByUserId: "user-1", source: "birth" }]);
  });
});
