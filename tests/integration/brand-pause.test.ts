import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

// Keep workflow + runs-client inert so the scheduler under test never actually fires a flow
// and always sees "no live run" (→ campaigns are eligible to claim unless a pause holds them).
const { mockExecute } = vi.hoisted(() => ({ mockExecute: vi.fn() }));

vi.mock("../../src/lib/workflows.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/lib/workflows.js")>();
  return { ...original, executeCampaignWorkflow: mockExecute };
});

vi.mock("@distribute/runs-client", () => ({
  listRuns: vi.fn().mockResolvedValue({ runs: [] }),
  createRun: vi.fn().mockResolvedValue({ id: "run-1" }),
  updateRun: vi.fn(),
  getStatsBudget: vi.fn(),
}));

import request from "supertest";
import { eq } from "drizzle-orm";
import app from "../../src/index.js";
import { db } from "../../src/db/index.js";
import { campaigns } from "../../src/db/schema.js";
import { cleanTestData, closeDb, insertTestCampaign, setBrandPause } from "../helpers/test-db.js";
import { reRunDueCampaigns, claimStuckCampaigns } from "../../src/lib/scheduler.js";

const API_KEY = process.env.CAMPAIGN_SERVICE_API_KEY || "test-api-key";
const orgId = "brand-pause-org";
const past = () => new Date(Date.now() - 60_000);

function getPause(brandId: string, org = orgId) {
  return request(app).get(`/brands/${brandId}/pause`).set("x-api-key", API_KEY).set("x-org-id", org);
}
function patchPause(brandId: string, paused: boolean, org = orgId) {
  return request(app)
    .patch(`/brands/${brandId}/pause`)
    .set("x-api-key", API_KEY)
    .set("x-org-id", org)
    .set("Content-Type", "application/json")
    .send({ paused });
}

// One afterAll at FILE scope (single shared pg pool across describe blocks).
afterAll(async () => {
  await cleanTestData();
  await closeDb();
});

describe("Brand pause routes", () => {
  beforeEach(async () => {
    await cleanTestData();
    vi.clearAllMocks();
    mockExecute.mockResolvedValue(undefined);
  });

  it("GET returns paused=false, updatedAt=null when no row exists", async () => {
    const brandId = crypto.randomUUID();
    const res = await getPause(brandId).expect(200);
    expect(res.body).toEqual({ brandId, orgId, paused: false, updatedAt: null });
  });

  it("PATCH {paused:true} then GET returns paused=true", async () => {
    const brandId = crypto.randomUUID();
    const patched = await patchPause(brandId, true).expect(200);
    expect(patched.body.paused).toBe(true);
    expect(patched.body.brandId).toBe(brandId);
    expect(patched.body.orgId).toBe(orgId);
    expect(patched.body.updatedAt).not.toBeNull();

    const got = await getPause(brandId).expect(200);
    expect(got.body.paused).toBe(true);
  });

  it("PATCH upserts in place (single row, flips value)", async () => {
    const brandId = crypto.randomUUID();
    await patchPause(brandId, true).expect(200);
    await patchPause(brandId, false).expect(200);

    const got = await getPause(brandId).expect(200);
    expect(got.body.paused).toBe(false);

    // Exactly one row exists for the brand.
    const rows = await db.query.brandPause.findMany({ where: (b, { eq: e }) => e(b.brandId, brandId) });
    expect(rows).toHaveLength(1);
  });

  it("PATCH rejects a non-boolean paused body (400, fail-loud)", async () => {
    const brandId = crypto.randomUUID();
    await request(app)
      .patch(`/brands/${brandId}/pause`)
      .set("x-api-key", API_KEY)
      .set("x-org-id", orgId)
      .send({ paused: "yes" })
      .expect(400);
  });

  it("is org-scoped: org B cannot see org A's pause state", async () => {
    const brandId = crypto.randomUUID();
    await patchPause(brandId, true, "org-A").expect(200);

    const otherOrg = await getPause(brandId, "org-B").expect(200);
    expect(otherOrg.body.paused).toBe(false);
    expect(otherOrg.body.orgId).toBe("org-B");
  });

  it("requires x-org-id (400)", async () => {
    const brandId = crypto.randomUUID();
    await request(app).get(`/brands/${brandId}/pause`).set("x-api-key", API_KEY).expect(400);
  });

  it("requires a valid api key (401)", async () => {
    const brandId = crypto.randomUUID();
    await request(app).get(`/brands/${brandId}/pause`).set("x-api-key", "wrong").set("x-org-id", orgId).expect(401);
  });
});

