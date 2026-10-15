import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";

/**
 * FUNNEL-HEAD-TRIGGER-1015 (owner 2026-10-15): a trigger fires every live funnel campaign whose FUNNEL starts on it,
 * its proactive pipes included, and those units never run on their own cadence; a legacy reactive funnel fires
 * exactly as before; the PUBLIC door refuses a trigger features-service serves `callable: false`, the internal door
 * (our own services) takes every declared trigger as before.
 */

const { mockExecute, mockCatalogue, mockListRuns, mockResolveSlug } = vi.hoisted(() => ({
  mockExecute: vi.fn(),
  mockCatalogue: vi.fn(),
  mockListRuns: vi.fn(),
  mockResolveSlug: vi.fn(),
}));

vi.mock("@distribute/runs-client", () => ({
  createRun: vi.fn(),
  updateRun: vi.fn(),
  listRuns: mockListRuns,
  getStatsBudget: vi.fn().mockResolvedValue({ windows: [] }),
}));
vi.mock("../../src/lib/workflows.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/lib/workflows.js")>();
  return { ...original, executeCampaignWorkflow: mockExecute };
});
vi.mock("../../src/lib/channel-operator-client.js", () => ({ fetchChannelCatalogue: mockCatalogue }));
vi.mock("../../src/lib/features-workflow-projection-client.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/lib/features-workflow-projection-client.js")>();
  return { ...original, resolveSelectionForTrigger: mockResolveSlug };
});
// Every unit here is funded: the dispatch decision under test is which trigger fires which unit.
vi.mock("../../src/lib/sales-funnel-campaigns.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/sales-funnel-campaigns.js")>()),
  salesFunnelUnitMoney: vi.fn().mockResolvedValue({ run: true, pace: { spentCents: 0, ceilingCents: 5000 } }),
}));

import app from "../../src/index.js";
import { db } from "../../src/db/index.js";
import { campaigns, triggerEvents } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import { cleanTestData, closeDb, insertTestCampaign } from "../helpers/test-db.js";
import { reRunDueCampaigns } from "../../src/lib/scheduler.js";

const API_KEY = process.env.CAMPAIGN_SERVICE_API_KEY || "test-api-key";
const ORG = "b645207b-0000-4000-8000-0000000000f1";
const BRAND = "75d7e3e8-0000-4000-8000-0000000000f2";
const OFFER = "231bb036-0000-4000-8000-0000000000f3";
const USER = "7a3b1c22-0000-4000-8000-0000000000f4";
const RUN = "9f0d1c22-0000-4000-8000-0000000000f5";
const COLD = "sales-cold-email-outreach";
const LEAD_LEG = "lead_found_to_conversation";
const REPLY_LEG = "conversation_to_meeting_booked";
const LEAD = "lead_found";
const REPLY = "positive_reply_received";
const HEADED = `trigger:${LEAD}+${LEAD_LEG}@${COLD}+conversation_to_paid_client`;

function catalogue() {
  const trigger = (id: string, label: string, fromStepKey: string | null, kind: string, callable?: boolean) =>
    [id, { id, label, fromStepKey, firedBy: "x", coded: true, kind, ...(callable === undefined ? {} : { callable }) }] as const;
  return {
    ok: true,
    operatorBySlug: new Map(),
    legsBySlug: new Map([[COLD, new Set([LEAD_LEG])], ["ai-meeting-booking", new Set([REPLY_LEG])]]),
    stepKeys: new Set(["lead_found", "conversation", "meeting_booked", "paid_client", "signup"]),
    legs: [
      { legKey: LEAD_LEG, fromStepKey: "lead_found", toStepKey: "conversation" },
      { legKey: REPLY_LEG, fromStepKey: "conversation", toStepKey: "meeting_booked" },
    ],
    triggers: new Map([
      trigger(LEAD, "Lead", "lead_found", "event", true),
      trigger(REPLY, "Positive reply", "conversation", "event", true),
      trigger("signup_not_paid_24_hours", "Signup Not Paid In 24 Hours", "signup", "delay", false),
      trigger("github_issue_in_prod", "GitHub Issue In Prod", null, "github_issue_in_prod", false),
      trigger("follow_up_due", "Follow-up Due", null, "reported", true),
      trigger("email_pushed_via_api", "Email Pushed Via API", null, "reported", true),
      trigger("follow_up_date_reached", "Follow-up Date Reached", null, "reported", true),
      // Requests between our services: features-service serves them callable: false.
      trigger("lead_requested", "Lead requested", null, "event", false),
      trigger("on_demand", "On demand", null, "event", false),
      // Not served `callable` yet: accepted as before.
      trigger("website_visited", "Website visit", null, "event"),
    ]),
    triggerTransitions: [{ featureSlug: "ai-meeting-booking", legKey: REPLY_LEG, triggerId: REPLY }],
  };
}

