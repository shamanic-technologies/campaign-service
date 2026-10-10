import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";

// Mock external deps used by other internal routes (required for app import)
vi.mock("@distribute/runs-client", () => ({
  createRun: vi.fn(),
  updateRun: vi.fn(),
  listRuns: vi.fn(),
  getStatsBudget: vi.fn(),
}));

vi.mock("../../src/lib/workflows.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/lib/workflows.js")>();
  return { ...original, executeCampaignWorkflow: vi.fn() };
});

vi.mock("../../src/lib/gate-check.js", () => ({
  runGateChecks: vi.fn(),
}));

import app from "../../src/index.js";
import { db } from "../../src/db/index.js";
import {
  campaigns,
  campaignStatusTransitions,
  campaignAudienceAvailability,
  campaignAudienceExhaustion,
  brandPauseTransitions,
  triggerEvents,
  triggerPollCursors,
  salesFunnelCampaigns,
} from "../../src/db/schema.js";
import { eq, sql } from "drizzle-orm";
import { cleanTestData, closeDb, insertTestCampaign } from "../helpers/test-db.js";

const API_KEY = process.env.CAMPAIGN_SERVICE_API_KEY || "test-api-key";

// The two migration rollback snapshots exist in production (migrations 0058 / 0060) but are not
// in schema.ts, so `db:push` never builds them. Mirror their production columns here.
const SNAPSHOT_DDL = [
  sql`CREATE TABLE IF NOT EXISTS campaigns_funnel_key_snapshot_20260926 (
    id text, org_id text, brand_id text, offer_id text, acquisition_channel text, status text,
    funnel_key text, leg_key text, snapshotted_at timestamptz DEFAULT now())`,
  sql`CREATE TABLE IF NOT EXISTS campaign_funnel_owner_decisions_funnel_snapshot_20260926 (
    campaign_id text, org_id text, brand_id text, previous_funnel_key text, funnel_key text,
    decided_by text, decided_on text, source text, applied_at timestamptz DEFAULT now())`,
];

type Row = { org_id: string; brand_id: string | null };

async function snapshotRows(table: string, campaignColumn: string, campaignId: string): Promise<Row[]> {
  return (await db.execute(
    sql`SELECT org_id, brand_id FROM ${sql.raw(table)} WHERE ${sql.raw(campaignColumn)} = ${campaignId}`,
  )) as unknown as Row[];
}

