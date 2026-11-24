import { describe, it, expect } from "vitest";
import { capsBody, statesCaps, volumeWithoutBudget } from "../../src/lib/sales-funnel-campaign-caps.js";

describe("capsBody (ONE-CAMPAIGN-VOLUME-1122)", () => {
  const own = { maxBudget: { amountCents: 26000, period: "weekly" as const }, maxVolume: { count: 10, period: "weekly" as const } };
  it("a stated half replaces, an unstated half keeps the campaign's own cap", () => {
    expect(capsBody({ maxVolume: { count: 15, period: "weekly" } }, own)).toEqual({ maxBudget: own.maxBudget, maxVolume: { count: 15, period: "weekly" } });
  });
  it("null clears a half", () => {
    expect(capsBody({ maxBudget: null }, own)).toEqual({ maxBudget: null, maxVolume: own.maxVolume });
  });
  it("no own cap = an unstated half is empty", () => {
    expect(capsBody({ maxBudget: { amountCents: 100, period: "daily" } }, null)).toEqual({ maxBudget: { amountCents: 100, period: "daily" }, maxVolume: null });
  });
  it("statesCaps", () => {
    expect(statesCaps({})).toBe(false);
    expect(statesCaps({ maxBudget: undefined, maxVolume: undefined })).toBe(false);
    expect(statesCaps({ maxVolume: null })).toBe(true);
  });
  it("volumeWithoutBudget (VOL-NEEDS-USD-1124)", () => {
    expect(volumeWithoutBudget({ maxVolume: { count: 1, period: "daily" } })).toBe(true);
    expect(volumeWithoutBudget({ maxVolume: { count: 1, period: "daily" }, maxBudget: null })).toBe(true);
    expect(volumeWithoutBudget({ maxVolume: { count: 1, period: "daily" }, maxBudget: { amountCents: 100, period: "daily" } })).toBe(false);
    expect(volumeWithoutBudget({ maxBudget: { amountCents: 100, period: "daily" } })).toBe(false);
    expect(volumeWithoutBudget({ maxVolume: null })).toBe(false);
  });
});
