import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../../src/lib/sales-outreach-campaign.js", () => ({
  SALES_OUTREACH_FEATURE_SLUG: "sales-cold-email-outreach",
  SALES_CRM_FEATURE_SLUG: "sales-crm-email-outreach",
  isSalesFunnelFeature: (s?: string | null) =>
    s === "sales-cold-email-outreach" || s === "sales-crm-email-outreach" || s === "google-ads",
  // OUTBOUND only: this email asks for more PEOPLE to contact, which means nothing to a channel
  // that buys impressions.
  isOutboundSalesFeature: (s?: string | null) =>
    s === "sales-cold-email-outreach" || s === "sales-crm-email-outreach",
}));

// The guard that separates "ran out of people" from "never had anybody".
const hasExhaustedAudience = vi.fn(async () => true);
vi.mock("../../src/lib/audience-exhaustion.js", () => ({
  hasExhaustedAudience: (campaignId: string) => hasExhaustedAudience(campaignId),
}));

const fetchBrandRuntimeContext = vi.fn(async () => ({
  brand: { id: "brand-1", name: "Lux Projects Bali" },
  currentGoal: "meetingBooked",
  brandProfile: null,
}));
vi.mock("../../src/lib/brand-runtime-client.js", () => ({
  fetchBrandRuntimeContext: (brandId: string, identity: unknown) =>
    fetchBrandRuntimeContext(brandId as never, identity as never),
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { maybeSendExtendAudienceEmail } from "../../src/lib/transactional-email.js";
import type { Campaign } from "../../src/db/schema.js";

process.env.TRANSACTIONAL_EMAIL_SERVICE_URL = "https://te.test.local";
process.env.TRANSACTIONAL_EMAIL_SERVICE_API_KEY = "te-key";
process.env.BILLING_SERVICE_URL = "https://billing.test.local";
process.env.BILLING_SERVICE_API_KEY = "billing-key";

function makeCampaign(overrides: Partial<Campaign> = {}): Campaign {
  return {
    id: "campaign-1",
    orgId: "org-1",
    createdByUserId: "user-1",
    parentRunId: null,
    name: "Test",
    workflowSlug: "granite",
    brandIds: ["brand-1"],
    featureSlug: "sales-cold-email-outreach",
    featureInputs: null,
    activeGoalId: null,
    brandProfileId: null,
    audienceId: null,
    goal: null,
    audienceIds: null,
    servicesOffered: null,
    clickDestinationUrl: null,
    maxBudgetDailyUsd: null,
    maxBudgetWeeklyUsd: null,
    maxBudgetMonthlyUsd: null,
    maxBudgetTotalUsd: null,
    dailyBudgetCents: 500,
    maxLeads: null,
    startDate: null,
    endDate: null,
    status: "ongoing",
    nextRunAt: null,
    notifyFrequency: null,
    notifyChannel: null,
    notifyDestination: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Campaign;
}

// Route mock fetch by URL. Default: auto-topup ON, brand budget positive, send OK.
function routeFetch(opts: { autoTopup?: boolean; brandBudgetCents?: string | null; sendOk?: boolean } = {}) {
  const { autoTopup = true, brandBudgetCents = "1000", sendOk = true } = opts;
  mockFetch.mockImplementation((url: string) => {
    if (url.includes("/internal/accounts/by-org/")) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ has_auto_topup: autoTopup }) });
    }
    if (url.includes("/daily-budget")) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ dailyBudgetCents: brandBudgetCents }) });
    }
    if (url.endsWith("/send")) {
      return Promise.resolve({ ok: sendOk, status: sendOk ? 200 : 500, json: () => Promise.resolve({ results: [] }) });
    }
    return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
  });
}

function sendCall() {
  return mockFetch.mock.calls.find((c) => String(c[0]).endsWith("/send"));
}

