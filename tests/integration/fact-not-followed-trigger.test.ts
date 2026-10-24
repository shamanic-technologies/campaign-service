import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

const { mockExecute, mockCatalogue, mockFunding, mockListRuns, mockResolveSlug, mockGetStatsBudget, mockReachers, mockEver, mockFile, mockDue } =
  vi.hoisted(() => ({
    mockGetStatsBudget: vi.fn(),
    mockExecute: vi.fn(),
    mockCatalogue: vi.fn(),
    mockFunding: vi.fn(),
    mockListRuns: vi.fn(),
    mockResolveSlug: vi.fn(),
    mockReachers: vi.fn(),
    mockEver: vi.fn(),
    mockFile: vi.fn(),
    mockDue: vi.fn(),
  }));

vi.mock("@distribute/runs-client", () => ({
  createRun: vi.fn(),
  updateRun: vi.fn(),
  listRuns: mockListRuns,
  getStatsBudget: (p: { featureSlug?: string }) => (p?.featureSlug?.startsWith("sourcing-") ? Promise.resolve({ windows: [] }) : mockGetStatsBudget(p)),
}));
vi.mock("../../src/lib/workflows.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/lib/workflows.js")>();
  return { ...original, executeCampaignWorkflow: mockExecute };
});
vi.mock("../../src/lib/channel-operator-client.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/lib/channel-operator-client.js")>();
  return { ...original, fetchChannelCatalogue: mockCatalogue };
});
vi.mock("../../src/lib/features-workflow-projection-client.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/lib/features-workflow-projection-client.js")>();
  return { ...original, resolveSelectionForTrigger: mockResolveSlug };
});
vi.mock("../../src/lib/step-reach-client.js", () => ({ fetchStepReachers: mockReachers, hasEverReachedStep: mockEver }));
// The dispatched campaigns are sales funnel UNITS: their money is their funnel's caps, driven here
// by `mockFunding` (funded = runs; not funded = held, `kind` defaulting to `unfunded`).
vi.mock("../../src/lib/sales-funnel-campaigns.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/lib/sales-funnel-campaigns.js")>();
  return {
    ...original,
    salesFunnelUnitMoney: async () => {
      const f = await mockFunding();
      return f.funded
        ? { run: true, pace: { spentCents: 0, ceilingCents: f.ceilingCents } }
        : { run: false, kind: f.kind ?? "unfunded", reason: "Unfunded", detail: f.reason, nextRunAt: new Date(Date.now() + 600_000) };
    },
  };
});
vi.mock("../../src/lib/sales-funnel-people.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/lib/sales-funnel-people.js")>();
  return { ...original, fileNamedPerson: mockFile, scheduleNamedPersonDue: mockDue };
});

import { eq } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { triggerEvents } from "../../src/db/schema.js";
import { cleanTestData, closeDb, insertTestCampaign } from "../helpers/test-db.js";
import { fireDueTriggerEvents } from "../../src/lib/trigger-events.js";
import { runTriggerDetectorsTick } from "../../src/lib/trigger-detectors.js";
import { reRunDueCampaigns } from "../../src/lib/scheduler.js";

const ORG = "b645207b-0000-4000-8000-000000000031";
const BRAND = "75d7e3e8-0000-4000-8000-000000000032";
const OFFER = "231bb036-0000-4000-8000-000000000033";
const USER = "7a3b1c22-0000-4000-8000-000000000034";
const TRIGGER = "signup_not_paid_30_min";
const SLUG = "ai-follow-up-email";
const LEG = "signup" + "_to_" + "paid_client";
const MIN = 60_000;

function catalogue() {
  return {
    ok: true,
    operatorBySlug: new Map(),
    legsBySlug: new Map(),
    stepKeys: new Set(["signup", "paid_client"]),
    legs: [],
    triggers: new Map([
      [TRIGGER, {
        id: TRIGGER, label: "Signup Not Paid In 30 Min", fromStepKey: "signup", firedBy: "campaign-service", coded: true,
        kind: "delay", origin: "declared", params: { afterStep: "signup", minutes: 30, unlessStep: "paid_client" },
      }],
    ]),
    triggerTransitions: [{ featureSlug: SLUG, legKey: LEG, triggerId: TRIGGER }],
  };
}

const events = () => db.select().from(triggerEvents).where(eq(triggerEvents.triggerId, TRIGGER));

