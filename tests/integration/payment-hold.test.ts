import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";

const { mockExecuteCampaignWorkflow } = vi.hoisted(() => ({
  mockExecuteCampaignWorkflow: vi.fn(),
}));

vi.mock("../../src/lib/workflows.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/lib/workflows.js")>();
  return { ...original, executeCampaignWorkflow: mockExecuteCampaignWorkflow };
});

vi.mock("../../src/lib/selected-dispatch.js", () => ({
  dispatchSelectedRun: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@distribute/runs-client", () => ({
  createRun: vi.fn().mockResolvedValue({ id: "mock-run-id" }),
  updateRun: vi.fn().mockResolvedValue({}),
  listRuns: vi.fn().mockResolvedValue({ runs: [] }),
  getStatsBudget: vi.fn().mockResolvedValue({ windows: [] }),
}));

import app from "../../src/index.js";
import { db } from "../../src/db/index.js";
import { campaigns, campaignStatusTransitions } from "../../src/db/schema.js";
import { readPaymentHold, paymentStartRefusal } from "../../src/lib/payment-hold.js";
import { holdPaymentDeclinedOrgs, resetPaymentHoldSweepClock, PAYMENT_HOLD_RECHECK_MS } from "../../src/lib/payment-hold-sweep.js";
import { cleanTestData, insertTestCampaign, closeDb } from "../helpers/test-db.js";

const API_KEY = process.env.CAMPAIGN_SERVICE_API_KEY || "test-api-key";
const DECLINED_ORG = "81b34252-61e3-47b5-9293-5294b6fb51b6";
const HEALTHY_ORG = "00673148-ce8e-4bd8-816f-8d6e6d2facff";
const DECLINED = {
  status: 409,
  body: {
    error: "Your campaigns are paused because your card was declined. Pay your outstanding balance and add a card that works, then start them again.",
    reason: "payment_declined" as const,
    blockedReason: "card_declined",
  },
};

/** billing's verdict per org, as the sweep and the start paths read it. */
function billingSays(held: Record<string, boolean>) {
  vi.mocked(readPaymentHold).mockImplementation(async (orgId: string) =>
    held[orgId] ? { ok: true, held: true, blockedReason: "card_declined" } : { ok: true, held: false },
  );
  vi.mocked(paymentStartRefusal).mockImplementation(async (orgId: string) => (held[orgId] ? DECLINED : null));
}

function activate(orgId: string, campaignId: string, brandId: string) {
  return request(app)
    .patch(`/campaigns/${campaignId}`)
    .set("x-api-key", API_KEY)
    .set("x-org-id", orgId)
    .set("x-user-id", crypto.randomUUID())
    .set("x-run-id", crypto.randomUUID())
    .set("x-brand-id", brandId)
    .set("x-feature-slug", "sales-cold-email-outreach")
    .send({ status: "activate" });
}

