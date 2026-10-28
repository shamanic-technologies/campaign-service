import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";

const { mockPlan, mockCatalogue, mockFunnel } = vi.hoisted(() => ({
  mockPlan: vi.fn(),
  mockCatalogue: vi.fn(),
  mockFunnel: vi.fn(),
}));

vi.mock("@distribute/runs-client", () => ({
  createRun: vi.fn(async () => ({ id: crypto.randomUUID() })),
  updateRun: vi.fn(),
  listRuns: vi.fn(async () => ({ runs: [] })),
  getStatsBudget: vi.fn(),
}));

vi.mock("../../src/lib/startable-pair.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/lib/startable-pair.js")>();
  return { ...original, resolveSalesFunnelPlan: mockPlan };
});

vi.mock("../../src/lib/channel-operator-client.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/lib/channel-operator-client.js")>();
  return { ...original, fetchChannelCatalogue: mockCatalogue };
});

vi.mock("../../src/lib/sales-funnel-catalogue-client.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/lib/sales-funnel-catalogue-client.js")>();
  return { ...original, fetchSalesFunnel: mockFunnel };
});

import app from "../../src/index.js";
import { cleanTestData, closeDb, insertTestCampaign } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { salesFunnelCampaigns } from "../../src/db/schema.js";
import { salesFunnelShapeOf } from "../../src/lib/sales-funnel-target.js";

const API_KEY = process.env.CAMPAIGN_SERVICE_API_KEY || "test-api-key";
const ORG = "b645207b-0000-4000-8000-0000000000a1";
const BRAND = "75d7e3e8-0000-4000-8000-0000000000a2";
const OFFER = "231bb036-0000-4000-8000-0000000000a3";
const COLD = "sales-cold-email-outreach";
const ENTRY = "lead_found_to_conversation";
const FUNNEL = `${ENTRY}@${COLD}+conversation_to_paid_client`;

const LEGS = [
  { legKey: ENTRY, fromStepKey: "lead_found", toStepKey: "conversation" },
  { legKey: "conversation_to_paid_client", fromStepKey: "conversation", toStepKey: "paid_client" },
  { legKey: "conversation_to_meeting_booked", fromStepKey: "conversation", toStepKey: "meeting_booked" },
];
const CATALOGUE = {
  ok: true,
  operatorBySlug: new Map(),
  legsBySlug: new Map(),
  legs: LEGS,
  stepKeys: new Set(["lead_found", "conversation", "meeting_booked", "paid_client"]),
};

const withPerson = (r: request.Test, user = "user_target") =>
  r.set("x-api-key", API_KEY).set("x-org-id", ORG).set("x-user-id", user).set("x-run-id", crypto.randomUUID());
const launch = (body: Record<string, unknown>) =>
  withPerson(request(app).post("/sales-funnel-campaigns")).send({ brandId: BRAND, offerId: OFFER, salesFunnelId: FUNNEL, status: "stopped", ...body });
const patch = (id: string, body: Record<string, unknown>, user?: string) =>
  withPerson(request(app).patch(`/sales-funnel-campaigns/${id}`), user).send(body);

function plan(shape: unknown = { target: "paid_client", reason: null, mode: "proactive", triggerId: null }) {
  return {
    ok: true,
    plan: {
      salesFunnelId: FUNNEL,
      salesFunnelName: "Epiphany",
      units: [{ pipeId: `${COLD}|${ENTRY}`, featureSlug: COLD, legKey: ENTRY, mode: "proactive", workflowSlug: "aurora-v3" }],
      ...(shape ? { shape } : {}),
    },
  };
}

