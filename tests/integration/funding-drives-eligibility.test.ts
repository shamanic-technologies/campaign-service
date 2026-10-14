import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

/**
 * Funding a campaign is what makes it eligible to run.
 *
 * This file replaces the brand-pause suite. `brand_pause` was a second source of truth for a fact
 * the money already states: the customer surface that wrote it was deleted when the product
 * decided a customer stops a campaign by defunding it, no writer replaced it anywhere in the fleet,
 * and the flag kept holding campaigns nobody could release — 27 brands stored paused, 10 of them
 * funded, 11 ongoing campaigns that could never be claimed.
 *
 * What is pinned here is the RULE, not any row count: nothing funded → held; fund one campaign →
 * eligible, with no manual step.
 */

// Keep workflow + runs-client inert so the scheduler under test never fires a real flow and
// always sees "no live run" (→ campaigns are eligible to claim unless the funding hold stops them).
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

import request from "supertest";
import { eq } from "drizzle-orm";
import app from "../../src/index.js";
import { db } from "../../src/db/index.js";
import { campaigns, brandPauseTransitions } from "../../src/db/schema.js";
import { cleanTestData, closeDb, insertTestCampaign } from "../helpers/test-db.js";
import { reRunDueCampaigns, claimStuckCampaigns } from "../../src/lib/scheduler.js";
import { SALES_OUTREACH_FEATURE_SLUG } from "../../src/lib/sales-outreach-campaign.js";
import { FUNDING_RECHECK_MS } from "../../src/lib/brand-turns.js";

const API_KEY = process.env.CAMPAIGN_SERVICE_API_KEY || "test-api-key";
const orgId = "funding-eligibility-org";
const past = () => new Date(Date.now() - 60_000);

// billing-service states the brand's daily budget and its sales funnel caps. Since the one money
// model (owner 2026-10-14) a campaign's money is its sales funnel's caps, and billing's per-campaign
// ceilings are never read.
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const OFFER = "11111111-1111-4111-8111-111111111111";
const LEG = "start_to_conversation";

/** billing answers this brand daily budget (and funnel caps) for every brand asked about. */
function billingAnswers(brandDailyBudgetCents: string | null, funnelCaps: unknown[] = []) {
  mockFetch.mockImplementation(async (url: string) => {
    if (String(url).includes("/sales-funnel-caps")) {
      return { ok: true, json: async () => ({ orgId, brandId: "b", caps: funnelCaps }) };
    }
    if (String(url).includes("/campaign-budgets") || String(url).includes("/campaign-budget?")) {
      throw new Error(`retired per-campaign ceilings read: ${url}`);
    }
    if (String(url).includes("/daily-budget")) {
      return { ok: true, json: async () => ({ brandId: "b", dailyBudgetCents: brandDailyBudgetCents, updatedAt: null }) };
    }
    return { ok: false, status: 500, json: async () => ({}) };
  });
}

/** billing cannot be read at all. */
function billingUnavailable() {
  mockFetch.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });
}

function getPause(brandId: string, org = orgId) {
  return request(app).get(`/brands/${brandId}/pause`).set("x-api-key", API_KEY).set("x-org-id", org);
}
function getPauseHistory(brandId: string, org = orgId) {
  return request(app).get(`/brands/${brandId}/pause-history`).set("x-api-key", API_KEY).set("x-org-id", org);
}

async function insertSalesCampaign(brandId: string, over: Record<string, unknown> = {}) {
  return insertTestCampaign(orgId, {
    status: "ongoing",
    nextRunAt: past(),
    brandIds: [brandId],
    brandId,
    acquisitionChannel: "cold_email",
    featureSlug: SALES_OUTREACH_FEATURE_SLUG,
    createdByUserId: "user-x",
    offerId: OFFER,
    legKey: LEG,
    ...over,
  });
}

afterAll(async () => {
  await cleanTestData();
  await closeDb();
});

