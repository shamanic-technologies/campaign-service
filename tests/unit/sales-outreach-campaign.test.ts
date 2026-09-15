import { describe, expect, it, vi } from "vitest";
import {
  AI_MEETING_BOOKING_FEATURE_SLUG,
  GOOGLE_ADS_FEATURE_SLUG,
  PR_EXPERT_QUOTE_FEATURE_SLUG,
  isOutboundSalesFeature,
  isSalesFunnelFeature,
  MAX_BUDGET_FIELDS,
  salesMaxBudgetRefusal,
  SALES_CRM_FEATURE_SLUG,
  SALES_FEEDBACK_REQUEST_FEATURE_SLUG,
  SALES_OUTREACH_FEATURE_SLUG,
} from "../../src/lib/sales-outreach-campaign.js";
import type { Campaign } from "../../src/db/schema.js";

function campaign(overrides: Partial<Campaign> = {}): Campaign {
  const now = new Date("2026-06-18T00:00:00.000Z");
  return {
    id: "campaign-1",
    orgId: "org-1",
    createdByUserId: "user-1",
    parentRunId: null,
    name: "Sales",
    workflowSlug: "sales-email-cold-outreach",
    brandIds: ["brand-1"],
    featureSlug: SALES_OUTREACH_FEATURE_SLUG,
    featureInputs: null,
    activeGoalId: null,
    brandProfileId: null,
    audienceId: null,
    maxBudgetDailyUsd: null,
    maxBudgetWeeklyUsd: null,
    maxBudgetMonthlyUsd: null,
    maxBudgetTotalUsd: null,
    maxLeads: null,
    startDate: null,
    endDate: null,
    status: "ongoing",
    nextRunAt: null,
    notifyFrequency: null,
    notifyChannel: null,
    notifyDestination: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function mutation(returned: Campaign[]) {
  const returning = vi.fn().mockResolvedValue(returned);
  const where = vi.fn(() => ({ returning }));
  const set = vi.fn(() => ({ where }));
  const values = vi.fn(() => ({ returning }));
  return {
    update: vi.fn(() => ({ set })),
    insert: vi.fn(() => ({ values })),
    fns: { set, where, values, returning },
  };
}

describe("isSalesFunnelFeature", () => {
  it("includes every acquisition channel that sells a sales funnel — paid reach included", () => {
    // Membership is a MONEY statement, not a medium one: this campaign's ceiling is billing's,
    // per (funnel, channel, offer). Google Ads answers that identically to a cold email.
    expect(isSalesFunnelFeature(GOOGLE_ADS_FEATURE_SLUG)).toBe(true);
    expect(isSalesFunnelFeature("google-ads")).toBe(true);
  });

  it("includes ai-meeting-booking — its ceiling is billing's like every other funded pair", () => {
    // It answers a lead who already replied instead of reaching a new person, but the MONEY
    // question is identical: billing states its per-(funnel, channel, offer, leg) ceiling and the
    // campaign paces on it, so it is a member of this family and not a mechanism of its own.
    expect(isSalesFunnelFeature(AI_MEETING_BOOKING_FEATURE_SLUG)).toBe(true);
    expect(isSalesFunnelFeature("ai-meeting-booking")).toBe(true);
  });

  it("includes pr-expert-quote-outreach — earned media is funded like every other channel", () => {
    // features-service publishes it platform-operated with three VISIT-led funnels and
    // workflow-service holds eight active dynasties for it, so it can run; billing states its
    // per-(funnel, channel, offer, leg) ceiling, so it is paced here. That is the whole of
    // membership: a MONEY statement, not a medium one.
    expect(isSalesFunnelFeature(PR_EXPERT_QUOTE_FEATURE_SLUG)).toBe(true);
    expect(isSalesFunnelFeature("pr-expert-quote-outreach")).toBe(true);
  });

  it("does NOT include the SUPERSEDED pr-expert-quote-opportunities spelling", () => {
    // features-service carries `superseded_by_slug` onto the current slug. Only the current one
    // is funded, and two names for one channel is how a brand grows two identities for one offer.
    expect(isSalesFunnelFeature("pr-expert-quote-opportunities")).toBe(false);
  });

  it("does NOT sweep in the rest of the published paid-reach catalogue", () => {
    // Published by features-service, executable by nothing — a campaign for one would sit ongoing
    // and produce nothing forever.
    for (const slug of ["meta-ads", "linkedin-ads", "tiktok-ads", "bing-ads", "cold-call-outreach"]) {
      expect(isSalesFunnelFeature(slug)).toBe(false);
    }
  });

  it("includes both cold and CRM sales-outreach features (full parity)", () => {
    expect(isSalesFunnelFeature(SALES_OUTREACH_FEATURE_SLUG)).toBe(true);
    expect(isSalesFunnelFeature(SALES_CRM_FEATURE_SLUG)).toBe(true);
    expect(isSalesFunnelFeature("sales-cold-email-outreach")).toBe(true);
    expect(isSalesFunnelFeature("sales-crm-email-outreach")).toBe(true);
  });

  it("excludes non-sales features and empty/nullish slugs", () => {
    expect(isSalesFunnelFeature("pr-cold-email-outreach")).toBe(false);
    expect(isSalesFunnelFeature("hiring-cold-email-outreach")).toBe(false);
    expect(isSalesFunnelFeature("")).toBe(false);
    expect(isSalesFunnelFeature(null)).toBe(false);
    expect(isSalesFunnelFeature(undefined)).toBe(false);
  });
});

describe("isOutboundSalesFeature", () => {
  it("is the cold-email subset — the channels that share leads and sending accounts", () => {
    expect(isOutboundSalesFeature(SALES_OUTREACH_FEATURE_SLUG)).toBe(true);
    expect(isOutboundSalesFeature(SALES_CRM_FEATURE_SLUG)).toBe(true);
    expect(isOutboundSalesFeature(SALES_FEEDBACK_REQUEST_FEATURE_SLUG)).toBe(true);
  });

  it("EXCLUDES paid reach — an ad shares no lead population and no mailbox", () => {
    // Three behaviours key on this and must not reach a Google Ads campaign: the per-brand
    // serialization, the greedy workflow rotation, and the extend-audience lifecycle email.
    expect(isOutboundSalesFeature(GOOGLE_ADS_FEATURE_SLUG)).toBe(false);
    expect(isOutboundSalesFeature(null)).toBe(false);
  });

  it("EXCLUDES pr-expert-quote-outreach — earned media reaches nobody and sends nothing", () => {
    // The same three behaviours must not reach it: it holds no lead population and burns no
    // sending account (the work is answering a journalist's question), it produces no
    // send-tagged evidence for the greedy workflow rotation to price a DAG on, and the
    // extend-audience email would ask its customer for more PEOPLE to contact — nonsense for a
    // channel whose whole input is quote requests.
    expect(isOutboundSalesFeature(PR_EXPERT_QUOTE_FEATURE_SLUG)).toBe(false);
    expect(isOutboundSalesFeature("pr-expert-quote-opportunities")).toBe(false);
  });

  it("EXCLUDES ai-meeting-booking — it answers people who already replied", () => {
    // The same three behaviours must not reach it: it shares no lead population and no sending
    // account with cold email, it produces no send-tagged evidence for a workflow rotation to
    // price a DAG on, and asking its customer for more PEOPLE to contact is nonsense for a
    // channel whose whole input is people who already answered.
    expect(isOutboundSalesFeature(AI_MEETING_BOOKING_FEATURE_SLUG)).toBe(false);
  });
});

describe("salesMaxBudgetRefusal", () => {
  const SALES = "sales-cold-email-outreach";
  const NON_SALES = "pr-cold-email-outreach";

  it("refuses each per-campaign budget window on a sales-family campaign, naming where the ceiling belongs", () => {
    for (const slug of [
      SALES,
      "sales-crm-email-outreach",
      "feedback-request-cold-email-outreach",
      "google-ads",
      "ai-meeting-booking",
      "pr-expert-quote-outreach",
    ]) {
      for (const field of MAX_BUDGET_FIELDS) {
        const message = salesMaxBudgetRefusal(slug, { [field]: "10.00" });
        expect(message).toContain(field);
        expect(message).toContain("billing");
        expect(message).toMatch(/funnel/i);
      }
    }
  });

  it("names every stated field in one refusal", () => {
    const message = salesMaxBudgetRefusal(SALES, {
      maxBudgetDailyUsd: "10.00",
      maxBudgetTotalUsd: "500.00",
    });
    expect(message).toContain("maxBudgetDailyUsd");
    expect(message).toContain("maxBudgetTotalUsd");
  });

  it("allows a NON-sales campaign to state one — the column is live for it and gate-check enforces it", () => {
    for (const field of MAX_BUDGET_FIELDS) {
      expect(salesMaxBudgetRefusal(NON_SALES, { [field]: "10.00" })).toBeNull();
      expect(salesMaxBudgetRefusal("hiring-cold-email-outreach", { [field]: "10.00" })).toBeNull();
      expect(salesMaxBudgetRefusal(null, { [field]: "10.00" })).toBeNull();
    }
  });

  it("has nothing to refuse when a sales campaign states no budget window", () => {
    expect(salesMaxBudgetRefusal(SALES, {})).toBeNull();
    expect(salesMaxBudgetRefusal(SALES, { dailyBudgetCents: 5000, name: "x" })).toBeNull();
  });
});
