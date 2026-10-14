import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";

const { mockExecute, mockPlan, mockFunnelMoney, mockSchedule, mockFile } = vi.hoisted(() => ({
  mockExecute: vi.fn(),
  mockPlan: vi.fn(),
  mockFunnelMoney: vi.fn(),
  mockSchedule: vi.fn(),
  mockFile: vi.fn(),
}));

vi.mock("@distribute/runs-client", () => ({
  createRun: vi.fn(async () => ({ id: crypto.randomUUID() })),
  updateRun: vi.fn(),
  listRuns: vi.fn(async () => ({ runs: [] })),
  getStatsBudget: vi.fn(),
}));

vi.mock("../../src/lib/features-workflow-projection-client.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/lib/features-workflow-projection-client.js")>();
  return {
    ...original,
    resolveSelectionForTrigger: vi.fn(async (a: { fallbackSlug: string }) => ({ workflowSlug: a.fallbackSlug, audienceId: null })),
    fetchLegProjectionRows: vi.fn(async () => []),
  };
});

vi.mock("../../src/lib/brand-runtime-client.js", () => ({
  fetchBrandRuntimeContext: vi.fn(async () => ({ brandProfile: null })),
}));

vi.mock("../../src/lib/workflows.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/lib/workflows.js")>();
  return { ...original, executeCampaignWorkflow: mockExecute };
});

vi.mock("../../src/lib/startable-pair.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/lib/startable-pair.js")>();
  return { ...original, resolveSalesFunnelPlan: mockPlan };
});

vi.mock("../../src/lib/sales-funnel-campaigns.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/lib/sales-funnel-campaigns.js")>();
  return { ...original, salesFunnelUnitMoney: mockFunnelMoney };
});

// /start-run reads the leg's reactivity from the catalogue: answered unreadable here (reactive null),
// never a real network read that outlives the test timeout.
vi.mock("../../src/lib/channel-operator-client.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/lib/channel-operator-client.js")>();
  return { ...original, fetchChannelCatalogue: vi.fn(async () => ({ ok: false, detail: "not served in this test" })) };
});

vi.mock("../../src/lib/sales-funnel-people.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/lib/sales-funnel-people.js")>();
  return { ...original, scheduleNamedPersonDue: mockSchedule, fileNamedPerson: mockFile };
});

import app from "../../src/index.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { campaigns, salesFunnelCampaigns } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import { runCampaignsInScope, STEP_TRIGGER_SKIPS } from "../../src/lib/step-trigger.js";
import { sameLeg } from "../../src/lib/leg-identity.js";

const API_KEY = process.env.CAMPAIGN_SERVICE_API_KEY || "test-api-key";
const ORG = "b645207b-0000-4000-8000-0000000000a1";
const BRAND = "75d7e3e8-0000-4000-8000-0000000000a2";
const OFFER = "231bb036-0000-4000-8000-0000000000a3";
const CHANNEL = "warm-email-follow-up";
const LEG = "figure_available_to_answered";
const FUNNEL = `${LEG}@${CHANNEL}`;
const COLD = "sales-cold-email-outreach";
const ENTRY = "lead_found_to_conversation";

const withPerson = (r: request.Test) =>
  r.set("x-api-key", API_KEY).set("x-org-id", ORG).set("x-user-id", "user_copilot").set("x-run-id", crypto.randomUUID());
const launch = (body: Record<string, unknown>) => withPerson(request(app).post("/sales-funnel-campaigns")).send(body);
const patch = (id: string, body: Record<string, unknown>) =>
  withPerson(request(app).patch(`/sales-funnel-campaigns/${id}`)).send(body);

const reactivePlan = {
  ok: true,
  plan: {
    salesFunnelId: FUNNEL,
    salesFunnelName: "Follow-up",
    units: [{ pipeId: `${CHANNEL}|${LEG}`, featureSlug: CHANNEL, legKey: LEG, mode: "reactive", workflowSlug: "follow-up-v1" }],
  },
};

