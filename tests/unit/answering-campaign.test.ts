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
  campaigns: { id: "id", orgId: "org_id", offerId: "offer_id", legKey: "leg_key", brandIds: "brand_ids" },
}));

const { mockCatalogue } = vi.hoisted(() => ({ mockCatalogue: vi.fn() }));
vi.mock("../../src/lib/channel-operator-client.js", () => ({ fetchChannelCatalogue: mockCatalogue }));

import {
  resolveAnsweringCampaign,
  resolveAnsweringCampaigns,
  AnsweringScopeError,
  ANSWERING_ABSENCES,
} from "../../src/lib/answering-campaign.js";

const ORG = "5fefaf5a-0000-4000-8000-000000000001";
const BRAND = "a179bbd9-0000-4000-8000-000000000002";
const OFFER = "3484bbae-0000-4000-8000-000000000003";

/** Spelled the way features-service publishes them, without writing a leg literal down. */
const ENTRY_LEG = "start_to_" + "conversation";
const CONTINUING_LEG = "conversation" + "_to_" + ["meeting", "booked"].join("_");
const LATER_LEG = ["meeting", "booked"].join("_") + "_to_" + ["meeting", "attended"].join("_");

const HELD_ID = "3922c8e1-0000-4000-8000-000000000010";
const ANSWERER_ID = "8c748ddd-0000-4000-8000-000000000011";

function held(over: Record<string, unknown> = {}) {
  return {
    id: HELD_ID,
    orgId: ORG,
    status: "ongoing",
    brandId: BRAND,
    brandIds: [BRAND],
    offerId: OFFER,
    legKey: ENTRY_LEG,
    acquisitionChannel: "cold_email",
    featureSlug: "sales-cold-email-outreach",
    workflowSlug: "tango",
    createdAt: new Date("2026-09-01T00:00:00Z"),
    ...over,
  };
}

function answerer(over: Record<string, unknown> = {}) {
  return held({
    id: ANSWERER_ID,
    legKey: CONTINUING_LEG,
    acquisitionChannel: "ai_meeting_booking",
    featureSlug: "ai-meeting-booking",
    workflowSlug: "aurora",
    createdAt: new Date("2026-09-20T00:00:00Z"),
    ...over,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCatalogue.mockResolvedValue({
    ok: true,
    operatorBySlug: new Map(),
    legsBySlug: new Map<string, Set<string>>([
      ["sales-cold-email-outreach", new Set([ENTRY_LEG])],
      ["ai-meeting-booking", new Set([CONTINUING_LEG])],
    ]),
    stepKeys: new Set(["conversation", "meeting_booked", "meeting_attended"]),
    legs: [
      { legKey: ENTRY_LEG, fromStepKey: null, toStepKey: "conversation" },
      { legKey: CONTINUING_LEG, fromStepKey: "conversation", toStepKey: "meeting_booked" },
      { legKey: LATER_LEG, fromStepKey: "meeting_booked", toStepKey: "meeting_attended" },
    ],
  });
});

/**
 * findFirst serves by id (the held campaign, then each candidate's own row inside the predecessor
 * resolver); findMany serves by the leg set asked for (continuing legs here, preceding legs there).
 */
function world(rows: Array<ReturnType<typeof held>>) {
  mockFindFirst.mockImplementation(async (q: { where: { eq: [string, string] } }) =>
    rows.find((r) => r.id === q.where.eq[1]),
  );
  mockFindMany.mockImplementation(async (q: { where: { and: Array<Record<string, unknown>> } }) => {
    const legs = (q.where.and.find((c) => "inArray" in c) as { inArray: [string, string[]] }).inArray[1];
    return rows.filter((r) => r.legKey && legs.includes(r.legKey as string));
  });
}

describe("resolveAnsweringCampaign", () => {
  it("names the live campaign whose predecessor is this one — the claim path's own verdict", async () => {
    world([held(), answerer()]);
    const out = await resolveAnsweringCampaign(HELD_ID);
    expect(out.absence).toBeNull();
    expect(out.answeredBy).toMatchObject({ campaignId: ANSWERER_ID, legKey: CONTINUING_LEG, status: "ongoing" });
    expect(out.continuingLegKeys).toEqual([CONTINUING_LEG]);
    expect(out.toStepKey).toBe("conversation");
  });

  it("says nobody bought the answering leg, and which channels could — the prod case of #485", async () => {
    world([held()]);
    const out = await resolveAnsweringCampaign(HELD_ID);
    expect(out.answeredBy).toBeNull();
    expect(out.absence).toBe(ANSWERING_ABSENCES.NO_CAMPAIGN);
    expect(out.startableFeatureSlugs).toEqual(["ai-meeting-booking"]);
  });

  it("names a stopped answering campaign as stopped, not as answering", async () => {
    world([held(), answerer({ status: "stopped" })]);
    const out = await resolveAnsweringCampaign(HELD_ID);
    expect(out.answeredBy).toBeNull();
    expect(out.absence).toBe(ANSWERING_ABSENCES.STOPPED);
    expect(out.candidate?.campaignId).toBe(ANSWERER_ID);
  });

  it("a STOPPED held campaign whose live sibling runs the same leg is not answered — the live one is", async () => {
    const stoppedHeld = held({ id: "16705a37-0000-4000-8000-000000000020", status: "stopped" });
    world([stoppedHeld, held(), answerer()]);
    const out = await resolveAnsweringCampaign(stoppedHeld.id);
    expect(out.answeredBy).toBeNull();
    expect(out.absence).toBe(ANSWERING_ABSENCES.SERVES_ANOTHER);
    expect(out.candidateAnswersCampaignId).toBe(HELD_ID);
  });

  it("a campaign stating no leg can never be named as a predecessor, so nobody answers it", async () => {
    world([held({ legKey: null })]);
    const out = await resolveAnsweringCampaign(HELD_ID);
    expect(out.absence).toBe(ANSWERING_ABSENCES.NO_LEG);
    expect(mockCatalogue).not.toHaveBeenCalled();
  });

  it("an unreadable catalogue is a 502, never a null", async () => {
    world([held()]);
    mockCatalogue.mockResolvedValue({ ok: false, detail: "HTTP 503" });
    await expect(resolveAnsweringCampaign(HELD_ID)).rejects.toMatchObject({ status: 502, reason: "catalogue_unavailable" });
  });

  it("an unknown campaign is a 404", async () => {
    world([]);
    await expect(resolveAnsweringCampaign("nope")).rejects.toBeInstanceOf(AnsweringScopeError);
  });
});

describe("resolveAnsweringCampaigns", () => {
  it("reads the catalogue once and returns every id, a refusal included, in the order asked", async () => {
    world([held(), answerer()]);
    const out = await resolveAnsweringCampaigns([HELD_ID, "missing"]);
    expect(mockCatalogue).toHaveBeenCalledTimes(1);
    expect(out.map((e) => e.campaignId)).toEqual([HELD_ID, "missing"]);
    expect(out[0]).toMatchObject({ ok: true, answeredBy: { campaignId: ANSWERER_ID } });
    expect(out[1]).toMatchObject({ ok: false, status: 404, reason: "unknown_campaign" });
  });
});
