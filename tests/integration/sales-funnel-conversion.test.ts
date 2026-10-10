import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

const { mockMode, mockCatalogue, mockBudgets, mockSelected, mockPaths, mockFunnel, mockSearch, mockPipe, mockPathSearch } = vi.hoisted(() => ({
  mockPathSearch: vi.fn(),
  mockMode: vi.fn(),
  mockPipe: vi.fn(),
  mockCatalogue: vi.fn(),
  mockBudgets: vi.fn(),
  mockSelected: vi.fn(),
  mockPaths: vi.fn(),
  mockFunnel: vi.fn(),
  mockSearch: vi.fn(),
}));

vi.mock("../../src/lib/channel-operator-client.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/lib/channel-operator-client.js")>();
  return { ...original, fetchChannelCatalogue: mockCatalogue };
});
vi.mock("../../src/lib/campaign-budget-client.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/lib/campaign-budget-client.js")>();
  return { ...original, fetchCampaignBudgets: mockBudgets };
});
vi.mock("../../src/lib/brand-sales-budget-client.js", () => ({ fetchBrandSalesBudget: mockMode }));
vi.mock("../../src/lib/reactive-defaults.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/lib/reactive-defaults.js")>();
  return { ...original, fetchOfferSelectedSalesPaths: mockSelected, fetchOfferCatalogueSalesPaths: mockPaths };
});
vi.mock("../../src/lib/sales-funnel-catalogue-client.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/lib/sales-funnel-catalogue-client.js")>();
  return { ...original, fetchSalesFunnel: mockFunnel, searchSalesFunnelIds: mockSearch, fetchPipe: mockPipe, searchSalesPaths: mockPathSearch };
});

import { db } from "../../src/db/index.js";
import { campaigns, campaignStatusTransitions, salesFunnelCampaigns } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import { cleanTestData, closeDb, insertTestCampaign } from "../helpers/test-db.js";
import { convertToSalesFunnelCampaigns } from "../../src/lib/sales-funnel-conversion.js";

const ORG = "b645207b-0000-4000-8000-0000000000c1";
const BRAND = "75d7e3e8-0000-4000-8000-0000000000c2";
const OFFER = "231bb036-0000-4000-8000-0000000000c3";
const USER = "7a3b1c22-0000-4000-8000-0000000000c4";
const RUN = "9f0d1c22-0000-4000-8000-0000000000c5";
const COLD = "sales-cold-email-outreach";
const ENTRY = "lead_found_to_conversation";
const AMB = "ai-meeting-booking";
const AIC = "ai-instant-call";
const MEET = ["conversation", "to", "meeting", "booked"].join("_");
const CALL = ["conversation", "to", "booking", "call"].join("_");
const SOURCE = "sourcing-apollo-cold-filters";
const SOURCE_LEG = "start_to_lead_found";
const PROACTIVE_FUNNEL = `${ENTRY}@${COLD}+conversation_to_paid_client`;
const MEET_FUNNEL = `${MEET}@${AMB}+meeting_booked_to_paid_client`;
// The cold email pipe THEN the meeting-booking pipe: mixes proactive and reactive, never chosen.
const MIXED_FUNNEL = `${ENTRY}@${COLD}+${MEET}@${AMB}+meeting_booked_to_paid_client`;

const row = (featureSlug: string, legKey: string, status = "ongoing") =>
  insertTestCampaign(ORG, {
    brandIds: [BRAND], brandId: BRAND, featureSlug, offerId: OFFER, legKey, status,
    workflowSlug: featureSlug === AIC || featureSlug === SOURCE ? undefined : `${featureSlug}-v1`,
    createdByUserId: USER, parentRunId: RUN,
  });

