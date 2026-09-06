import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

/**
 * Funding a sales funnel is what makes its campaigns eligible to run.
 *
 * This file replaces the brand-pause suite. `brand_pause` was a second source of truth for a fact
 * the money already states: the customer surface that wrote it was deleted when the product
 * decided a customer stops a funnel by defunding it, no writer replaced it anywhere in the fleet,
 * and the flag kept holding campaigns nobody could release — 27 brands stored paused, 10 of them
 * funded, 11 ongoing campaigns that could never be claimed.
 *
 * What is pinned here is the RULE, not any row count: nothing funded → held; fund one funnel →
 * eligible, with no manual step.
 */

// Keep workflow + runs-client inert so the scheduler under test never fires a real flow and
// always sees "no live run" (→ campaigns are eligible to claim unless the funding hold stops them).
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

import request from "supertest";
import { eq } from "drizzle-orm";
import app from "../../src/index.js";
import { db } from "../../src/db/index.js";
import { campaigns, brandPauseTransitions } from "../../src/db/schema.js";
import { cleanTestData, closeDb, insertTestCampaign } from "../helpers/test-db.js";
import { reRunDueCampaigns, claimStuckCampaigns } from "../../src/lib/scheduler.js";
import { SALES_OUTREACH_FEATURE_SLUG } from "../../src/lib/sales-outreach-campaign.js";
import { FUNDING_RECHECK_MS } from "../../src/lib/funnel-campaigns.js";

const API_KEY = process.env.CAMPAIGN_SERVICE_API_KEY || "test-api-key";
const orgId = "funding-eligibility-org";
const past = () => new Date(Date.now() - 60_000);

// billing-service is the ONE source of "is this funded". It still names these funnels the
// pre-rename way on the wire, which is exactly what production sends today.
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

