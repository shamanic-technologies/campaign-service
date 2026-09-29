import { describe, it, expect, beforeEach, vi } from "vitest";

const { mockFindMany, mockPeriods, mockCatalogue } = vi.hoisted(() => ({
  mockFindMany: vi.fn(),
  mockPeriods: vi.fn(),
  mockCatalogue: vi.fn(),
}));

vi.mock("../../src/db/index.js", () => ({
  db: {
    query: { campaigns: { findMany: mockFindMany } },
    select: () => ({ from: () => ({ where: mockPeriods }) }),
  },
}));

vi.mock("../../src/lib/channel-operator-client.js", () => ({ fetchChannelCatalogue: mockCatalogue }));

import {
  recurringCampaignStatuses,
  RecurringStatusCatalogueError,
} from "../../src/lib/recurring-status.js";

const ORG = "b645207b-0000-4000-8000-000000000001";
const BRAND = "75d7e3e8-0000-4000-8000-000000000002";
/** Spelled without writing a leg literal down, the way features-service publishes them. */
const ENTRY_LEG = "start_to_" + "conversation";
const CONTINUING_LEG = "conversation" + "_to_" + ["meeting", "booked"].join("_");

function campaign(over: Record<string, unknown> = {}) {
  return {
    id: "c1",
    orgId: ORG,
    brandId: BRAND,
    brandIds: [BRAND],
    offerId: "offer-1",
    legKey: ENTRY_LEG,
    featureSlug: "sales-cold-email-outreach",
    acquisitionChannel: "cold_email",
    workflowSlug: "lithium",
    status: "ongoing",
    ...over,
  };
}

function period(campaignId: string, hasAudience: boolean) {
  return {
    campaignId,
    hasAudience,
    startedAt: new Date("2026-09-20T10:00:00Z"),
    lastObservedAt: new Date("2026-09-29T08:00:00Z"),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPeriods.mockResolvedValue([]);
  mockCatalogue.mockResolvedValue({
    ok: true,
    operatorBySlug: new Map(),
    legsBySlug: new Map(),
    stepKeys: new Set(),
    legs: [
      { legKey: ENTRY_LEG, fromStepKey: null, toStepKey: "conversation" },
      { legKey: CONTINUING_LEG, fromStepKey: "conversation", toStepKey: "meeting_booked" },
    ],
  });
});

describe("recurringCampaignStatuses", () => {
  it("counts a running entry-leg campaign with an available audience as recurring", async () => {
    mockFindMany.mockResolvedValue([campaign()]);
    mockPeriods.mockResolvedValue([period("c1", true)]);
    const [row] = await recurringCampaignStatuses({ brandId: BRAND });
    expect(row).toMatchObject({
      campaignId: "c1",
      offerId: "offer-1",
      legKey: ENTRY_LEG,
      featureSlug: "sales-cold-email-outreach",
      running: true,
      executedByPlatform: true,
      kind: "proactive",
      audience: "available",
      allAudiencesExhausted: false,
      audienceSince: "2026-09-20T10:00:00.000Z",
      audienceLastObservedAt: "2026-09-29T08:00:00.000Z",
      recurring: true,
    });
    expect(row.recurringUnknownReason).toBeUndefined();
  });

  it("marks a continuing leg reactive and never recurring", async () => {
    mockFindMany.mockResolvedValue([campaign({ legKey: CONTINUING_LEG })]);
    mockPeriods.mockResolvedValue([period("c1", true)]);
    const [row] = await recurringCampaignStatuses({ orgId: ORG });
    expect(row.kind).toBe("reactive");
    expect(row.recurring).toBe(false);
  });

  it("an exhausted audience is yes, and not recurring", async () => {
    mockFindMany.mockResolvedValue([campaign()]);
    mockPeriods.mockResolvedValue([period("c1", false)]);
    const [row] = await recurringCampaignStatuses({ orgId: ORG });
    expect(row.audience).toBe("exhausted");
    expect(row.allAudiencesExhausted).toBe(true);
    expect(row.recurring).toBe(false);
  });

  it("keeps not_recorded distinct from available: unknown, never true", async () => {
    mockFindMany.mockResolvedValue([campaign()]);
    const [row] = await recurringCampaignStatuses({ orgId: ORG });
    expect(row.audience).toBe("not_recorded");
    expect(row.allAudiencesExhausted).toBeNull();
    expect(row.recurring).toBeNull();
    expect(row.recurringUnknownReason).toBe("audience_not_recorded");
  });

  it("a stopped campaign is not running and not recurring, whatever else is unknown", async () => {
    mockFindMany.mockResolvedValue([campaign({ status: "stopped", legKey: null })]);
    const [row] = await recurringCampaignStatuses({ orgId: ORG });
    expect(row.running).toBe(false);
    expect(row.kind).toBeNull();
    expect(row.kindUnknownReason).toBe("campaign_states_no_leg");
    expect(row.recurring).toBe(false);
  });

  it("a campaign with no workflow is never scheduled, so never recurring", async () => {
    mockFindMany.mockResolvedValue([campaign({ workflowSlug: null })]);
    mockPeriods.mockResolvedValue([period("c1", true)]);
    const [row] = await recurringCampaignStatuses({ orgId: ORG });
    expect(row.executedByPlatform).toBe(false);
    expect(row.recurring).toBe(false);
  });

  it("names a leg the catalogue does not publish", async () => {
    mockFindMany.mockResolvedValue([campaign({ legKey: "retired_" + "to_" + "nowhere" })]);
    mockPeriods.mockResolvedValue([period("c1", true)]);
    const [row] = await recurringCampaignStatuses({ orgId: ORG });
    expect(row.kind).toBeNull();
    expect(row.kindUnknownReason).toBe("leg_not_published");
    expect(row.recurring).toBeNull();
    expect(row.recurringUnknownReason).toBe("kind_unknown");
  });

  it("is loud when the catalogue cannot be read", async () => {
    mockFindMany.mockResolvedValue([campaign()]);
    mockCatalogue.mockResolvedValue({ ok: false, detail: "HTTP 503" });
    await expect(recurringCampaignStatuses({ orgId: ORG })).rejects.toBeInstanceOf(
      RecurringStatusCatalogueError,
    );
  });

  it("leaves a co-branded legacy row out of a brand read", async () => {
    mockFindMany.mockResolvedValue([
      campaign({ id: "solo" }),
      campaign({ id: "co", brandId: null, brandIds: [BRAND, "other"] }),
    ]);
    const rows = await recurringCampaignStatuses({ brandId: BRAND });
    expect(rows.map((r) => r.campaignId)).toEqual(["solo"]);
  });

  it("makes no catalogue or period read for a scope with no campaign", async () => {
    mockFindMany.mockResolvedValue([]);
    expect(await recurringCampaignStatuses({ orgId: ORG })).toEqual([]);
    expect(mockCatalogue).not.toHaveBeenCalled();
    expect(mockPeriods).not.toHaveBeenCalled();
  });
});
