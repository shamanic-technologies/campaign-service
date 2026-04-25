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
  const sourceBrandId = crypto.randomUUID();
  const targetBrandId = crypto.randomUUID();
  const otherBrandId = crypto.randomUUID();

  beforeEach(async () => {
    await cleanTestData();
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("transfers solo-brand campaigns from source to target org (no targetBrandId)", async () => {
    const campaign = await insertTestCampaign(sourceOrgId, {
      name: "Solo Brand Campaign",
      brandIds: [sourceBrandId],
    });

    const res = await request(app)
      .post("/internal/transfer-brand")
      .set("x-api-key", API_KEY)
      .send({ sourceBrandId, sourceOrgId, targetOrgId });

    expect(res.status).toBe(200);
    expect(res.body.updatedTables).toEqual([
      { tableName: "campaigns", count: 1 },
    ]);

    // Verify the campaign now belongs to targetOrgId with same brand
    const updated = await db.query.campaigns.findFirst({
      where: eq(campaigns.id, campaign.id),
    });
    expect(updated!.orgId).toBe(targetOrgId);
    expect(updated!.brandIds).toEqual([sourceBrandId]);
  });

  it("transfers and remaps brand when targetBrandId is provided", async () => {
    const campaign = await insertTestCampaign(sourceOrgId, {
      name: "Remap Brand Campaign",
      brandIds: [sourceBrandId],
    });

    const res = await request(app)
      .post("/internal/transfer-brand")
      .set("x-api-key", API_KEY)
      .send({ sourceBrandId, sourceOrgId, targetOrgId, targetBrandId });

    expect(res.status).toBe(200);
    expect(res.body.updatedTables).toEqual([
      { tableName: "campaigns", count: 1 },
    ]);

    // Verify org AND brand were updated
    const updated = await db.query.campaigns.findFirst({
      where: eq(campaigns.id, campaign.id),
    });
    expect(updated!.orgId).toBe(targetOrgId);
    expect(updated!.brandIds).toEqual([targetBrandId]);
  });

  it("skips co-branding campaigns (multiple brand IDs)", async () => {
    await insertTestCampaign(sourceOrgId, {
      name: "Co-Brand Campaign",
      brandIds: [sourceBrandId, otherBrandId],
    });

    const res = await request(app)
      .post("/internal/transfer-brand")
      .set("x-api-key", API_KEY)
      .send({ sourceBrandId, sourceOrgId, targetOrgId });

    expect(res.status).toBe(200);
    expect(res.body.updatedTables).toEqual([
      { tableName: "campaigns", count: 0 },
    ]);
  });

  it("skips campaigns belonging to a different org", async () => {
    await insertTestCampaign("org_other", {
      name: "Other Org Campaign",
      brandIds: [sourceBrandId],
    });

    const res = await request(app)
      .post("/internal/transfer-brand")
      .set("x-api-key", API_KEY)
      .send({ sourceBrandId, sourceOrgId, targetOrgId });

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
      .send({ sourceBrandId, sourceOrgId, targetOrgId });

    expect(res.status).toBe(200);
    expect(res.body.updatedTables).toEqual([
      { tableName: "campaigns", count: 0 },
    ]);
  });

  it("is idempotent — second run is a no-op", async () => {
    await insertTestCampaign(sourceOrgId, {
      name: "Idempotent Campaign",
      brandIds: [sourceBrandId],
    });

    // First call transfers
    const res1 = await request(app)
      .post("/internal/transfer-brand")
      .set("x-api-key", API_KEY)
      .send({ sourceBrandId, sourceOrgId, targetOrgId });

    expect(res1.body.updatedTables[0].count).toBe(1);

    // Second call is a no-op (already transferred)
    const res2 = await request(app)
      .post("/internal/transfer-brand")
      .set("x-api-key", API_KEY)
      .send({ sourceBrandId, sourceOrgId, targetOrgId });

    expect(res2.status).toBe(200);
    expect(res2.body.updatedTables[0].count).toBe(0);
  });

  it("is idempotent with targetBrandId — second run is a no-op", async () => {
    await insertTestCampaign(sourceOrgId, {
      name: "Idempotent Remap Campaign",
      brandIds: [sourceBrandId],
    });

    const res1 = await request(app)
      .post("/internal/transfer-brand")
      .set("x-api-key", API_KEY)
      .send({ sourceBrandId, sourceOrgId, targetOrgId, targetBrandId });

    expect(res1.body.updatedTables[0].count).toBe(1);

    // Second call: sourceBrandId no longer exists in source org
    const res2 = await request(app)
      .post("/internal/transfer-brand")
      .set("x-api-key", API_KEY)
      .send({ sourceBrandId, sourceOrgId, targetOrgId, targetBrandId });

    expect(res2.status).toBe(200);
    expect(res2.body.updatedTables[0].count).toBe(0);
  });

  it("transfers multiple matching campaigns at once", async () => {
    await insertTestCampaign(sourceOrgId, {
      name: "Campaign A",
      brandIds: [sourceBrandId],
    });
    await insertTestCampaign(sourceOrgId, {
      name: "Campaign B",
      brandIds: [sourceBrandId],
    });
    // This one should NOT be transferred (co-brand)
    await insertTestCampaign(sourceOrgId, {
      name: "Campaign C Co-Brand",
      brandIds: [sourceBrandId, otherBrandId],
    });

    const res = await request(app)
      .post("/internal/transfer-brand")
      .set("x-api-key", API_KEY)
      .send({ sourceBrandId, sourceOrgId, targetOrgId });

    expect(res.status).toBe(200);
    expect(res.body.updatedTables[0].count).toBe(2);
  });

  it("step 2 remaps brand_ids across all orgs (no org filter)", async () => {
    // Campaign in source org — step 1 moves it, step 2 remaps it
    const campaignSource = await insertTestCampaign(sourceOrgId, {
      name: "Source Org Campaign",
      brandIds: [sourceBrandId],
    });

    // Campaign in a third org with same sourceBrandId — step 1 skips it, step 2 remaps it
    const thirdOrgId = "org_third_test";
    const campaignThird = await insertTestCampaign(thirdOrgId, {
      name: "Third Org Campaign",
      brandIds: [sourceBrandId],
    });

    const res = await request(app)
      .post("/internal/transfer-brand")
      .set("x-api-key", API_KEY)
      .send({ sourceBrandId, sourceOrgId, targetOrgId, targetBrandId });

    expect(res.status).toBe(200);
    // count reflects max(step1=1, step2=2) = 2
    expect(res.body.updatedTables[0].count).toBe(2);

    // Source campaign: moved to targetOrg AND brand remapped
    const updatedSource = await db.query.campaigns.findFirst({
      where: eq(campaigns.id, campaignSource.id),
    });
    expect(updatedSource!.orgId).toBe(targetOrgId);
    expect(updatedSource!.brandIds).toEqual([targetBrandId]);

    // Third org campaign: stayed in thirdOrg but brand was remapped
    const updatedThird = await db.query.campaigns.findFirst({
      where: eq(campaigns.id, campaignThird.id),
    });
    expect(updatedThird!.orgId).toBe(thirdOrgId);
    expect(updatedThird!.brandIds).toEqual([targetBrandId]);
  });

  it("returns 400 for invalid body", async () => {
    const res = await request(app)
      .post("/internal/transfer-brand")
      .set("x-api-key", API_KEY)
      .send({ sourceBrandId: "not-a-uuid" });

    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid targetBrandId", async () => {
    const res = await request(app)
      .post("/internal/transfer-brand")
      .set("x-api-key", API_KEY)
      .send({ sourceBrandId, sourceOrgId, targetOrgId, targetBrandId: "not-a-uuid" });

    expect(res.status).toBe(400);
  });

  it("returns 401 without API key", async () => {
    const res = await request(app)
      .post("/internal/transfer-brand")
      .send({ sourceBrandId, sourceOrgId, targetOrgId });

    expect(res.status).toBe(401);
  });
});