describe("Scheduler holds paused-brand campaigns", () => {
  beforeEach(async () => {
    await cleanTestData();
    vi.clearAllMocks();
    mockExecute.mockResolvedValue(undefined);
  });

  it("reRunDueCampaigns does NOT claim a due campaign whose brand is paused, and leaves status=ongoing", async () => {
    const brandId = crypto.randomUUID();
    const campaign = await insertTestCampaign(orgId, {
      status: "ongoing",
      nextRunAt: past(),
      brandIds: [brandId],
      featureSlug: "sales-cold-email-v1",
      createdByUserId: "user-x",
    });
    await setBrandPause(orgId, brandId, true);

    const count = await reRunDueCampaigns();
    expect(count).toBe(0);
    expect(mockExecute).not.toHaveBeenCalled();

    const after = await db.query.campaigns.findFirst({ where: eq(campaigns.id, campaign.id) });
    expect(after!.status).toBe("ongoing"); // held, NOT stopped
    expect(after!.nextRunAt).not.toBeNull(); // nextRunAt untouched (not claimed)
  });

  it("reRunDueCampaigns DOES claim a due campaign whose brand is not paused", async () => {
    const brandId = crypto.randomUUID();
    await insertTestCampaign(orgId, {
      status: "ongoing",
      nextRunAt: past(),
      brandIds: [brandId],
      featureSlug: "sales-cold-email-v1",
      createdByUserId: "user-x",
    });
    // No pause row (or paused=false) → unaffected.
    await setBrandPause(orgId, brandId, false);

    const count = await reRunDueCampaigns();
    expect(count).toBe(1);
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  it("holds a multi-brand campaign if ANY one of its brands is paused", async () => {
    const b1 = crypto.randomUUID();
    const b2 = crypto.randomUUID();
    await insertTestCampaign(orgId, {
      status: "ongoing",
      nextRunAt: past(),
      brandIds: [b1, b2],
      featureSlug: "sales-cold-email-v1",
      createdByUserId: "user-x",
    });
    await setBrandPause(orgId, b2, true); // only the second brand is paused

    const count = await reRunDueCampaigns();
    expect(count).toBe(0);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("a pause in a DIFFERENT org does not hold this org's campaign", async () => {
    const brandId = crypto.randomUUID();
    await insertTestCampaign(orgId, {
      status: "ongoing",
      nextRunAt: past(),
      brandIds: [brandId],
      featureSlug: "sales-cold-email-v1",
      createdByUserId: "user-x",
    });
    await setBrandPause("some-other-org", brandId, true); // same brandId, wrong org

    const count = await reRunDueCampaigns();
    expect(count).toBe(1); // not held — pause is org-scoped
  });

  it("claimStuckCampaigns does NOT claim a stuck campaign whose brand is paused", async () => {
    const brandId = crypto.randomUUID();
    const campaign = await insertTestCampaign(orgId, {
      status: "ongoing",
      nextRunAt: null, // stuck shape: ongoing + no nextRunAt
      brandIds: [brandId],
    });
    await setBrandPause(orgId, brandId, true);

    const claimed = await claimStuckCampaigns();
    expect(claimed).toBe(0);

    const after = await db.query.campaigns.findFirst({ where: eq(campaigns.id, campaign.id) });
    expect(after!.nextRunAt).toBeNull(); // not claimed
  });

  it("un-pausing resumes: held while paused, claimed on the next tick after un-pause", async () => {
    const brandId = crypto.randomUUID();
    await insertTestCampaign(orgId, {
      status: "ongoing",
      nextRunAt: past(),
      brandIds: [brandId],
      featureSlug: "sales-cold-email-v1",
      createdByUserId: "user-x",
    });
    await setBrandPause(orgId, brandId, true);

    expect(await reRunDueCampaigns()).toBe(0); // held

    await setBrandPause(orgId, brandId, false); // un-pause
    expect(await reRunDueCampaigns()).toBe(1); // resumed, zero re-launch
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });
});
