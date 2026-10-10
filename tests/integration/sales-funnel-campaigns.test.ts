import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";

const { mockExecute, mockPlan, mockFunnelMoney, realMoney } = vi.hoisted(() => ({
  mockExecute: vi.fn(),
  mockPlan: vi.fn(),
  mockFunnelMoney: vi.fn(),
  realMoney: { fn: null as null | ((...a: never[]) => unknown) },
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
  };
});

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
  realMoney.fn = original.salesFunnelUnitMoney as never;
  return { ...original, salesFunnelUnitMoney: mockFunnelMoney };
});

import app from "../../src/index.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { campaigns, campaignStatusTransitions, salesFunnelCampaigns } from "../../src/db/schema.js";
import { and, eq } from "drizzle-orm";
import { stopOrgCampaignsWithHistory, TRANSITION_SOURCES } from "../../src/lib/campaign-status-history.js";
import { resolvePredecessorCampaign } from "../../src/lib/predecessor-campaign.js";
import { runCampaignsInScope, STEP_TRIGGER_SKIPS } from "../../src/lib/step-trigger.js";
import { sameLeg } from "../../src/lib/leg-identity.js";
import type { ChannelCatalogueRead } from "../../src/lib/channel-operator-client.js";

const API_KEY = process.env.CAMPAIGN_SERVICE_API_KEY || "test-api-key";
const ORG = "b645207b-0000-4000-8000-0000000000f1";
const BRAND = "75d7e3e8-0000-4000-8000-0000000000f2";
const OFFER = "231bb036-0000-4000-8000-0000000000f3";
const COLD = "sales-cold-email-outreach";
const ENTRY = "lead_found_to_conversation";
const BOOKING = "ai-meeting-booking";
const REACTIVE = ["conversation", "to", "meeting", "booked"].join("_");
const EPIPHANY = `${ENTRY}@${COLD}+${REACTIVE}@${BOOKING}+meeting_booked_to_paid_client`;
const OTHER_FUNNEL = `${ENTRY}@${COLD}+${REACTIVE}@${BOOKING}+meeting_booked_to_meeting_attended+meeting_attended_to_paid_client`;

const withPerson = (r: request.Test) =>
  r.set("x-api-key", API_KEY).set("x-org-id", ORG).set("x-user-id", "user_funnel").set("x-run-id", crypto.randomUUID());

const launch = (body: Record<string, unknown>) => withPerson(request(app).post("/sales-funnel-campaigns")).send(body);
const patchFunnel = (id: string, status: string) => withPerson(request(app).patch(`/sales-funnel-campaigns/${id}`)).send({ status });

function planOf(name: string) {
  return {
    ok: true,
    plan: {
      salesFunnelId: "unused",
      salesFunnelName: name,
      units: [
        { pipeId: `${COLD}|${ENTRY}`, featureSlug: COLD, legKey: ENTRY, mode: "proactive", workflowSlug: "aurora-v3" },
        { pipeId: `${BOOKING}|${REACTIVE}`, featureSlug: BOOKING, legKey: REACTIVE, mode: "reactive", workflowSlug: "booking-v1" },
      ],
    },
  };
}

async function unitsOf(salesFunnelCampaignId: string) {
  return db.select().from(campaigns).where(eq(campaigns.salesFunnelCampaignId, salesFunnelCampaignId));
}