/** billing answers these per-funnel ceilings for every brand asked about. */
function billingAnswers(
  funnels: Array<{ funnelKey: string; dailyBudgetCents: string }>,
  brandDailyBudgetCents: string | null,
  // The ADDITIVE (funnel, acquisition-channel feature) grain. Omitted = a billing deploy that does
  // not serve it, which is what every case that does not pass it relies on.
  channels?: Array<{ funnelKey: string; featureSlug: string; dailyBudgetCents: string }>,
  // Which sales funnels each channel may be SOLD THROUGH, as features-service states it. Default:
  // every channel sells every funnel.
  sellableByFeature?: Record<string, string[]>,
) {
  mockFetch.mockImplementation(async (url: string) => {
    if (String(url).includes("/funnel-budgets")) {
      return {
        ok: true,
        json: async () => ({
          brandId: "b",
          dailyBudgetCents: brandDailyBudgetCents,
          funnels: funnels.map((f) => ({ ...f, updatedAt: null })),
          ...(channels ? { channels: channels.map((c) => ({ ...c, updatedAt: null })) } : {}),
        }),
      };
    }
    // workflow-service: which workflow can RUN a channel. A workflow belongs to a feature, so a
    // second channel never inherits the first one's.
    if (String(url).includes("/workflows")) {
      const featureSlug = new URL(String(url)).searchParams.get("featureSlug");
      return {
        ok: true,
        json: async () => ({
          workflows: [{ workflowSlug: `${featureSlug}-seed`, featureSlug, createdAt: "2026-08-18T00:00:00.000Z" }],
        }),
      };
    }
    // features-service's per-channel statement: which sales funnels this acquisition channel may
    // be SOLD THROUGH. The cold-email pitch sells every funnel.
    if (String(url).includes("/features/")) {
      const slug = decodeURIComponent(String(url).split("/features/")[1]!);
      return {
        ok: true,
        json: async () => ({
          feature: {
            slug,
            salesFunnels: sellableByFeature?.[slug] ?? [
              "sales_meetings_from_conversation",
              "sales_meetings_from_website",
              "website_purchases",
              "form_magnet",
            ],
          },
        }),
      };
    }
    // brand-service's declared sales funnels — every funnel billing funds is declared active.
    if (String(url).includes("/sales-funnels")) {
      return {
        ok: true,
        json: async () => ({
          funnels: [
            { funnelKey: "sales_meetings_from_conversation", active: true, name: "x", steps: [], rates: {} },
            { funnelKey: "website_purchases", active: true, name: "y", steps: [], rates: {} },
          ],
        }),
      };
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
    funnelKey: "sales_meetings_from_conversation",
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

describe("the scheduler holds what the customer funds nothing for", () => {
  it("holds a sales campaign whose every funnel is funded at zero, and leaves it ongoing", async () => {
    billingAnswers([{ funnelKey: "reply_meeting", dailyBudgetCents: "0" }], "0");
    const brandId = crypto.randomUUID();
    const campaign = await insertSalesCampaign(brandId);

    await reRunDueCampaigns();

    expect(mockExecute).not.toHaveBeenCalled();
    const after = await db.query.campaigns.findFirst({ where: eq(campaigns.id, campaign.id) });
    // HELD, not stopped — and re-checked on the funding cadence rather than every minute.
    expect(after!.status).toBe("ongoing");
    expect(after!.nextRunAt!.getTime()).toBeGreaterThan(Date.now() + FUNDING_RECHECK_MS - 30_000);
  });

  it("holds a brand that states no budget at all — unfunded is not unbounded", async () => {
    billingAnswers([], null);
    const brandId = crypto.randomUUID();
    await insertSalesCampaign(brandId);

    await reRunDueCampaigns();
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("holds fail-CLOSED when billing cannot be read", async () => {
    billingUnavailable();
    const brandId = crypto.randomUUID();
    await insertSalesCampaign(brandId);

    await reRunDueCampaigns();
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("runs the campaign of a funnel the customer funds — no manual step", async () => {
    billingAnswers([{ funnelKey: "reply_meeting", dailyBudgetCents: "5000" }], "5000");
    const brandId = crypto.randomUUID();
    await insertSalesCampaign(brandId);

    await reRunDueCampaigns();
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  it("funding a funnel releases the campaign that was held, on the next tick", async () => {
    const brandId = crypto.randomUUID();
    const campaign = await insertSalesCampaign(brandId);

    billingAnswers([{ funnelKey: "reply_meeting", dailyBudgetCents: "0" }], "0");
    await reRunDueCampaigns();
    expect(mockExecute).not.toHaveBeenCalled();

    // The customer funds the funnel. Nothing else happens — no button, no API call to us.
    billingAnswers([{ funnelKey: "reply_meeting", dailyBudgetCents: "5000" }], "5000");
    await db.update(campaigns).set({ nextRunAt: past() }).where(eq(campaigns.id, campaign.id));

    await reRunDueCampaigns();
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  it("still runs a brand with ONE pot and no per-funnel ceilings, exactly as before", async () => {
    billingAnswers([], "5000");
    const brandId = crypto.randomUUID();
    await insertSalesCampaign(brandId, { funnelKey: null });

    await reRunDueCampaigns();
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  it("does NOT hold a non-sales campaign of an unfunded brand — this is a sales-outreach rule", async () => {
    billingAnswers([], null);
    const brandId = crypto.randomUUID();
    await insertTestCampaign(orgId, {
      status: "ongoing",
      nextRunAt: past(),
      brandIds: [brandId],
      featureSlug: "pr-expert-quote-outreach",
      createdByUserId: "user-x",
    });

    expect(await reRunDueCampaigns()).toBe(1);
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  it("claimStuckCampaigns still recovers a stuck campaign — the hold is applied at the turn, not the claim", async () => {
    billingAnswers([{ funnelKey: "reply_meeting", dailyBudgetCents: "0" }], "0");
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
    billingAnswers(
      [{ funnelKey: "reply_meeting", dailyBudgetCents: "5000" }],
      "5000",
      [
        { funnelKey: "reply_meeting", featureSlug: "sales-cold-email-outreach", dailyBudgetCents: "3000" },
        { funnelKey: "reply_meeting", featureSlug: "feedback-request-cold-email-outreach", dailyBudgetCents: "2000" },
      ],
    );
    const brandId = crypto.randomUUID();
    await insertSalesCampaign(brandId);

    await reRunDueCampaigns();

    const all = await db.query.campaigns.findMany();
    expect(all).toHaveLength(1);
    expect(all[0].featureSlug).toBe(SALES_OUTREACH_FEATURE_SLUG);
  });

  it("leaves a brand whose campaigns are ALL STOPPED exactly as it is, however well funded", async () => {
    billingAnswers([{ funnelKey: "reply_meeting", dailyBudgetCents: "5000" }], "5000");
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
    billingAnswers([{ funnelKey: "reply_meeting", dailyBudgetCents: "5000" }], "5000");
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
  it("held when every funnel is funded at zero", async () => {
    billingAnswers([{ funnelKey: "reply_meeting", dailyBudgetCents: "0" }], "0");
    const brandId = crypto.randomUUID();
    const res = await getPause(brandId).expect(200);
    expect(res.body).toEqual({ brandId, orgId, paused: true, updatedAt: null });
  });

  it("held when the brand states no budget at all", async () => {
    billingAnswers([], null);
    const brandId = crypto.randomUUID();
    const res = await getPause(brandId).expect(200);
    expect(res.body.paused).toBe(true);
  });

  it("NOT held when one funnel carries a positive ceiling", async () => {
    billingAnswers(
      [
        { funnelKey: "reply_meeting", dailyBudgetCents: "0" },
        { funnelKey: "visit_signup", dailyBudgetCents: "1000" },
      ],
      "1000",
    );
    const brandId = crypto.randomUUID();
    const res = await getPause(brandId).expect(200);
    expect(res.body.paused).toBe(false);
  });

  it("NOT held when the brand has one pot and it is positive", async () => {
    billingAnswers([], "2500");
    const brandId = crypto.randomUUID();
    const res = await getPause(brandId).expect(200);
    expect(res.body.paused).toBe(false);
  });

  it("502s rather than reporting a brand as running when billing cannot be read", async () => {
    billingUnavailable();
    await getPause(crypto.randomUUID()).expect(502);
  });

  it("requires x-org-id (400) — funding belongs to the (org, brand) pair", async () => {
    billingAnswers([], "1000");
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
