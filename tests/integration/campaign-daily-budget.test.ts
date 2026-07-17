import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

// Keep workflow + runs-client inert — these routes never fire a flow.
vi.mock("../../src/lib/workflows.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/lib/workflows.js")>();
  return { ...original, executeCampaignWorkflow: vi.fn() };
});

vi.mock("@distribute/runs-client", () => ({
  listRuns: vi.fn().mockResolvedValue({ runs: [] }),
  createRun: vi.fn().mockResolvedValue({ id: "run-1" }),
  updateRun: vi.fn(),
  getStatsBudget: vi.fn(),
}));

import request from "supertest";
import { and, eq } from "drizzle-orm";
import app from "../../src/index.js";
import { db } from "../../src/db/index.js";
import { campaigns } from "../../src/db/schema.js";
import { cleanTestData, closeDb, insertTestCampaign } from "../helpers/test-db.js";

const API_KEY = process.env.CAMPAIGN_SERVICE_API_KEY || "test-api-key";
const SALES = "sales-cold-email-outreach";
const orgId = "daily-budget-org";
const otherOrg = "daily-budget-org-2";

function patchBrandBudget(brandId: string, dailyBudgetCents: number | null, org = orgId) {
  return request(app)
    .patch(`/brands/${brandId}/daily-budget`)
    .set("x-api-key", API_KEY)
    .set("x-org-id", org)
    .set("Content-Type", "application/json")
    .send({ dailyBudgetCents });
}

function patchCampaign(id: string, body: Record<string, unknown>, org = orgId) {
  return request(app)
    .patch(`/campaigns/${id}`)
    .set("x-api-key", API_KEY)
    .set("x-org-id", org)
    .set("Content-Type", "application/json")
    .send(body);
}

async function dbBudget(id: string): Promise<number | null> {
  const row = await db.query.campaigns.findFirst({ where: eq(campaigns.id, id) });
  return row!.dailyBudgetCents;
}

afterAll(async () => {
  await cleanTestData();
  await closeDb();
});

describe("PATCH /campaigns/:id — set one campaign's daily budget (NEED 5a)", () => {
  beforeEach(async () => {
    await cleanTestData();
  });

  it("sets and later clears the campaign's own daily budget", async () => {
    const c = await insertTestCampaign(orgId, { brandIds: ["brand-1"], featureSlug: SALES });
    expect(await dbBudget(c.id)).toBeNull();

    const set = await patchCampaign(c.id, { dailyBudgetCents: 2500 });
    expect(set.status).toBe(200);
    expect(set.body.campaign.dailyBudgetCents).toBe(2500);
    expect(await dbBudget(c.id)).toBe(2500);

    const clear = await patchCampaign(c.id, { dailyBudgetCents: null });
    expect(clear.status).toBe(200);
    expect(clear.body.campaign.dailyBudgetCents).toBeNull();
    expect(await dbBudget(c.id)).toBeNull();
  });

  it("GET /campaigns/:id returns dailyBudgetCents", async () => {
    const c = await insertTestCampaign(orgId, { brandIds: ["brand-1"], featureSlug: SALES, dailyBudgetCents: 700 });
    const res = await request(app).get(`/campaigns/${c.id}`).set("x-api-key", API_KEY).set("x-org-id", orgId);
    expect(res.status).toBe(200);
    expect(res.body.campaign.dailyBudgetCents).toBe(700);
  });

  it("rejects a negative budget", async () => {
    const c = await insertTestCampaign(orgId, { brandIds: ["brand-1"], featureSlug: SALES });
    const res = await patchCampaign(c.id, { dailyBudgetCents: -5 });
    expect(res.status).toBe(400);
  });
});

describe("PATCH /brands/:brandId/daily-budget — propagate to ALL brand campaigns (NEED 5b)", () => {
  beforeEach(async () => {
    await cleanTestData();
  });

  it("sets the daily budget on every sales campaign of the brand at once", async () => {
    const a = await insertTestCampaign(orgId, { name: "A", brandIds: ["brand-1"], featureSlug: SALES });
    const b = await insertTestCampaign(orgId, { name: "B", brandIds: ["brand-1"], featureSlug: SALES });

    const res = await patchBrandBudget("brand-1", 3000);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ brandId: "brand-1", orgId, dailyBudgetCents: 3000, updatedCount: 2 });
    expect(await dbBudget(a.id)).toBe(3000);
    expect(await dbBudget(b.id)).toBe(3000);
  });

  it("null clears the budget on all the brand's campaigns → they fall back to the brand budget", async () => {
    const a = await insertTestCampaign(orgId, { brandIds: ["brand-1"], featureSlug: SALES, dailyBudgetCents: 3000 });
    const res = await patchBrandBudget("brand-1", null);
    expect(res.status).toBe(200);
    expect(res.body.dailyBudgetCents).toBeNull();
    expect(await dbBudget(a.id)).toBeNull();
  });

  it("does NOT touch another org's campaigns for the same brandId", async () => {
    const mine = await insertTestCampaign(orgId, { brandIds: ["brand-shared"], featureSlug: SALES });
    const theirs = await insertTestCampaign(otherOrg, { brandIds: ["brand-shared"], featureSlug: SALES });

    const res = await patchBrandBudget("brand-shared", 4200);
    expect(res.body.updatedCount).toBe(1);
    expect(await dbBudget(mine.id)).toBe(4200);
    expect(await dbBudget(theirs.id)).toBeNull();
  });

  it("does NOT touch non-sales campaigns (budget only paces the sales feature)", async () => {
    const sales = await insertTestCampaign(orgId, { brandIds: ["brand-2"], featureSlug: SALES });
    const nonSales = await insertTestCampaign(orgId, { brandIds: ["brand-2"], featureSlug: "pr-expert-quote-opportunities" });

    const res = await patchBrandBudget("brand-2", 900);
    expect(res.body.updatedCount).toBe(1);
    expect(await dbBudget(sales.id)).toBe(900);
    expect(await dbBudget(nonSales.id)).toBeNull();
  });

  it("updatedCount 0 when the brand has no campaigns", async () => {
    const res = await patchBrandBudget("brand-none", 1000);
    expect(res.status).toBe(200);
    expect(res.body.updatedCount).toBe(0);
  });

  it("rejects a negative budget", async () => {
    const res = await patchBrandBudget("brand-1", -1);
    expect(res.status).toBe(400);
  });
});
