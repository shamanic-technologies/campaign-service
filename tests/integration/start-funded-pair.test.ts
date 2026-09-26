import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";

const { mockExecute, mockResolve } = vi.hoisted(() => ({
  mockExecute: vi.fn(),
  mockResolve: vi.fn(),
}));

vi.mock("@distribute/runs-client", () => ({
  createRun: vi.fn(),
  updateRun: vi.fn(),
  listRuns: vi.fn(async () => ({ runs: [] })),
  getStatsBudget: vi.fn(),
}));

// Every person-started run is SELECTED (see dispatchSelectedRun); resolve to the configured slug
// so these route tests make no features-service call.
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
  return { ...original, resolveStartablePair: mockResolve };
});

import app from "../../src/index.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { campaigns, campaignStatusTransitions } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";

const API_KEY = process.env.CAMPAIGN_SERVICE_API_KEY || "test-api-key";
const ORG = "b645207b-0000-4000-8000-000000000011";
const BRAND = "75d7e3e8-0000-4000-8000-000000000012";
const OFFER = "231bb036-0000-4000-8000-000000000013";
const CHANNEL = "sales-cold-email-outreach";
const LEG = "start_to_conversation";

const post = (body: Record<string, unknown>, headers: Record<string, string> = {}) => {
  const req = request(app)
    .post("/campaigns/start-funded-pair")
    .set("x-api-key", API_KEY)
    .set("x-org-id", ORG)
    .set("x-user-id", "user_start_test")
    .set("x-run-id", crypto.randomUUID());
  for (const [k, v] of Object.entries(headers)) req.set(k, v);
  return req.send(body);
};

const body = { brandId: BRAND, offerId: OFFER, legKey: LEG, featureSlug: CHANNEL };

/**
 * A customer funds an acquisition channel and expects it to start working. Money still starts
 * nothing on its own — these assert the other half: a PERSON can say "start it", they never get a
 * second campaign for a pair that has one, and a pair that cannot be started is told why in a
 * sentence a dashboard can render as-is.
 */
describe("POST /campaigns/start-funded-pair", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await cleanTestData();
    mockResolve.mockResolvedValue({
      ok: true,
      pair: { legKey: LEG, ceilingCents: 2500, workflowSlug: "aurora-v3" },
    });
    mockExecute.mockResolvedValue(undefined);
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("starts the campaign for a funded pair without a workflow, a name or a budget", async () => {
    const res = await post(body).expect(201);

    expect(res.body.started).toBe(true);
    expect(res.body.alreadyRunning).toBe(false);
    expect(res.body.ceilingCents).toBe(2500);

    const campaign = res.body.campaign;
    expect(campaign.status).toBe("ongoing");
    expect(campaign).not.toHaveProperty("funnelKey");
    expect(campaign.offerId).toBe(OFFER);
    expect(campaign.legKey).toBe(LEG);
    expect(campaign.featureSlug).toBe(CHANNEL);
    // Chosen HERE, never by the caller.
    expect(campaign.workflowSlug).toBe("aurora-v3");
    expect(campaign.name).toContain(LEG);
    // The money is billing's. No per-campaign ceiling is ever written by this route.
    expect(campaign.dailyBudgetCents).toBeNull();
    expect(campaign.maxBudgetDailyUsd).toBeNull();

    // Its birth is on the ledger, and its first run was dispatched.
    const transitions = await db.query.campaignStatusTransitions.findMany({
      where: eq(campaignStatusTransitions.campaignId, campaign.id),
    });
    expect(transitions).toHaveLength(1);
    expect(transitions[0]!.toStatus).toBe("ongoing");
    expect(mockExecute).toHaveBeenCalledWith("aurora-v3", expect.objectContaining({ campaignId: campaign.id }));
  });

  it("does not create a second campaign for a pair that already has a live one", async () => {
    const first = await post(body).expect(201);
    const second = await post(body).expect(200);

    expect(second.body.campaign.id).toBe(first.body.campaign.id);
    expect(second.body.started).toBe(false);
    expect(second.body.alreadyRunning).toBe(true);

    const rows = await db.query.campaigns.findMany({ where: eq(campaigns.orgId, ORG) });
    expect(rows).toHaveLength(1);
  });

  it("starts the campaign the customer had STOPPED rather than twinning it", async () => {
    const first = await post(body).expect(201);
    const id = first.body.campaign.id;

    await request(app)
      .patch(`/campaigns/${id}`)
      .set("x-api-key", API_KEY)
      .set("x-org-id", ORG)
      .set("x-user-id", "user_start_test")
      .send({ status: "stop" })
      .expect(200);

    const restarted = await post(body).expect(200);
    expect(restarted.body.campaign.id).toBe(id);
    expect(restarted.body.campaign.status).toBe("ongoing");
    expect(restarted.body.started).toBe(true);

    const rows = await db.query.campaigns.findMany({ where: eq(campaigns.orgId, ORG) });
    expect(rows).toHaveLength(1);

    // The ledger says which surface the person acted on.
    const transitions = await db.query.campaignStatusTransitions.findMany({
      where: eq(campaignStatusTransitions.campaignId, id),
    });
    expect(transitions.map((t) => t.source)).toContain("start_funded_pair");
  });

  it("renders a refusal a person can read, with a code a consumer can branch on", async () => {
    mockResolve.mockResolvedValue({
      ok: false,
      refusal: {
        status: 409,
        code: "not_funded",
        message: "You haven't funded this channel for that offer and step. Set its daily budget, then start it.",
      },
    });

    const res = await post(body).expect(409);
    expect(res.body.reason).toBe("not_funded");
    expect(res.body.error).toMatch(/daily budget/);

    const rows = await db.query.campaigns.findMany({ where: eq(campaigns.orgId, ORG) });
    expect(rows).toHaveLength(0);
  });

  it("refuses a caller that states a workflow, a name or a budget", async () => {
    for (const extra of [
      { workflowSlug: "aurora-v3" },
      { name: "My campaign" },
      { dailyBudgetCents: 5000 },
      { maxBudgetDailyUsd: "10.00" },
      // The sales funnel is retired: a caller still stating one is told so.
      { funnelKey: "sales_meetings_from_conversation" },
    ]) {
      const res = await post({ ...body, ...extra });
      expect(res.status).toBe(400);
    }
  });

  it("requires the identity workflow-service will be asked with", async () => {
    const res = await request(app)
      .post("/campaigns/start-funded-pair")
      .set("x-api-key", API_KEY)
      .set("x-org-id", ORG)
      .send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/x-user-id|x-run-id/);
  });

  it("gives a CUSTOMER-operated channel a campaign with no workflow, and never triggers one", async () => {
    mockResolve.mockResolvedValue({
      ok: true,
      pair: { legKey: LEG, ceilingCents: 2500, workflowSlug: null },
    });

    const res = await post(body).expect(201);
    expect(res.body.campaign.workflowSlug).toBeNull();
    expect(res.body.campaign.nextRunAt).toBeNull();
    expect(mockExecute).not.toHaveBeenCalled();
  });
});