beforeEach(async () => {
  await cleanTestData();
  vi.clearAllMocks();
  mockExecute.mockResolvedValue(undefined);
  process.env.BILLING_SERVICE_URL = "https://billing.test.local";
  process.env.BILLING_SERVICE_API_KEY = "test-billing-key";
  process.env.FEATURES_SERVICE_URL = "https://features.test.local";
  process.env.FEATURES_SERVICE_API_KEY = "test-features-key";
});

describe("the scheduler holds a sales campaign that is not a sales funnel unit", () => {
  it("holds it by name whatever billing states, reads no money for it, and leaves it ongoing", async () => {
    billingAnswers("5000");
    const brandId = crypto.randomUUID();
    const campaign = await insertSalesCampaign(brandId, { dailyBudgetCents: 5000 });

    await reRunDueCampaigns();

    expect(mockExecute).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
    const after = await db.query.campaigns.findFirst({ where: eq(campaigns.id, campaign.id) });
    // HELD, not stopped — and re-checked on the funding cadence rather than every minute.
    expect(after!.status).toBe("ongoing");
    expect(after!.nextRunAt!.getTime()).toBeGreaterThan(Date.now() + FUNDING_RECHECK_MS - 30_000);
  });

  it("does NOT hold a non-sales campaign at the turn — the gate refuses it instead", async () => {
    billingAnswers(null);
    const brandId = crypto.randomUUID();
    await insertTestCampaign(orgId, {
      status: "ongoing",
      nextRunAt: past(),
      brandIds: [brandId],
      featureSlug: "pr-cold-email-outreach",
      createdByUserId: "user-x",
    });

    expect(await reRunDueCampaigns()).toBe(1);
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  it("claimStuckCampaigns still recovers a stuck campaign — the hold is applied at the turn, not the claim", async () => {
    billingAnswers("0");
    const brandId = crypto.randomUUID();
    const campaign = await insertSalesCampaign(brandId, { nextRunAt: null });

    expect(await claimStuckCampaigns()).toBe(1);
    const after = await db.query.campaigns.findFirst({ where: eq(campaigns.id, campaign.id) });
    expect(after!.nextRunAt).not.toBeNull();

    // …and the very next claim holds it again rather than running it.
    await reRunDueCampaigns();
    expect(mockExecute).not.toHaveBeenCalled();
  });
});

describe("money never starts anything", () => {
  it("stands NO campaign up for a funded pair that has none — whatever else it funds", async () => {
    // The 2026-09-06 incident. A brand parked at its ceiling funds a SECOND acquisition channel;
    // before this, a sweep created a campaign for it. A campaign exists because the customer said
    // so, so the second channel simply has no campaign until they launch one.
    billingAnswers("5000");
    const brandId = crypto.randomUUID();
    await insertSalesCampaign(brandId);

    await reRunDueCampaigns();

    const all = await db.query.campaigns.findMany();
    expect(all).toHaveLength(1);
    expect(all[0].featureSlug).toBe(SALES_OUTREACH_FEATURE_SLUG);
  });

  it("leaves a brand whose campaigns are ALL STOPPED exactly as it is, however well funded", async () => {
    billingAnswers("5000");
    const brandId = crypto.randomUUID();
    const stopped = await insertSalesCampaign(brandId, { status: "stopped", nextRunAt: null });

    await reRunDueCampaigns();
    await claimStuckCampaigns();

    const all = await db.query.campaigns.findMany();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(stopped.id);
    expect(all[0].status).toBe("stopped");
  });

  it("never resumes a campaign the customer stopped, however well funded its ceiling", async () => {
    billingAnswers("5000");
    const brandId = crypto.randomUUID();
    const stopped = await insertSalesCampaign(brandId, {
      status: "stopped",
      nextRunAt: null,
      stopReason: "manual",
    });

    await reRunDueCampaigns();
    await claimStuckCampaigns();

    const after = await db.query.campaigns.findFirst({ where: eq(campaigns.id, stopped.id) });
    expect(after!.status).toBe("stopped");
    expect(after!.stopReason).toBe("manual");
  });
});

describe("GET /brands/:brandId/pause answers from the money", () => {
  it("held when the brand's daily budget is zero", async () => {
    billingAnswers("0");
    const brandId = crypto.randomUUID();
    const res = await getPause(brandId).expect(200);
    expect(res.body).toEqual({ brandId, orgId, paused: true, updatedAt: null });
  });

  it("held when the brand states no budget at all", async () => {
    billingAnswers(null);
    const brandId = crypto.randomUUID();
    const res = await getPause(brandId).expect(200);
    expect(res.body.paused).toBe(true);
  });

  it("NOT held when the brand's daily budget is positive", async () => {
    billingAnswers("2500");
    const brandId = crypto.randomUUID();
    const res = await getPause(brandId).expect(200);
    expect(res.body.paused).toBe(false);
  });

  it("NOT held when the brand is funded only by a SALES FUNNEL max budget", async () => {
    billingAnswers(null, [
      { offerId: OFFER, salesFunnelId: "f@x", funded: true, fundedBy: "max_budget", maxBudget: { amountCents: "7000", period: "weekly", dailyBudgetCents: "1000" }, maxVolume: null, updatedAt: "2026-10-10T00:00:00Z" },
    ]);
    const res = await getPause(crypto.randomUUID()).expect(200);
    expect(res.body.paused).toBe(false);
  });

  it("NOT held when the only funnel cap is a max volume (owner 2026-10-11: max $ AND/OR max volume)", async () => {
    billingAnswers(null, [
      { offerId: OFFER, salesFunnelId: "f@x", funded: true, fundedBy: "max_volume", maxBudget: null, maxVolume: { count: 5, period: "daily", unit: "first_contacts" }, updatedAt: "2026-10-10T00:00:00Z" },
    ]);
    const res = await getPause(crypto.randomUUID()).expect(200);
    expect(res.body.paused).toBe(false);
  });

  it("still held when billing says the funnel is not funded", async () => {
    billingAnswers(null, [
      { offerId: OFFER, salesFunnelId: "f@x", funded: false, fundedBy: null, maxBudget: null, maxVolume: { count: 0, period: "daily", unit: "first_contacts" }, updatedAt: "2026-10-10T00:00:00Z" },
    ]);
    const res = await getPause(crypto.randomUUID()).expect(200);
    expect(res.body.paused).toBe(true);
  });

  it("502s rather than reporting a brand as running when billing cannot be read", async () => {
    billingUnavailable();
    await getPause(crypto.randomUUID()).expect(502);
  });

  it("requires x-org-id (400) — funding belongs to the (org, brand) pair", async () => {
    billingAnswers("1000");
    await request(app).get(`/brands/${crypto.randomUUID()}/pause`).set("x-api-key", API_KEY).expect(400);
  });

  it("requires a valid api key (401)", async () => {
    await getPause(crypto.randomUUID()).set("x-api-key", "wrong").expect(401);
  });

  it("has no writer: PATCH /brands/:brandId/pause is gone", async () => {
    await request(app)
      .patch(`/brands/${crypto.randomUUID()}/pause`)
      .set("x-api-key", API_KEY)
      .set("x-org-id", orgId)
      .send({ paused: true })
      .expect(404);
  });
});

describe("GET /brands/:brandId/pause-history still serves the flag-era timeline", () => {
  it("returns an empty timeline when no transition was ever recorded", async () => {
    const brandId = crypto.randomUUID();
    const res = await getPauseHistory(brandId).expect(200);
    expect(res.body).toEqual({ brandId, orgId, transitions: [] });
  });

  it("returns the recorded flips oldest first, org-scoped", async () => {
    const brandId = crypto.randomUUID();
    await db.insert(brandPauseTransitions).values({
      brandId, orgId, paused: true, transitionedAt: new Date("2026-07-01T00:00:00Z"),
    });
    await db.insert(brandPauseTransitions).values({
      brandId, orgId, paused: false, transitionedAt: new Date("2026-07-05T00:00:00Z"),
    });
    await db.insert(brandPauseTransitions).values({
      brandId, orgId: "another-org", paused: true, transitionedAt: new Date("2026-07-02T00:00:00Z"),
    });

    const res = await getPauseHistory(brandId).expect(200);
    expect(res.body.transitions.map((t: { paused: boolean }) => t.paused)).toEqual([true, false]);
  });
});
