import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";

const { mockCatalogue, mockExecute, mockResolve, mockSelected, mockPaths, mockWorkflow } = vi.hoisted(() => ({
  mockCatalogue: vi.fn(),
  mockExecute: vi.fn(),
  mockResolve: vi.fn(),
  mockSelected: vi.fn(),
  mockPaths: vi.fn(),
  mockWorkflow: vi.fn(),
}));

vi.mock("@distribute/runs-client", () => ({
  createRun: vi.fn(),
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
vi.mock("../../src/lib/channel-operator-client.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/lib/channel-operator-client.js")>();
  return { ...original, fetchChannelCatalogue: mockCatalogue };
});
vi.mock("../../src/lib/mission-status-notification.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/lib/mission-status-notification.js")>();
  return { ...original, signalMissionStatusChanged: vi.fn(async () => undefined) };
});
vi.mock("../../src/lib/startable-pair.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/lib/startable-pair.js")>();
  return { ...original, resolveStartablePair: mockResolve };
});
vi.mock("../../src/lib/startable-workflow-client.js", () => ({ fetchStartableWorkflowSlug: mockWorkflow }));

import app from "../../src/index.js";
import { cleanTestData, closeDb, insertTestCampaign } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { campaigns, campaignStatusTransitions } from "../../src/db/schema.js";
import { and, eq } from "drizzle-orm";
import { signalMissionStatusChanged } from "../../src/lib/mission-status-notification.js";

const API_KEY = process.env.CAMPAIGN_SERVICE_API_KEY || "test-api-key";
const ORG = "a1c00000-0000-4000-8000-000000000001";
const BRAND = "a1c00000-0000-4000-8000-000000000002";
const OFFER = "a1c00000-0000-4000-8000-000000000003";
const COLD = "sales-cold-email-outreach";
const AIC = "ai-instant-call";
const AIC_LEG = "conversation_to_booking_call";

const CATALOGUE = {
  ok: true as const,
  operatorBySlug: new Map([[COLD, "platform" as const], [AIC, "platform" as const]]),
  legsBySlug: new Map<string, ReadonlySet<string>>([
    [COLD, new Set(["start_to_conversation"])],
    [AIC, new Set([AIC_LEG])],
  ]),
  legs: [
    { legKey: "start_to_conversation", fromStepKey: null, toStepKey: "conversation" },
    { legKey: AIC_LEG, fromStepKey: "conversation", toStepKey: "booking_call" },
  ],
  stepKeys: new Set(["conversation", "booking_call"]),
};

const headers = (r: request.Test, feature: string) =>
  r.set("x-api-key", API_KEY)
    .set("x-org-id", ORG)
    .set("x-user-id", "user_aic")
    .set("x-run-id", crypto.randomUUID())
    .set("x-brand-id", BRAND)
    .set("x-feature-slug", feature);

const createAic = (over: Record<string, unknown> = {}) =>
  headers(request(app).post("/campaigns"), AIC).send({
    name: "AI Instant Call",
    orgId: ORG,
    brandIds: [BRAND],
    offerId: OFFER,
    legKey: AIC_LEG,
    workflowSlug: "ai-instant-call-belenos",
    ...over,
  });

const patchStatus = (id: string, status: "activate" | "stop") =>
  headers(request(app).patch(`/campaigns/${id}`), AIC).send({ status });

const rowOf = async (id: string) => (await db.query.campaigns.findFirst({ where: eq(campaigns.id, id) }))!;

describe("AI Instant Call: its pipe's workflow places the call, like every channel (AIC-COMMON-1015)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await cleanTestData();
    mockCatalogue.mockResolvedValue(CATALOGUE);
    mockExecute.mockResolvedValue(undefined);
    mockSelected.mockResolvedValue({ ok: true, value: { stated: true, combinationKeys: [] } });
    mockPaths.mockResolvedValue({ ok: true, value: [] });
  });

  it("is created ON with its workflow, stored and dispatched like any channel", async () => {
    const created = await createAic().expect(201);
    const id = created.body.campaign.id as string;
    expect(created.body.campaign).toMatchObject({
      status: "ongoing", featureSlug: AIC, legKey: AIC_LEG, offerId: OFFER,
      workflowSlug: "ai-instant-call-belenos", acquisitionChannel: "ai_instant_call",
    });

    const stopped = await patchStatus(id, "stop").expect(200);
    expect(stopped.body.campaign.status).toBe("stopped");
    const restarted = await patchStatus(id, "activate").expect(200);
    expect(restarted.body.campaign.status).toBe("ongoing");
  });

  it("refuses a create that states no workflow, like every channel", async () => {
    const res = await createAic({ workflowSlug: undefined }).expect(400);
    expect(res.body.reason).toBe("workflow_required");
    expect(await db.query.campaigns.findMany({ where: eq(campaigns.orgId, ORG) })).toHaveLength(0);
  });

  it("every other channel still must state a workflow", async () => {
    const res = await headers(request(app).post("/campaigns"), COLD).send({
      name: "Cold", orgId: ORG, brandIds: [BRAND], offerId: OFFER, legKey: "start_to_conversation",
    }).expect(400);
    expect(res.body.reason).toBe("workflow_required");
  });

  it("turning it on does not stop the offer's running proactive campaign", async () => {
    const proactive = await insertTestCampaign(ORG, {
      status: "ongoing", brandIds: [BRAND], brandId: BRAND, offerId: OFFER,
      legKey: "start_to_conversation", featureSlug: COLD, acquisitionChannel: "cold_email",
      maxBudgetDailyUsd: undefined,
    });
    const res = await createAic().expect(201);
    expect(res.body.stoppedCampaigns).toEqual([]);
    expect((await rowOf(proactive.id)).status).toBe("ongoing");
  });

  it("the on/off read: GET /campaigns by (brand, offer, channel, leg) names the campaign and its status", async () => {
    const id = (await createAic().expect(201)).body.campaign.id as string;
    const read = () =>
      request(app)
        .get("/campaigns")
        .query({ brandId: BRAND, offerId: OFFER, featureSlug: AIC, legKey: AIC_LEG })
        .set("x-api-key", API_KEY)
        .set("x-org-id", ORG);

    const on = await read().expect(200);
    expect(on.body.campaigns.map((c: { id: string; status: string }) => [c.id, c.status])).toEqual([[id, "ongoing"]]);

    const stop = await patchStatus(id, "stop");
    expect(stop.status, JSON.stringify(stop.body)).toBe(200);
    const off = await read().query({ status: "ongoing" }).expect(200);
    expect(off.body.campaigns).toEqual([]);
  });
});

afterAll(async () => {
  await cleanTestData();
  await closeDb();
});
