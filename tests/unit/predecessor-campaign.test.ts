import { describe, it, expect, beforeEach, vi } from "vitest";

const { mockFindFirst, mockFindMany } = vi.hoisted(() => ({
  mockFindFirst: vi.fn(),
  mockFindMany: vi.fn(),
}));

vi.mock("../../src/db/index.js", () => ({
  db: { query: { campaigns: { findFirst: mockFindFirst, findMany: mockFindMany } } },
}));

vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => ({ and: args }),
  eq: (a: unknown, b: unknown) => ({ eq: [a, b] }),
  inArray: (a: unknown, b: unknown) => ({ inArray: [a, b] }),
  arrayContains: (a: unknown, b: unknown) => ({ arrayContains: [a, b] }),
}));

vi.mock("../../src/db/schema.js", () => ({
  campaigns: {
    id: "id",
    orgId: "org_id",
    offerId: "offer_id",
    legKey: "leg_key",
    brandIds: "brand_ids",
  },
}));

const { mockCatalogue } = vi.hoisted(() => ({ mockCatalogue: vi.fn() }));
vi.mock("../../src/lib/channel-operator-client.js", () => ({ fetchChannelCatalogue: mockCatalogue }));

import {
  resolvePredecessorCampaign,
  PredecessorScopeError,
  PREDECESSOR_ABSENCES,
} from "../../src/lib/predecessor-campaign.js";

const ORG = "b645207b-0000-4000-8000-000000000001";
const BRAND = "75d7e3e8-0000-4000-8000-000000000002";
const OFFER = "d5ecba00-0000-4000-8000-000000000003";
const OTHER_OFFER = "9f0d1c22-0000-4000-8000-000000000004";

/** Spelled the way features-service publishes them, without writing a leg literal down. */
const ENTRY_LEG = "start_to_" + "conversation";
const CONTINUING_LEG = "conversation" + "_to_" + ["meeting", "booked"].join("_");
const LATER_LEG = ["meeting", "booked"].join("_") + "_to_" + ["meeting", "attended"].join("_");

function campaign(over: Record<string, unknown> = {}) {
  return {
    id: "8c748ddd-0000-4000-8000-000000000010",
    orgId: ORG,
    status: "ongoing",
    brandId: BRAND,
    brandIds: [BRAND],
    offerId: OFFER,
    legKey: CONTINUING_LEG,
    acquisitionChannel: "ai_meeting_booking",
    featureSlug: "ai-meeting-booking",
    workflowSlug: "aurora",
    createdAt: new Date("2026-09-02T23:29:13Z"),
    ...over,
  };
}

function sibling(over: Record<string, unknown> = {}) {
  return campaign({
    id: "f7b1b610-0000-4000-8000-000000000011",
    legKey: ENTRY_LEG,
    acquisitionChannel: "cold_email",
    featureSlug: "sales-cold-email-outreach",
    workflowSlug: "lithium",
    createdAt: new Date("2026-09-06T07:40:47Z"),
    ...over,
  });
}