describe("funnel campaign target + brief (FACTORY-P1-CAMPAIGN-TARGET-BRIEF)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await cleanTestData();
    mockPlan.mockResolvedValue(plan());
    mockCatalogue.mockResolvedValue(CATALOGUE);
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("is born targeting its funnel's last step, with its mode, and no brief", async () => {
    const res = await launch({}).expect(201);
    expect(res.body.salesFunnelCampaign).toMatchObject({
      target: "paid_client",
      mode: "proactive",
      triggerId: null,
      brief: null,
      briefUpdatedAt: null,
      briefUpdatedByUserId: null,
      instruction: null,
    });
    expect(mockCatalogue).not.toHaveBeenCalled();
  });

  it("is born with a stated target and brief (dated, attributed), distinct from its instruction", async () => {
    const res = await launch({ target: "meeting_booked", brief: "Cold email only, never write to someone who asked to stop.", instruction: "Be short." }).expect(201);
    const fc = res.body.salesFunnelCampaign;
    expect(fc).toMatchObject({
      target: "meeting_booked",
      brief: "Cold email only, never write to someone who asked to stop.",
      briefUpdatedByUserId: "user_target",
      instruction: "Be short.",
    });
    expect(Date.parse(fc.briefUpdatedAt)).toBeGreaterThan(Date.now() - 60_000);
  });

  it("refuses a target that is not a catalogue step (400 unknown_target_step), nothing written", async () => {
    const res = await launch({ target: "world_peace" }).expect(400);
    expect(res.body).toMatchObject({ reason: "unknown_target_step", target: "world_peace" });
    expect(await db.select().from(salesFunnelCampaigns)).toHaveLength(0);
  });

  it("502 catalogue_unavailable when the steps cannot be read", async () => {
    mockCatalogue.mockResolvedValue({ ok: false, detail: "down" });
    const res = await launch({ target: "paid_client" }).expect(502);
    expect(res.body.reason).toBe("catalogue_unavailable");
  });

  it("PATCH sets the brief alone (dated + attributed) and keeps instruction, target and status", async () => {
    const born = (await launch({ instruction: "Be short." }).expect(201)).body.salesFunnelCampaign;
    const res = await patch(born.id, { brief: "Test for 30 days." }, "user_editor").expect(200);
    expect(res.body.salesFunnelCampaign).toMatchObject({
      brief: "Test for 30 days.",
      briefUpdatedByUserId: "user_editor",
      instruction: "Be short.",
      target: "paid_client",
      status: "stopped",
    });
    // Same brief again = not an edit: the date does not move.
    const again = await patch(born.id, { brief: "Test for 30 days." }, "someone_else").expect(200);
    expect(again.body.salesFunnelCampaign.briefUpdatedAt).toBe(res.body.salesFunnelCampaign.briefUpdatedAt);
    expect(again.body.salesFunnelCampaign.briefUpdatedByUserId).toBe("user_editor");
    // null clears it (and is an edit).
    const cleared = await patch(born.id, { brief: null }).expect(200);
    expect(cleared.body.salesFunnelCampaign).toMatchObject({ brief: null, briefUpdatedByUserId: "user_target", instruction: "Be short." });
  });

  it("PATCH restates the target, refuses an unknown one, and GET reads both back", async () => {
    const born = (await launch({}).expect(201)).body.salesFunnelCampaign;
    await patch(born.id, { target: "meeting_booked", brief: "Meetings only." }).expect(200);
    const refused = await patch(born.id, { target: "nope" }).expect(400);
    expect(refused.body.reason).toBe("unknown_target_step");
    const read = await withPerson(request(app).get(`/sales-funnel-campaigns/${born.id}`)).expect(200);
    expect(read.body.salesFunnelCampaign).toMatchObject({ target: "meeting_booked", brief: "Meetings only.", mode: "proactive" });
    const list = await withPerson(request(app).get(`/sales-funnel-campaigns?brandId=${BRAND}`)).expect(200);
    expect(list.body.salesFunnelCampaigns[0]).toMatchObject({ target: "meeting_booked", brief: "Meetings only." });
  });

  it("a hand-back applies a stated brief/target and leaves the rest", async () => {
    await launch({ instruction: "Be short." }).expect(201);
    const back = await launch({ brief: "Never on Sundays." }).expect(200);
    expect(back.body).toMatchObject({ created: false });
    expect(back.body.salesFunnelCampaign).toMatchObject({ brief: "Never on Sundays.", instruction: "Be short.", target: "paid_client" });
  });

  it("backfill fills every row missing a target from its funnel's last step, never overwrites a stated one", async () => {
    const reactive = "trigger:lead_event+start_to_paid_client@ai-follow-up-email";
    const now = new Date();
    const base = { orgId: ORG, brandId: BRAND, offerId: OFFER, status: "stopped", createdAt: now, updatedAt: now };
    await db.insert(salesFunnelCampaigns).values([
      { ...base, id: crypto.randomUUID(), salesFunnelId: FUNNEL, salesFunnelName: "A" },
      { ...base, id: crypto.randomUUID(), salesFunnelId: reactive, salesFunnelName: "B", peopleKey: "x" },
      { ...base, id: crypto.randomUUID(), salesFunnelId: "retired-funnel", salesFunnelName: "C", peopleKey: "y" },
      { ...base, id: crypto.randomUUID(), salesFunnelId: FUNNEL, salesFunnelName: "D", peopleKey: "z", target: "meeting_booked" },
    ]);
    // A retired funnel whose campaign still has its units: read from them.
    const eId = crypto.randomUUID();
    await db.insert(salesFunnelCampaigns).values({ ...base, id: eId, salesFunnelId: "retired-2", salesFunnelName: "E" });
    await insertTestCampaign(ORG, { name: "E unit", featureSlug: "ai-follow-up-email", legKey: "conversation_to_paid_client", salesFunnelCampaignId: eId, salesFunnelId: "retired-2", runsOnTriggerId: "signup_not_paid" });
    LEGS.push({ legKey: "start_to_paid_client", fromStepKey: null as never, toStepKey: "paid_client" });
    mockFunnel.mockImplementation(async (id: string) => {
      if (id === FUNNEL) {
        return { ok: true, value: { id, name: "A", triggerId: null, pipeIds: [], legs: [
          { legKey: ENTRY, pipe: { id: `${COLD}|${ENTRY}`, mode: "proactive" }, channelIds: [COLD] },
          { legKey: "conversation_to_paid_client", pipe: null, channelIds: ["your-team"] },
        ] } };
      }
      if (id === reactive) {
        return { ok: true, value: { id, name: "B", triggerId: "lead_event", pipeIds: [], legs: [
          { legKey: "start_to_paid_client", pipe: { id: "ai-follow-up-email|start_to_paid_client", mode: "proactive" }, channelIds: [] },
        ] } };
      }
      return { ok: false, notFound: true, detail: "404" };
    });

    const dry = await request(app).post("/internal/sales-funnel-campaigns/target-backfill").set("x-api-key", API_KEY).send({}).expect(200);
    expect(dry.body).toMatchObject({ apply: false, scanned: 5, byTarget: { paid_client: 3, meeting_booked: 1, null: 1 } });
    expect(dry.body.fromUnits).toEqual([{ salesFunnelCampaignId: eId, salesFunnelId: "retired-2", target: "paid_client" }]);
    expect(dry.body.failures).toEqual([expect.objectContaining({ salesFunnelId: "retired-funnel", reason: "funnel_retired" })]);
    expect((await db.select().from(salesFunnelCampaigns)).filter((r) => r.mode !== null)).toHaveLength(0);

    const applied = await request(app).post("/internal/sales-funnel-campaigns/target-backfill").set("x-api-key", API_KEY).send({ apply: true }).expect(200);
    expect(applied.body.byTarget).toEqual({ paid_client: 3, meeting_booked: 1, null: 1 });
    const rows = await db.select().from(salesFunnelCampaigns);
    const byName = Object.fromEntries(rows.map((r) => [r.salesFunnelName, r]));
    expect(byName.A).toMatchObject({ target: "paid_client", mode: "proactive", triggerId: null });
    expect(byName.B).toMatchObject({ target: "paid_client", mode: "reactive", triggerId: "lead_event" });
    expect(byName.C).toMatchObject({ target: null, mode: null });
    expect(byName.D).toMatchObject({ target: "meeting_booked", mode: "proactive" });
    expect(byName.E).toMatchObject({ target: "paid_client", mode: "reactive", triggerId: "signup_not_paid" });

    // Idempotent: only the retired one is left.
    const again = await request(app).post("/internal/sales-funnel-campaigns/target-backfill").set("x-api-key", API_KEY).send({ apply: true }).expect(200);
    expect(again.body).toMatchObject({ scanned: 1, failures: [expect.objectContaining({ reason: "funnel_retired" })] });
    LEGS.pop();
  });
});

describe("salesFunnelShapeOf", () => {
  it("target = the last leg's toStep, mode from the head trigger else the head pipe", () => {
    expect(salesFunnelShapeOf({ triggerId: null, legs: [{ legKey: ENTRY, pipe: { id: "p", mode: "proactive" }, channelIds: [] }] }, LEGS))
      .toEqual({ target: "conversation", reason: null, mode: "proactive", triggerId: null });
    expect(salesFunnelShapeOf({ triggerId: null, legs: [{ legKey: "x", pipe: { id: "p", mode: "reactive" }, channelIds: [] }] }, LEGS))
      .toEqual({ target: null, reason: "last_leg_unpublished", mode: "reactive", triggerId: null });
    expect(salesFunnelShapeOf({ triggerId: "t", legs: [] }, LEGS)).toEqual({ target: null, reason: "funnel_has_no_legs", mode: "reactive", triggerId: "t" });
  });
});