const followUp = (email: string, extra: Record<string, unknown> = {}) =>
  launch({ brandId: BRAND, offerId: OFFER, salesFunnelId: FUNNEL, status: "ongoing", people: [{ email }], ...extra });

const isFollowUpPipe = (c: { featureSlug: string | null; legKey: string | null }) =>
  c.featureSlug === CHANNEL && sameLeg(c.featureSlug, LEG, c.legKey);

describe("a sales funnel campaign that names its people and carries an instruction", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await cleanTestData();
    mockPlan.mockResolvedValue(reactivePlan);
    mockExecute.mockResolvedValue(undefined);
    mockFunnelMoney.mockResolvedValue({ run: true });
    mockSchedule.mockResolvedValue({ ok: true });
    mockFile.mockImplementation(async ({ email }: { email: string }) => ({ ok: true, leadId: `lead-${email}`, filed: true }));
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("is born ACTIVE naming its person (canonical) with its instruction; the same person again is handed back", async () => {
    const res = await followUp(" Marie@Example.com ", { instruction: "Give Marie her exact cost per booked meeting." }).expect(201);
    const fc = res.body.salesFunnelCampaign;
    expect(res.body).toMatchObject({ created: true, started: true });
    expect(fc).toMatchObject({
      status: "ongoing",
      people: [{ email: "marie@example.com", leadId: "lead-marie@example.com" }],
      instruction: "Give Marie her exact cost per booked meeting.",
    });
    expect(fc.units).toHaveLength(1);
    expect(fc.people).toEqual([{ email: "marie@example.com", leadId: null }].map((p) => ({ ...p, leadId: "lead-marie@example.com" })));
    expect(mockFile).toHaveBeenCalledWith(expect.objectContaining({ orgId: ORG, campaignId: fc.units[0].campaignId, email: "marie@example.com" }));
    expect(res.body.filing).toEqual([
      { email: "marie@example.com", campaignId: fc.units[0].campaignId, outcome: "filed", leadId: "lead-marie@example.com" },
    ]);

    mockFile.mockClear();
    const again = await followUp("marie@example.com").expect(200);
    expect(mockFile).not.toHaveBeenCalled();
    expect(again.body).toMatchObject({ created: false, started: false });
    expect(again.body.salesFunnelCampaign.id).toBe(fc.id);
    expect(again.body.salesFunnelCampaign.instruction).toBe("Give Marie her exact cost per booked meeting.");
  });

  it("a person the brand does not know is still born, said in `filing`, leadId null", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockFile.mockResolvedValue({ ok: false, code: "person_not_known", detail: "lead-service 404" });
    const res = await followUp("stranger@example.com").expect(201);
    expect(res.body.salesFunnelCampaign.people).toEqual([{ email: "stranger@example.com", leadId: null }]);
    expect(res.body.filing[0].outcome).toBe("person_not_known");
  });

  it("another person on the SAME funnel is another campaign, both live; a campaign naming nobody coexists", async () => {
    const marie = await followUp("marie@example.com").expect(201);
    const paul = await followUp("paul@example.com").expect(201);
    const nobody = await launch({ brandId: BRAND, offerId: OFFER, salesFunnelId: FUNNEL, status: "ongoing" }).expect(201);
    const ids = [marie, paul, nobody].map((r) => r.body.salesFunnelCampaign.id);
    expect(new Set(ids).size).toBe(3);
    const live = await db.select().from(campaigns).where(eq(campaigns.orgId, ORG));
    expect(live.filter((c) => c.status === "ongoing")).toHaveLength(3);
    expect(nobody.body.salesFunnelCampaign.people).toBeNull();
  });

  it("refuses a funnel that also finds new people, writing nothing", async () => {
    mockPlan.mockResolvedValue({
      ok: true,
      plan: {
        salesFunnelId: FUNNEL,
        salesFunnelName: "Mixed",
        units: [
          { pipeId: `${COLD}|${ENTRY}`, featureSlug: COLD, legKey: ENTRY, mode: "proactive", workflowSlug: "aurora-v3" },
          reactivePlan.plan.units[0],
        ],
      },
    });
    const res = await followUp("marie@example.com").expect(400);
    expect(res.body.reason).toBe("people_need_reactive_funnel");
    expect(await db.select().from(salesFunnelCampaigns).where(eq(salesFunnelCampaigns.orgId, ORG))).toHaveLength(0);
  });

  it("rewords the instruction without touching the status; null clears it; an empty body is refused", async () => {
    const created = await followUp("marie@example.com", { instruction: "old words" }).expect(201);
    const id = created.body.salesFunnelCampaign.id;

    const reworded = await patch(id, { instruction: "new words" }).expect(200);
    expect(reworded.body.salesFunnelCampaign).toMatchObject({ instruction: "new words", status: "ongoing" });

    const cleared = await patch(id, { instruction: null }).expect(200);
    expect(cleared.body.salesFunnelCampaign.instruction).toBeNull();

    await patch(id, {}).expect(400);

    const stopped = await patch(id, { status: "stop", instruction: "kept" }).expect(200);
    expect(stopped.body.salesFunnelCampaign).toMatchObject({ status: "stopped", instruction: "kept" });
  });

  it("lists the campaigns naming a person (case-insensitive)", async () => {
    await followUp("marie@example.com").expect(201);
    await followUp("paul@example.com").expect(201);
    const res = await withPerson(request(app).get("/sales-funnel-campaigns"))
      .query({ personEmail: "MARIE@example.com", status: "ongoing" })
      .expect(200);
    expect(res.body.salesFunnelCampaigns).toHaveLength(1);
    expect(res.body.salesFunnelCampaigns[0].people[0].email).toBe("marie@example.com");
  });

  it("/start-run answers the funnel campaign's CURRENT instruction and people; null for a campaign naming nothing", async () => {
    const created = await followUp("marie@example.com", { instruction: "first" }).expect(201);
    const unitId = created.body.salesFunnelCampaign.units[0].campaignId;
    await patch(created.body.salesFunnelCampaign.id, { instruction: "edited" }).expect(200);

    const run = await request(app)
      .post("/start-run")
      .set({
        "x-api-key": API_KEY,
        "x-org-id": ORG,
        "x-campaign-id": unitId,
        "x-user-id": "user_copilot",
        "x-run-id": crypto.randomUUID(),
        "x-workflow-slug": "follow-up-v1",
        "x-feature-slug": CHANNEL,
      })
      .expect(200);
    expect(run.body.instruction).toBe("edited");
    expect(run.body.people).toEqual([{ email: "marie@example.com", leadId: "lead-marie@example.com" }]);
  });

  describe("an event its pipe answers", () => {
    it("makes each person DUE on its own unit, then dispatches EVERY person campaign (no rationing between them)", async () => {
      const marie = await followUp("marie@example.com").expect(201);
      const paul = await followUp("paul@example.com").expect(201);
      const marieUnit = marie.body.salesFunnelCampaign.units[0].campaignId;
      const paulUnit = paul.body.salesFunnelCampaign.units[0].campaignId;

      const out = await runCampaignsInScope({ orgId: ORG, brandId: BRAND, offerId: OFFER }, isFollowUpPipe, "test event");

      expect(mockSchedule).toHaveBeenCalledWith(expect.objectContaining({ orgId: ORG, campaignId: marieUnit, email: "marie@example.com" }));
      expect(mockSchedule).toHaveBeenCalledWith(expect.objectContaining({ orgId: ORG, campaignId: paulUnit, email: "paul@example.com" }));
      // Same channel cohort: one dispatch this pass, the other person's debt stays due for its next run.
      expect(out.triggered.length + out.skipped.filter((s) => s.reason === STEP_TRIGGER_SKIPS.COHORT_RUN_IN_FLIGHT).length).toBe(2);
      expect(out.skipped.some((s) => s.reason === STEP_TRIGGER_SKIPS.PIPE_HANDLED_BY_ANOTHER_CAMPAIGN)).toBe(false);
    });

    it("a REPORTED event naming one lead runs only the campaign naming that lead", async () => {
      const marie = await followUp("marie@example.com").expect(201);
      await followUp("paul@example.com").expect(201);
      const marieUnit = marie.body.salesFunnelCampaign.units[0].campaignId;
      const out = await runCampaignsInScope(
        { orgId: ORG, brandId: BRAND, offerId: OFFER },
        isFollowUpPipe,
        "test event",
        undefined,
        "lead-marie@example.com",
      );
      expect(out.triggered.map((t) => t.campaignId)).toEqual([marieUnit]);
      expect(out.skipped.map((s) => s.reason)).toEqual([STEP_TRIGGER_SKIPS.EVENT_NAMES_ANOTHER_PERSON]);
      expect(mockSchedule).toHaveBeenCalledTimes(1);
      expect(mockSchedule).toHaveBeenCalledWith(expect.objectContaining({ email: "marie@example.com" }));
    });

    it("an event naming another lead does not concern it", async () => {
      await followUp("marie@example.com").expect(201);
      const out = await runCampaignsInScope(
        { orgId: ORG, brandId: BRAND, offerId: OFFER },
        isFollowUpPipe,
        "test event",
        { eventId: crypto.randomUUID(), triggerId: "figure_available", leadId: crypto.randomUUID(), item: null },
      );
      expect(out.triggered).toEqual([]);
      expect(out.skipped.map((s) => s.reason)).toEqual([STEP_TRIGGER_SKIPS.EVENT_NAMES_ANOTHER_PERSON]);
      expect(mockSchedule).not.toHaveBeenCalled();
      expect(mockExecute).not.toHaveBeenCalled();
    });

    it("a person not filed on the unit is filed at the event, then made due and dispatched", async () => {
      await followUp("marie@example.com").expect(201);
      mockSchedule.mockResolvedValueOnce({ ok: false, code: "person_not_filed", detail: "lead-service 404" }).mockResolvedValueOnce({ ok: true });
      mockFile.mockClear();
      const out = await runCampaignsInScope({ orgId: ORG, brandId: BRAND, offerId: OFFER }, isFollowUpPipe, "test event");
      expect(mockFile).toHaveBeenCalledTimes(1);
      expect(mockSchedule).toHaveBeenCalledTimes(2);
      expect(out.triggered).toHaveLength(1);
    });

    it("a person lead-service does not hold on the unit is a named skip, nothing dispatched", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      mockSchedule.mockResolvedValue({ ok: false, code: "person_not_filed", detail: "lead-service 404" });
      await followUp("marie@example.com").expect(201);
      const out = await runCampaignsInScope({ orgId: ORG, brandId: BRAND, offerId: OFFER }, isFollowUpPipe, "test event");
      expect(out.triggered).toEqual([]);
      expect(out.skipped.map((s) => s.reason)).toEqual([STEP_TRIGGER_SKIPS.PERSON_NOT_FILED]);
      expect(mockExecute).not.toHaveBeenCalled();
    });

    it("a capped campaign owes nobody anything: no debt written, nothing dispatched", async () => {
      mockFunnelMoney.mockResolvedValue({ run: false, kind: "reached", detail: "max volume 1 reached" });
      await followUp("marie@example.com").expect(201);
      const out = await runCampaignsInScope({ orgId: ORG, brandId: BRAND, offerId: OFFER }, isFollowUpPipe, "test event");
      expect(out.skipped.map((s) => s.reason)).toEqual([STEP_TRIGGER_SKIPS.SALES_FUNNEL_CAP]);
      expect(mockSchedule).not.toHaveBeenCalled();
    });

    it("a cancelled (stopped) follow-up is never dispatched", async () => {
      const created = await followUp("marie@example.com").expect(201);
      await patch(created.body.salesFunnelCampaign.id, { status: "stop" }).expect(200);
      const out = await runCampaignsInScope({ orgId: ORG, brandId: BRAND, offerId: OFFER }, isFollowUpPipe, "test event");
      expect(out.triggered).toEqual([]);
      expect(mockSchedule).not.toHaveBeenCalled();
      expect(mockExecute).not.toHaveBeenCalled();
    });
  });
});