describe("maybeSendExtendAudienceEmail", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    hasExhaustedAudience.mockClear();
    hasExhaustedAudience.mockResolvedValue(true);
    fetchBrandRuntimeContext.mockClear();
    fetchBrandRuntimeContext.mockResolvedValue({
      brand: { id: "brand-1", name: "Lux Projects Bali" },
      currentGoal: "meetingBooked",
      brandProfile: null,
    });
    routeFetch();
  });

  it("sends when exhausted + active + budgeted + auto-topup ON", async () => {
    await maybeSendExtendAudienceEmail(makeCampaign(), { runId: "run-1" });
    const call = sendCall();
    expect(call).toBeTruthy();
    const body = JSON.parse(String(call![1].body));
    expect(body.eventType).toBe("audience_fully_contacted");
    expect(body.brandIds).toEqual(["brand-1"]);
    expect(call![1].headers["x-user-id"]).toBe("user-1");
    expect(call![1].headers["x-org-id"]).toBe("org-1");
    expect(call![1].headers["x-run-id"]).toBe("run-1");
  });

  it("does NOT send when no audience was ever exhausted — nobody was ever contacted", async () => {
    // The zero-audience brand: it reaches the same auto-stop branch, having contacted nobody.
    hasExhaustedAudience.mockResolvedValue(false);
    await maybeSendExtendAudienceEmail(makeCampaign(), { runId: "r" });
    expect(sendCall()).toBeUndefined();
  });

  it("stays silent for a zero-audience brand however many times its campaign stops", async () => {
    hasExhaustedAudience.mockResolvedValue(false);
    for (let i = 0; i < 5; i++) {
      await maybeSendExtendAudienceEmail(makeCampaign(), { runId: `r-${i}` });
    }
    expect(sendCall()).toBeUndefined();
  });

  it("names the brand in a footer and links to that brand's audiences page", async () => {
    await maybeSendExtendAudienceEmail(makeCampaign(), { runId: "run-1" });
    const body = JSON.parse(String(sendCall()![1].body));
    expect(body.metadata.audiencesUrl).toBe(
      "https://dashboard.distribute.you/orgs/org-1/brands/brand-1/audiences",
    );
    expect(body.metadata.brandFooter).toBe("About your outreach for Lux Projects Bali.");
    expect(body.metadata.brandFooterHtml).toBe("About your outreach for Lux Projects Bali.");
  });

  it("escapes the brand name it interpolates into the HTML body", async () => {
    fetchBrandRuntimeContext.mockResolvedValue({
      brand: { id: "brand-1", name: '<script>x</script> & Co' },
      currentGoal: "meetingBooked",
      brandProfile: null,
    } as never);
    await maybeSendExtendAudienceEmail(makeCampaign(), { runId: "r" });
    const body = JSON.parse(String(sendCall()![1].body));
    expect(body.metadata.brandFooterHtml).toBe("About your outreach for &lt;script&gt;x&lt;/script&gt; &amp; Co.");
    expect(body.metadata.brandFooter).toBe("About your outreach for <script>x</script> & Co.");
  });

  it("still sends, with no footer and no invented name, when the brand identity cannot be read", async () => {
    fetchBrandRuntimeContext.mockRejectedValue(new Error("brand-service down"));
    await maybeSendExtendAudienceEmail(makeCampaign(), { runId: "r" });
    const body = JSON.parse(String(sendCall()![1].body));
    expect(body.metadata.brandFooter).toBe("");
    expect(body.metadata.brandFooterHtml).toBe("");
    // The one click still lands on the brand's own audiences page.
    expect(body.metadata.audiencesUrl).toBe(
      "https://dashboard.distribute.you/orgs/org-1/brands/brand-1/audiences",
    );
  });

  it("does NOT send for a non-sales feature", async () => {
    await maybeSendExtendAudienceEmail(makeCampaign({ featureSlug: "pr-expert-quote-outreach" }), { runId: "r" });
    expect(sendCall()).toBeUndefined();
  });

  it("does NOT send for a PAID-REACH campaign — it has no audience to extend", async () => {
    // Google Ads is in the funnel-funded family (its money is billing's, same as cold email) but
    // it works no list of names: asking its owner for more people to contact would be nonsense.
    await maybeSendExtendAudienceEmail(makeCampaign({ featureSlug: "google-ads" }), { runId: "r" });
    expect(sendCall()).toBeUndefined();
  });

  it("does NOT send when the campaign has no owning user", async () => {
    await maybeSendExtendAudienceEmail(makeCampaign({ createdByUserId: null }), { runId: "r" });
    expect(sendCall()).toBeUndefined();
  });

  it("does NOT send when the brand's budget is zero — a defunded brand is a held brand", async () => {
    // This replaces the old brand-pause guard: the flag is gone, and "funds nothing" is now the
    // one statement that a brand is not running.
    routeFetch({ brandBudgetCents: 0 });
    await maybeSendExtendAudienceEmail(makeCampaign({ dailyBudgetCents: null }), { runId: "r" });
    expect(sendCall()).toBeUndefined();
  });

  it("does NOT send when no daily budget is configured (campaign null + brand null)", async () => {
    routeFetch({ brandBudgetCents: null });
    await maybeSendExtendAudienceEmail(makeCampaign({ dailyBudgetCents: null }), { runId: "r" });
    expect(sendCall()).toBeUndefined();
  });

  it("sends on brand-budget fallback when the campaign has no own budget but the brand does", async () => {
    routeFetch({ brandBudgetCents: "800" });
    await maybeSendExtendAudienceEmail(makeCampaign({ dailyBudgetCents: null }), { runId: "r" });
    expect(sendCall()).toBeTruthy();
  });

  it("does NOT send when auto-topup is OFF", async () => {
    routeFetch({ autoTopup: false });
    await maybeSendExtendAudienceEmail(makeCampaign(), { runId: "r" });
    expect(sendCall()).toBeUndefined();
  });

  it("does NOT send (fail-safe) when the auto-topup read fails", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes("/internal/accounts/by-org/")) return Promise.reject(new Error("billing down"));
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ dailyBudgetCents: "1000" }) });
    });
    await maybeSendExtendAudienceEmail(makeCampaign(), { runId: "r" });
    expect(sendCall()).toBeUndefined();
  });

  it("never throws when the send itself fails (fire-and-forget)", async () => {
    routeFetch({ sendOk: false });
    await expect(maybeSendExtendAudienceEmail(makeCampaign(), { runId: "r" })).resolves.toBeUndefined();
  });

  it("does NOT send when the campaign has no brands", async () => {
    await maybeSendExtendAudienceEmail(makeCampaign({ brandIds: [] }), { runId: "r" });
    expect(sendCall()).toBeUndefined();
  });
});