describe("fact not followed: a delay trigger with unlessStep", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await cleanTestData();
    mockCatalogue.mockResolvedValue(catalogue());
    mockFunding.mockResolvedValue({ funded: true, ceilingCents: 5000 });
    mockListRuns.mockResolvedValue({ runs: [] });
    mockResolveSlug.mockImplementation(async (p: { fallbackSlug: string }) => ({ workflowSlug: p.fallbackSlug, audienceId: null }));
    mockExecute.mockResolvedValue({ runId: "run-1" });
    mockGetStatsBudget.mockResolvedValue({ windows: [{ label: "today", totalCostInUsdCents: "0", netTotalCostInUsdCents: "0" }] });
    mockFile.mockResolvedValue({ ok: true, leadId: "lead-filed", outcome: "filed" });
    mockDue.mockResolvedValue({ ok: true });
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  const campaignOn = () =>
    insertTestCampaign(ORG, {
      brandIds: [BRAND], brandId: BRAND, status: "ongoing", featureSlug: SLUG, workflowSlug: `${SLUG}-v1`,
      createdByUserId: USER, parentRunId: "9f0d1c22-0000-4000-8000-000000000039", offerId: OFFER, legKey: LEG,
      salesFunnelCampaignId: crypto.randomUUID(), salesFunnelId: "sf-signup-follow-up",
    });

  it("plans one event per person who reached the step, fires 30 min later for the one still not paid, cancels the one who paid", async () => {
    const campaign = await campaignOn();
    const now = new Date();
    const t0 = new Date(now.getTime() - 5 * MIN);
    mockReachers.mockResolvedValue([
      { email: "quiet@distribute.you", name: "Quiet", phone: null, reachedAt: t0 },
      { email: "payer@distribute.you", name: "Payer", phone: "+33600000000", reachedAt: t0 },
    ]);

    const tick = await runTriggerDetectorsTick(now);
    expect(tick?.delay).toEqual({ triggers: 1, scopes: 1, planned: 2 });
    // The window asked: never older than the delay + the delay itself.
    expect(mockReachers.mock.calls[0][0]).toMatchObject({ orgId: ORG, brandId: BRAND, step: "signup" });
    expect((mockReachers.mock.calls[0][0].since as Date).getTime()).toBe(now.getTime() - 60 * MIN);
    const planned = await events();
    const due = new Date(t0.getTime() + 30 * MIN);
    for (const e of planned) {
      expect(e).toMatchObject({ status: "pending", leadId: null, step: "signup" });
      expect(e.dueAt.toISOString()).toBe(due.toISOString());
    }

    // Once per person x trigger x offer.
    expect((await runTriggerDetectorsTick(now))?.delay.planned).toBe(0);

    expect(await fireDueTriggerEvents(new Date(due.getTime() - MIN))).toBe(0);

    // Everyone still reaches the anchor (signup); only the payer reached paid_client.
    mockEver.mockImplementation(async (p: { email: string; step: string }) => p.step === "signup" || (p.step === "paid_client" && p.email === "payer@distribute.you"));
    expect(await fireDueTriggerEvents(new Date(due.getTime() + MIN))).toBe(2);
    const byEmail = new Map((await events()).map((e) => [(e.detail as { person: { email: string } }).person.email, e]));
    expect(byEmail.get("payer@distribute.you")).toMatchObject({ status: "done", outcome: "skipped", skipReason: "step_reached" });
    expect(byEmail.get("quiet@distribute.you")).toMatchObject({ status: "done", outcome: "ran", ranCampaignIds: [campaign.id] });
    expect(mockFile).toHaveBeenCalledTimes(1);
    expect(mockFile.mock.calls[0][0]).toMatchObject({ campaignId: campaign.id, email: "quiet@distribute.you" });
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(mockExecute.mock.calls[0][1]).toMatchObject({
      campaignId: campaign.id,
      trigger: { triggerId: TRIGGER, leadId: "lead-filed", person: { email: "quiet@distribute.you" } },
    });
  });

  it("a funnel HEADED by the delay trigger (its pipe names another trigger) is planned and fired per person, never by the tick (FUNNEL-HEAD-TRIGGER-1015)", async () => {
    // The pipe answers follow_up_due, not this delay trigger: only the funnel head makes the unit answer it.
    mockCatalogue.mockResolvedValue({ ...catalogue(), triggerTransitions: [{ featureSlug: SLUG, legKey: LEG, triggerId: "follow_up_due" }] });
    const past = new Date(Date.now() - MIN);
    const unit = await insertTestCampaign(ORG, {
      brandIds: [BRAND], brandId: BRAND, status: "ongoing", featureSlug: SLUG, workflowSlug: `${SLUG}-v1`,
      createdByUserId: USER, parentRunId: "9f0d1c22-0000-4000-8000-000000000039", offerId: OFFER, legKey: LEG,
      salesFunnelCampaignId: crypto.randomUUID(), salesFunnelId: `trigger:${TRIGGER}+${LEG}@${SLUG}`,
      runsOnTriggerId: TRIGGER, nextRunAt: past,
    });

    // The tick never dispatches it.
    await reRunDueCampaigns();
    expect(mockExecute).not.toHaveBeenCalled();

    const now = new Date();
    const t0 = new Date(now.getTime() - 5 * MIN);
    mockReachers.mockResolvedValue([{ email: "quiet@distribute.you", name: "Quiet", phone: null, reachedAt: t0 }]);
    expect((await runTriggerDetectorsTick(now))?.delay).toEqual({ triggers: 1, scopes: 1, planned: 1 });
    // Once per person x trigger x offer, as for a pipe trigger.
    expect((await runTriggerDetectorsTick(now))?.delay.planned).toBe(0);

    mockEver.mockImplementation(async (p: { step: string }) => p.step === "signup");
    expect(await fireDueTriggerEvents(new Date(t0.getTime() + 31 * MIN))).toBe(1);
    const [event] = await events();
    expect(event).toMatchObject({ status: "done", outcome: "ran", ranCampaignIds: [unit.id] });
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(mockExecute.mock.calls[0][1]).toMatchObject({ campaignId: unit.id, trigger: { triggerId: TRIGGER, person: { email: "quiet@distribute.you" } } });
  });

  it("a delay trigger nothing answers (no pipe names it, no funnel heads it) is not detected", async () => {
    mockCatalogue.mockResolvedValue({ ...catalogue(), triggerTransitions: [] });
    await campaignOn();
    mockReachers.mockResolvedValue([{ email: "quiet@distribute.you", name: null, phone: null, reachedAt: new Date(Date.now() - 5 * MIN) }]);
    expect((await runTriggerDetectorsTick(new Date()))?.delay).toEqual({ triggers: 0, scopes: 0, planned: 0 });
    expect(await events()).toHaveLength(0);
  });

  it("a person who reached the step longer ago than the delay is never planned (backfill)", async () => {
    await campaignOn();
    const now = new Date();
    mockReachers.mockResolvedValue([]);
    await runTriggerDetectorsTick(now);
    expect(await events()).toHaveLength(0);
  });

  it("lead-service unreadable at fire time: nothing sent, the event waits for the retry", async () => {
    await campaignOn();
    const now = new Date();
    const t0 = new Date(now.getTime() - 5 * MIN);
    mockReachers.mockResolvedValue([{ email: "quiet@distribute.you", name: null, phone: null, reachedAt: t0 }]);
    await runTriggerDetectorsTick(now);
    mockEver.mockRejectedValue(new Error("lead-service GET step-reached (paid_client) failed: 502"));
    await fireDueTriggerEvents(new Date(t0.getTime() + 31 * MIN));
    const [event] = await events();
    expect(event).toMatchObject({ status: "pending", outcome: null });
    expect(event.lastError).toContain("502");
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("WITHDRAWN-FACT-CANCELS-1024: a person whose anchor fact was withdrawn (a mail scanner's signup) is never sent", async () => {
    await campaignOn();
    const now = new Date();
    const t0 = new Date(now.getTime() - 5 * MIN);
    mockReachers.mockResolvedValue([{ email: "scanner@distribute.you", name: null, phone: null, reachedAt: t0 }]);
    await runTriggerDetectorsTick(now);
    // lead-service no longer counts the anchor step for the person (its fact was withdrawn).
    mockEver.mockResolvedValue(false);
    await fireDueTriggerEvents(new Date(t0.getTime() + 31 * MIN));
    const [event] = await events();
    expect(event).toMatchObject({ status: "done", outcome: "skipped", skipReason: "anchor_withdrawn" });
    expect(mockExecute).not.toHaveBeenCalled();
  });
});
