import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
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
import { brandPause, campaigns } from "../../src/db/schema.js";
import { and, eq } from "drizzle-orm";
import { cleanTestData, closeDb, insertTestCampaign, setBrandPause } from "../helpers/test-db.js";

const API_KEY = process.env.CAMPAIGN_SERVICE_API_KEY || "test-api-key";

describe("DELETE /internal/campaigns/by-org/:orgId", () => {
  beforeEach(async () => {
    await cleanTestData();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("deletes campaign-owned org state and leaves other orgs untouched", async () => {
    const orgId = crypto.randomUUID();
    const otherOrgId = crypto.randomUUID();
    const brandId = crypto.randomUUID();
    const otherBrandId = crypto.randomUUID();
    const campaign = await insertTestCampaign(orgId, {
      name: "Active Org Campaign",
      brandIds: [brandId],
      status: "ongoing",
      nextRunAt: new Date(Date.now() - 60_000),
      createdByUserId: crypto.randomUUID(),
      featureSlug: "sales-cold-email-v1",
    });
    const stoppedCampaign = await insertTestCampaign(orgId, {
      name: "Stopped Org Campaign",
      brandIds: [crypto.randomUUID()],
      status: "stopped",
    });
    const otherCampaign = await insertTestCampaign(otherOrgId, {
      name: "Other Org Campaign",
      brandIds: [otherBrandId],
      status: "ongoing",
    });
    await setBrandPause(orgId, brandId, true);
    await setBrandPause(otherOrgId, otherBrandId, true);

    const res = await request(app)
      .delete(`/internal/campaigns/by-org/${orgId}`)
      .set("x-api-key", API_KEY)
      .expect(200);

    expect(res.body).toEqual({
      orgId,
      deletedTables: [
        { tableName: "campaigns", count: 2 },
        { tableName: "brand_pause", count: 1 },
      ],
    });

    const deletedActive = await db.query.campaigns.findFirst({
      where: eq(campaigns.id, campaign.id),
    });
    const deletedStopped = await db.query.campaigns.findFirst({
      where: eq(campaigns.id, stoppedCampaign.id),
    });
    const deletedPause = await db.query.brandPause.findFirst({
      where: and(eq(brandPause.orgId, orgId), eq(brandPause.brandId, brandId)),
    });
    const remainingOtherCampaign = await db.query.campaigns.findFirst({
      where: eq(campaigns.id, otherCampaign.id),
    });
    const remainingOtherPause = await db.query.brandPause.findFirst({
      where: and(eq(brandPause.orgId, otherOrgId), eq(brandPause.brandId, otherBrandId)),
    });

    expect(deletedActive).toBeUndefined();
    expect(deletedStopped).toBeUndefined();
    expect(deletedPause).toBeUndefined();
    expect(remainingOtherCampaign).toBeDefined();
    expect(remainingOtherPause).toBeDefined();
  });

  it("is idempotent when no campaign-owned org state remains", async () => {
    const orgId = crypto.randomUUID();
    const brandId = crypto.randomUUID();
    await insertTestCampaign(orgId, { brandIds: [brandId] });
    await setBrandPause(orgId, brandId, true);

    const first = await request(app)
      .delete(`/internal/campaigns/by-org/${orgId}`)
      .set("x-api-key", API_KEY)
      .expect(200);
    expect(first.body.deletedTables).toEqual([
      { tableName: "campaigns", count: 1 },
      { tableName: "brand_pause", count: 1 },
    ]);

    const second = await request(app)
      .delete(`/internal/campaigns/by-org/${orgId}`)
      .set("x-api-key", API_KEY)
      .expect(200);
    expect(second.body.deletedTables).toEqual([
      { tableName: "campaigns", count: 0 },
      { tableName: "brand_pause", count: 0 },
    ]);
  });

  it("returns 200 with zero counts for an org that never had campaign state", async () => {
    const orgId = crypto.randomUUID();

    const res = await request(app)
      .delete(`/internal/campaigns/by-org/${orgId}`)
      .set("x-api-key", API_KEY)
      .expect(200);

    expect(res.body.deletedTables).toEqual([
      { tableName: "campaigns", count: 0 },
      { tableName: "brand_pause", count: 0 },
    ]);
  });

  it("requires service API key auth", async () => {
    await request(app)
      .delete(`/internal/campaigns/by-org/${crypto.randomUUID()}`)
      .expect(401);

    await request(app)
      .delete(`/internal/campaigns/by-org/${crypto.randomUUID()}`)
      .set("x-api-key", "wrong-key")
      .expect(401);
  });

  it("returns non-2xx when the database transaction fails", async () => {
    const orgId = crypto.randomUUID();
    vi.spyOn(db, "transaction").mockRejectedValueOnce(new Error("database unavailable"));

    const res = await request(app)
      .delete(`/internal/campaigns/by-org/${orgId}`)
      .set("x-api-key", API_KEY)
      .expect(500);

    expect(res.body.error).toBe("Internal server error");
  });
});