const unit = (over: Parameters<typeof insertTestCampaign>[1]) =>
  insertTestCampaign(ORG, {
    brandIds: [BRAND],
    brandId: BRAND,
    status: "ongoing",
    createdByUserId: USER,
    parentRunId: RUN,
    offerId: OFFER,
    salesFunnelCampaignId: crypto.randomUUID(),
    ...over,
  });
const headedColdEmail = (over: Parameters<typeof insertTestCampaign>[1] = {}) =>
  unit({ featureSlug: COLD, legKey: LEAD_LEG, workflowSlug: "cold-email-lyra", salesFunnelId: HEADED, runsOnTriggerId: LEAD, ...over });
const proactiveColdEmail = () =>
  unit({ featureSlug: COLD, legKey: LEAD_LEG, workflowSlug: "cold-email-lyra", salesFunnelId: `start_to_lead_found@lead-sourcing+${LEAD_LEG}@${COLD}+conversation_to_paid_client` });
const meetingBooking = () =>
  unit({ featureSlug: "ai-meeting-booking", legKey: REPLY_LEG, workflowSlug: "aurora-v3", salesFunnelId: `${REPLY_LEG}@ai-meeting-booking+meeting_booked_to_paid_client` });

const postEvent = (body: Record<string, unknown>, path = "/internal/trigger-events") =>
  request(app).post(path).set("x-api-key", API_KEY).set("x-org-id", ORG).send({ brandId: BRAND, offerId: OFFER, ...body });
const postPublic = (body: Record<string, unknown>) => postEvent(body, "/internal/trigger-events/public");
const executedCampaignIds = () => mockExecute.mock.calls.map((c) => (c[1] as { campaignId: string }).campaignId);

