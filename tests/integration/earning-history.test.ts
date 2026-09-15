import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import app from "../../src/index.js";
import { db } from "../../src/db/index.js";
import { campaignAudienceAvailability, campaignStatusTransitions } from "../../src/db/schema.js";
import { cleanTestData, closeDb, insertTestCampaign, randomId } from "../helpers/test-db.js";
import { recordAudienceAvailability } from "../../src/lib/campaign-audience-availability.js";
import {
  markAudienceExhausted,
  resolveAudienceExhaustion,
  getFreshExhaustedAudienceIds,
} from "../../src/lib/audience-exhaustion.js";

const API_KEY = process.env.CAMPAIGN_SERVICE_API_KEY || "test-api-key";
const ORG = randomId();

/**
 * WAS THIS CAMPAIGN EARNING ON A PAST DAY?
 *
 * These pin the three things that make that question answerable at all: every status change leaves
 * a trace, audience availability is a period with a beginning AND an end, and a day before the
 * record begins reads `not_recorded` rather than as a day the campaign was not running. The last
 * one is the whole point — a month published as a guess came out NEGATIVE.
 */
describe("earning history", () => {
  const DAY = 24 * 60 * 60 * 1000;

  beforeEach(async () => {
    await cleanTestData();
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  function utcDay(d: Date) {
    return d.toISOString().slice(0, 10);
  }

  function readHistory(campaignIds: string[], from: string, to: string) {
    return request(app)
      .post("/internal/campaigns/earning-history")
      .set("x-api-key", API_KEY)
      .send({ campaignIds, from, to });
  }

  function transitionsOf(campaignId: string) {
    return db
      .select()
      .from(campaignStatusTransitions)
      .where(eq(campaignStatusTransitions.campaignId, campaignId));
  }

  it("records a transition for every status change, and none can land without one", async () => {
    const created = await request(app)
      .post("/campaigns")
      .set("x-api-key", API_KEY)
      .set("x-org-id", ORG)
      .set("x-user-id", randomId())
      .set("x-run-id", crypto.randomUUID())
      .set("x-feature-slug", "pr-cold-email-outreach")
      .send({
        name: `earning-${randomId()}`,
        workflowSlug: "pr-cold-email-outreach-v1",
        orgId: ORG,
        brandIds: [randomId()],
      })
      .expect(201);

    const id = created.body.campaign.id;

    // The BIRTH is a transition like any other: a replay must be able to tell "did not exist yet"
    // from "existed and was stopped".
    let rows = await transitionsOf(id);
    expect(rows).toHaveLength(1);
    expect(rows[0].fromStatus).toBeNull();
    expect(rows[0].toStatus).toBe("ongoing");
    expect(rows[0].source).toBe("create");

    const patch = (body: Record<string, unknown>) =>
      request(app)
        .patch(`/campaigns/${id}`)
        .set("x-api-key", API_KEY)
        .set("x-org-id", ORG)
        .set("x-user-id", randomId())
        .set("x-run-id", crypto.randomUUID())
        .set("x-feature-slug", "pr-cold-email-outreach")
        .send(body);

    await patch({ status: "stop" }).expect(200);
    await patch({ status: "activate" }).expect(200);

    rows = (await transitionsOf(id)).sort(
      (a, b) => a.occurredAt.getTime() - b.occurredAt.getTime(),
    );
    expect(rows.map((r) => [r.fromStatus, r.toStatus, r.reason, r.source])).toEqual([
      [null, "ongoing", null, "create"],
      ["ongoing", "stopped", "manual", "patch"],
      ["stopped", "ongoing", null, "patch"],
    ]);

    // A non-status update touches nothing: the history records changes, not writes.
    await patch({ maxLeads: 12 }).expect(200);
    expect(await transitionsOf(id)).toHaveLength(3);
  }, 20000);

  it("stops an org's campaigns WITH their transitions", async () => {
    const org = randomId();
    const campaign = await insertTestCampaign(org, { status: "ongoing" });

    await request(app)
      .delete(`/internal/campaigns/by-org/${org}`)
      .set("x-api-key", API_KEY)
      .expect(200);

    const rows = await transitionsOf(campaign.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].fromStatus).toBe("ongoing");
    expect(rows[0].toStatus).toBe("stopped");
    expect(rows[0].reason).toBe("org_teardown");
  });

  it("gives audience exhaustion an END, and the live TTL read is unchanged by it", async () => {
    const campaign = await insertTestCampaign(ORG, { status: "ongoing" });
    const audience = randomId();

    await markAudienceExhausted(campaign.id, audience);
    expect(await getFreshExhaustedAudienceIds(campaign.id)).toEqual([audience]);

    // A run served from it again: the period ENDS, and the bandit stops excluding it immediately
    // rather than waiting out a TTL nobody can replay.
    await resolveAudienceExhaustion(campaign.id, audience);
    expect(await getFreshExhaustedAudienceIds(campaign.id)).toEqual([]);

    // Going dry again opens a SECOND period — impossible while the pair was the primary key, which
    // is exactly why the record could never say a campaign had come back.
    await markAudienceExhausted(campaign.id, audience);
    expect(await getFreshExhaustedAudienceIds(campaign.id)).toEqual([audience]);
  });

  it("reads a past day from recorded history, and a day before the record as NOT RECORDED", async () => {
    const campaign = await insertTestCampaign(ORG, { status: "ongoing" });
    const now = new Date();
    const today = utcDay(now);
    const yesterday = utcDay(new Date(now.getTime() - DAY));
    const threeDaysAgo = utcDay(new Date(now.getTime() - 3 * DAY));

    // Nothing recorded at all: every day is unknown, and the campaign is still RETURNED — an
    // absent row would be indistinguishable from "it was not earning".
    const blank = await readHistory([campaign.id], threeDaysAgo, today).expect(200);
    expect(blank.body.campaigns).toHaveLength(1);
    expect(blank.body.campaigns[0].statusRecordedSince).toBeNull();
    expect(blank.body.campaigns[0].days.every((d: { earning: null }) => d.earning === null)).toBe(true);
    expect(blank.body.campaigns[0].days.every((d: { status: string }) => d.status === "not_recorded")).toBe(true);

    // The record opens two days ago: it was running, and it had somebody to contact.
    const twoDaysAgo = new Date(now.getTime() - 2 * DAY);
    await db.insert(campaignStatusTransitions).values({
      campaignId: campaign.id,
      orgId: ORG,
      fromStatus: null,
      toStatus: "ongoing",
      reason: null,
      source: "record_opened",
      occurredAt: twoDaysAgo,
    });
    await db.insert(campaignAudienceAvailability).values({
      campaignId: campaign.id,
      orgId: ORG,
      hasAudience: true,
      startedAt: twoDaysAgo,
      lastObservedAt: twoDaysAgo,
    });

    const read = await readHistory([campaign.id], threeDaysAgo, today).expect(200);
    const byDay = Object.fromEntries(
      read.body.campaigns[0].days.map((d: { day: string }) => [d.day, d]),
    );
    expect(byDay[threeDaysAgo].earning).toBeNull();
    expect(byDay[threeDaysAgo].unknownReason).toBe("both_not_recorded");
    expect(byDay[yesterday]).toMatchObject({ status: "ongoing", audience: "available", earning: true });
    expect(byDay[today]).toMatchObject({ earning: true });
  }, 20000);

  it("reads as NOT earning while it had nobody, and earning again from the day it did", async () => {
    const campaign = await insertTestCampaign(ORG, { status: "ongoing" });
    const now = new Date();
    const today = utcDay(now);
    const yesterday = utcDay(new Date(now.getTime() - DAY));
    const threeDaysAgo = utcDay(new Date(now.getTime() - 3 * DAY));

    await db.insert(campaignStatusTransitions).values({
      campaignId: campaign.id,
      orgId: ORG,
      fromStatus: null,
      toStatus: "ongoing",
      reason: null,
      source: "record_opened",
      occurredAt: new Date(now.getTime() - 4 * DAY),
    });

    // Dry from four days ago until this morning, then somebody again. Exactly the shape the brief
    // asks for: a campaign that went dry and was later given an audience reads as earning again.
    await db.insert(campaignAudienceAvailability).values({
      campaignId: campaign.id,
      orgId: ORG,
      hasAudience: false,
      startedAt: new Date(now.getTime() - 4 * DAY),
      lastObservedAt: new Date(now.getTime() - DAY),
      endedAt: new Date(`${today}T00:30:00.000Z`),
    });
    await db.insert(campaignAudienceAvailability).values({
      campaignId: campaign.id,
      orgId: ORG,
      hasAudience: true,
      startedAt: new Date(`${today}T00:30:00.000Z`),
      lastObservedAt: now,
    });

    const read = await readHistory([campaign.id], threeDaysAgo, today).expect(200);
    const byDay = Object.fromEntries(
      read.body.campaigns[0].days.map((d: { day: string }) => [d.day, d]),
    );
    expect(byDay[threeDaysAgo]).toMatchObject({ status: "ongoing", audience: "exhausted", earning: false });
    expect(byDay[yesterday]).toMatchObject({ audience: "exhausted", earning: false });
    expect(byDay[today]).toMatchObject({ audience: "available", earning: true });
  }, 20000);

  it("records availability as PERIODS — one row per episode, not one per observation", async () => {
    const campaign = await insertTestCampaign(ORG, { status: "ongoing" });

    await recordAudienceAvailability(campaign.id, ORG, true);
    await recordAudienceAvailability(campaign.id, ORG, true);
    await recordAudienceAvailability(campaign.id, ORG, true);
    let rows = await db
      .select()
      .from(campaignAudienceAvailability)
      .where(eq(campaignAudienceAvailability.campaignId, campaign.id));
    expect(rows).toHaveLength(1);

    await recordAudienceAvailability(campaign.id, ORG, false);
    rows = await db
      .select()
      .from(campaignAudienceAvailability)
      .where(eq(campaignAudienceAvailability.campaignId, campaign.id));
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.endedAt === null)).toHaveLength(1);
    expect(rows.find((r) => r.endedAt === null)!.hasAudience).toBe(false);
  });

  it("refuses a range it cannot honestly answer at once", async () => {
    const bad = await readHistory([randomId()], "2026-03-10", "2026-03-01").expect(400);
    expect(bad.body.error).toMatch(/after/);

    const huge = await readHistory([randomId()], "2020-01-01", "2026-01-01").expect(400);
    expect(huge.body.error).toMatch(/at most/);
  });

  it("answers the single-campaign read the same way", async () => {
    const campaign = await insertTestCampaign(ORG, { status: "ongoing" });
    const today = utcDay(new Date());
    const res = await request(app)
      .get(`/internal/campaigns/${campaign.id}/earning-history`)
      .query({ from: today, to: today })
      .set("x-api-key", API_KEY)
      .expect(200);

    expect(res.body.campaigns).toHaveLength(1);
    expect(res.body.campaigns[0].campaignId).toBe(campaign.id);
    expect(res.body.campaigns[0].days).toHaveLength(1);
  });
});
