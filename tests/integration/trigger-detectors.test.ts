import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

const { mockExecute, mockCatalogue, mockFunding, mockListRuns, mockResolveSlug, mockSalesBudget, mockGetStatsBudget, mockLeadActivity } = vi.hoisted(() => ({
  mockSalesBudget: vi.fn(),
  mockGetStatsBudget: vi.fn(),
  mockExecute: vi.fn(),
  mockCatalogue: vi.fn(),
  mockFunding: vi.fn(),
  mockListRuns: vi.fn(),
  mockResolveSlug: vi.fn(),
  mockLeadActivity: vi.fn(),
}));

vi.mock("@distribute/runs-client", () => ({
  createRun: vi.fn(),
  updateRun: vi.fn(),
  listRuns: mockListRuns,
  getStatsBudget: (p: { featureSlug?: string }) => (p?.featureSlug?.startsWith("sourcing-") ? Promise.resolve({ windows: [] }) : mockGetStatsBudget(p)),
}));
vi.mock("../../src/lib/brand-sales-budget-client.js", () => ({ fetchBrandSalesBudget: mockSalesBudget }));
vi.mock("../../src/lib/workflows.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/lib/workflows.js")>();
  return { ...original, executeCampaignWorkflow: mockExecute };
});
vi.mock("../../src/lib/channel-operator-client.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/lib/channel-operator-client.js")>();
  return { ...original, fetchChannelCatalogue: mockCatalogue };
});
vi.mock("../../src/lib/campaign-funding.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/lib/campaign-funding.js")>();
  return { ...original, campaignFunding: mockFunding };
});
vi.mock("../../src/lib/features-workflow-projection-client.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/lib/features-workflow-projection-client.js")>();
  return { ...original, resolveSelectionForTrigger: mockResolveSlug };
});
vi.mock("../../src/lib/lead-activity-client.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/lib/lead-activity-client.js")>();
  return { ...original, fetchOfferLeadActivity: mockLeadActivity };
});

import { and, eq } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { campaigns, salesFunnelCampaigns, triggerEvents, triggerPollCursors } from "../../src/db/schema.js";
import { resetSalesFunnelCapsCache } from "../../src/lib/sales-funnel-campaigns.js";
import { cleanTestData, closeDb, insertTestCampaign } from "../helpers/test-db.js";
import { fireDueTriggerEvents } from "../../src/lib/trigger-events.js";
import { runTriggerDetectorsTick } from "../../src/lib/trigger-detectors.js";
import { pollDueTriggers } from "../../src/lib/poll-trigger-detector.js";
import { foldLeadActivity } from "../../src/lib/lead-activity-client.js";
import type { TregAnswer } from "../../src/lib/treg-meter.js";

const ORG = "b645207b-0000-4000-8000-000000000021";
const BRAND = "75d7e3e8-0000-4000-8000-000000000022";
const OFFER = "231bb036-0000-4000-8000-000000000023";
const USER = "7a3b1c22-0000-4000-8000-000000000024";
const DELAY = "no_reply_after_3_days";
const POLL = "someone_reacted_to_my_posts";
const FOLLOW_UP_SLUG = "whatsapp-follow-up";
const FOLLOW_UP_LEG = "lead_found" + "_to_" + "conversation";
const REACT_SLUG = "linkedin-reaction-outreach";
const REACT_LEG = "start" + "_to_" + "conversation";
const DAY = 24 * 60 * 60_000;

const source = JSON.stringify({ endpoint: "fetchinio.linkedin.post.engagement", method: "GET", query: { url: "https://linkedin.com/company/acme" }, items: "data.items", itemId: "urn", maxMicro: 3000 });

function catalogue() {
  return {
    ok: true,
    operatorBySlug: new Map(),
    legsBySlug: new Map(),
    stepKeys: new Set(["lead_found", "conversation"]),
    legs: [],
    triggers: new Map([
      ["lead_requested", { id: "lead_requested", label: "Lead requested", fromStepKey: null, firedBy: "lead-service", coded: true, kind: "event", origin: "code", params: null }],
      [DELAY, { id: DELAY, label: "No reply after 3 days", fromStepKey: "lead_found", firedBy: "campaign-service", coded: true, kind: "delay", origin: "declared", params: { afterStep: "lead_found", days: 3 } }],
      [POLL, { id: POLL, label: "Someone reacted", fromStepKey: null, firedBy: "campaign-service", coded: true, kind: "poll", origin: "declared", params: { source, everyMinutes: 5 } }],
    ]),
    triggerTransitions: [
      { featureSlug: FOLLOW_UP_SLUG, legKey: FOLLOW_UP_LEG, triggerId: DELAY },
      { featureSlug: REACT_SLUG, legKey: REACT_LEG, triggerId: POLL },
    ],
  };
}