describe("POST /internal/transfer-brand", () => {
  const sourceOrgId = "org_source_test";
  const targetOrgId = "org_target_test";
  const sourceBrandId = crypto.randomUUID();
  const targetBrandId = crypto.randomUUID();
  const otherBrandId = crypto.randomUUID();

  const post = (body: Record<string, unknown>) =>
    request(app).post("/internal/transfer-brand").set("x-api-key", API_KEY).send(body);
  const countFor = (res: request.Response, table: string) =>
    (res.body.updatedTables as Array<{ tableName: string; count: number }>).find((t) => t.tableName === table)?.count;

  beforeAll(async () => {
    for (const ddl of SNAPSHOT_DDL) await db.execute(ddl);
  });

  beforeEach(async () => {
    await cleanTestData();
    await db.execute(sql`DELETE FROM campaigns_funnel_key_snapshot_20260926`);
    await db.execute(sql`DELETE FROM campaign_funnel_owner_decisions_funnel_snapshot_20260926`);
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  /** A brand's campaign with a row in every table this service ties to the org. */
  async function seedBrandHistory(orgId: string, brandId: string, name: string) {
    const campaign = await insertTestCampaign(orgId, { name, brandIds: [brandId], brandId });
    await db.insert(campaignStatusTransitions).values([
      { campaignId: campaign.id, orgId, fromStatus: null, toStatus: "ongoing", source: "create" },
      { campaignId: campaign.id, orgId, fromStatus: "ongoing", toStatus: "stopped", reason: "manual", source: "patch" },
    ]);
    await db.insert(campaignAudienceAvailability).values({ campaignId: campaign.id, orgId, hasAudience: true });
    await db.insert(campaignAudienceExhaustion).values({ campaignId: campaign.id, audienceId: crypto.randomUUID() });
    await db.execute(sql`INSERT INTO campaigns_funnel_key_snapshot_20260926 (id, org_id, brand_id, funnel_key)
      VALUES (${campaign.id}, ${orgId}, ${brandId}, 'sales_meetings_from_conversation')`);
    await db.execute(sql`INSERT INTO campaign_funnel_owner_decisions_funnel_snapshot_20260926 (campaign_id, org_id, brand_id, funnel_key)
      VALUES (${campaign.id}, ${orgId}, ${brandId}, 'sales_meetings_from_conversation')`);
    return campaign;
  }

  /** Every org-tied row of the brand, per table, still under `orgId`. */
  async function remainingUnder(orgId: string, campaignId: string) {
    const [c] = await db.select().from(campaigns).where(eq(campaigns.id, campaignId));
    const st = await db.select().from(campaignStatusTransitions).where(eq(campaignStatusTransitions.campaignId, campaignId));
    const av = await db.select().from(campaignAudienceAvailability).where(eq(campaignAudienceAvailability.campaignId, campaignId));
    const fk = await snapshotRows("campaigns_funnel_key_snapshot_20260926", "id", campaignId);
    const fo = await snapshotRows("campaign_funnel_owner_decisions_funnel_snapshot_20260926", "campaign_id", campaignId);
    return {
      campaigns: c.orgId === orgId ? 1 : 0,
      statusTransitions: st.filter((r) => r.orgId === orgId).length,
      availability: av.filter((r) => r.orgId === orgId).length,
      funnelKeySnapshot: fk.filter((r) => r.org_id === orgId).length,
      funnelOwnerSnapshot: fo.filter((r) => r.org_id === orgId).length,
    };
  }

  const NOTHING = { campaigns: 0, statusTransitions: 0, availability: 0, funnelKeySnapshot: 0, funnelOwnerSnapshot: 0 };

  it("moves every table's rows of the brand to the target org, and nothing stays under the source org", async () => {
    const campaign = await seedBrandHistory(sourceOrgId, sourceBrandId, "Brand Campaign");
    await db.insert(brandPauseTransitions).values([
      { brandId: sourceBrandId, orgId: sourceOrgId, paused: true },
      { brandId: sourceBrandId, orgId: sourceOrgId, paused: false },
    ]);
    const now = new Date();
    await db.insert(triggerEvents).values({
      orgId: sourceOrgId, brandId: sourceBrandId, offerId: crypto.randomUUID(), triggerId: "positive_reply_received",
      recordedVia: "trigger_events", occurredAt: now, dueAt: now, status: "done", outcome: "skipped", skipReason: "no_campaign",
    });
    await db.insert(triggerPollCursors).values({
      triggerId: "post_reacted", orgId: sourceOrgId, brandId: sourceBrandId, offerId: crypto.randomUUID(), nextPollAt: now,
    });
    const [salesFunnelCampaign] = await db.insert(salesFunnelCampaigns).values({
      orgId: sourceOrgId, brandId: sourceBrandId, offerId: crypto.randomUUID(), salesFunnelId: "f@x", salesFunnelName: "Epiphany", status: "stopped",
    }).returning();

    const res = await post({ sourceBrandId, sourceOrgId, targetOrgId });

    expect(res.status).toBe(200);
    const [movedSalesFunnelCampaign] = await db.select().from(salesFunnelCampaigns).where(eq(salesFunnelCampaigns.id, salesFunnelCampaign.id));
    expect(movedSalesFunnelCampaign.orgId).toBe(targetOrgId);
    expect(res.body).toEqual({
      updatedTables: [
        { tableName: "campaigns", count: 1 },
        { tableName: "sales_funnel_campaigns", count: 1 },
        { tableName: "campaign_status_transitions", count: 2 },
        { tableName: "campaign_audience_availability", count: 1 },
        { tableName: "brand_pause_transitions", count: 2 },
        { tableName: "trigger_events", count: 1 },
        { tableName: "trigger_poll_cursors", count: 1 },
        { tableName: "campaigns_funnel_key_snapshot_20260926", count: 1 },
        { tableName: "campaign_funnel_owner_decisions_funnel_snapshot_20260926", count: 1 },
      ],
      coBrandedSkipped: 0,
    });

    expect(await remainingUnder(sourceOrgId, campaign.id)).toEqual(NOTHING);
    expect(await remainingUnder(targetOrgId, campaign.id)).toEqual({
      campaigns: 1, statusTransitions: 2, availability: 1, funnelKeySnapshot: 1, funnelOwnerSnapshot: 1,
    });
    const pauses = await db.select().from(brandPauseTransitions).where(eq(brandPauseTransitions.brandId, sourceBrandId));
    expect(pauses.map((p) => p.orgId)).toEqual([targetOrgId, targetOrgId]);
    const events = await db.select().from(triggerEvents).where(eq(triggerEvents.brandId, sourceBrandId));
    expect(events.map((e) => e.orgId)).toEqual([targetOrgId]);

    // No brand rewrite asked: the campaign keeps its brand, its status, its history.
    const [moved] = await db.select().from(campaigns).where(eq(campaigns.id, campaign.id));
    expect(moved.brandId).toBe(sourceBrandId);
    expect(moved.brandIds).toEqual([sourceBrandId]);
    expect(moved.status).toBe(campaign.status);

    // Exhaustion marks carry no org — they follow the campaign id, which never changes.
    const marks = await db.select().from(campaignAudienceExhaustion).where(eq(campaignAudienceExhaustion.campaignId, campaign.id));
    expect(marks).toHaveLength(1);
  });

  it("rewrites the brand id on every moved table when targetBrandId is given", async () => {
    const campaign = await seedBrandHistory(sourceOrgId, sourceBrandId, "Remap Campaign");
    await db.insert(brandPauseTransitions).values({ brandId: sourceBrandId, orgId: sourceOrgId, paused: true });

    const res = await post({ sourceBrandId, sourceOrgId, targetOrgId, targetBrandId });

    expect(res.status).toBe(200);
    expect(countFor(res, "campaigns")).toBe(1);
    expect(countFor(res, "campaign_status_transitions")).toBe(2);
    expect(countFor(res, "campaign_audience_availability")).toBe(1);
    expect(countFor(res, "brand_pause_transitions")).toBe(1);

    const [moved] = await db.select().from(campaigns).where(eq(campaigns.id, campaign.id));
    expect(moved.orgId).toBe(targetOrgId);
    expect(moved.brandId).toBe(targetBrandId);
    expect(moved.brandIds).toEqual([targetBrandId]);
    expect(await remainingUnder(sourceOrgId, campaign.id)).toEqual(NOTHING);

    const [pause] = await db.select().from(brandPauseTransitions);
    expect(pause).toMatchObject({ orgId: targetOrgId, brandId: targetBrandId });
    const [fk] = await snapshotRows("campaigns_funnel_key_snapshot_20260926", "id", campaign.id);
    expect(fk).toEqual({ org_id: targetOrgId, brand_id: targetBrandId });
    const [fo] = await snapshotRows("campaign_funnel_owner_decisions_funnel_snapshot_20260926", "campaign_id", campaign.id);
    expect(fo).toEqual({ org_id: targetOrgId, brand_id: targetBrandId });
  });

  it("is idempotent — a second call moves nothing and reports zeros (pure move and merge)", async () => {
    for (const body of [
      { sourceBrandId, sourceOrgId, targetOrgId },
      { sourceBrandId, sourceOrgId, targetOrgId, targetBrandId },
    ]) {
      await cleanTestData();
      const campaign = await seedBrandHistory(sourceOrgId, sourceBrandId, `Idempotent ${Object.keys(body).length}`);
      await db.insert(brandPauseTransitions).values({ brandId: sourceBrandId, orgId: sourceOrgId, paused: true });

      const first = await post(body);
      expect(countFor(first, "campaigns")).toBe(1);

      const second = await post(body);
      expect(second.status).toBe(200);
      for (const t of second.body.updatedTables) expect(t.count).toBe(0);
      expect(await remainingUnder(sourceOrgId, campaign.id)).toEqual(NOTHING);
    }
  });

  it("matches a campaign on its brand_id column even when brand_ids is empty", async () => {
    const campaign = await insertTestCampaign(sourceOrgId, { name: "brand_id only", brandIds: undefined, brandId: sourceBrandId });
    await db.update(campaigns).set({ brandIds: null }).where(eq(campaigns.id, campaign.id));

    const res = await post({ sourceBrandId, sourceOrgId, targetOrgId, targetBrandId });

    expect(countFor(res, "campaigns")).toBe(1);
    const [moved] = await db.select().from(campaigns).where(eq(campaigns.id, campaign.id));
    expect(moved).toMatchObject({ orgId: targetOrgId, brandId: targetBrandId, brandIds: null });
  });

  it("leaves co-branded campaigns in place and says how many", async () => {
    const coBranded = await insertTestCampaign(sourceOrgId, {
      name: "Co-Brand Campaign",
      brandIds: [sourceBrandId, otherBrandId],
      brandId: sourceBrandId,
    });
    await seedBrandHistory(sourceOrgId, sourceBrandId, "Solo");

    const res = await post({ sourceBrandId, sourceOrgId, targetOrgId });

    expect(countFor(res, "campaigns")).toBe(1);
    expect(res.body.coBrandedSkipped).toBe(1);
    const [row] = await db.select().from(campaigns).where(eq(campaigns.id, coBranded.id));
    expect(row.orgId).toBe(sourceOrgId);
  });

  it("never touches another org's rows of the same brand — not the org, not the brand id", async () => {
    // A brand row is a shared global identity: another org can claim the same brand.
    const thirdOrgId = "org_third_test";
    const third = await seedBrandHistory(thirdOrgId, sourceBrandId, "Third Org Campaign");
    await db.insert(brandPauseTransitions).values({ brandId: sourceBrandId, orgId: thirdOrgId, paused: true });
    await seedBrandHistory(sourceOrgId, sourceBrandId, "Source Org Campaign");

    const res = await post({ sourceBrandId, sourceOrgId, targetOrgId, targetBrandId });

    expect(countFor(res, "campaigns")).toBe(1);
    expect(countFor(res, "brand_pause_transitions")).toBe(0);
    const [row] = await db.select().from(campaigns).where(eq(campaigns.id, third.id));
    expect(row).toMatchObject({ orgId: thirdOrgId, brandId: sourceBrandId, brandIds: [sourceBrandId] });
    expect(await remainingUnder(thirdOrgId, third.id)).toEqual({
      campaigns: 1, statusTransitions: 2, availability: 1, funnelKeySnapshot: 1, funnelOwnerSnapshot: 1,
    });
    const [fk] = await snapshotRows("campaigns_funnel_key_snapshot_20260926", "id", third.id);
    expect(fk.brand_id).toBe(sourceBrandId);
    const [pause] = await db.select().from(brandPauseTransitions).where(eq(brandPauseTransitions.orgId, thirdOrgId));
    expect(pause.brandId).toBe(sourceBrandId);
  });

  it("skips campaigns of a different brand in the source org", async () => {
    await seedBrandHistory(sourceOrgId, otherBrandId, "Other Brand");

    const res = await post({ sourceBrandId, sourceOrgId, targetOrgId });

    for (const t of res.body.updatedTables) expect(t.count).toBe(0);
  });

  it("moves several campaigns at once", async () => {
    await seedBrandHistory(sourceOrgId, sourceBrandId, "Campaign A");
    await seedBrandHistory(sourceOrgId, sourceBrandId, "Campaign B");

    const res = await post({ sourceBrandId, sourceOrgId, targetOrgId });

    expect(countFor(res, "campaigns")).toBe(2);
    expect(countFor(res, "campaign_status_transitions")).toBe(4);
  });

  it("409s and moves NOTHING when a campaign name collides in the target org", async () => {
    const campaign = await seedBrandHistory(sourceOrgId, sourceBrandId, "Same Name");
    await insertTestCampaign(targetOrgId, { name: "Same Name", brandIds: [otherBrandId], status: "stopped" });

    const res = await post({ sourceBrandId, sourceOrgId, targetOrgId });

    expect(res.status).toBe(409);
    expect(res.body.constraint).toBe("uniq_campaigns_org_name");
    expect(await remainingUnder(sourceOrgId, campaign.id)).toEqual({
      campaigns: 1, statusTransitions: 2, availability: 1, funnelKeySnapshot: 1, funnelOwnerSnapshot: 1,
    });
  });

  it("returns 400 for invalid body", async () => {
    const res = await post({ sourceBrandId: "not-a-uuid" });
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid targetBrandId", async () => {
    const res = await post({ sourceBrandId, sourceOrgId, targetOrgId, targetBrandId: "not-a-uuid" });
    expect(res.status).toBe(400);
  });

  it("returns 401 without API key", async () => {
    const res = await request(app).post("/internal/transfer-brand").send({ sourceBrandId, sourceOrgId, targetOrgId });
    expect(res.status).toBe(401);
  });
});
