import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";

const { mockCatalogue, mockExecute, mockStatsBudget, mockSelected, mockPaths } = vi.hoisted(() => ({
  mockCatalogue: vi.fn(),
  mockExecute: vi.fn(),
  mockStatsBudget: vi.fn(),
  mockSelected: vi.fn(),
  mockPaths: vi.fn(),
}));

vi.mock("@distribute/runs-client", () => ({
  createRun: vi.fn(),
  updateRun: vi.fn(),
  listRuns: vi.fn(async () => ({ runs: [] })),
  getStatsBudget: mockStatsBudget,
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

import app from "../../src/index.js";
import { cleanTestData, closeDb, insertTestCampaign } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { campaigns, campaignStatusTransitions } from "../../src/db/schema.js";
import { and, eq } from "drizzle-orm";
import * as store from "../../src/lib/source-campaign-store.js";

const API_KEY = process.env.CAMPAIGN_SERVICE_API_KEY || "test-api-key";
const ORG = "50c0e000-0000-4000-8000-000000000001";
const BRAND = "50c0e000-0000-4000-8000-000000000002";
const OFFER = "50c0e000-0000-4000-8000-000000000003";
const COLD = "sales-cold-email-outreach";
const APOLLO = "sourcing-apollo-cold-filters";
const SIGNALS = "sourcing-linkedin-engagement-signals";
const BUYING = "sourcing-apollo-buying-signals";
const CRM_SOURCE = "sourcing-crm-contacts";
const SOURCE_LEG = "start_to_lead_found";
const OUTREACH_LEG = "start_to_conversation";

// Even a catalogue that one day PUBLISHES the source leg as an entry leg must not make a source
// one of the offer's "one proactive campaign".
const CATALOGUE = {
  ok: true as const,
  operatorBySlug: new Map([[COLD, "platform" as const]]),
  legsBySlug: new Map<string, ReadonlySet<string>>([[COLD, new Set([OUTREACH_LEG, "start_to_website_visit"])]]),
  legs: [
    { legKey: OUTREACH_LEG, fromStepKey: null, toStepKey: "conversation" },
    { legKey: "start_to_website_visit", fromStepKey: null, toStepKey: "website_visit" },
    { legKey: SOURCE_LEG, fromStepKey: null, toStepKey: "lead_found" },
  ],
  stepKeys: new Set(["conversation", "website_visit", "lead_found"]),
};

const withIdentity = (r: request.Test, featureSlug: string) =>
  r
    .set("x-api-key", API_KEY)
    .set("x-org-id", ORG)
    .set("x-user-id", "user_sources")
    .set("x-run-id", crypto.randomUUID())
    .set("x-brand-id", BRAND)
    .set("x-feature-slug", featureSlug);

/** Exactly what the dashboard sends to turn a source ON (gateway passthrough). */
const turnOn = (origin: string, legKey = SOURCE_LEG) =>
  withIdentity(request(app).post("/campaigns/start-funded-pair"), origin)
    .send({ brandId: BRAND, offerId: OFFER, featureSlug: origin, legKey });

const patchStatus = (id: string, featureSlug: string, status: "stop" | "activate") =>
  withIdentity(request(app).patch(`/campaigns/${id}`), featureSlug).send({ status });

const jubilation = (status = "ongoing") =>
  insertTestCampaign(ORG, {
    status,
    brandIds: [BRAND],
    brandId: BRAND,
    offerId: OFFER,
    legKey: OUTREACH_LEG,
    featureSlug: COLD,
    acquisitionChannel: "cold_email",
    maxBudgetDailyUsd: undefined,
  });

const rowOf = async (id: string) => (await db.query.campaigns.findFirst({ where: eq(campaigns.id, id) }))!;

describe("Source campaigns: an offer's lead sources are campaigns (owner 2026-10-07)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await cleanTestData();
    mockCatalogue.mockResolvedValue(CATALOGUE);
    mockExecute.mockResolvedValue(undefined);
    mockSelected.mockResolvedValue({ ok: true, value: { stated: true, combinationKeys: [] } });
    mockPaths.mockResolvedValue({ ok: true, value: [] });
    mockStatsBudget.mockResolvedValue({ windows: [] });
    // tests/setup.ts stubs the store for every other suite; this one is ABOUT it.
    const actual = await vi.importActual<typeof import("../../src/lib/source-campaign-store.js")>("../../src/lib/source-campaign-store.js");
    vi.mocked(store.ensureSourcesOnStart).mockImplementation(actual.ensureSourcesOnStart);
    vi.mocked(store.sourceCampaignsFeeding).mockImplementation(actual.sourceCampaignsFeeding);
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("turns a source ON with start-funded-pair: no workflow, never dispatched, the outreach campaign keeps running", async () => {
    const outreach = await jubilation();

    const res = await turnOn(APOLLO).expect(201);

    expect(res.body.campaign).toMatchObject({
      featureSlug: APOLLO, legKey: SOURCE_LEG, offerId: OFFER, status: "ongoing", workflowSlug: null, nextRunAt: null,
    });
    expect(res.body.ceilingCents).toBeNull();
    expect(res.body.stoppedCampaigns).toEqual([]);
    expect(mockExecute).not.toHaveBeenCalled();
    expect((await rowOf(outreach.id)).status).toBe("ongoing");
  });

  it("several sources ON at once beside the running outreach campaign; turning the outreach on stops none", async () => {
    const outreach = await jubilation("stopped");
    const a = (await turnOn(APOLLO).expect(201)).body.campaign;
    const b = (await turnOn(SIGNALS).expect(201)).body.campaign;

    const res = await patchStatus(outreach.id, COLD, "activate").expect(200);
    expect(res.body.stoppedCampaigns).toEqual([]);

    for (const id of [a.id, b.id, outreach.id]) expect((await rowOf(id)).status).toBe("ongoing");
  });

  it("On then Off then On again through the same routes the dashboard uses, recorded in the ledger", async () => {
    await jubilation();
    const on = (await turnOn(BUYING).expect(201)).body.campaign;

    const off = await patchStatus(on.id, BUYING, "stop").expect(200);
    expect(off.body.campaign).toMatchObject({ status: "stopped", stopReason: "manual" });

    // A second start-funded-pair hands back the SAME row, started (no twin).
    const again = await turnOn(BUYING).expect(200);
    expect(again.body.campaign.id).toBe(on.id);
    expect(again.body.campaign.status).toBe("ongoing");

    const back = await patchStatus(on.id, BUYING, "stop").expect(200);
    expect(back.body.campaign.status).toBe("stopped");
    const reactivated = await patchStatus(on.id, BUYING, "activate").expect(200);
    expect(reactivated.body.campaign.status).toBe("ongoing");
    expect(mockExecute).not.toHaveBeenCalled();

    const ledger = await db.select().from(campaignStatusTransitions).where(eq(campaignStatusTransitions.campaignId, on.id));
    expect(ledger.map((t) => t.toStatus)).toEqual(["ongoing", "stopped", "ongoing", "stopped", "ongoing"]);
  });

  it("refuses a retired origin, another leg, and a POST /campaigns create of a source", async () => {
    const retired = await turnOn("sourcing-apify-search").expect(400);
    expect(retired.body.reason).toBe("unknown_channel");
    const wrongLeg = await turnOn(APOLLO, OUTREACH_LEG).expect(400);
    expect(wrongLeg.body.reason).toBe("leg_not_performed");

    const create = await withIdentity(request(app).post("/campaigns"), APOLLO)
      .send({ name: "x", orgId: ORG, brandIds: [BRAND], workflowSlug: "w", offerId: OFFER, legKey: SOURCE_LEG })
      .expect(400);
    expect(create.body.reason).toBe("source_campaign_via_start_pair");
  });

  it("serves the offer's sources to siblings: four live origins, absent = OFF, running ones with their ids", async () => {
    const outreach = await jubilation();
    const a = (await turnOn(APOLLO).expect(201)).body.campaign;
    const b = (await turnOn(SIGNALS).expect(201)).body.campaign;
    await patchStatus(b.id, SIGNALS, "stop").expect(200);

    const res = await request(app)
      .get(`/internal/offers/${OFFER}/source-campaigns?brandId=${BRAND}`)
      .set("x-api-key", API_KEY)
      .set("x-org-id", ORG)
      .expect(200);
    expect(res.body.sourceLegKey).toBe(SOURCE_LEG);
    expect(res.body.sourceCampaigns.map((s: { featureSlug: string }) => s.featureSlug)).toEqual([APOLLO, BUYING, SIGNALS, CRM_SOURCE]);
    const by = Object.fromEntries(res.body.sourceCampaigns.map((s: { featureSlug: string }) => [s.featureSlug, s]));
    expect(by[APOLLO]).toMatchObject({ campaignId: a.id, status: "ongoing", running: true, campaignKey: `campaign:${APOLLO}|${SOURCE_LEG}` });
    expect(by[SIGNALS]).toMatchObject({ campaignId: b.id, status: "stopped", running: false });
    expect(by[BUYING]).toMatchObject({ campaignId: null, status: null, running: false });
    expect(res.body.runningSourceCampaigns).toEqual([{ featureSlug: APOLLO, campaignId: a.id, campaignKey: `campaign:${APOLLO}|${SOURCE_LEG}` }]);

    await request(app).get(`/internal/offers/${OFFER}/source-campaigns?brandId=${BRAND}`).set("x-api-key", API_KEY).expect(400);

    const feeding = await request(app).get(`/internal/campaigns/${outreach.id}/source-campaigns`).set("x-api-key", API_KEY).expect(200);
    expect(feeding.body.sourced).toBe(true);
    expect(feeding.body.sourceCampaigns).toEqual(expect.arrayContaining([
      expect.objectContaining({ campaignId: a.id, featureSlug: APOLLO, running: true }),
      expect.objectContaining({ campaignId: b.id, featureSlug: SIGNALS, running: false }),
    ]));
    // CRM contacts never feed a cold-email campaign.
    expect(feeding.body.servedOrigins).not.toContain(CRM_SOURCE);
  });

  it("a person's first outreach start on an offer with no source births its default source ON", async () => {
    const outreach = await jubilation("stopped");
    await patchStatus(outreach.id, COLD, "activate").expect(200);

    const rows = await db.select().from(campaigns).where(and(eq(campaigns.offerId, OFFER), eq(campaigns.legKey, SOURCE_LEG)));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ featureSlug: APOLLO, status: "ongoing", workflowSlug: null, nextRunAt: null });
    const [birth] = await db.select().from(campaignStatusTransitions).where(eq(campaignStatusTransitions.campaignId, rows[0].id));
    expect(birth).toMatchObject({ fromStatus: null, toStatus: "ongoing", source: "source_default" });
  });

  it("an offer holding any source row gets no default: a person's Off stays off", async () => {
    const outreach = await jubilation("stopped");
    const a = (await turnOn(SIGNALS).expect(201)).body.campaign;
    await patchStatus(a.id, SIGNALS, "stop").expect(200);

    await patchStatus(outreach.id, COLD, "activate").expect(200);

    const rows = await db.select().from(campaigns).where(and(eq(campaigns.offerId, OFFER), eq(campaigns.legKey, SOURCE_LEG)));
    expect(rows.map((r) => [r.featureSlug, r.status])).toEqual([[SIGNALS, "stopped"]]);
  });

  describe("a source nobody turned off follows its outreach campaign back ON (owner 2026-10-09)", () => {
    // Prod 2026-10-09, Novemiq: the 10-07 mirror bore the offer's only source OFF (a copy of the
    // outreach pause). The client restarted the outreach; 0 leads were served for 5 hours.
    const sourceStoppedBy = async (origin: string, source: string, reason: string) => {
      const row = await insertTestCampaign(ORG, {
        status: "stopped",
        stopReason: reason,
        brandIds: [BRAND],
        brandId: BRAND,
        offerId: OFFER,
        legKey: SOURCE_LEG,
        featureSlug: origin,
        maxBudgetDailyUsd: undefined,
      });
      await db.insert(campaignStatusTransitions).values({
        campaignId: row.id, orgId: ORG, fromStatus: null, toStatus: "stopped", reason, source,
      });
      return row;
    };

    it("a source the mirror bore OFF comes back ON when a person restarts the outreach campaign", async () => {
      const outreach = await jubilation("stopped");
      const mirrored = await sourceStoppedBy(APOLLO, "source_mirror", "manual");

      await patchStatus(outreach.id, COLD, "activate").expect(200);

      expect(await rowOf(mirrored.id)).toMatchObject({ status: "ongoing", stopReason: null, nextRunAt: null });
      const ledger = await db.select().from(campaignStatusTransitions).where(eq(campaignStatusTransitions.campaignId, mirrored.id));
      expect(ledger.map((t) => [t.toStatus, t.source]).sort()).toEqual([["ongoing", "source_follows_outreach"], ["stopped", "source_mirror"]]);
      // No default twin is born beside it.
      const rows = await db.select().from(campaigns).where(and(eq(campaigns.offerId, OFFER), eq(campaigns.legKey, SOURCE_LEG)));
      expect(rows).toHaveLength(1);
      // The scheduler no longer holds the outreach campaign for `sources_off`.
      const feeding = await store.sourceCampaignsFeeding(outreach.id, COLD);
      expect(feeding.some((f) => f.status === "ongoing")).toBe(true);
    });

    it("a source the payment hold stopped follows the person's restart too", async () => {
      const outreach = await jubilation("stopped");
      const held = await sourceStoppedBy(SIGNALS, "payment_hold", "payment_declined");

      await patchStatus(outreach.id, COLD, "activate").expect(200);

      expect((await rowOf(held.id)).status).toBe("ongoing");
    });

    it("a source a PERSON turned off stays off, even beside a mirrored one that comes back", async () => {
      const outreach = await jubilation("stopped");
      const mirrored = await sourceStoppedBy(APOLLO, "source_mirror", "manual");
      const personOff = (await turnOn(SIGNALS).expect(201)).body.campaign;
      await patchStatus(personOff.id, SIGNALS, "stop").expect(200);

      await patchStatus(outreach.id, COLD, "activate").expect(200);

      expect((await rowOf(mirrored.id)).status).toBe("ongoing");
      expect((await rowOf(personOff.id)).status).toBe("stopped");
    });

    it("a reactive outreach leg turns no source on; a CRM source never follows a cold-email start", async () => {
      const crm = await sourceStoppedBy(CRM_SOURCE, "source_mirror", "manual");
      const reactive = await insertTestCampaign(ORG, {
        status: "stopped", brandIds: [BRAND], brandId: BRAND, offerId: OFFER, legKey: "conversation_to_meeting_booked",
        featureSlug: COLD, acquisitionChannel: "cold_email", maxBudgetDailyUsd: undefined,
      });
      const apollo = await sourceStoppedBy(APOLLO, "source_mirror", "manual");

      await patchStatus(reactive.id, COLD, "activate");

      expect((await rowOf(apollo.id)).status).toBe("stopped");
      expect((await rowOf(crm.id)).status).toBe("stopped");
    });
  });

  describe("migration of today's state (POST /internal/source-campaigns/mirror)", () => {
    const mirror = (apply?: boolean) =>
      request(app).post("/internal/source-campaigns/mirror").set("x-api-key", API_KEY).send(apply === undefined ? {} : { apply });

    it("dry run writes nothing; apply mirrors ON and OFF offers, adds observed origins, and is idempotent", async () => {
      const on = await jubilation("ongoing");
      const OFF_OFFER = "50c0e000-0000-4000-8000-000000000009";
      const offOutreach = await insertTestCampaign(ORG, {
        status: "stopped", stopReason: "payment_declined", brandIds: [BRAND], brandId: BRAND, offerId: OFF_OFFER,
        legKey: OUTREACH_LEG, featureSlug: COLD, acquisitionChannel: "cold_email", maxBudgetDailyUsd: undefined,
      });
      // The ON offer also found leads through LinkedIn signals this fortnight.
      mockStatsBudget.mockImplementation(async (p: { campaignId?: string; featureSlug?: string }) => ({
        windows: p.campaignId === on.id && p.featureSlug === SIGNALS
          ? [{ label: "window", totalCostInUsdCents: "12.5000000000", actualCostInUsdCents: "12.5", provisionedCostInUsdCents: "0" }]
          : [],
      }));

      const dry = await mirror().expect(200);
      expect(dry.body.applied).toBe(false);
      expect(dry.body.counts).toEqual({ ongoing: 2, stopped: 1, observed: 1 });
      expect(await db.select().from(campaigns).where(eq(campaigns.legKey, SOURCE_LEG))).toHaveLength(0);

      const applied = await mirror(true).expect(200);
      expect(applied.body.applied).toBe(true);
      const sources = await db.select().from(campaigns).where(eq(campaigns.legKey, SOURCE_LEG));
      const view = sources.map((s) => [s.offerId, s.featureSlug, s.status, s.stopReason, s.workflowSlug]).sort();
      expect(view).toEqual([
        [OFFER, APOLLO, "ongoing", null, null],
        [OFFER, SIGNALS, "ongoing", null, null],
        [OFF_OFFER, APOLLO, "stopped", "payment_declined", null],
      ].sort());
      const off = sources.find((s) => s.offerId === OFF_OFFER)!;
      const [birth] = await db.select().from(campaignStatusTransitions).where(eq(campaignStatusTransitions.campaignId, off.id));
      expect(birth).toMatchObject({ fromStatus: null, toStatus: "stopped", reason: "payment_declined", source: "source_mirror" });
      expect(offOutreach.id).toBeTruthy();

      // Nothing outreach-side moved, nothing dispatched.
      expect((await rowOf(on.id)).status).toBe("ongoing");
      expect(mockExecute).not.toHaveBeenCalled();

      const again = await mirror(true).expect(200);
      expect(again.body.plan).toEqual([]);
      expect(again.body.alreadyPresent).toBe(3);
    });
  });
});