describe("sales funnel campaigns (brand x offer x sales funnel, one unit per pipe)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await cleanTestData();
    mockPlan.mockResolvedValue(planOf("Epiphany"));
    mockExecute.mockResolvedValue(undefined);
    mockFunnelMoney.mockImplementation(realMoney.fn as never);
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("creates a funnel STOPPED with one stopped unit per pipe, each carrying the funnel identity, and runs nothing", async () => {
    const res = await launch({ brandId: BRAND, offerId: OFFER, salesFunnelId: EPIPHANY, status: "stopped" }).expect(201);

    const fc = res.body.salesFunnelCampaign;
    expect(res.body).toMatchObject({ created: true, started: false });
    expect(fc).toMatchObject({ brandId: BRAND, offerId: OFFER, salesFunnelId: EPIPHANY, salesFunnelName: "Epiphany", status: "stopped" });
    expect(fc.units.map((u: { pipeId: string; status: string }) => [u.pipeId, u.status])).toEqual([
      [`${COLD}|${ENTRY}`, "stopped"],
      [`${BOOKING}|${REACTIVE}`, "stopped"],
    ]);

    const units = await unitsOf(fc.id);
    expect(units).toHaveLength(2);
    for (const u of units) {
      expect(u.salesFunnelId).toBe(EPIPHANY);
      expect(u.salesFunnelCampaignId).toBe(fc.id);
      expect(u.offerId).toBe(OFFER);
      expect(u.brandId).toBe(BRAND);
      expect(u.nextRunAt).toBeNull();
    }
    const births = await db.select().from(campaignStatusTransitions).where(eq(campaignStatusTransitions.orgId, ORG));
    expect(births.map((t) => [t.fromStatus, t.toStatus, t.source])).toEqual([
      [null, "stopped", TRANSITION_SOURCES.SALES_FUNNEL],
      [null, "stopped", TRANSITION_SOURCES.SALES_FUNNEL],
    ]);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("runs and pauses every unit TOGETHER, only at the funnel", async () => {
    const created = await launch({ brandId: BRAND, offerId: OFFER, salesFunnelId: EPIPHANY, status: "stopped" }).expect(201);
    const id = created.body.salesFunnelCampaign.id;

    const on = await patchFunnel(id, "activate").expect(200);
    expect(on.body.salesFunnelCampaign.status).toBe("ongoing");
    let units = await unitsOf(id);
    expect(units.every((u) => u.status === "ongoing" && u.stopReason === null && u.nextRunAt !== null)).toBe(true);

    const off = await patchFunnel(id, "stop").expect(200);
    expect(off.body.salesFunnelCampaign).toMatchObject({ status: "stopped", stopReason: "manual" });
    units = await unitsOf(id);
    expect(units.every((u) => u.status === "stopped" && u.stopReason === "manual")).toBe(true);

    for (const u of units) {
      const ledger = await db.select().from(campaignStatusTransitions).where(eq(campaignStatusTransitions.campaignId, u.id));
      expect(ledger.map((t) => t.toStatus)).toEqual(["stopped", "ongoing", "stopped"]);
    }
  });

  it("a unit's run/pause moves its WHOLE funnel; its identity and delete are refused", async () => {
    const created = await launch({ brandId: BRAND, offerId: OFFER, salesFunnelId: EPIPHANY, status: "stopped" }).expect(201);
    const fcId = created.body.salesFunnelCampaign.id;
    const [first, second] = created.body.salesFunnelCampaign.units.map((u: { campaignId: string }) => u.campaignId);

    // A screen still showing the pipe pauses/runs the funnel: every unit moves.
    const on = await withPerson(request(app).patch(`/campaigns/${first}`))
      .set("x-brand-id", BRAND).set("x-feature-slug", COLD).send({ status: "activate" }).expect(200);
    expect(on.body).toMatchObject({ campaign: { id: first, status: "ongoing" }, salesFunnelCampaignId: fcId });
    expect((await unitsOf(fcId)).map((u) => u.status)).toEqual(["ongoing", "ongoing"]);
    const [fc] = await db.select().from(salesFunnelCampaigns).where(eq(salesFunnelCampaigns.id, fcId));
    expect(fc.status).toBe("ongoing");

    await withPerson(request(app).patch(`/campaigns/${second}`)).send({ status: "stop" }).expect(200);
    expect((await unitsOf(fcId)).map((u) => u.status)).toEqual(["stopped", "stopped"]);

    const refused = await withPerson(request(app).patch(`/campaigns/${first}`)).send({ legKey: "x" }).expect(409);
    expect(refused.body).toMatchObject({ reason: "sales_funnel_unit", salesFunnelCampaignId: fcId });
    await withPerson(request(app).delete(`/campaigns/${first}`)).expect(409);

    // Its own settings are still its own.
    await withPerson(request(app).patch(`/campaigns/${first}`)).send({ clickDestinationUrl: "https://x.test" }).expect(200);
  });

  it("a lead SOURCE unit keeps its own On/Off; a funnel start never restarts a source a person turned off", async () => {
    mockPlan.mockResolvedValue({
      ok: true,
      plan: {
        salesFunnelId: "unused", salesFunnelName: "Epiphany",
        units: [
          { pipeId: "sourcing-apollo-cold-filters|start_to_lead_found", featureSlug: "sourcing-apollo-cold-filters", legKey: "start_to_lead_found", mode: "reactive", workflowSlug: null },
          { pipeId: `${COLD}|${ENTRY}`, featureSlug: COLD, legKey: ENTRY, mode: "proactive", workflowSlug: "aurora-v3" },
        ],
      },
    });
    const created = await launch({ brandId: BRAND, offerId: OFFER, salesFunnelId: EPIPHANY, status: "ongoing" }).expect(201);
    const fcId = created.body.salesFunnelCampaign.id;
    const source = created.body.salesFunnelCampaign.units.find((u: { featureSlug: string }) => u.featureSlug.startsWith("sourcing-")).campaignId;

    // A person turns the source off: it alone stops.
    await withPerson(request(app).patch(`/campaigns/${source}`)).set("x-feature-slug", "sourcing-apollo-cold-filters").send({ status: "stop" }).expect(200);
    let units = await unitsOf(fcId);
    expect(units.find((u) => u.id === source)!.status).toBe("stopped");
    expect(units.find((u) => u.id !== source)!.status).toBe("ongoing");

    // Funnel paused then run again: the source a person turned off stays off.
    await patchFunnel(fcId, "stop").expect(200);
    await patchFunnel(fcId, "activate").expect(200);
    units = await unitsOf(fcId);
    expect(units.find((u) => u.id === source)!.status).toBe("stopped");
    expect(units.find((u) => u.id !== source)!.status).toBe("ongoing");
  });

  it("never creates a funnel campaign twice: hands it back, started only when asked", async () => {
    const first = await launch({ brandId: BRAND, offerId: OFFER, salesFunnelId: EPIPHANY, status: "stopped" }).expect(201);
    const again = await launch({ brandId: BRAND, offerId: OFFER, salesFunnelId: EPIPHANY, status: "stopped" }).expect(200);
    expect(again.body).toMatchObject({ created: false, started: false });
    expect(again.body.salesFunnelCampaign.id).toBe(first.body.salesFunnelCampaign.id);

    const started = await launch({ brandId: BRAND, offerId: OFFER, salesFunnelId: EPIPHANY, status: "ongoing" }).expect(200);
    expect(started.body).toMatchObject({ created: false, started: true });
    expect(started.body.salesFunnelCampaign.units.every((u: { status: string }) => u.status === "ongoing")).toBe(true);
    expect(await db.select().from(salesFunnelCampaigns)).toHaveLength(1);
  });

  it("runs a pipe two funnels share TWICE, once per funnel (uniqueness includes the funnel)", async () => {
    const a = await launch({ brandId: BRAND, offerId: OFFER, salesFunnelId: EPIPHANY, status: "ongoing" }).expect(201);
    mockPlan.mockResolvedValue(planOf("Bliss"));
    const b = await launch({ brandId: BRAND, offerId: OFFER, salesFunnelId: OTHER_FUNNEL, status: "ongoing" }).expect(201);

    const live = await db.select().from(campaigns).where(and(eq(campaigns.orgId, ORG), eq(campaigns.status, "ongoing")));
    expect(live).toHaveLength(4);
    // A funnel start stops nothing: funnel A's proactive unit is still on.
    const aUnits = await unitsOf(a.body.salesFunnelCampaign.id);
    expect(aUnits.every((u) => u.status === "ongoing")).toBe(true);
    expect(b.body.salesFunnelCampaign.units).toHaveLength(2);
  });

  it("a (leg x channel) create never matches, restarts or stops a funnel unit", async () => {
    const fc = await launch({ brandId: BRAND, offerId: OFFER, salesFunnelId: EPIPHANY, status: "stopped" }).expect(201);
    const res = await withPerson(request(app).post("/campaigns"))
      .set("x-brand-id", BRAND)
      .set("x-feature-slug", COLD)
      .send({ name: "pre-funnel", workflowSlug: "aurora-v3", orgId: ORG, brandIds: [BRAND], featureSlug: COLD, offerId: OFFER, legKey: ENTRY })
      .expect(201);
    expect(res.body.campaign.salesFunnelCampaignId).toBeNull();
    const units = await unitsOf(fc.body.salesFunnelCampaign.id);
    expect(units.every((u) => u.status === "stopped")).toBe(true);
  });

  it("an org-wide stop (payment hold) that reaches the units stops the funnel campaign too", async () => {
    const fc = await launch({ brandId: BRAND, offerId: OFFER, salesFunnelId: EPIPHANY, status: "ongoing" }).expect(201);
    await db.transaction((tx) =>
      stopOrgCampaignsWithHistory(tx, ORG, "payment_declined", and(eq(campaigns.orgId, ORG), eq(campaigns.status, "ongoing")), TRANSITION_SOURCES.PAYMENT_HOLD),
    );
    const [row] = await db.select().from(salesFunnelCampaigns).where(eq(salesFunnelCampaigns.id, fc.body.salesFunnelCampaign.id));
    expect(row).toMatchObject({ status: "stopped", stopReason: "payment_declined" });
  });

  it("filters GET /campaigns by sales funnel campaign and lists funnel campaigns with their units", async () => {
    const fc = await launch({ brandId: BRAND, offerId: OFFER, salesFunnelId: EPIPHANY, status: "stopped" }).expect(201);
    const list = await withPerson(request(app).get(`/campaigns?salesFunnelCampaignId=${fc.body.salesFunnelCampaign.id}`)).expect(200);
    expect(list.body.campaigns).toHaveLength(2);
    const funnels = await withPerson(request(app).get(`/sales-funnel-campaigns?brandId=${BRAND}`)).expect(200);
    expect(funnels.body.salesFunnelCampaigns).toHaveLength(1);
    expect(funnels.body.salesFunnelCampaigns[0].units).toHaveLength(2);
    await withPerson(request(app).get(`/sales-funnel-campaigns/${fc.body.salesFunnelCampaign.id}`)).expect(200);
    await withPerson(request(app).get(`/sales-funnel-campaigns/${crypto.randomUUID()}`)).expect(404);
  });

  it("refuses with the plan's own answer and writes nothing", async () => {
    mockPlan.mockResolvedValue({ ok: false, refusal: { status: 400, code: "unknown_sales_funnel", message: "We don't know this sales funnel." } });
    const res = await launch({ brandId: BRAND, offerId: OFFER, salesFunnelId: "nope", status: "stopped" }).expect(400);
    expect(res.body).toEqual({ error: "We don't know this sales funnel.", reason: "unknown_sales_funnel" });
    expect(await db.select().from(salesFunnelCampaigns)).toHaveLength(0);
    // status is required: never defaulted.
    await launch({ brandId: BRAND, offerId: OFFER, salesFunnelId: EPIPHANY }).expect(400);
  });

  describe("two funnels sharing a REACTIVE pipe never act twice on one event", () => {
    const catalogue = {
      ok: true,
      legs: [
        { legKey: ENTRY, fromStepKey: "lead_found", toStepKey: "conversation" },
        { legKey: REACTIVE, fromStepKey: "conversation", toStepKey: "meeting_booked" },
      ],
      legsBySlug: new Map([[COLD, new Set([ENTRY])], [BOOKING, new Set([REACTIVE])]]),
      operatorBySlug: new Map(),
      stepKeys: new Set(["lead_found", "conversation", "meeting_booked"]),
    } as unknown as ChannelCatalogueRead;

    async function twoFunnels() {
      const a = await launch({ brandId: BRAND, offerId: OFFER, salesFunnelId: EPIPHANY, status: "ongoing" }).expect(201);
      mockPlan.mockResolvedValue(planOf("Bliss"));
      const b = await launch({ brandId: BRAND, offerId: OFFER, salesFunnelId: OTHER_FUNNEL, status: "ongoing" }).expect(201);
      const unit = (fc: request.Response, slug: string) =>
        fc.body.salesFunnelCampaign.units.find((u: { featureSlug: string }) => u.featureSlug === slug).campaignId as string;
      return {
        aEntry: unit(a, COLD), aReactive: unit(a, BOOKING),
        bEntry: unit(b, COLD), bReactive: unit(b, BOOKING),
      };
    }

    it("resolves each reactive unit's predecessor inside its OWN funnel", async () => {
      const ids = await twoFunnels();
      const a = await resolvePredecessorCampaign(ids.aReactive, catalogue);
      const b = await resolvePredecessorCampaign(ids.bReactive, catalogue);
      expect(a.predecessor?.campaignId).toBe(ids.aEntry);
      expect(b.predecessor?.campaignId).toBe(ids.bEntry);
    });

    it("a REACTIVE-only funnel's unit answers the people the offer's PROACTIVE funnel found", async () => {
      mockPlan.mockResolvedValue({ ok: true, plan: { salesFunnelId: "u", salesFunnelName: "Proactive", units: [
        { pipeId: `${COLD}|${ENTRY}`, featureSlug: COLD, legKey: ENTRY, mode: "proactive", workflowSlug: "aurora-v3" },
      ] } });
      const p = await launch({ brandId: BRAND, offerId: OFFER, salesFunnelId: EPIPHANY, status: "ongoing" }).expect(201);
      mockPlan.mockResolvedValue({ ok: true, plan: { salesFunnelId: "u", salesFunnelName: "Reactive", units: [
        { pipeId: `${BOOKING}|${REACTIVE}`, featureSlug: BOOKING, legKey: REACTIVE, mode: "reactive", workflowSlug: "booking-v1" },
      ] } });
      const r = await launch({ brandId: BRAND, offerId: OFFER, salesFunnelId: `${REACTIVE}@${BOOKING}+meeting_booked_to_paid_client`, status: "ongoing" }).expect(201);
      const reactiveUnit = r.body.salesFunnelCampaign.units[0].campaignId;
      const answer = await resolvePredecessorCampaign(reactiveUnit, catalogue);
      expect(answer.predecessor?.campaignId).toBe(p.body.salesFunnelCampaign.units[0].campaignId);
    });

    it("dispatches ONE campaign per shared pipe for an event: the oldest; the other is named skipped", async () => {
      const ids = await twoFunnels();
      mockFunnelMoney.mockResolvedValue({ run: true });
      const out = await runCampaignsInScope(
        { orgId: ORG, brandId: BRAND, offerId: OFFER },
        (c) => sameLeg(c.featureSlug, REACTIVE, c.legKey),
        "test event",
      );
      expect(out.triggered.map((t) => t.campaignId)).toEqual([ids.aReactive]);
      expect(out.skipped).toEqual([
        expect.objectContaining({ campaignId: ids.bReactive, reason: STEP_TRIGGER_SKIPS.PIPE_HANDLED_BY_ANOTHER_CAMPAIGN }),
      ]);
      expect(mockExecute).toHaveBeenCalledTimes(1);
    });

    it("holds every unit while billing cannot answer for the funnel's caps (fail-closed)", async () => {
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      const billingUrl = process.env.BILLING_SERVICE_URL;
      delete process.env.BILLING_SERVICE_URL;
      await twoFunnels();
      const out = await runCampaignsInScope(
        { orgId: ORG, brandId: BRAND, offerId: OFFER },
        (c) => sameLeg(c.featureSlug, REACTIVE, c.legKey),
        "test event",
      );
      expect(out.triggered).toEqual([]);
      expect(out.skipped.map((s) => s.reason)).toEqual([STEP_TRIGGER_SKIPS.SALES_FUNNEL_CAP, STEP_TRIGGER_SKIPS.SALES_FUNNEL_CAP]);
      expect(mockExecute).not.toHaveBeenCalled();
      if (billingUrl !== undefined) process.env.BILLING_SERVICE_URL = billingUrl;
      errors.mockRestore();
    });
  });
});