const campaignOn = (featureSlug: string, legKey: string) =>
  insertTestCampaign(ORG, {
    brandIds: [BRAND],
    brandId: BRAND,
    status: "ongoing",
    featureSlug,
    workflowSlug: `${featureSlug}-v1`,
    createdByUserId: USER,
    parentRunId: "9f0d1c22-0000-4000-8000-000000000029",
    offerId: OFFER,
    legKey,
  });

/** lead-service found the person: what lead-service records at campaign-service today. */
const leadFound = (leadId: string, at: Date) =>
  db.insert(triggerEvents).values({
    orgId: ORG, brandId: BRAND, offerId: OFFER, triggerId: "lead_requested", leadId,
    idempotencyKey: `lead_requested:${leadId}`, recordedVia: "trigger_events", occurredAt: at, dueAt: at,
    status: "done", outcome: "ran", ranCampaignIds: ["source-campaign"], performedByCaller: true, processedAt: at,
  });

const delayEvents = () => db.select().from(triggerEvents).where(eq(triggerEvents.triggerId, DELAY));
const pollEvents = () => db.select().from(triggerEvents).where(eq(triggerEvents.triggerId, POLL));
const quietRow = { leadId: "x", replied: false, clicked: false, bounced: false, unsubscribed: false, crmPositiveReplyAt: null };

