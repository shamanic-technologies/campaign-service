import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

const { mockCatalogue, mockFunnel, mockPipe } = vi.hoisted(() => ({
  mockCatalogue: vi.fn(),
  mockFunnel: vi.fn(),
  mockPipe: vi.fn(),
}));

vi.mock("../../src/lib/channel-operator-client.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/lib/channel-operator-client.js")>();
  return { ...original, fetchChannelCatalogue: mockCatalogue };
});
vi.mock("../../src/lib/sales-funnel-catalogue-client.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/lib/sales-funnel-catalogue-client.js")>();
  return { ...original, fetchSalesFunnel: mockFunnel, fetchPipe: mockPipe };
});

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { campaigns, campaignStatusTransitions } from "../../src/db/schema.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { insertSalesFunnelCampaignWithUnits } from "../../src/lib/campaign-status-history.js";
import { completeSalesFunnelUnits } from "../../src/lib/sales-funnel-unit-completion.js";

const ORG = "b645207b-0000-4000-8000-0000000000d1";
const BRAND = "75d7e3e8-0000-4000-8000-0000000000d2";
const OFFER = "231bb036-0000-4000-8000-0000000000d3";
const COLD = "sales-cold-email-outreach";
const ENTRY = "lead_found_to_conversation";
const MEET = ["conversation", "to", "meeting", "booked"].join("_");
const SOURCE = "sourcing-apollo-cold-filters";
// Bliss as the catalogue serves it: sources, cold email, then the customer's own team on every leg.
const BLISS = `${ENTRY}@${COLD}+${MEET}+meeting_booked_to_paid_client`;
const BOOKING = `your-team-meeting-booking|${MEET}`;
const CLOSING = "your-team-closing-calls|meeting_booked_to_paid_client";
const leg = (legKey: string, pipeId: string | null, channelIds: string[]) =>
  ({ legKey, pipe: pipeId ? { id: pipeId, mode: "reactive" as const } : null, channelIds });

const bornBliss = (status: "ongoing" | "stopped") =>
  insertSalesFunnelCampaignWithUnits({
    id: randomUUID(), orgId: ORG, brandId: BRAND, offerId: OFFER, salesFunnelId: BLISS, salesFunnelName: "Bliss",
    status, createdByUserId: null, parentRunId: null,
    // What the 2026-10-10 conversion left: the cold email row only, no unit on the "Your team" legs.
    units: [{ featureSlug: COLD, legKey: ENTRY, workflowSlug: "cold-v1", name: `Bliss ${randomUUID()}`, acquisitionChannel: "cold_email" }],
  });

describe("completing a funnel campaign's units: every leg has its channel (owner 2026-10-11)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await cleanTestData();
    mockCatalogue.mockResolvedValue({
      ok: true,
      operatorBySlug: new Map([["your-team-meeting-booking", "customer"], ["your-team-closing-calls", "customer"], [COLD, "platform"]]),
    });
    mockFunnel.mockImplementation(async (id: string) => ({
      ok: true,
      value: {
        id, name: "Bliss", pipeIds: [`${COLD}|${ENTRY}`, BOOKING, CLOSING],
        legs: [
          leg("start_to_lead_found", null, [SOURCE]),
          leg(ENTRY, `${COLD}|${ENTRY}`, [COLD]),
          leg(MEET, BOOKING, ["your-team-meeting-booking"]),
          leg("meeting_booked_to_paid_client", CLOSING, ["your-team-closing-calls"]),
        ],
      },
    }));
    mockPipe.mockImplementation(async (id: string) => ({ ok: true, value: { id, name: "Bird", channelSlug: id.split("|")[0], legKey: id.split("|")[1], mode: "reactive" } }));
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("lists the missing 'Your team' legs on a dry run, writes them on apply in the funnel's status, then has nothing left", async () => {
    const live = await bornBliss("ongoing");
    const dry = await completeSalesFunnelUnits({ apply: false });
    expect(dry.counts).toMatchObject({ funnelCampaigns: 1, incomplete: 1, unitsAdded: 0, unresolved: 0 });
    expect(dry.funnelCampaigns[0].added).toEqual([
      { featureSlug: "your-team-meeting-booking", legKey: MEET },
      { featureSlug: "your-team-closing-calls", legKey: "meeting_booked_to_paid_client" },
    ]);
    expect(await db.select().from(campaigns)).toHaveLength(1);

    const applied = await completeSalesFunnelUnits({ apply: true });
    expect(applied.counts.unitsAdded).toBe(2);
    const units = await db.select().from(campaigns).where(eq(campaigns.salesFunnelCampaignId, live.salesFunnelCampaign.id));
    const team = units.filter((u) => u.featureSlug !== COLD);
    expect(team.map((u) => [u.featureSlug, u.status, u.workflowSlug, u.nextRunAt, u.offerId, u.brandId])).toEqual(
      expect.arrayContaining([
        ["your-team-meeting-booking", "ongoing", null, null, OFFER, BRAND],
        ["your-team-closing-calls", "ongoing", null, null, OFFER, BRAND],
      ]),
    );
    const births = await db.select().from(campaignStatusTransitions).where(eq(campaignStatusTransitions.campaignId, team[0].id));
    expect(births).toMatchObject([{ source: "sales_funnel", toStatus: "ongoing" }]);

    const again = await completeSalesFunnelUnits({ apply: true });
    expect(again.counts).toMatchObject({ incomplete: 0, unitsAdded: 0 });
  });

  it("a STOPPED funnel campaign's new units are born stopped", async () => {
    const off = await bornBliss("stopped");
    await completeSalesFunnelUnits({ apply: true });
    const units = await db.select().from(campaigns).where(eq(campaigns.salesFunnelCampaignId, off.salesFunnelCampaign.id));
    expect(units.map((u) => u.status)).toEqual(["stopped", "stopped", "stopped"]);
  });

  it("never creates a PLATFORM pipe, and names a catalogue leg with no channel", async () => {
    await bornBliss("ongoing");
    mockFunnel.mockImplementation(async (id: string) => ({
      ok: true,
      value: {
        id, name: "Bliss", pipeIds: [`${COLD}|${ENTRY}`, `ai-meeting-booking|${MEET}`],
        legs: [
          leg(ENTRY, `${COLD}|${ENTRY}`, [COLD]),
          leg(MEET, `ai-meeting-booking|${MEET}`, ["ai-meeting-booking"]),
          leg("meeting_booked_to_paid_client", null, []),
        ],
      },
    }));
    const report = await completeSalesFunnelUnits({ apply: true });
    expect(report.funnelCampaigns[0]).toMatchObject({
      added: [],
      missingPlatformPipes: [`ai-meeting-booking|${MEET}`],
      legsWithoutChannel: ["meeting_booked_to_paid_client"],
    });
    expect(report.counts.unresolved).toBe(1);
    expect(await db.select().from(campaigns)).toHaveLength(1);
  });
});
