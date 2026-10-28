import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

// A unit whose pipe LEFT its funnel campaign's plan (FACTORY-P1-FOLLOW-PLAN) stays ON but takes no new people: the
// scheduler parks it instead of dispatching a run (a proactive run would find new people).
const { mockExecute } = vi.hoisted(() => ({ mockExecute: vi.fn() }));
vi.mock("../../src/lib/features-workflow-projection-client.js", () => ({
  resolveSelectionForTrigger: vi.fn(async (a) => ({ workflowSlug: a.fallbackSlug, audienceId: null })),
}));
vi.mock("../../src/lib/workflows.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/lib/workflows.js")>();
  return { ...original, executeCampaignWorkflow: mockExecute };
});
vi.mock("@distribute/runs-client", () => ({
  listRuns: vi.fn().mockResolvedValue({ runs: [] }),
  createRun: vi.fn().mockResolvedValue({ id: "run-1" }),
  updateRun: vi.fn(),
  getStatsBudget: vi.fn().mockResolvedValue({ windows: [] }),
}));

import { eq } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { campaigns } from "../../src/db/schema.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { insertSalesFunnelCampaignWithUnits } from "../../src/lib/campaign-status-history.js";
import { acquisitionChannelForFeature } from "../../src/lib/campaign-identity.js";
import { reRunDueCampaigns } from "../../src/lib/scheduler.js";
import { PLAN_DRAINING_RECHECK_MS } from "../../src/lib/sales-funnel-plan-constants.js";

const ORG = "b645207b-0000-4000-8000-0000000000d1";
const COLD = "sales-cold-email-outreach";

describe("a pipe that left its plan takes no new people (FACTORY-P1-FOLLOW-PLAN)", () => {
  beforeEach(async () => {
    await cleanTestData();
    mockExecute.mockReset();
  });
  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("the scheduler parks a draining proactive unit (still ongoing), never dispatches it", async () => {
    const id = crypto.randomUUID();
    const { units } = await insertSalesFunnelCampaignWithUnits({
      id,
      orgId: ORG,
      brandId: "75d7e3e8-0000-4000-8000-0000000000d2",
      offerId: "231bb036-0000-4000-8000-0000000000d3",
      salesFunnelId: `lead_found_to_conversation@${COLD}`,
      salesFunnelName: "Epiphany",
      status: "ongoing",
      createdByUserId: "cfe148ed-0000-4000-8000-0000000000d4",
      parentRunId: "9a1b2c3d-0000-4000-8000-0000000000d5",
      followsPlan: true,
      units: [{ featureSlug: COLD, legKey: "lead_found_to_conversation", workflowSlug: "cold-wf", acquisitionChannel: acquisitionChannelForFeature(COLD)!, name: `Epiphany ${id.slice(0, 8)} - cold` }],
    });
    await db.update(campaigns).set({ planRole: "draining", nextRunAt: new Date(Date.now() - 60_000) }).where(eq(campaigns.id, units[0].id));
    const before = Date.now();
    await reRunDueCampaigns();
    expect(mockExecute).not.toHaveBeenCalled();
    const [row] = await db.select().from(campaigns).where(eq(campaigns.id, units[0].id));
    expect(row.status).toBe("ongoing");
    expect(row.nextRunAt!.getTime()).toBeGreaterThanOrEqual(before + PLAN_DRAINING_RECHECK_MS - 1000);
  });
});
