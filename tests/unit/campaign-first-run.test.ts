import { describe, it, expect } from "vitest";
import { nextRunFrom, isOneOffFinished } from "../../src/lib/campaign-first-run.js";
import { billingCapsPath, type SalesFunnelMoneyVerdict } from "../../src/lib/sales-funnel-campaigns.js";
import type { Campaign } from "../../src/db/schema.js";

// DISTRY-CALL-IS-CAMPAIGN-1121: when a campaign's next run happens, read from what the dispatch reads.
const NOW = new Date("2026-11-21T12:00:00.000Z");
const unit = (over: Partial<Campaign> = {}) =>
  ({ workflowSlug: "engine:newsletter_drafted", planRole: null, runsOnTriggerId: null, nextRunAt: NOW, ...over }) as Campaign;
const ongoing = { status: "ongoing", stopReason: null };
const held = (kind: "unfunded" | "unreadable" | "cap_reached", figures?: SalesFunnelMoneyVerdict extends infer V ? V extends { figures?: infer F } ? F : never : never): SalesFunnelMoneyVerdict =>
  ({ run: false, kind, reason: kind, detail: `held ${kind}`, nextRunAt: NOW, ...(figures ? { figures } : {}) }) as SalesFunnelMoneyVerdict;

describe("nextRunFrom", () => {
  it("a due, funded unit: scheduled now, within a minute", () => {
    const r = nextRunFrom(ongoing, [unit()], { run: true, pace: { spentCents: 0, ceilingCents: 100 } }, NOW);
    expect(r).toMatchObject({ state: "scheduled", at: NOW.toISOString(), withinSeconds: 60, reason: null });
    expect(r.detail).toContain("within a minute");
  });

  it("a unit due later: scheduled at its time", () => {
    const later = new Date(NOW.getTime() + 600_000);
    expect(nextRunFrom(ongoing, [unit({ nextRunAt: later })], { run: true, pace: { spentCents: 0, ceilingCents: 1 } }, NOW))
      .toMatchObject({ state: "scheduled", at: later.toISOString() });
  });

  it("no max budget / max volume yet: waiting, unfunded, with billing's sentence", () => {
    expect(nextRunFrom(ongoing, [unit()], held("unfunded"), NOW)).toMatchObject({ state: "waiting", at: null, reason: "unfunded", detail: "held unfunded" });
  });

  it("a ONE-OFF cap reached = finished; a monthly one reached = waiting", () => {
    const oneOff = held("cap_reached", { cap: "max_volume", period: "one_off", volumeConsumed: 1, volumeCount: 1, volumeUnit: "unit" });
    expect(isOneOffFinished(oneOff)).toBe(true);
    expect(nextRunFrom(ongoing, [unit()], oneOff, NOW)).toMatchObject({ state: "finished", reason: "cap_reached" });
    const monthly = held("cap_reached", { cap: "max_budget", period: "monthly", spentCents: 100, ceilingCents: 100, refusedSpendCents: null });
    expect(nextRunFrom(ongoing, [unit()], monthly, NOW)).toMatchObject({ state: "waiting", reason: "cap_reached" });
  });

  it("stopped / trigger-only / nothing runs", () => {
    expect(nextRunFrom({ status: "stopped", stopReason: "manual" }, [unit()], null, NOW)).toMatchObject({ state: "stopped", reason: "manual" });
    expect(nextRunFrom(ongoing, [unit({ runsOnTriggerId: "lead_event" })], { run: true, pace: { spentCents: 0, ceilingCents: 1 } }, NOW))
      .toMatchObject({ state: "on_event", at: null });
    expect(nextRunFrom(ongoing, [unit({ workflowSlug: null })], null, NOW)).toMatchObject({ state: "nothing_runs" });
  });
});

describe("billingCapsPath", () => {
  it("keeps the offer segment byte for byte when the campaign names one, drops it when it names none", () => {
    expect(billingCapsPath({ brandId: "b", offerId: "o", salesFunnelId: "f@x", salesFunnelCampaignId: "c" }))
      .toBe("/internal/brands/b/offers/o/sales-funnels/f%40x/campaigns/c/caps");
    expect(billingCapsPath({ brandId: "b", offerId: null, salesFunnelId: "newsletter_drafted", salesFunnelCampaignId: "c" }))
      .toBe("/internal/brands/b/sales-funnels/newsletter_drafted/campaigns/c/caps");
    expect(billingCapsPath({ brandId: "b", offerId: "o", salesFunnelId: "f" })).toBe("/internal/brands/b/offers/o/sales-funnels/f/caps");
  });
});
