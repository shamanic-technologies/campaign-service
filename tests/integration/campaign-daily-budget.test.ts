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
