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
const ORG = "5e1f0000-0000-4000-8000-000000000001";
const BRAND = "5e1f0000-0000-4000-8000-000000000002";
const OFFER = "5e1f0000-0000-4000-8000-000000000003";
const OTHER_OFFER = "5e1f0000-0000-4000-8000-000000000004";
const COLD = "sales-cold-email-outreach";
const MEETING = "ai-meeting-booking";
const signal = vi.mocked(signalMissionStatusChanged);

const CATALOGUE = {
  ok: true as const,
  operatorBySlug: new Map([[COLD, "platform" as const], [MEETING, "platform" as const]]),
  legsBySlug: new Map<string, ReadonlySet<string>>([
    [COLD, new Set(["start_to_conversation", "start_to_website_visit"])],
    [MEETING, new Set(["conversation_to_meeting_booked"])],
  ]),
  legs: [
    { legKey: "start_to_conversation", fromStepKey: null, toStepKey: "conversation" },
    { legKey: "start_to_website_visit", fromStepKey: null, toStepKey: "website_visit" },
    { legKey: "conversation_to_meeting_booked", fromStepKey: "conversation", toStepKey: "meeting_booked" },
  ],
  stepKeys: new Set(["conversation", "website_visit", "meeting_booked"]),
};

const campaign = (legKey: string, status: string, over: Record<string, unknown> = {}) =>
  insertTestCampaign(ORG, {
    status,
    brandIds: [BRAND],
    brandId: BRAND,
    offerId: OFFER,
    legKey,
    featureSlug: legKey.startsWith("start_") ? COLD : MEETING,
    acquisitionChannel: legKey.startsWith("start_") ? "cold_email" : "ai_meeting_booking",
    maxBudgetDailyUsd: undefined,
    ...over,
  });

const activate = (id: string) =>
  request(app)
    .patch(`/campaigns/${id}`)
    .set("x-api-key", API_KEY)
    .set("x-org-id", ORG)
    .set("x-user-id", "user_switch")
    .set("x-run-id", crypto.randomUUID())
    .set("x-brand-id", BRAND)
    .set("x-feature-slug", COLD)
    .send({ status: "activate" });

const statusOf = async (id: string) =>
  (await db.query.campaigns.findFirst({ where: eq(campaigns.id, id) }))!;

