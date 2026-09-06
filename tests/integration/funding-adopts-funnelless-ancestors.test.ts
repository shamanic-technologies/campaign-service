import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

/**
 * The 16 Aug shape, reproduced: a stopped funnel-less ancestor plus a funding event.
 *
 * Migration 0048 folded stopped funnel-less ancestors onto the funnel of their triple's one live
 * campaign, ONCE, against the fleet as it stood on 13 Aug. Nine days later a customer read $53 of
 * spend on an offer and $1.81 on that offer's only live campaign, because $51.68 of the campaign's
 * OWN history sat on an ancestor that answers to no funnel — a row that was still LIVE on 13 Aug,
 * so 0048 correctly declined it, and that became eligible the day it stopped.
 *
 * What is pinned here is that provisioning a funnel campaign for an (org, brand, acquisition
 * channel) leaves NO funnel-less ancestor of that triple behind — including, and especially, when
 * the campaign for the funded funnel ALREADY EXISTS. That is the placement trap: the
 * existing-campaign check returns early with `continue`, so an adoption written after it would
 * never run for the very brand this recurrence was found on.
 */

const { mockExecute } = vi.hoisted(() => ({ mockExecute: vi.fn() }));

vi.mock("../../src/lib/features-workflow-projection-client.js", () => ({
  resolveWorkflowSlugForTrigger: vi.fn(async (a) => a.fallbackSlug),
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
import { campaigns, campaignFunnelOwnerDecisions } from "../../src/db/schema.js";
import { cleanTestData, closeDb, insertTestCampaign } from "../helpers/test-db.js";
import { reRunDueCampaigns } from "../../src/lib/scheduler.js";
import { SALES_OUTREACH_FEATURE_SLUG } from "../../src/lib/sales-outreach-campaign.js";
import { ANCESTOR_ADOPTION_SOURCE } from "../../src/lib/funnel-ancestor-adoption.js";

const orgId = "ancestor-adoption-org";
const otherOrgId = "ancestor-adoption-other-org";
const CONVERSATION = "sales_meetings_from_conversation";
const WEBSITE = "sales_meetings_from_website";
const past = () => new Date(Date.now() - 60_000);

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

/**
 * billing funds these funnels for every brand asked about. It still names them the pre-rename way
 * on the wire, which is exactly what production sends today.
 */
function billingFunds(funnels: Array<{ funnelKey: string; dailyBudgetCents: string }>) {
  mockFetch.mockImplementation(async (url: string) => {
    if (String(url).includes("/funnel-budgets")) {
      return {
        ok: true,
        json: async () => ({
          brandId: "b",
          dailyBudgetCents: "5000",
          funnels: funnels.map((f) => ({ ...f, updatedAt: null })),
        }),
      };
    }
    if (String(url).includes("/workflows")) {
      const featureSlug = new URL(String(url)).searchParams.get("featureSlug");
      return {
        ok: true,
        json: async () => ({
          workflows: [
            { workflowSlug: `${featureSlug}-seed`, featureSlug, createdAt: "2026-08-18T00:00:00.000Z" },
          ],
        }),
      };
    }
    if (String(url).includes("/features/")) {
      return {
        ok: true,
        json: async () => ({
          feature: {
            salesFunnels: [CONVERSATION, WEBSITE, "website_purchases", "form_magnet"],
          },
        }),
      };
    }
    if (String(url).includes("/sales-funnels")) {
      return {
        ok: true,
        json: async () => ({
          funnels: [
            { funnelKey: CONVERSATION, active: true, name: "x", steps: [], rates: {} },
            { funnelKey: WEBSITE, active: true, name: "y", steps: [], rates: {} },
          ],
        }),
      };
    }
    return { ok: false, status: 500, json: async () => ({}) };
  });
}

function salesCampaign(brandId: string, org: string, over: Record<string, unknown> = {}) {
  return insertTestCampaign(org, {
    status: "ongoing",
    nextRunAt: past(),
    brandIds: [brandId],
    brandId,
    acquisitionChannel: "cold_email",
    featureSlug: SALES_OUTREACH_FEATURE_SLUG,
    createdByUserId: "user-x",
    funnelKey: CONVERSATION,
    ...over,
  });
}

async function funnelOf(id: string): Promise<string | null> {
  const [row] = await db.select().from(campaigns).where(eq(campaigns.id, id));
  return row?.funnelKey ?? null;
}

async function statusOf(id: string): Promise<string | undefined> {
  const [row] = await db.select().from(campaigns).where(eq(campaigns.id, id));
  return row?.status;
}

beforeEach(async () => {
  await cleanTestData();
  await db.delete(campaignFunnelOwnerDecisions);
  vi.clearAllMocks();
  mockExecute.mockResolvedValue(undefined);
  process.env.BILLING_SERVICE_URL = "https://billing.test.local";
  process.env.BILLING_SERVICE_API_KEY = "test-billing-key";
  process.env.FEATURES_SERVICE_URL = "https://features.test.local";
  process.env.FEATURES_SERVICE_API_KEY = "test-features-key";
  process.env.WORKFLOW_SERVICE_URL = "https://workflow.test.local";
  process.env.WORKFLOW_SERVICE_API_KEY = "test-workflow-key";
});

afterAll(async () => {
  await cleanTestData();
  await db.delete(campaignFunnelOwnerDecisions);
  await closeDb();
});

describe("provisioning a funnel campaign leaves no funnel-less ancestor behind", () => {
  it("folds the ancestor even though the funded funnel's campaign ALREADY EXISTS", async () => {
    // Exactly the prod shape: 9570e3ce ongoing on the funnel, 2bd9ec88 stopped and stating none.
    const brandId = crypto.randomUUID();
    const live = await salesCampaign(brandId, orgId);
    const ancestor = await salesCampaign(brandId, orgId, {
      status: "stopped",
      nextRunAt: null,
      funnelKey: null,
      stopReason: null,
    });

    billingFunds([{ funnelKey: "reply_meeting", dailyBudgetCents: "5000" }]);
    await reRunDueCampaigns();

    expect(await funnelOf(ancestor.id)).toBe(CONVERSATION);
    // Nothing else about it moves — it stays STOPPED, which is the whole point: features-service
    // folds a stopped ancestor onto the live member of the identity.
    expect(await statusOf(ancestor.id)).toBe("stopped");
    expect(await funnelOf(live.id)).toBe(CONVERSATION);
    expect(await statusOf(live.id)).toBe("ongoing");
  });

  it("records the write with the value it replaced, under its own source tag", async () => {
    const brandId = crypto.randomUUID();
    await salesCampaign(brandId, orgId);
    const ancestor = await salesCampaign(brandId, orgId, {
      status: "stopped",
      nextRunAt: null,
      funnelKey: null,
    });

    billingFunds([{ funnelKey: "reply_meeting", dailyBudgetCents: "5000" }]);
    await reRunDueCampaigns();

    const [decision] = await db
      .select()
      .from(campaignFunnelOwnerDecisions)
      .where(eq(campaignFunnelOwnerDecisions.source, ANCESTOR_ADOPTION_SOURCE));

    expect(decision?.campaignId).toBe(ancestor.id);
    expect(decision?.previousFunnelKey).toBeNull();
    expect(decision?.funnelKey).toBe(CONVERSATION);
    expect(decision?.orgId).toBe(orgId);
    expect(decision?.brandId).toBe(brandId);
  });

  it("a second tick changes nothing — the ancestor states a funnel now", async () => {
    const brandId = crypto.randomUUID();
    const live = await salesCampaign(brandId, orgId);
    const ancestor = await salesCampaign(brandId, orgId, {
      status: "stopped",
      nextRunAt: null,
      funnelKey: null,
    });

    billingFunds([{ funnelKey: "reply_meeting", dailyBudgetCents: "5000" }]);
    await reRunDueCampaigns();

    const [before] = await db.select().from(campaigns).where(eq(campaigns.id, ancestor.id));
    const decisionsBefore = await db.select().from(campaignFunnelOwnerDecisions);

    await db.update(campaigns).set({ nextRunAt: past() }).where(eq(campaigns.id, live.id));
    await reRunDueCampaigns();

    const [after] = await db.select().from(campaigns).where(eq(campaigns.id, ancestor.id));
    expect(after.funnelKey).toBe(before.funnelKey);
    expect(after.updatedAt?.toISOString()).toBe(before.updatedAt?.toISOString());
    expect(await db.select().from(campaignFunnelOwnerDecisions)).toHaveLength(
      decisionsBefore.length,
    );
  });

  it("never tries to resume the folded ancestor alongside the incumbent it now shares an identity with", async () => {
    // Folding an ancestor onto the live campaign's funnel makes it findable by the
    // existing-campaign lookup. Ordered on creation date alone, a stopped ancestor created AFTER
    // the incumbent is returned instead of it, and the resume path then brings it back next to a
    // campaign it now collides with on uniq_campaigns_org_brand_funnel_channel — a 23505 raised
    // inside planFunnelTurns, which fail-closes and holds the brand every tick, forever.
    const brandId = crypto.randomUUID();
    const live = await salesCampaign(brandId, orgId);
    // The incumbent is the OLDER row, so "the newest campaign of this pair" is the wrong answer.
    await db
      .update(campaigns)
      .set({ createdAt: new Date(Date.now() - 86_400_000) })
      .where(eq(campaigns.id, live.id));
    const ancestor = await salesCampaign(brandId, orgId, {
      status: "stopped",
      nextRunAt: null,
      funnelKey: null,
      stopReason: null,
    });

    billingFunds([{ funnelKey: "reply_meeting", dailyBudgetCents: "5000" }]);
    await reRunDueCampaigns();
    // The fold happened on the first tick; the second is the one that would have collided.
    await db.update(campaigns).set({ nextRunAt: past() }).where(eq(campaigns.id, live.id));
    await reRunDueCampaigns();

    expect(await funnelOf(ancestor.id)).toBe(CONVERSATION);
    expect(await statusOf(ancestor.id)).toBe("stopped");
    expect(await statusOf(live.id)).toBe("ongoing");
    // The brand was never held: the campaign fired on both ticks.
    expect(mockExecute).toHaveBeenCalledTimes(2);
  });

  it("leaves the ancestor alone when the triple has SEVERAL live funnels", async () => {
    const brandId = crypto.randomUUID();
    await salesCampaign(brandId, orgId, { funnelKey: CONVERSATION });
    await salesCampaign(brandId, orgId, { funnelKey: WEBSITE });
    const ancestor = await salesCampaign(brandId, orgId, {
      status: "stopped",
      nextRunAt: null,
      funnelKey: null,
    });

    billingFunds([
      { funnelKey: "reply_meeting", dailyBudgetCents: "5000" },
      { funnelKey: "visit_meeting", dailyBudgetCents: "5000" },
    ]);
    await reRunDueCampaigns();

    expect(await funnelOf(ancestor.id)).toBeNull();
    expect(await db.select().from(campaignFunnelOwnerDecisions)).toHaveLength(0);
  });

  it("never touches another org's campaigns on the same brand row", async () => {
    const brandId = crypto.randomUUID();
    await salesCampaign(brandId, orgId);
    const foreign = await salesCampaign(brandId, otherOrgId, {
      status: "stopped",
      nextRunAt: null,
      funnelKey: null,
    });

    billingFunds([{ funnelKey: "reply_meeting", dailyBudgetCents: "5000" }]);
    await reRunDueCampaigns();

    expect(await funnelOf(foreign.id)).toBeNull();
  });

  it("never touches a stopped ancestor on a DIFFERENT acquisition channel", async () => {
    const brandId = crypto.randomUUID();
    await salesCampaign(brandId, orgId);
    const otherChannel = await insertTestCampaign(orgId, {
      status: "stopped",
      brandIds: [brandId],
      brandId,
      acquisitionChannel: "pr_cold_email",
      featureSlug: "pr-cold-email-outreach",
      funnelKey: null,
    });

    billingFunds([{ funnelKey: "reply_meeting", dailyBudgetCents: "5000" }]);
    await reRunDueCampaigns();

    expect(await funnelOf(otherChannel.id)).toBeNull();
  });
});