describe("converting the live (leg x channel) campaigns into sales funnel campaigns", () => {
  const billingCalls: Array<{ url: string; body: unknown; headers: Record<string, string> }> = [];

  beforeEach(async () => {
    vi.clearAllMocks();
    await cleanTestData();
    billingCalls.length = 0;
    process.env.BILLING_SERVICE_URL = "https://billing.test.local";
    process.env.BILLING_SERVICE_API_KEY = "k";
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: { body?: string; headers: Record<string, string> }) => {
      billingCalls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null, headers: init?.headers ?? {} });
      return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
    }));
    mockCatalogue.mockResolvedValue({
      ok: true,
      legs: [
        { legKey: SOURCE_LEG, fromStepKey: null, toStepKey: "lead_found" },
        { legKey: ENTRY, fromStepKey: "lead_found", toStepKey: "conversation" },
        { legKey: MEET, fromStepKey: "conversation", toStepKey: "meeting_booked" },
        { legKey: CALL, fromStepKey: "conversation", toStepKey: "booking_call" },
      ],
      legsBySlug: new Map([[COLD, new Set([ENTRY])], [AMB, new Set([MEET])], [AIC, new Set([CALL])]]),
      reactiveBySlug: new Map([[COLD, new Map([[ENTRY, false]])], [AMB, new Map([[MEET, true]])], [AIC, new Map([[CALL, true]])]]),
      operatorBySlug: new Map([["your-team-meeting-attendance", "customer"]]),
      stepKeys: new Set(),
    });
    mockBudgets.mockResolvedValue({
      ok: true,
      brandDailyBudgetCents: 1100,
      campaigns: [
        { offerId: OFFER, legKey: ENTRY, featureSlug: COLD, dailyBudgetCents: 500, sourcingCeilingCents: null },
        { offerId: OFFER, legKey: SOURCE_LEG, featureSlug: SOURCE, dailyBudgetCents: 500, sourcingCeilingCents: null },
        { offerId: OFFER, legKey: MEET, featureSlug: AMB, dailyBudgetCents: 100, sourcingCeilingCents: 0 },
      ],
    });
    mockMode.mockResolvedValue({ ok: true, mode: "campaigns" });
    mockSelected.mockResolvedValue({ ok: true, value: { stated: false, combinationKeys: null } });
    mockPaths.mockResolvedValue({ ok: true, value: [
      { combinationKey: PROACTIVE_FUNNEL, roi: 3, legs: [{ legKey: ENTRY, reactive: false, workedBy: "platform", channelSlug: COLD, channelManaged: true }] },
    ] });
    mockFunnel.mockImplementation(async (id: string) => {
      if (id === PROACTIVE_FUNNEL) return { ok: true, value: { id, name: "Zenith", pipeIds: [`${COLD}|${ENTRY}`], legs: [{ legKey: ENTRY, pipe: { id: `${COLD}|${ENTRY}`, mode: "proactive" } }, { legKey: "conversation_to_paid_client", pipe: null }] } };
      if (id === MIXED_FUNNEL) return { ok: true, value: { id, name: "Victory", pipeIds: [`${COLD}|${ENTRY}`, `${AMB}|${MEET}`], legs: [{ legKey: ENTRY, pipe: { id: `${COLD}|${ENTRY}`, mode: "proactive" } }, { legKey: MEET, pipe: { id: `${AMB}|${MEET}`, mode: "reactive" } }] } };
      // A reactive-only funnel whose next leg is the CUSTOMER's own team (a customer-operated pipe).
      if (id === MEET_FUNNEL) return { ok: true, value: { id, name: "Motivate", pipeIds: [`${AMB}|${MEET}`, "your-team-meeting-attendance|meeting_booked_to_meeting_attended"], legs: [{ legKey: MEET, pipe: { id: `${AMB}|${MEET}`, mode: "reactive" } }, { legKey: "meeting_booked_to_meeting_attended", pipe: { id: "your-team-meeting-attendance|meeting_booked_to_meeting_attended", mode: "reactive" } }, { legKey: "meeting_attended_to_paid_client", pipe: null }] } };
      return { ok: false, notFound: true, detail: "404" };
    });
    mockPipe.mockImplementation(async (id: string) => ({ ok: true, value: { id, name: "Bird", channelSlug: id.split("|")[0], legKey: id.split("|")[1], mode: "reactive" } }));
    mockPathSearch.mockResolvedValue({ ok: true, value: [{ id: `${MEET}+meeting_booked_to_paid_client`, type: "reactive" }, { id: `${ENTRY}+${MEET}`, type: "proactive" }] });
    mockSearch.mockImplementation(async (_q: string, channel: string) => ({ ok: true, value: channel === AMB ? [MEET_FUNNEL] : channel === COLD ? [MIXED_FUNNEL, PROACTIVE_FUNNEL] : [] }));
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await cleanTestData();
    await closeDb();
  });

  it("plans per offer (dry run): one proactive funnel (sources + pipe, caps summed), one per reactive pipe; writes nothing", async () => {
    const cold = await row(COLD, ENTRY);
    const src = await row(SOURCE, SOURCE_LEG);
    const amb = await row(AMB, MEET);
    const aic = await row(AIC, CALL);

    const report = await convertToSalesFunnelCampaigns({ apply: false });

    const proactive = report.groups.find((g) => g.kind === "proactive")!;
    expect(proactive).toMatchObject({ salesFunnelId: PROACTIVE_FUNNEL, maxBudgetDailyCents: 1000, basis: "best_roi_path", skipped: null });
    expect(proactive.campaignIds.sort()).toEqual([cold.id, src.id].sort());
    const meet = report.groups.find((g) => g.campaignIds[0] === amb.id)!;
    expect(meet).toMatchObject({ kind: "reactive", salesFunnelId: MEET_FUNNEL, maxBudgetDailyCents: 100, skipped: null });
    // No ceiling: kept exactly as it is, and listed.
    expect(report.groups.find((g) => g.campaignIds[0] === aic.id)).toMatchObject({ skipped: "reactive_without_ceiling_kept_as_is" });

    expect(billingCalls).toEqual([]);
    expect(await db.select().from(salesFunnelCampaigns)).toEqual([]);
  });

  it("applies: units linked with NO status move, and billing swaps the cap for the ceilings atomically; idempotent", async () => {
    const cold = await row(COLD, ENTRY);
    const src = await row(SOURCE, SOURCE_LEG);
    const amb = await row(AMB, MEET);
    const aic = await row(AIC, CALL);
    const before = await db.select().from(campaignStatusTransitions);

    const report = await convertToSalesFunnelCampaigns({ apply: true, actingEmail: "owner@test.local" });

    expect(billingCalls.every((c) => c.url.includes("/internal/brands/") && c.url.endsWith("/caps"))).toBe(true);
    const caps = billingCalls.map((c) => [decodeURIComponent(c.url.split("/sales-funnels/")[1]), c.body]);
    expect(caps).toEqual([
      [`${PROACTIVE_FUNNEL}/caps`, { maxBudget: { amountCents: "1000", period: "daily" }, maxVolume: null, replacesCeilings: expect.arrayContaining([{ featureSlug: COLD, legKey: ENTRY }, { featureSlug: SOURCE, legKey: SOURCE_LEG }]) }],
      [`${MEET_FUNNEL}/caps`, { maxBudget: { amountCents: "100", period: "daily" }, maxVolume: null, replacesCeilings: [{ featureSlug: AMB, legKey: MEET }] }],
    ]);
    expect(billingCalls[0].headers).toMatchObject({ "x-org-id": ORG, "x-user-id": USER, "x-email": "owner@test.local" });

    const funnels = await db.select().from(salesFunnelCampaigns);
    expect(funnels.map((f) => [f.salesFunnelId, f.status]).sort()).toEqual([[MEET_FUNNEL, "ongoing"], [PROACTIVE_FUNNEL, "ongoing"]].sort());
    const after = await db.select().from(campaigns);
    const byId = new Map(after.map((c) => [c.id, c]));
    for (const c of after) expect(c.status).toBe("ongoing");
    expect(byId.get(cold.id)!.salesFunnelCampaignId).toBe(byId.get(src.id)!.salesFunnelCampaignId);
    expect(byId.get(amb.id)!.salesFunnelId).toBe(MEET_FUNNEL);
    expect(byId.get(aic.id)!.salesFunnelCampaignId).toBeNull();
    expect(await db.select().from(campaignStatusTransitions)).toHaveLength(before.length);
    expect(report.counts).toMatchObject({ campaigns: 4, converted: 3, skipped: 1 });

    billingCalls.length = 0;
    const again = await convertToSalesFunnelCampaigns({ apply: true });
    expect(again.groups.filter((g) => !g.skipped)).toEqual([]);
    expect(billingCalls).toEqual([]);
  });

  it("writes NOTHING for a group billing refuses (409): the rows stay pre-funnel campaigns", async () => {
    const cold = await row(COLD, ENTRY);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 409, json: async () => ({}), text: async () => '{"reason":"subscriber"}' })));
    const report = await convertToSalesFunnelCampaigns({ apply: true });
    expect(report.groups[0].error).toContain("409");
    expect(await db.select().from(salesFunnelCampaigns)).toEqual([]);
    const [still] = await db.select().from(campaigns).where(eq(campaigns.id, cold.id));
    expect(still.salesFunnelCampaignId).toBeNull();
  });

  it("plans, never forces, what billing would refuse: a global sales budget, a positive offer-less ceiling", async () => {
    await row(COLD, ENTRY);
    mockMode.mockResolvedValue({ ok: true, mode: "global" });
    expect((await convertToSalesFunnelCampaigns({ apply: true })).groups[0].skipped).toBe("brand_in_global_sales_budget_mode");

    mockMode.mockResolvedValue({ ok: true, mode: "campaigns" });
    mockBudgets.mockResolvedValue({ ok: true, brandDailyBudgetCents: 800, campaigns: [
      { offerId: null, legKey: ENTRY, featureSlug: COLD, dailyBudgetCents: 800, sourcingCeilingCents: 350 },
    ] });
    expect((await convertToSalesFunnelCampaigns({ apply: true })).groups[0].skipped).toBe("positive_offer_less_ceiling_billing_cannot_replace");
    expect(billingCalls).toEqual([]);
  });

  it("links a group funded at zero without any billing write (it stays unfunded)", async () => {
    await row(COLD, ENTRY);
    mockBudgets.mockResolvedValue({ ok: true, brandDailyBudgetCents: 0, campaigns: [
      { offerId: null, legKey: ENTRY, featureSlug: COLD, dailyBudgetCents: 0, sourcingCeilingCents: null },
    ] });
    const zero = await convertToSalesFunnelCampaigns({ apply: true });
    expect(zero.groups[0]).toMatchObject({ maxBudgetDailyCents: 0, capWritten: false, skipped: null });
    expect(billingCalls).toEqual([]);
    expect(await db.select().from(salesFunnelCampaigns)).toHaveLength(1);
  });

  it("prefers the offer's TICKED sales path, and never a funnel naming another platform pipe", async () => {
    await row(COLD, ENTRY);
    const legsOf = (...keys: string[]) => keys.map((legKey, i) => ({ legKey, reactive: i > 0, workedBy: "platform", channelSlug: i === 0 ? COLD : null, channelManaged: true }));
    const BEST_PATH = `${ENTRY}+conversation_to_paid_client`;
    const TICKED_PATH = `${ENTRY}+conversation_to_signup+signup_to_paid_client`;
    const TICKED = `${ENTRY}@${COLD}+conversation_to_signup+signup_to_paid_client`;
    mockPaths.mockResolvedValue({ ok: true, value: [
      { combinationKey: PROACTIVE_FUNNEL, roi: 9, legs: legsOf(ENTRY, "conversation_to_paid_client") },
      { combinationKey: TICKED, roi: 1, legs: legsOf(ENTRY, "conversation_to_signup", "signup_to_paid_client") },
    ] });
    mockSelected.mockResolvedValue({ ok: true, value: { stated: true, combinationKeys: [TICKED] } });
    mockSearch.mockImplementation(async (_q: string, _ch: string, pathId?: string) => ({
      ok: true,
      value: pathId === TICKED_PATH ? [TICKED] : pathId === BEST_PATH ? [MIXED_FUNNEL, PROACTIVE_FUNNEL] : [],
    }));
    const base = mockFunnel.getMockImplementation()!;
    mockFunnel.mockImplementation(async (id: string) => id === TICKED
      ? { ok: true, value: { id, name: "Ticked", pipeIds: [`${COLD}|${ENTRY}`], legs: [{ legKey: ENTRY, pipe: { id: `${COLD}|${ENTRY}`, mode: "proactive" } }, { legKey: "conversation_to_signup", pipe: null }, { legKey: "signup_to_paid_client", pipe: null }] } }
      : base(id));
    const report = await convertToSalesFunnelCampaigns({ apply: false });
    expect(report.groups[0]).toMatchObject({ salesFunnelId: TICKED, basis: "selected_path" });

    // Nothing ticked: the best path's PURE funnel, skipping the mixed one listed first.
    mockSelected.mockResolvedValue({ ok: true, value: { stated: false, combinationKeys: null } });
    const best = await convertToSalesFunnelCampaigns({ apply: false });
    expect(best.groups[0]).toMatchObject({ salesFunnelId: PROACTIVE_FUNNEL, basis: "best_roi_path" });
  });

  it("leaves a reactive pipe as it is while the catalogue has no reactive-only funnel for it", async () => {
    const amb = await row(AMB, MEET);
    mockSearch.mockResolvedValue({ ok: true, value: [] });
    const report = await convertToSalesFunnelCampaigns({ apply: true });
    expect(report.groups).toEqual([expect.objectContaining({ campaignIds: [amb.id], skipped: "no_reactive_funnel_in_catalogue" })]);
    const [still] = await db.select().from(campaigns).where(eq(campaigns.id, amb.id));
    expect(still.salesFunnelCampaignId).toBeNull();
    expect(billingCalls).toEqual([]);
  });
});