describe("ONE proactive campaign ON per offer (owner 2026-10-05)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await cleanTestData();
    mockCatalogue.mockResolvedValue(CATALOGUE);
    mockExecute.mockResolvedValue(undefined);
    // Reactive defaults after a start: nothing ticked, so the switch tests write nothing else.
    mockSelected.mockResolvedValue({ ok: true, value: { stated: true, combinationKeys: [] } });
    mockPaths.mockResolvedValue({ ok: true, value: [] });
  });
  it("turning a proactive campaign ON stops the offer's other ON proactive campaign, as the person's act", async () => {
    const live = await campaign("start_to_conversation", "ongoing");
    const picked = await campaign("start_to_website_visit", "stopped", { stopReason: "manual" });
    const reactive = await campaign("conversation_to_meeting_booked", "ongoing");

    const res = await activate(picked.id).expect(200);

    expect(res.body.campaign.status).toBe("ongoing");
    expect(res.body.stoppedCampaigns).toEqual([
      { id: live.id, name: live.name, featureSlug: COLD, offerId: OFFER, legKey: "start_to_conversation" },
    ]);
    const stopped = await statusOf(live.id);
    expect(stopped.status).toBe("stopped");
    expect(stopped.stopReason).toBe("manual");
    expect(stopped.nextRunAt).toBeNull();
    // A reactive campaign is never stopped by the switch.
    expect((await statusOf(reactive.id)).status).toBe("ongoing");

    const [t] = await db.select().from(campaignStatusTransitions).where(eq(campaignStatusTransitions.campaignId, live.id));
    expect(t).toMatchObject({ fromStatus: "ongoing", toStatus: "stopped", reason: "manual", source: "proactive_switch" });

    // Billing hears the stop with the same person, so the plan money moves to the new one.
    expect(signal).toHaveBeenCalledWith(expect.objectContaining({
      campaignId: live.id, source: "proactive_switch", fromStatus: "ongoing", toStatus: "stopped",
      actor: expect.objectContaining({ userId: "user_switch" }),
    }));
  });

  it("another offer's proactive campaign is never touched", async () => {
    const elsewhere = await campaign("start_to_conversation", "ongoing", { offerId: OTHER_OFFER });
    const picked = await campaign("start_to_website_visit", "stopped");
    const res = await activate(picked.id).expect(200);
    expect(res.body.stoppedCampaigns).toEqual([]);
    expect((await statusOf(elsewhere.id)).status).toBe("ongoing");
  });

  it("turning a REACTIVE campaign on stops nothing", async () => {
    const live = await campaign("start_to_conversation", "ongoing");
    const reactive = await campaign("conversation_to_meeting_booked", "stopped");
    const res = await activate(reactive.id).expect(200);
    expect(res.body.stoppedCampaigns).toEqual([]);
    expect((await statusOf(live.id)).status).toBe("ongoing");
  });

  it("an unreadable catalogue while another campaign is live refuses the start and writes nothing", async () => {
    const live = await campaign("start_to_conversation", "ongoing");
    const picked = await campaign("start_to_website_visit", "stopped", { stopReason: "manual" });
    mockCatalogue.mockResolvedValue({ ok: false, detail: "HTTP 503" });

    const res = await activate(picked.id).expect(502);
    expect(res.body.reason).toBe("catalogue_unavailable");
    expect((await statusOf(picked.id)).status).toBe("stopped");
    expect((await statusOf(live.id)).status).toBe("ongoing");
    expect(await db.select().from(campaignStatusTransitions)).toHaveLength(0);
  });

  it("NO CHANGE for an offer with at most one proactive campaign and no reactive one: no read, no stop", async () => {
    const only = await campaign("start_to_conversation", "stopped", { stopReason: "manual" });
    mockCatalogue.mockClear();

    const res = await activate(only.id).expect(200);
    expect(res.body.campaign.status).toBe("ongoing");
    expect(res.body.stoppedCampaigns).toEqual([]);
    // The rule read nothing, and nothing switches on in the background (reactive defaults retired 2026-10-10).
    expect(mockCatalogue).toHaveBeenCalledTimes(0);
    const rows = await db.query.campaigns.findMany({ where: eq(campaigns.orgId, ORG) });
    expect(rows).toHaveLength(1);
    const transitions = await db.select().from(campaignStatusTransitions);
    expect(transitions.map((t) => t.source)).toEqual(["patch"]);
  });

  it("start-funded-pair creating a new proactive campaign stops the live one", async () => {
    const live = await campaign("start_to_conversation", "ongoing");
    mockResolve.mockResolvedValue({ ok: true, pair: { legKey: "start_to_website_visit", ceilingCents: 2500, workflowSlug: "aurora-v3" } });

    const res = await request(app)
      .post("/campaigns/start-funded-pair")
      .set("x-api-key", API_KEY)
      .set("x-org-id", ORG)
      .set("x-user-id", "user_switch")
      .set("x-run-id", crypto.randomUUID())
      .send({ brandId: BRAND, offerId: OFFER, legKey: "start_to_website_visit", featureSlug: COLD })
      .expect(201);

    expect(res.body.started).toBe(true);
    expect(res.body.stoppedCampaigns.map((c: { id: string }) => c.id)).toEqual([live.id]);
    expect((await statusOf(live.id)).status).toBe("stopped");
  });

  it("start-funded-pair on an ALREADY running proactive campaign still stops the other one (the person said: this one)", async () => {
    const other = await campaign("start_to_conversation", "ongoing");
    const picked = await campaign("start_to_website_visit", "ongoing");
    mockResolve.mockResolvedValue({ ok: true, pair: { legKey: "start_to_website_visit", ceilingCents: 2500, workflowSlug: "aurora-v3" } });

    const res = await request(app)
      .post("/campaigns/start-funded-pair")
      .set("x-api-key", API_KEY)
      .set("x-org-id", ORG)
      .set("x-user-id", "user_switch")
      .set("x-run-id", crypto.randomUUID())
      .send({ brandId: BRAND, offerId: OFFER, legKey: "start_to_website_visit", featureSlug: COLD })
      .expect(200);

    expect(res.body.alreadyRunning).toBe(true);
    expect(res.body.campaign.id).toBe(picked.id);
    expect(res.body.stoppedCampaigns.map((c: { id: string }) => c.id)).toEqual([other.id]);
    expect((await statusOf(other.id)).status).toBe("stopped");
  });

  it("POST /campaigns restarting a stopped proactive campaign stops the live one", async () => {
    const live = await campaign("start_to_conversation", "ongoing");
    const picked = await campaign("start_to_website_visit", "stopped", { stopReason: "manual" });

    const res = await request(app)
      .post("/campaigns")
      .set("x-api-key", API_KEY)
      .set("x-org-id", ORG)
      .set("x-user-id", "user_switch")
      .set("x-run-id", crypto.randomUUID())
      .set("x-brand-id", BRAND)
      .set("x-feature-slug", COLD)
      .send({ name: "x", workflowSlug: "aurora-v3", orgId: ORG, brandIds: [BRAND], offerId: OFFER, legKey: "start_to_website_visit" })
      .expect(200);

    expect(res.body.campaign.id).toBe(picked.id);
    expect(res.body.stoppedCampaigns.map((c: { id: string }) => c.id)).toEqual([live.id]);
  });

  it("two people turning on two proactive campaigns at once end with exactly one ON", async () => {
    const a = await campaign("start_to_conversation", "stopped");
    const b = await campaign("start_to_website_visit", "stopped");
    await Promise.all([activate(a.id).expect(200), activate(b.id).expect(200)]);
    const live = await db.query.campaigns.findMany({
      where: and(eq(campaigns.orgId, ORG), eq(campaigns.status, "ongoing")),
    });
    expect(live).toHaveLength(1);
  });

  it("stopping a proactive campaign stops nothing else and states no stoppedCampaigns", async () => {
    const a = await campaign("start_to_conversation", "ongoing");
    const b = await campaign("start_to_website_visit", "ongoing");
    const res = await request(app)
      .patch(`/campaigns/${a.id}`)
      .set("x-api-key", API_KEY)
      .set("x-org-id", ORG)
      .set("x-user-id", "user_switch")
      .send({ status: "stop" })
      .expect(200);
    expect(res.body).not.toHaveProperty("stoppedCampaigns");
    expect((await statusOf(b.id)).status).toBe("ongoing");
  });
});

describe("reactive defaults are retired (owner 2026-10-10: a campaign IS a sales funnel)", () => {
  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });
  it("POST /offers/:offerId/reactive-defaults no longer exists", async () => {
    await request(app)
      .post(`/offers/${OFFER}/reactive-defaults`)
      .set("x-api-key", API_KEY)
      .set("x-org-id", ORG)
      .set("x-user-id", "user_paths")
      .set("x-run-id", crypto.randomUUID())
      .send({ brandId: BRAND })
      .expect(404);
  });
});