describe("generic trigger detectors", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await cleanTestData();
    mockCatalogue.mockResolvedValue(catalogue());
    mockFunding.mockResolvedValue({ funded: true, ceilingCents: 5000 });
    mockListRuns.mockResolvedValue({ runs: [] });
    mockResolveSlug.mockImplementation(async (p: { fallbackSlug: string }) => ({ workflowSlug: p.fallbackSlug, audienceId: null }));
    mockExecute.mockResolvedValue(undefined);
    mockSalesBudget.mockResolvedValue({ ok: true, mode: "campaigns" });
    mockGetStatsBudget.mockResolvedValue({ windows: [{ label: "today", totalCostInUsdCents: "0", netTotalCostInUsdCents: "0" }] });
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  describe("delay: N days after a step, if nothing happened", () => {
    it("fires at its due time for the lead nothing happened to, and skips the lead who replied meanwhile", async () => {
      const campaign = await campaignOn(FOLLOW_UP_SLUG, FOLLOW_UP_LEG);
      const t0 = new Date(Date.now() - 60 * 60_000);
      await leadFound("lead-quiet", t0);
      await leadFound("lead-replied", t0);
      mockLeadActivity.mockResolvedValue(foldLeadActivity([
        { ...quietRow, leadId: "lead-quiet" },
        { ...quietRow, leadId: "lead-replied", replied: true },
      ]));

      const tick = await runTriggerDetectorsTick(new Date());
      expect(tick?.delay).toEqual({ triggers: 1, scopes: 1, planned: 2 });
      const planned = await delayEvents();
      expect(planned.map((e) => e.status)).toEqual(["pending", "pending"]);
      const dueAt = new Date(t0.getTime() + 3 * DAY);
      for (const e of planned) expect(e.dueAt.toISOString()).toBe(dueAt.toISOString());
      expect(mockExecute).not.toHaveBeenCalled();

      // Before the due time nothing fires.
      expect(await fireDueTriggerEvents(new Date(dueAt.getTime() - 60_000))).toBe(0);
      expect(mockExecute).not.toHaveBeenCalled();

      // At the due time: the quiet lead's leg runs, the lead who replied is skipped with the reason.
      expect(await fireDueTriggerEvents(new Date(dueAt.getTime() + 60_000))).toBe(2);
      const byLead = new Map((await delayEvents()).map((e) => [e.leadId, e]));
      expect(byLead.get("lead-quiet")).toMatchObject({ status: "done", outcome: "ran", ranCampaignIds: [campaign.id] });
      expect(byLead.get("lead-replied")).toMatchObject({ status: "done", outcome: "skipped", skipReason: "lead_replied", ranCampaignIds: [] });
      expect(mockExecute).toHaveBeenCalledTimes(1);
      expect(mockExecute.mock.calls[0][1]).toMatchObject({
        campaignId: campaign.id,
        trigger: { eventId: byLead.get("lead-quiet")!.id, triggerId: DELAY, leadId: "lead-quiet", item: null },
      });
      // The anchor stays on the row beside the outcome.
      expect(byLead.get("lead-quiet")!.detail).toMatchObject({ afterStep: "lead_found", days: 3, anchorAt: t0.toISOString() });

      // Exactly once per lead x trigger: another tick plans nothing.
      const again = await runTriggerDetectorsTick(new Date());
      expect(again?.delay.planned).toBe(0);
      expect(await delayEvents()).toHaveLength(2);
    });

    it("a later event on the lead (another step reached) is something that happened: skipped `lead_progressed`", async () => {
      await campaignOn(FOLLOW_UP_SLUG, FOLLOW_UP_LEG);
      const t0 = new Date(Date.now() - 60 * 60_000);
      await leadFound("lead-a", t0);
      mockLeadActivity.mockResolvedValue(foldLeadActivity([{ ...quietRow, leadId: "lead-a" }]));
      await runTriggerDetectorsTick(new Date());
      const later = new Date(t0.getTime() + DAY);
      await db.insert(triggerEvents).values({
        orgId: ORG, brandId: BRAND, offerId: OFFER, triggerId: "positive_reply_received", step: "conversation", leadId: "lead-a",
        recordedVia: "trigger_for_step", occurredAt: later, dueAt: later, status: "done", outcome: "skipped", skipReason: "no_campaign",
      });

      await fireDueTriggerEvents(new Date(t0.getTime() + 3 * DAY + 60_000));
      const [event] = await delayEvents();
      expect(event).toMatchObject({ outcome: "skipped", skipReason: "lead_progressed" });
      expect(mockExecute).not.toHaveBeenCalled();
    });

    it("lead-service unreadable: nothing fired, the event waits for the retry", async () => {
      await campaignOn(FOLLOW_UP_SLUG, FOLLOW_UP_LEG);
      const t0 = new Date(Date.now() - 60 * 60_000);
      await leadFound("lead-b", t0);
      mockLeadActivity.mockRejectedValue(new Error("lead-service GET /orgs/leads?view=compact failed: 502"));
      await runTriggerDetectorsTick(new Date());

      await fireDueTriggerEvents(new Date(t0.getTime() + 3 * DAY + 60_000));
      const [event] = await delayEvents();
      expect(event).toMatchObject({ status: "pending", outcome: null });
      expect(event.lastError).toContain("502");
      expect(mockExecute).not.toHaveBeenCalled();
    });

    it("no live campaign on a leg naming the trigger: nothing planned (no row per lead fleet-wide)", async () => {
      await leadFound("lead-c", new Date(Date.now() - 60 * 60_000));
      const tick = await runTriggerDetectorsTick(new Date());
      expect(tick?.delay).toEqual({ triggers: 1, scopes: 0, planned: 0 });
      expect(await delayEvents()).toHaveLength(0);
    });
  });

  describe("poll: a new item appeared at the source", () => {
    const answer = (ids: string[]): TregAnswer => ({ status: 200, body: { data: { items: ids.map((urn) => ({ urn, name: `person ${urn}` })) } }, chargedMicro: 1200, runId: "run-x" });

    it("fires once per NEW item across ticks, never twice; the first read is the baseline", async () => {
      const campaign = await campaignOn(REACT_SLUG, REACT_LEG);
      const treg = vi.fn();
      const t0 = new Date();
      const cat = catalogue() as never;

      // Tick 1: the baseline. Items already there are recorded, never fired.
      treg.mockResolvedValueOnce(answer(["a", "b"]));
      expect(await pollDueTriggers(cat, t0, treg)).toMatchObject({ triggers: 1, scopes: 1, baseline: 1, fired: 0 });
      expect(mockExecute).not.toHaveBeenCalled();
      expect((await pollEvents()).map((e) => e.skipReason).sort()).toEqual(["poll_baseline", "poll_baseline"]);

      // Before everyMinutes elapsed: not due, the source is not read (nor paid).
      expect(await pollDueTriggers(cat, new Date(t0.getTime() + 2 * 60_000), treg)).toMatchObject({ polled: 0, fired: 0 });
      expect(treg).toHaveBeenCalledTimes(1);

      // Tick 2: one new item, fired once.
      treg.mockResolvedValueOnce(answer(["a", "b", "c"]));
      expect(await pollDueTriggers(cat, new Date(t0.getTime() + 5 * 60_000), treg)).toMatchObject({ polled: 1, fired: 1 });
      expect(mockExecute).toHaveBeenCalledTimes(1);
      const [fired] = (await pollEvents()).filter((e) => e.outcome === "ran");
      expect(fired).toMatchObject({ ranCampaignIds: [campaign.id], recordedVia: "poll_detector" });
      expect(mockExecute.mock.calls[0][1].trigger).toEqual({ eventId: fired.id, triggerId: POLL, leadId: null, item: { urn: "c", name: "person c" } });

      // Tick 3: the same items again plus one: only the new one fires; c never fires twice.
      treg.mockResolvedValueOnce(answer(["a", "b", "c", "d"]));
      expect(await pollDueTriggers(cat, new Date(t0.getTime() + 10 * 60_000), treg)).toMatchObject({ polled: 1, fired: 1 });
      expect(mockExecute).toHaveBeenCalledTimes(2);
      expect(mockExecute.mock.calls[1][1].trigger.item).toEqual({ urn: "d", name: "person d" });
      const ran = (await pollEvents()).filter((e) => e.outcome === "ran");
      expect(ran).toHaveLength(2);

      // The read was metered on the campaign that pays (org-billed).
      expect(treg.mock.calls[0][0]).toMatchObject({ orgId: ORG, userId: USER, brandId: BRAND, campaignId: campaign.id, featureSlug: REACT_SLUG });
      expect(treg.mock.calls[0][1]).toMatchObject({ endpoint: "fetchinio.linkedin.post.engagement", method: "GET", maxMicro: 3000 });
    });

    it("the campaign's budget cap holds the read: no call, nothing fired", async () => {
      await campaignOn(REACT_SLUG, REACT_LEG);
      mockGetStatsBudget.mockResolvedValue({ windows: [{ label: "today", totalCostInUsdCents: "5000", netTotalCostInUsdCents: "5000" }] });
      const treg = vi.fn();
      expect(await pollDueTriggers(catalogue() as never, new Date(), treg)).toMatchObject({ held: 1, polled: 0, fired: 0 });
      expect(treg).not.toHaveBeenCalled();
      const [cursor] = await db.select().from(triggerPollCursors).where(and(eq(triggerPollCursors.triggerId, POLL), eq(triggerPollCursors.orgId, ORG)));
      expect(cursor).toMatchObject({ lastOutcome: "budget_held", baselineAt: null });
    });

    it("an unfunded campaign holds the read too", async () => {
      await campaignOn(REACT_SLUG, REACT_LEG);
      mockFunding.mockResolvedValue({ funded: false, reason: "campaign is not funded" });
      const treg = vi.fn();
      expect(await pollDueTriggers(catalogue() as never, new Date(), treg)).toMatchObject({ held: 1 });
      expect(treg).not.toHaveBeenCalled();
    });

    describe("a brand whose only live campaigns are SALES FUNNEL units still has a payer", () => {
      const SALES_FUNNEL_ID = `${REACT_LEG}@${REACT_SLUG}+conversation_to_paid_client`;
      const capsFetch = (caps: Record<string, unknown>) =>
        vi.fn(async (url: string) => {
          if (!String(url).includes("/sales-funnels/")) throw new Error(`unexpected fetch ${url}`);
          return { ok: true, status: 200, json: async () => ({ pipes: null, maxVolume: null, ...caps }) };
        });
      const budget = (consumedCents: string) => ({
        amountCents: "1000", period: "weekly", periodStart: "2026-10-05T00:00:00Z", periodEnd: null,
        consumedCents, remainingCents: null, reached: Number(consumedCents) >= 1000,
        consumedUnavailableReason: null, consumedUnavailableDetail: null,
      });

      async function funnelUnitOn(featureSlug: string, legKey: string) {
        const [parent] = await db.insert(salesFunnelCampaigns).values({
          orgId: ORG, brandId: BRAND, offerId: OFFER, salesFunnelId: SALES_FUNNEL_ID, salesFunnelName: "Epiphany", status: "ongoing",
        }).returning();
        const unit = await campaignOn(featureSlug, legKey);
        await db.update(campaigns).set({ salesFunnelId: SALES_FUNNEL_ID, salesFunnelCampaignId: parent.id }).where(eq(campaigns.id, unit.id));
        return unit;
      }

      beforeEach(async () => {
        process.env.BILLING_SERVICE_URL = "https://billing.test.local";
        process.env.BILLING_SERVICE_API_KEY = "k";
        resetSalesFunnelCapsCache();
        // The pre-funnel money says NO: a unit must never be paid by it, nor held by it.
        mockFunding.mockResolvedValue({ funded: false, reason: "pre-funnel money is not a unit's" });
      });

      it("pays the read on the unit (its own org, its own run) and fires the new item on it", async () => {
        const unit = await funnelUnitOn(REACT_SLUG, REACT_LEG);
        vi.stubGlobal("fetch", capsFetch({ stated: true, maxBudget: budget("100") }));
        try {
          const treg = vi.fn().mockResolvedValueOnce(answer(["a"])).mockResolvedValueOnce(answer(["a", "b"]));
          const t0 = new Date();
          expect(await pollDueTriggers(catalogue() as never, t0, treg)).toMatchObject({ baseline: 1, held: 0 });
          expect(treg.mock.calls[0][0]).toMatchObject({ orgId: ORG, userId: USER, brandId: BRAND, campaignId: unit.id, featureSlug: REACT_SLUG });
          resetSalesFunnelCapsCache();
          expect(await pollDueTriggers(catalogue() as never, new Date(t0.getTime() + 5 * 60_000), treg)).toMatchObject({ polled: 1, fired: 1 });
          const [fired] = (await pollEvents()).filter((e) => e.outcome === "ran");
          expect(fired.ranCampaignIds).toEqual([unit.id]);
          expect(mockFunding).not.toHaveBeenCalled();
        } finally {
          vi.unstubAllGlobals();
        }
      });

      it("holds the read when the funnel states no max budget, or the read would not fit under it", async () => {
        await funnelUnitOn(REACT_SLUG, REACT_LEG);
        const treg = vi.fn();
        vi.stubGlobal("fetch", capsFetch({ stated: false, maxBudget: null }));
        try {
          expect(await pollDueTriggers(catalogue() as never, new Date(), treg)).toMatchObject({ held: 1, polled: 0 });
        } finally {
          vi.unstubAllGlobals();
        }
        const [cursor] = await db.select().from(triggerPollCursors).where(eq(triggerPollCursors.triggerId, POLL));
        expect(cursor.lastError).toContain("sales funnel states no max budget");

        await db.update(triggerPollCursors).set({ nextPollAt: new Date(0) }).where(eq(triggerPollCursors.id, cursor.id));
        resetSalesFunnelCapsCache();
        vi.stubGlobal("fetch", capsFetch({ stated: true, maxBudget: budget("999.9") }));
        try {
          expect(await pollDueTriggers(catalogue() as never, new Date(), treg)).toMatchObject({ held: 1, polled: 0 });
        } finally {
          vi.unstubAllGlobals();
        }
        expect(treg).not.toHaveBeenCalled();
      });
    });

    it("a failed source read fires nothing and keeps the baseline unset", async () => {
      await campaignOn(REACT_SLUG, REACT_LEG);
      const treg = vi.fn().mockResolvedValue({ status: 502, body: { error: "upstream" }, chargedMicro: 0, runId: "r" });
      expect(await pollDueTriggers(catalogue() as never, new Date(), treg)).toMatchObject({ failed: 1, fired: 0 });
      expect(await pollEvents()).toHaveLength(0);
    });
  });
});
