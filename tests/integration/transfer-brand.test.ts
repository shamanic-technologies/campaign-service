import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
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
import { campaigns } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import { cleanTestData, closeDb, insertTestCampaign } from "../helpers/test-db.js";

const API_KEY = process.env.CAMPAIGN_SERVICE_API_KEY || "test-api-key";

describe("POST /internal/transfer-brand", () => {
  const sourceOrgId = "org_source_test";
  const targetOrgId = "org_target_test";
  const brandId = crypto.randomUUID();
  const otherBrandId = crypto.randomUUID();

  beforeEach(async () => {
    await cleanTestData();
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("transfers solo-brand campaigns from source to target org", async () => {
    // Insert a solo-brand campaign matching the brandId
    const campaign = await insertTestCampaign(sourceOrgId, {
      name: "Solo Brand Campaign",
      brandIds: [brandId],
    });

    const res = await request(app)
      .post("/internal/transfer-brand")
      .set("x-api-key", API_KEY)
      .send({ brandId, sourceOrgId, targetOrgId });

    expect(res.status).toBe(200);
    expect(res.body.updatedTables).toEqual([
      { tableName: "campaigns", count: 1 },
    ]);

    // Verify the campaign now belongs to targetOrgId
    const updated = await db.query.campaigns.findFirst({
      where: eq(campaigns.id, campaign.id),
    });
    expect(updated!.orgId).toBe(targetOrgId);
  });

  it("skips co-branding campaigns (multiple brand IDs)", async () => {
    // Insert a co-branding campaign with brandId + another
    await insertTestCampaign(sourceOrgId, {
      name: "Co-Brand Campaign",
      brandIds: [brandId, otherBrandId],
    });

    const res = await request(app)
      .post("/internal/transfer-brand")
      .set("x-api-key", API_KEY)
      .send({ brandId, sourceOrgId, targetOrgId });

    expect(res.status).toBe(200);
    expect(res.body.updatedTables).toEqual([
      { tableName: "campaigns", count: 0 },
    ]);
  });

  it("skips campaigns belonging to a different org", async () => {
    await insertTestCampaign("org_other", {
      name: "Other Org Campaign",
      brandIds: [brandId],
    });

    const res = await request(app)
      .post("/internal/transfer-brand")
      .set("x-api-key", API_KEY)
      .send({ brandId, sourceOrgId, targetOrgId });

    expect(res.status).toBe(200);
    expect(res.body.updatedTables).toEqual([
      { tableName: "campaigns", count: 0 },
    ]);
  });

  it("skips campaigns with a different brand ID", async () => {
    await insertTestCampaign(sourceOrgId, {
      name: "Different Brand Campaign",
      brandIds: [otherBrandId],
    });

    const res = await request(app)
      .post("/internal/transfer-brand")
      .set("x-api-key", API_KEY)
      .send({ brandId, sourceOrgId, targetOrgId });

    expect(res.status).toBe(200);
    expect(res.body.updatedTables).toEqual([
      { tableName: "campaigns", count: 0 },
    ]);
  });

  it("is idempotent — second run is a no-op", async () => {
    await insertTestCampaign(sourceOrgId, {
      name: "Idempotent Campaign",
      brandIds: [brandId],
    });

    // First call transfers
    const res1 = await request(app)
      .post("/internal/transfer-brand")
      .set("x-api-key", API_KEY)
      .send({ brandId, sourceOrgId, targetOrgId });

    expect(res1.body.updatedTables[0].count).toBe(1);

    // Second call is a no-op (already transferred)
    const res2 = await request(app)
      .post("/internal/transfer-brand")
      .set("x-api-key", API_KEY)
      .send({ brandId, sourceOrgId, targetOrgId });

    expect(res2.status).toBe(200);
    expect(res2.body.updatedTables[0].count).toBe(0);
  });

  it("transfers multiple matching campaigns at once", async () => {
    await insertTestCampaign(sourceOrgId, {
      name: "Campaign A",
      brandIds: [brandId],
    });
    await insertTestCampaign(sourceOrgId, {
      name: "Campaign B",
      brandIds: [brandId],
    });
    // This one should NOT be transferred (co-brand)
    await insertTestCampaign(sourceOrgId, {
      name: "Campaign C Co-Brand",
      brandIds: [brandId, otherBrandId],
    });

    const res = await request(app)
      .post("/internal/transfer-brand")
      .set("x-api-key", API_KEY)
      .send({ brandId, sourceOrgId, targetOrgId });

    expect(res.status).toBe(200);
    expect(res.body.updatedTables[0].count).toBe(2);
  });

  it("returns 400 for invalid body", async () => {
    const res = await request(app)
      .post("/internal/transfer-brand")
      .set("x-api-key", API_KEY)
      .send({ brandId: "not-a-uuid" });

    expect(res.status).toBe(400);
  });

  it("returns 401 without API key", async () => {
    const res = await request(app)
      .post("/internal/transfer-brand")
      .send({ brandId, sourceOrgId, targetOrgId });

    expect(res.status).toBe(401);
  });
});