function catalogueAnswers() {
  mockCatalogue.mockResolvedValue({
    ok: true,
    operatorBySlug: new Map(),
    legsBySlug: new Map(),
    stepKeys: new Set(["conversation", "meeting_booked", "meeting_attended"]),
    legs: [
      {
        legKey: ENTRY_LEG,
        fromStepKey: null,
        toStepKey: "conversation",
      },
      {
        legKey: CONTINUING_LEG,
        fromStepKey: "conversation",
        toStepKey: "meeting_booked",
      },
      {
        legKey: LATER_LEG,
        fromStepKey: "meeting_booked",
        toStepKey: "meeting_attended",
      },
    ],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  catalogueAnswers();
  mockFindMany.mockResolvedValue([]);
});

describe("resolvePredecessorCampaign", () => {
  it("resolves the campaign that ran the leg ending where this one begins", async () => {
    mockFindFirst.mockResolvedValue(campaign());
    mockFindMany.mockResolvedValue([sibling()]);

    const out = await resolvePredecessorCampaign("8c748ddd-0000-4000-8000-000000000010");

    expect(out.fromStepKey).toBe("conversation");
    expect(out.precedingLegKeys).toEqual([ENTRY_LEG]);
    expect(out.absence).toBeNull();
    expect(out.predecessor).toMatchObject({
      campaignId: "f7b1b610-0000-4000-8000-000000000011",
      legKey: ENTRY_LEG,
      status: "ongoing",
      acquisitionChannel: "cold_email",
    });
  });

  it("prefers the LIVE sibling over a stopped one, whatever their creation dates", async () => {
    mockFindFirst.mockResolvedValue(campaign());
    mockFindMany.mockResolvedValue([
      sibling({ id: "newer-stopped", status: "stopped", createdAt: new Date("2026-09-20T00:00:00Z") }),
      sibling({ id: "the-live-one", status: "ongoing", createdAt: new Date("2026-05-09T00:00:00Z") }),
    ]);

    const out = await resolvePredecessorCampaign("8c748ddd-0000-4000-8000-000000000010");
    expect(out.predecessor?.campaignId).toBe("the-live-one");
  });

  it("falls back to the most recent STOPPED sibling — the history is filed under it", async () => {
    mockFindFirst.mockResolvedValue(campaign());
    mockFindMany.mockResolvedValue([
      sibling({ id: "older", status: "stopped", createdAt: new Date("2026-05-09T00:00:00Z") }),
      sibling({ id: "newer", status: "stopped", createdAt: new Date("2026-08-20T00:00:00Z") }),
    ]);

    const out = await resolvePredecessorCampaign("8c748ddd-0000-4000-8000-000000000010");
    expect(out.predecessor?.campaignId).toBe("newer");
    expect(out.predecessor?.status).toBe("stopped");
  });

  it("answers a named ABSENCE for a campaign at the first leg of a journey", async () => {
    mockFindFirst.mockResolvedValue(campaign({ legKey: ENTRY_LEG }));

    const out = await resolvePredecessorCampaign("f7b1b610-0000-4000-8000-000000000011");
    expect(out.predecessor).toBeNull();
    expect(out.absence).toBe(PREDECESSOR_ABSENCES.ENTRY_LEG);
    // Nothing is even looked for — an entry leg has no predecessor, full stop.
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it("answers a named ABSENCE when nobody bought a campaign for the preceding leg", async () => {
    mockFindFirst.mockResolvedValue(campaign());
    mockFindMany.mockResolvedValue([]);

    const out = await resolvePredecessorCampaign("8c748ddd-0000-4000-8000-000000000010");
    expect(out.predecessor).toBeNull();
    expect(out.absence).toBe(PREDECESSOR_ABSENCES.NO_CAMPAIGN);
    expect(out.precedingLegKeys).toEqual([ENTRY_LEG]);
  });

  it("never serves a funnel", async () => {
    mockFindFirst.mockResolvedValue(campaign());
    mockFindMany.mockResolvedValue([sibling()]);

    const out = await resolvePredecessorCampaign("8c748ddd-0000-4000-8000-000000000010");
    expect(out).not.toHaveProperty("funnelKey");
    expect(out.predecessor?.campaignId).toBe("f7b1b610-0000-4000-8000-000000000011");
  });

  it.each([
    ["states no leg", { legKey: null }, PREDECESSOR_ABSENCES.NO_LEG],
    ["states no offer", { offerId: null }, PREDECESSOR_ABSENCES.NO_OFFER],
    ["states no brand", { brandId: null, brandIds: [] }, PREDECESSOR_ABSENCES.NO_BRAND],
  ])("answers a named absence for a campaign that %s", async (_label, over, absence) => {
    mockFindFirst.mockResolvedValue(campaign(over));

    const out = await resolvePredecessorCampaign("8c748ddd-0000-4000-8000-000000000010");
    expect(out.predecessor).toBeNull();
    expect(out.absence).toBe(absence);
  });

  it("REFUSES rather than answers null when the catalogue cannot be read", async () => {
    mockFindFirst.mockResolvedValue(campaign());
    mockCatalogue.mockResolvedValue({ ok: false, detail: "HTTP 503" });

    await expect(resolvePredecessorCampaign("8c748ddd-0000-4000-8000-000000000010")).rejects.toMatchObject({
      status: 502,
      reason: "catalogue_unavailable",
    });
  });

  it("REFUSES a leg features-service does not publish", async () => {
    mockFindFirst.mockResolvedValue(campaign({ legKey: "retired" + "_to_" + "nowhere" }));

    await expect(resolvePredecessorCampaign("8c748ddd-0000-4000-8000-000000000010")).rejects.toMatchObject({
      status: 409,
      reason: "leg_not_published",
    });
  });

  it("REFUSES rather than tie-breaks when two LIVE siblings run the preceding leg", async () => {
    mockFindFirst.mockResolvedValue(campaign());
    mockFindMany.mockResolvedValue([
      sibling({ id: "one", acquisitionChannel: "cold_email" }),
      sibling({ id: "two", acquisitionChannel: "feedback_request_email" }),
    ]);

    await expect(resolvePredecessorCampaign("8c748ddd-0000-4000-8000-000000000010")).rejects.toMatchObject({
      status: 409,
      reason: "several_predecessor_campaigns",
    });
  });

  it("404s an unknown campaign", async () => {
    mockFindFirst.mockResolvedValue(undefined);

    await expect(resolvePredecessorCampaign("nope")).rejects.toBeInstanceOf(PredecessorScopeError);
  });

  it("scopes the sibling read on the org, the brand, the offer and the preceding legs", async () => {
    mockFindFirst.mockResolvedValue(campaign());
    mockFindMany.mockResolvedValue([sibling()]);

    await resolvePredecessorCampaign("8c748ddd-0000-4000-8000-000000000010");

    const where = JSON.stringify(mockFindMany.mock.calls[0][0].where);
    expect(where).toContain(ORG);
    expect(where).toContain(BRAND);
    expect(where).toContain(OFFER);
    expect(where).not.toContain(OTHER_OFFER);
    expect(where).toContain(ENTRY_LEG);
  });
});
