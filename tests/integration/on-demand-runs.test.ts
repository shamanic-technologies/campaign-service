import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";

const { mockCreateRun } = vi.hoisted(() => ({ mockCreateRun: vi.fn() }));

vi.mock("@distribute/runs-client", () => ({
  createRun: mockCreateRun,
  updateRun: vi.fn(),
  listRuns: vi.fn().mockResolvedValue({ runs: [] }),
  getStatsBudget: vi.fn().mockResolvedValue({ windows: [] }),
}));

import app from "../../src/index.js";
import { db } from "../../src/db/index.js";
import { campaigns, triggerEvents } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import { cleanTestData, closeDb, insertTestCampaign } from "../helpers/test-db.js";

const API_KEY = process.env.CAMPAIGN_SERVICE_API_KEY || "test-api-key";
const ORG = "b645207b-0000-4000-8000-0000000000a1";
const OTHER_ORG = "b645207b-0000-4000-8000-0000000000a9";
const BRAND = "75d7e3e8-0000-4000-8000-0000000000a2";
const OFFER = "231bb036-0000-4000-8000-0000000000a3";
const USER = "7a3b1c22-0000-4000-8000-0000000000a4";
const CALLER_RUN = "9f0d1c22-0000-4000-8000-0000000000a5";

const unit = async (over: Record<string, unknown> = {}) => {
  const c = await insertTestCampaign(ORG, {
    brandIds: [BRAND],
    brandId: BRAND,
    status: "ongoing",
    featureSlug: "lead-sourcing",
    workflowSlug: "lead-sourcing-scheat",
    createdByUserId: USER,
    offerId: OFFER,
    legKey: "start_to_lead_found",
    ...over,
  });
  // The helper defaults a workflow; a unit stating none is written as such.
  if (over.workflowSlug === null) await db.update(campaigns).set({ workflowSlug: null }).where(eq(campaigns.id, c.id));
  return c;
};

const open = (body: Record<string, unknown>, org = ORG) =>
  request(app)
    .post("/internal/on-demand-runs")
    .set("x-api-key", API_KEY)
    .set("x-org-id", org)
    .set("x-user-id", USER)
    .set("x-run-id", CALLER_RUN)
    .send(body);

afterAll(async () => {
  await cleanTestData();
  await closeDb();
});

describe("on-demand runs (owner 2026-10-11: a sourcing pipe runs only when the cold email pipe asks)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await cleanTestData();
    mockCreateRun.mockResolvedValue({ id: "11111111-0000-4000-8000-0000000000b1" });
  });

  it("opens ONE root run of the unit: its campaign, brand, channel and workflow, never the asking run as parent", async () => {
    const c = await unit();
    const res = await open({ campaignId: c.id, audienceId: "aud-1" });
    expect(res.body).toMatchObject({ campaignId: c.id });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      runId: "11111111-0000-4000-8000-0000000000b1",
      campaignId: c.id,
      featureSlug: "lead-sourcing",
      workflowSlug: "lead-sourcing-scheat",
      brandIds: [BRAND],
    });
    expect(mockCreateRun).toHaveBeenCalledTimes(1);
    const args = mockCreateRun.mock.calls[0][0];
    expect(args).toMatchObject({
      orgId: ORG,
      serviceName: "campaign-service",
      taskName: c.id,
      campaignId: c.id,
      brandId: BRAND,
      userId: USER,
      workflowSlug: "lead-sourcing-scheat",
      featureSlug: "lead-sourcing",
      audienceId: "aud-1",
    });
    expect(args.parentRunId).toBeUndefined();
    // Opening a run is not an event: the performer records it when the ask is answered.
    expect(await db.select().from(triggerEvents)).toEqual([]);
  });

  it("refuses, opening nothing: another org's unit, a scheduled pipe, an off unit, a unit carrying no workflow", async () => {
    const c = await unit();
    expect((await open({ campaignId: c.id }, OTHER_ORG)).body.reason).toBe("unknown_campaign");

    const cold = await unit({ featureSlug: "sales-cold-email-outreach", legKey: "start_to_conversation", workflowSlug: "keel" });
    const notOnDemand = await open({ campaignId: cold.id });
    expect([notOnDemand.status, notOnDemand.body.reason]).toEqual([409, "not_on_demand"]);

    const off = await unit({ status: "stopped" });
    const offRes = await open({ campaignId: off.id });
    expect([offRes.status, offRes.body.reason]).toEqual([409, "campaign_off"]);

    const bare = await unit({ workflowSlug: null, offerId: "231bb036-0000-4000-8000-0000000000a8" });
    const bareRes = await open({ campaignId: bare.id });
    expect([bareRes.status, bareRes.body.reason]).toEqual([409, "no_workflow"]);

    expect(mockCreateRun).not.toHaveBeenCalled();
  });

  it("asks for the asking run's identity", async () => {
    const c = await unit();
    const res = await request(app).post("/internal/on-demand-runs").set("x-api-key", API_KEY).set("x-org-id", ORG).send({ campaignId: c.id });
    expect(res.status).toBe(400);
  });
});

describe("GET /internal/trigger-events/ran-counts (fleet: leads each sourcing unit found)", () => {
  beforeEach(async () => {
    await cleanTestData();
  });

  it("counts, per campaign, the events of ONE trigger that ran it, every org", async () => {
    const at = (iso: string) => new Date(iso);
    const base = { brandId: BRAND, offerId: OFFER, recordedVia: "trigger_events", status: "done", performedByCaller: true };
    await db.insert(triggerEvents).values([
      { ...base, id: "e1", orgId: ORG, triggerId: "on_demand", outcome: "ran", ranCampaignIds: ["u1"], occurredAt: at("2026-10-11T10:00:00Z"), dueAt: at("2026-10-11T10:00:00Z") },
      { ...base, id: "e2", orgId: OTHER_ORG, triggerId: "on_demand", outcome: "ran", ranCampaignIds: ["u1"], occurredAt: at("2026-10-11T12:00:00Z"), dueAt: at("2026-10-11T12:00:00Z") },
      { ...base, id: "e3", orgId: ORG, triggerId: "on_demand", outcome: "ran", ranCampaignIds: ["u2"], occurredAt: at("2026-10-11T11:00:00Z"), dueAt: at("2026-10-11T11:00:00Z") },
      { ...base, id: "e4", orgId: ORG, triggerId: "on_demand", outcome: "skipped", skipReason: "sources_off", ranCampaignIds: [], occurredAt: at("2026-10-11T09:00:00Z"), dueAt: at("2026-10-11T09:00:00Z") },
      { ...base, id: "e5", orgId: ORG, triggerId: "lead_requested", outcome: "ran", ranCampaignIds: ["u1"], occurredAt: at("2026-10-10T09:00:00Z"), dueAt: at("2026-10-10T09:00:00Z") },
    ]);
    const res = await request(app).get("/internal/trigger-events/ran-counts?triggerId=on_demand").set("x-api-key", API_KEY);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      triggerId: "on_demand",
      recordedSince: "2026-10-11T09:00:00.000Z",
      counts: [
        { campaignId: "u1", ran: 2, firstAt: "2026-10-11T10:00:00.000Z", lastAt: "2026-10-11T12:00:00.000Z" },
        { campaignId: "u2", ran: 1, firstAt: "2026-10-11T11:00:00.000Z", lastAt: "2026-10-11T11:00:00.000Z" },
      ],
    });
  });
});