describe("a declined card stops its org's campaigns, and nothing starts them until billing clears it", () => {
  beforeEach(async () => {
    await cleanTestData();
    vi.clearAllMocks();
    resetPaymentHoldSweepClock();
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("the sweep stops every ongoing campaign of a held org with payment_declined, and leaves a healthy org alone", async () => {
    const brand = crypto.randomUUID();
    const held = await insertTestCampaign(DECLINED_ORG, { brandIds: [brand], nextRunAt: new Date() });
    const alreadyStopped = await insertTestCampaign(DECLINED_ORG, { status: "stopped", stopReason: "manual" });
    const healthy = await insertTestCampaign(HEALTHY_ORG, { nextRunAt: new Date() });
    billingSays({ [DECLINED_ORG]: true });

    expect(await holdPaymentDeclinedOrgs()).toBe(1);

    const after = await db.query.campaigns.findMany();
    const byId = new Map(after.map((c) => [c.id, c]));
    expect(byId.get(held.id)).toMatchObject({ status: "stopped", stopReason: "payment_declined", nextRunAt: null });
    // A campaign a person already stopped keeps its own reason: nothing rewrites history.
    expect(byId.get(alreadyStopped.id)).toMatchObject({ status: "stopped", stopReason: "manual" });
    expect(byId.get(healthy.id)).toMatchObject({ status: "ongoing", stopReason: null });

    const transitions = await db.select().from(campaignStatusTransitions).where(eq(campaignStatusTransitions.campaignId, held.id));
    expect(transitions).toEqual([
      expect.objectContaining({ fromStatus: "ongoing", toStatus: "stopped", reason: "payment_declined", source: "payment_hold" }),
    ]);
    // Only orgs with a live campaign are asked.
    expect(vi.mocked(readPaymentHold).mock.calls.map((c) => c[0]).sort()).toEqual([DECLINED_ORG, HEALTHY_ORG].sort());
  });

  it("stops an org with NO payment method under no_payment_method, and a declined org under payment_declined", async () => {
    const NO_CARD_ORG = "5f0c2b9e-3a41-4d6e-9b7a-1c2d3e4f5a6b";
    const declined = await insertTestCampaign(DECLINED_ORG);
    const noCard = await insertTestCampaign(NO_CARD_ORG);
    vi.mocked(readPaymentHold).mockImplementation(async (orgId: string) =>
      orgId === NO_CARD_ORG
        ? { ok: true, held: true, blockedReason: "no_chargeable_card" }
        : { ok: true, held: true, blockedReason: "card_declined" },
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await holdPaymentDeclinedOrgs()).toBe(2);

    const byId = new Map((await db.query.campaigns.findMany()).map((c) => [c.id, c]));
    expect(byId.get(noCard.id)).toMatchObject({ status: "stopped", stopReason: "no_payment_method" });
    expect(byId.get(declined.id)).toMatchObject({ status: "stopped", stopReason: "payment_declined" });
    const transitions = await db.select().from(campaignStatusTransitions).where(eq(campaignStatusTransitions.campaignId, noCard.id));
    expect(transitions).toContainEqual(
      expect.objectContaining({ fromStatus: "ongoing", toStatus: "stopped", reason: "no_payment_method", source: "payment_hold" }),
    );
  });

  it("runs on its own cadence and is idempotent", async () => {
    await insertTestCampaign(DECLINED_ORG);
    billingSays({ [DECLINED_ORG]: true });
    const t0 = 1_000_000_000_000;
    expect(await holdPaymentDeclinedOrgs(t0)).toBe(1);
    expect(await holdPaymentDeclinedOrgs(t0 + 1_000)).toBe(0);
    expect(vi.mocked(readPaymentHold)).toHaveBeenCalledTimes(1);
    expect(await holdPaymentDeclinedOrgs(t0 + PAYMENT_HOLD_RECHECK_MS)).toBe(0);
  });

  it("stops nothing when billing cannot be read", async () => {
    const c = await insertTestCampaign(DECLINED_ORG);
    vi.mocked(readPaymentHold).mockResolvedValue({ ok: false, detail: "billing responded 502" });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await holdPaymentDeclinedOrgs()).toBe(0);
    expect((await db.query.campaigns.findFirst({ where: eq(campaigns.id, c.id) }))?.status).toBe("ongoing");
  });

  it("refuses to resume while held, then lets the customer resume once billing clears the org", async () => {
    const brand = crypto.randomUUID();
    const c = await insertTestCampaign(DECLINED_ORG, { brandIds: [brand], nextRunAt: new Date() });
    billingSays({ [DECLINED_ORG]: true });
    await holdPaymentDeclinedOrgs();

    const refused = await activate(DECLINED_ORG, c.id, brand).expect(409);
    expect(refused.body).toEqual(DECLINED.body);
    expect((await db.query.campaigns.findFirst({ where: eq(campaigns.id, c.id) }))?.status).toBe("stopped");
    expect(mockExecuteCampaignWorkflow).not.toHaveBeenCalled();

    // The customer paid and added a working card: billing no longer says charge_blocked.
    billingSays({});
    const resumed = await activate(DECLINED_ORG, c.id, brand).expect(200);
    expect(resumed.body.campaign).toMatchObject({ status: "ongoing", stopReason: null });
  });

  it("refuses a create (new or restart) for a held org before anything is written", async () => {
    billingSays({ [DECLINED_ORG]: true });
    const res = await request(app)
      .post("/campaigns")
      .set("x-api-key", API_KEY)
      .set("x-org-id", DECLINED_ORG)
      .set("x-user-id", crypto.randomUUID())
      .set("x-run-id", crypto.randomUUID())
      .set("x-feature-slug", "sales-cold-email-v1")
      .send({ name: "blocked", workflowSlug: "sales-email-cold-outreach", orgId: DECLINED_ORG, brandIds: [crypto.randomUUID()] })
      .expect(409);
    expect(res.body.reason).toBe("payment_declined");
    expect(await db.query.campaigns.findMany()).toEqual([]);
  });

  it("refuses start-funded-pair for a held org", async () => {
    billingSays({ [DECLINED_ORG]: true });
    const res = await request(app)
      .post("/campaigns/start-funded-pair")
      .set("x-api-key", API_KEY)
      .set("x-org-id", DECLINED_ORG)
      .set("x-user-id", crypto.randomUUID())
      .set("x-run-id", crypto.randomUUID())
      .send({ brandId: crypto.randomUUID(), offerId: crypto.randomUUID(), legKey: "start_to_conversation", featureSlug: "sales-cold-email-outreach" })
      .expect(409);
    expect(res.body.reason).toBe("payment_declined");
  });
});
