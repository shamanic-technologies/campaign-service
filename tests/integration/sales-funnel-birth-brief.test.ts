import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";

const { mockPlan, mockCatalogue, mockOfferName } = vi.hoisted(() => ({
  mockPlan: vi.fn(),
  mockCatalogue: vi.fn(),
  mockOfferName: vi.fn(),
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

vi.mock("../../src/lib/brand-offers-client.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/lib/brand-offers-client.js")>();
  return { ...original, fetchOfferName: mockOfferName };
});

// tests/setup.ts stubs the birth brief as unreadable for every launch test; this suite is about it.
vi.mock("../../src/lib/sales-funnel-birth-brief.js", async () => vi.importActual("../../src/lib/sales-funnel-birth-brief.js"));

import app from "../../src/index.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { salesFunnelCampaigns } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import { channelSlugsInLegOrder, composeBirthBrief, repairMissingBriefs } from "../../src/lib/sales-funnel-birth-brief.js";

const API_KEY = process.env.CAMPAIGN_SERVICE_API_KEY || "test-api-key";
const ORG = "b645207b-0000-4000-8000-00000000b1f1";
const BRAND = "75d7e3e8-0000-4000-8000-00000000b1f2";
const OFFER = "231bb036-0000-4000-8000-00000000b1f3";
const FUNNEL = "start_to_lead_found@lead-sourcing+lead_found_to_conversation@sales-cold-email-outreach+conversation_to_paid_client";

const LEGS = [
  { legKey: "start_to_lead_found", fromStepKey: null, toStepKey: "lead_found" },
  { legKey: "lead_found_to_conversation", fromStepKey: "lead_found", toStepKey: "conversation" },
  { legKey: "conversation_to_paid_client", fromStepKey: "conversation", toStepKey: "paid_client" },
];
const CATALOGUE = {
  ok: true,
  legs: LEGS,
  nameBySlug: new Map([
    ["lead-sourcing", "Lead Sourcing"],
    ["sales-cold-email-outreach", "Sales Cold Email Outreach"],
    ["your-team-reply-closing", "Your Team Reply Closing"],
  ]),
  stepLabels: new Map([["paid_client", "Paid client"]]),
};
const EXPECTED = "Goal: Paid client for Acme Audit.\nUse only these channels: Lead Sourcing, Sales Cold Email Outreach, Your Team Reply Closing.";

const withPerson = (r: request.Test) =>
  r.set("x-api-key", API_KEY).set("x-org-id", ORG).set("x-user-id", "user_brief").set("x-run-id", crypto.randomUUID());
const launch = (body: Record<string, unknown>) => withPerson(request(app).post("/sales-funnel-campaigns")).send(body);

function plan() {
  return {
    ok: true,
    plan: {
      salesFunnelId: FUNNEL,
      salesFunnelName: "Email Replies",
      shape: { target: "paid_client", reason: null, mode: "proactive", triggerId: null },
      // Stored order is not leg order (prod 3cfc2aaa): the brief still reads Start first.
      units: [
        { pipeId: "sales-cold-email-outreach|lead_found_to_conversation", featureSlug: "sales-cold-email-outreach", legKey: "lead_found_to_conversation", mode: "proactive", workflowSlug: "engine:email_sent" },
        { pipeId: "lead-sourcing|start_to_lead_found", featureSlug: "lead-sourcing", legKey: "start_to_lead_found", mode: "proactive", workflowSlug: "engine:lead_found" },
        { pipeId: "your-team-reply-closing|conversation_to_paid_client", featureSlug: "your-team-reply-closing", legKey: "conversation_to_paid_client", mode: "reactive", workflowSlug: null },
      ],
    },
  };
}

const rowOf = async (id: string) => (await db.select().from(salesFunnelCampaigns).where(eq(salesFunnelCampaigns.id, id)))[0]!;

describe("every campaign is born with a brief (CAMPAIGN-BORN-WITH-BRIEF-1111)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await cleanTestData();
    mockPlan.mockResolvedValue(plan());
    mockCatalogue.mockResolvedValue(CATALOGUE);
    mockOfferName.mockResolvedValue({ ok: true, name: "Acme Audit" });
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("composes the goal and the channels in leg order, with no dash", () => {
    expect(composeBirthBrief({ targetLabel: "Backlink earned", offerName: "Audit — Pro", channelNames: [] })).toBe("Goal: Backlink earned for Audit, Pro.");
    expect(
      channelSlugsInLegOrder(
        [
          { featureSlug: "b", legKey: "lead_found_to_conversation" },
          { featureSlug: null, legKey: null },
          { featureSlug: "a", legKey: "start_to_lead_found" },
          { featureSlug: "a", legKey: "start_to_lead_found" },
        ],
        LEGS,
      ),
    ).toEqual(["a", "b"]);
  });

  it("a launch stating no brief stores the brief written from its Target, offer and channels", async () => {
    const res = await launch({ brandId: BRAND, offerId: OFFER, salesFunnelId: FUNNEL, status: "stopped" }).expect(201);
    expect(res.body.salesFunnelCampaign.brief).toBe(EXPECTED);
    const row = await rowOf(res.body.salesFunnelCampaign.id);
    expect(row.brief).toBe(EXPECTED);
    expect(row.briefUpdatedAt).not.toBeNull();
    expect(row.briefUpdatedByUserId).toBeNull();
    expect(mockOfferName).toHaveBeenCalledWith(BRAND, OFFER, expect.objectContaining({ orgId: ORG, userId: "user_brief" }));
  });

  it("a stated brief is kept as stated", async () => {
    const res = await launch({ brandId: BRAND, offerId: OFFER, salesFunnelId: FUNNEL, status: "stopped", brief: "Only CFOs in Lyon." }).expect(201);
    expect((await rowOf(res.body.salesFunnelCampaign.id)).brief).toBe("Only CFOs in Lyon.");
    expect(mockOfferName).not.toHaveBeenCalled();
  });

  it("a source unreadable at birth never blocks the launch; the repair writes the same brief, once, and never refills a cleared one", async () => {
    mockOfferName.mockResolvedValueOnce({ ok: false, reason: "unavailable", detail: "HTTP 503" });
    const res = await launch({ brandId: BRAND, offerId: OFFER, salesFunnelId: FUNNEL, status: "stopped" }).expect(201);
    const id = res.body.salesFunnelCampaign.id;
    expect((await rowOf(id)).brief).toBeNull();

    const dry = await repairMissingBriefs({ apply: false });
    expect(dry.rows).toEqual([expect.objectContaining({ salesFunnelCampaignId: id, outcome: "would_write", brief: EXPECTED })]);
    expect((await rowOf(id)).brief).toBeNull();

    const applied = await withPerson(request(app).post("/internal/sales-funnel-campaigns/brief-repair")).send({ apply: true }).expect(200);
    expect(applied.body.rows).toEqual([expect.objectContaining({ salesFunnelCampaignId: id, outcome: "written", brief: EXPECTED })]);
    expect((await rowOf(id)).brief).toBe(EXPECTED);
    expect((await repairMissingBriefs({ apply: true })).scanned).toBe(0);

    // A person clears it: it stays cleared.
    await withPerson(request(app).patch(`/sales-funnel-campaigns/${id}`)).send({ brief: null }).expect(200);
    expect((await rowOf(id)).brief).toBeNull();
    expect((await repairMissingBriefs({ apply: true })).scanned).toBe(0);
  });

  it("the repair says why it cannot write (no target), and writes nothing", async () => {
    mockPlan.mockResolvedValue({ ...plan(), plan: { ...plan().plan, shape: undefined } });
    const res = await launch({ brandId: BRAND, offerId: OFFER, salesFunnelId: FUNNEL, status: "stopped" }).expect(201);
    const report = await repairMissingBriefs({ apply: true });
    expect(report.rows).toEqual([expect.objectContaining({ salesFunnelCampaignId: res.body.salesFunnelCampaign.id, outcome: "skipped", reason: "no_target" })]);
  });
});
