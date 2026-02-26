import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

const mockExecute = vi.hoisted(() => vi.fn());

vi.mock("../../src/lib/workflows.js", () => ({
  executeCampaignWorkflow: mockExecute,
}));

vi.mock("@mcpfactory/runs-client", () => ({
  listRuns: vi.fn().mockResolvedValue({ runs: [] }),
  createRun: vi.fn(),
  updateRun: vi.fn(),
  getStatsBudget: vi.fn(),
}));

import { db } from "../../src/db/index.js";
import { campaigns } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import { cleanTestData, closeDb, insertTestOrg, insertTestCampaign } from "../helpers/test-db.js";
import { resumeDueCampaigns } from "../../src/lib/scheduler.js";

describe("Scheduler - resumeDueCampaigns (integration)", () => {
  let org: { id: string; externalOrgId: string };

  beforeEach(async () => {
    await cleanTestData();
    vi.clearAllMocks();
    mockExecute.mockResolvedValue(undefined);
    org = await insertTestOrg({ externalOrgId: "scheduler-test-org" });
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("should not trigger anything when no campaigns are due", async () => {
    await insertTestCampaign(org.id, {
      status: "ongoing",
      appId: "mcpfactory",
    });

    const count = await resumeDueCampaigns();
    expect(count).toBe(0);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("should resume campaign whose toResumeAt is in the past", async () => {
    const pastDate = new Date(Date.now() - 60_000); // 1 minute ago
    const campaign = await insertTestCampaign(org.id, {
      status: "ongoing",
      appId: "mcpfactory",
      toResumeAt: pastDate,
    });

    const count = await resumeDueCampaigns();
    expect(count).toBe(1);

    // Should have cleared toResumeAt
    const updated = await db.query.campaigns.findFirst({
      where: eq(campaigns.id, campaign.id),
    });
    expect(updated!.toResumeAt).toBeNull();

    // Should have triggered workflow
    expect(mockExecute).toHaveBeenCalledWith(
      "sales-email-cold-outreach",
      {
        campaignId: campaign.id,
        orgId: org.externalOrgId,
        appId: "mcpfactory",
      },
    );
  });

  it("should NOT resume campaign whose toResumeAt is in the future", async () => {
    const futureDate = new Date(Date.now() + 3_600_000); // 1 hour from now
    await insertTestCampaign(org.id, {
      status: "ongoing",
      appId: "mcpfactory",
      toResumeAt: futureDate,
    });

    const count = await resumeDueCampaigns();
    expect(count).toBe(0);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("should NOT resume stopped campaigns even with past toResumeAt", async () => {
    const pastDate = new Date(Date.now() - 60_000);
    await insertTestCampaign(org.id, {
      status: "stopped",
      appId: "mcpfactory",
      toResumeAt: pastDate,
    });

    const count = await resumeDueCampaigns();
    expect(count).toBe(0);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("should resume multiple due campaigns", async () => {
    const pastDate = new Date(Date.now() - 60_000);

    await insertTestCampaign(org.id, {
      name: "Campaign A",
      status: "ongoing",
      appId: "mcpfactory",
      toResumeAt: pastDate,
    });
    await insertTestCampaign(org.id, {
      name: "Campaign B",
      status: "ongoing",
      appId: "mcpfactory",
      toResumeAt: pastDate,
    });

    const count = await resumeDueCampaigns();
    expect(count).toBe(2);
    expect(mockExecute).toHaveBeenCalledTimes(2);
  });

  it("should use empty string for appId when campaign has no appId", async () => {
    const pastDate = new Date(Date.now() - 60_000);
    await insertTestCampaign(org.id, {
      status: "ongoing",
      appId: undefined,
      toResumeAt: pastDate,
    });

    await resumeDueCampaigns();

    expect(mockExecute).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ appId: "" }),
    );
  });
});