describe("a trigger at the head of a sales funnel (FUNNEL-HEAD-TRIGGER-1015)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await cleanTestData();
    mockCatalogue.mockResolvedValue(catalogue());
    mockListRuns.mockResolvedValue({ runs: [] });
    mockResolveSlug.mockImplementation(async (a: { fallbackSlug: string }) => ({ workflowSlug: a.fallbackSlug, audienceId: null }));
    mockExecute.mockResolvedValue({ runId: "wf-run-1" });
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  describe("AC1: ⚡ Lead fires the cold email unit of the funnel it heads, and nothing else", () => {
    it("the door records ⚡ Lead for a person: the trigger-headed unit runs with the event; a proactive funnel's unit on the same pipe does not", async () => {
      const headed = await headedColdEmail();
      await proactiveColdEmail();
      await meetingBooking();

      const res = await postEvent({ triggerId: LEAD, leadId: "lead-42" });

      expect(res.status).toBe(201);
      expect(res.body.event).toMatchObject({ triggerId: LEAD, status: "done", outcome: "ran", ranCampaignIds: [headed.id] });
      expect(executedCampaignIds()).toEqual([headed.id]);
    });

    it("a trigger-headed unit that is OFF: the event says campaign_off, nothing runs", async () => {
      await headedColdEmail({ status: "stopped" });
      const res = await postEvent({ triggerId: LEAD });
      expect(res.body.event).toMatchObject({ outcome: "skipped", skipReason: "campaign_off" });
      expect(mockExecute).not.toHaveBeenCalled();
    });

    it("another trigger never fires it (a positive reply runs AI meeting booking only)", async () => {
      await headedColdEmail();
      const booking = await meetingBooking();
      const res = await postEvent({ triggerId: REPLY });
      expect(res.body.event).toMatchObject({ outcome: "ran", ranCampaignIds: [booking.id] });
      expect(executedCampaignIds()).toEqual([booking.id]);
    });

    it("never runs on its own between triggers: the scheduler parks it, an ordinary proactive unit still runs", async () => {
      const past = new Date(Date.now() - 60_000);
      const headed = await headedColdEmail({ nextRunAt: past });
      const ordinary = await unit({
        featureSlug: COLD,
        legKey: LEAD_LEG,
        workflowSlug: "cold-email-lyra",
        salesFunnelId: "another-proactive-funnel",
        brandIds: [crypto.randomUUID()],
        nextRunAt: past,
      });

      await reRunDueCampaigns();

      expect(executedCampaignIds()).not.toContain(headed.id);
      expect(executedCampaignIds()).toContain(ordinary.id);
      const [row] = await db.select().from(campaigns).where(eq(campaigns.id, headed.id));
      expect(row.nextRunAt!.getTime()).toBeGreaterThan(Date.now() + 9 * 60_000);
    });
  });

  describe("AC2: a legacy reactive funnel fires exactly as before", () => {
    it("Positive reply -> AI meeting booking: the unit its pipe names runs, nothing stored on it", async () => {
      const booking = await meetingBooking();
      expect(booking.runsOnTriggerId).toBeNull();
      const res = await postEvent({ triggerId: REPLY, leadId: "lead-7" });
      expect(res.status).toBe(201);
      expect(res.body.event).toMatchObject({ outcome: "ran", ranCampaignIds: [booking.id], leadId: "lead-7" });
      expect(executedCampaignIds()).toEqual([booking.id]);
    });

    it("a trigger no pipe names and no funnel heads still records `no_leg`", async () => {
      const res = await postEvent({ triggerId: LEAD });
      expect(res.body.event).toMatchObject({ outcome: "skipped", skipReason: "no_leg" });
    });
  });

  describe("AC3: the PUBLIC door refuses what distribute fires itself; the internal door takes every trigger", () => {
    it.each(["signup_not_paid_24_hours", "github_issue_in_prod", "on_demand", "lead_requested"])(
      "public door: %s is refused 400 `trigger_not_callable`, nothing recorded",
      async (triggerId) => {
        const res = await postPublic({ triggerId });
        expect(res.status).toBe(400);
        expect(res.body.reason).toBe("trigger_not_callable");
        expect(res.body.error).toContain(triggerId);
        expect(await db.select().from(triggerEvents)).toHaveLength(0);
      },
    );

    it.each(["follow_up_due", "email_pushed_via_api", "follow_up_date_reached", "website_visited"])(
      "public door: %s is accepted (callable, or no callable served yet)",
      async (triggerId) => {
        const res = await postPublic({ triggerId });
        expect(res.status).toBe(201);
        expect(res.body.event.triggerId).toBe(triggerId);
      },
    );

    it("public door: ⚡ Lead fires the trigger-headed unit like the internal door does", async () => {
      const headed = await headedColdEmail();
      const res = await postPublic({ triggerId: LEAD });
      expect(res.body.event).toMatchObject({ outcome: "ran", ranCampaignIds: [headed.id] });
    });

    it.each(["lead_requested", "on_demand", "signup_not_paid_24_hours", "follow_up_due"])(
      "internal door: %s is accepted exactly as today",
      async (triggerId) => {
        const res = await postEvent({ triggerId });
        expect(res.status).toBe(201);
        expect(res.body.event.triggerId).toBe(triggerId);
      },
    );
  });
});
