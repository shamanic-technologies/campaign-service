import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";

vi.mock("@distribute/runs-client", () => ({
  createRun: vi.fn(),
  updateRun: vi.fn(),
  listRuns: vi.fn(),
  getStatsBudget: vi.fn(),
}));

// Workflow bandit resolves to the campaign's configured slug (fallback) so the
// scheduler trigger does not make real network calls during integration tests.
vi.mock("../../src/lib/features-workflow-projection-client.js", () => ({
  resolveWorkflowSlugForTrigger: vi.fn(async (a) => a.fallbackSlug),
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
import { brandPauseTransitions, campaigns } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import { cleanTestData, closeDb, insertTestCampaign } from "../helpers/test-db.js";

const API_KEY = process.env.CAMPAIGN_SERVICE_API_KEY || "test-api-key";

describe("DELETE /internal/campaigns/by-org/:orgId", () => {
  const orgId = crypto.randomUUID();
  const otherOrgId = crypto.randomUUID();

  beforeEach(async () => {
    await cleanTestData();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("stops org campaigns, clears scheduler candidates, and removes the org's pause-history rows", async () => {
    const orgBrandId = crypto.randomUUID();
    const otherBrandId = crypto.randomUUID();
    const queuedCampaign = await insertTestCampaign(orgId, {
      status: "ongoing",
      nextRunAt: new Date(Date.now() + 60_000),
      brandIds: [orgBrandId],
    });
    const claimedCampaign = await insertTestCampaign(orgId, {
      status: "ongoing",
      nextRunAt: null,
      brandIds: [orgBrandId],
    });
    const alreadyStoppedCampaign = await insertTestCampaign(orgId, {
      status: "stopped",
      nextRunAt: null,
      brandIds: [orgBrandId],
    });
    const otherOrgCampaign = await insertTestCampaign(otherOrgId, {
      status: "ongoing",
      nextRunAt: new Date(Date.now() + 60_000),
      brandIds: [otherBrandId],
    });
    // A recorded pause transition for this org (cascade target) + one for the other org (survives).
    await db.insert(brandPauseTransitions).values({ brandId: orgBrandId, orgId, paused: true });
    await db.insert(brandPauseTransitions).values({ brandId: otherBrandId, orgId: otherOrgId, paused: true });

    const res = await request(app)
      .delete(`/internal/campaigns/by-org/${orgId}`)
      .set("x-api-key", API_KEY)
      .expect(200);

    expect(res.body.updatedTables).toEqual([
      { tableName: "campaigns", count: 2 },
      { tableName: "brand_pause_transitions", count: 1 },
    ]);

    const queuedAfter = await db.query.campaigns.findFirst({ where: eq(campaigns.id, queuedCampaign.id) });
    expect(queuedAfter!.status).toBe("stopped");
    expect(queuedAfter!.nextRunAt).toBeNull();

    const claimedAfter = await db.query.campaigns.findFirst({ where: eq(campaigns.id, claimedCampaign.id) });
    expect(claimedAfter!.status).toBe("stopped");
    expect(claimedAfter!.nextRunAt).toBeNull();

    const stoppedAfter = await db.query.campaigns.findFirst({ where: eq(campaigns.id, alreadyStoppedCampaign.id) });
    expect(stoppedAfter!.status).toBe("stopped");
    expect(stoppedAfter!.nextRunAt).toBeNull();

    const otherOrgAfter = await db.query.campaigns.findFirst({ where: eq(campaigns.id, otherOrgCampaign.id) });
    expect(otherOrgAfter!.status).toBe("ongoing");
    expect(otherOrgAfter!.nextRunAt).not.toBeNull();

    const orgTransitions = await db.query.brandPauseTransitions.findMany({ where: eq(brandPauseTransitions.orgId, orgId) });
    expect(orgTransitions).toHaveLength(0);
    const otherTransitions = await db.query.brandPauseTransitions.findMany({ where: eq(brandPauseTransitions.orgId, otherOrgId) });
    expect(otherTransitions).toHaveLength(1);
  });

  it("is idempotent when no org state exists", async () => {
    const res = await request(app)
      .delete(`/internal/campaigns/by-org/${orgId}`)
      .set("x-api-key", API_KEY)
      .expect(200);

    expect(res.body.updatedTables).toEqual([
      { tableName: "campaigns", count: 0 },
      { tableName: "brand_pause_transitions", count: 0 },
    ]);
  });

  it("is idempotent when retried after a successful teardown", async () => {
    await insertTestCampaign(orgId, {
      status: "ongoing",
      nextRunAt: new Date(Date.now() + 60_000),
      brandIds: [crypto.randomUUID()],
    });

    await request(app)
      .delete(`/internal/campaigns/by-org/${orgId}`)
      .set("x-api-key", API_KEY)
      .expect(200);

    const retry = await request(app)
      .delete(`/internal/campaigns/by-org/${orgId}`)
      .set("x-api-key", API_KEY)
      .expect(200);

    expect(retry.body.updatedTables).toEqual([
      { tableName: "campaigns", count: 0 },
      { tableName: "brand_pause_transitions", count: 0 },
    ]);
  });

  it("requires service API-key auth", async () => {
    await request(app)
      .delete(`/internal/campaigns/by-org/${orgId}`)
      .expect(401);
  });

  it("returns non-2xx when the DB transaction fails", async () => {
    const txSpy = vi.spyOn(db, "transaction");
    txSpy.mockImplementationOnce(async () => {
      throw new Error("db unavailable");
    });

    try {
      const res = await request(app)
        .delete(`/internal/campaigns/by-org/${orgId}`)
        .set("x-api-key", API_KEY)
        .expect(500);

      expect(res.body.error).toBe("Internal server error");
    } finally {
      txSpy.mockRestore();
    }
  });
});
