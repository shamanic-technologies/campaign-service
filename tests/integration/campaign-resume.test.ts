import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

// The two things the resume asks other services: does this brand have somebody to contact, and
// is there still a ceiling to spend against. Both are HTTP reads owned elsewhere; here they are
// stubbed so the test exercises the DECISION, against a real database.
const { mockServeableAudienceIds, mockFetchFunnelBudgets } = vi.hoisted(() => ({
  mockServeableAudienceIds: vi.fn(),
  mockFetchFunnelBudgets: vi.fn(),
}));

vi.mock("../../src/lib/serveable-audience.js", () => ({
  serveableAudienceIdsForCampaign: mockServeableAudienceIds,
}));

vi.mock("../../src/lib/funnel-budget-client.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/lib/funnel-budget-client.js")>();
  return { ...original, fetchFunnelBudgets: mockFetchFunnelBudgets };
});

import { eq } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { campaigns } from "../../src/db/schema.js";
import { cleanTestData, closeDb, insertTestCampaign, setBrandPause } from "../helpers/test-db.js";
import {
  resumeServeableCampaigns,
  countResumableCampaigns,
  resetResumeSweepThrottle,
  RESUME_SWEEP_INTERVAL_MS,
} from "../../src/lib/campaign-resume.js";
import { STOP_REASONS } from "../../src/lib/stop-reason.js";
import { SALES_OUTREACH_FEATURE_SLUG } from "../../src/lib/sales-outreach-campaign.js";

const orgId = "resume-org";
const FUNDED = { ok: true as const, brandDailyBudgetCents: 5_000, funnels: [] };

/** A campaign in the exact state /end-run leaves behind when every audience ran dry. */
async function insertExhaustedCampaign(over: Record<string, unknown> = {}) {
  const brandId = crypto.randomUUID();
  return insertTestCampaign(orgId, {
    status: "stopped",
    stopReason: STOP_REASONS.AUDIENCE_EXHAUSTED,
    brandIds: [brandId],
    brandId,
    acquisitionChannel: "cold_email",
    featureSlug: SALES_OUTREACH_FEATURE_SLUG,
    createdByUserId: "user-resume",
    nextRunAt: null,
    ...over,
  });
}

async function read(id: string) {
  return db.query.campaigns.findFirst({ where: eq(campaigns.id, id) });
}

beforeEach(async () => {
  await cleanTestData();
  vi.clearAllMocks();
  resetResumeSweepThrottle();
  mockServeableAudienceIds.mockResolvedValue(["audience-fresh"]);
  mockFetchFunnelBudgets.mockResolvedValue(FUNDED);
});

afterAll(async () => {
  await cleanTestData();
  await closeDb();
});

describe("resuming a campaign that ran out of people to contact", () => {
  it("brings it back once the brand has a serveable audience again (AC1)", async () => {
    const campaign = await insertExhaustedCampaign();

    const resumed = await resumeServeableCampaigns();

    expect(resumed).toBe(1);
    const after = await read(campaign.id);
    expect(after?.status).toBe("ongoing");
  });

  it("returns it to the same state a live campaign is in, due immediately (AC2)", async () => {
    const campaign = await insertExhaustedCampaign();
    const now = new Date();

    await resumeServeableCampaigns(now);

    const after = await read(campaign.id);
    expect(after?.status).toBe("ongoing");
    // Due now → the very next scheduler tick claims it like any other running campaign.
    expect(after?.nextRunAt?.getTime()).toBe(now.getTime());
    // The stop it described is over; an ongoing campaign is never a resume candidate.
    expect(after?.stopReason).toBeNull();
  });

  it("leaves it stopped while the brand still has nobody to contact", async () => {
    const campaign = await insertExhaustedCampaign();
    mockServeableAudienceIds.mockResolvedValue([]);

    expect(await resumeServeableCampaigns()).toBe(0);
    expect((await read(campaign.id))?.status).toBe("stopped");
  });

  it("says which campaign came back and what made it serveable (AC6)", async () => {
    const campaign = await insertExhaustedCampaign();
    mockServeableAudienceIds.mockResolvedValue(["aud-a", "aud-b"]);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await resumeServeableCampaigns();

    const line = log.mock.calls.map((c) => String(c[0])).find((m) => m.includes("Resumed campaign"));
    expect(line).toContain(campaign.id);
    expect(line).toContain("aud-a");
    expect(line).toContain("aud-b");
    log.mockRestore();
  });
});

describe("a campaign stopped for any other reason (AC3)", () => {
  it("stays stopped when a person stopped it by hand", async () => {
    const campaign = await insertExhaustedCampaign({ stopReason: STOP_REASONS.MANUAL });

    expect(await resumeServeableCampaigns()).toBe(0);
    const after = await read(campaign.id);
    expect(after?.status).toBe("stopped");
    expect(after?.stopReason).toBe(STOP_REASONS.MANUAL);
    // It is not even a candidate — the audience owner is never asked about it.
    expect(mockServeableAudienceIds).not.toHaveBeenCalled();
  });

  it("stays stopped when it reached its lead cap", async () => {
    const campaign = await insertExhaustedCampaign({ stopReason: STOP_REASONS.MAX_LEADS_REACHED });

    expect(await resumeServeableCampaigns()).toBe(0);
    expect((await read(campaign.id))?.status).toBe("stopped");
  });

  it("stays stopped when its org was torn down", async () => {
    const campaign = await insertExhaustedCampaign({ stopReason: STOP_REASONS.ORG_TEARDOWN });

    expect(await resumeServeableCampaigns()).toBe(0);
    expect((await read(campaign.id))?.status).toBe("stopped");
  });

  it("stays stopped when no reason was ever recorded", async () => {
    // Every campaign stopped before the reason existed. A stop nobody wrote a reason for is not
    // evidence of exhaustion, so the whole historical stopped population is invisible here.
    const campaign = await insertExhaustedCampaign({ stopReason: null });

    expect(await resumeServeableCampaigns()).toBe(0);
    expect((await read(campaign.id))?.status).toBe("stopped");
  });
});

describe("one live campaign per identity (AC4)", () => {
  it("refuses to resume when an ongoing campaign already holds the identity", async () => {
    const brandId = crypto.randomUUID();
    const shared = {
      brandIds: [brandId],
      brandId,
      acquisitionChannel: "cold_email",
      funnelKey: "sales_meetings_from_conversation",
    };
    const incumbent = await insertTestCampaign(orgId, {
      ...shared,
      status: "ongoing",
      featureSlug: SALES_OUTREACH_FEATURE_SLUG,
      createdByUserId: "user-resume",
    });
    const exhausted = await insertExhaustedCampaign(shared);

    expect(await resumeServeableCampaigns()).toBe(0);
    expect((await read(exhausted.id))?.status).toBe("stopped");
    expect((await read(incumbent.id))?.status).toBe("ongoing");

    // Still exactly one live campaign for the identity.
    const ongoing = await db.query.campaigns.findMany({
      where: eq(campaigns.brandId, brandId),
      columns: { id: true, status: true },
    });
    expect(ongoing.filter((c) => c.status === "ongoing")).toHaveLength(1);
  });

  it("resumes when the ongoing sibling works a DIFFERENT funnel", async () => {
    const brandId = crypto.randomUUID();
    await insertTestCampaign(orgId, {
      brandIds: [brandId],
      brandId,
      acquisitionChannel: "cold_email",
      funnelKey: "website_purchases",
      status: "ongoing",
      featureSlug: SALES_OUTREACH_FEATURE_SLUG,
      createdByUserId: "user-resume",
    });
    const exhausted = await insertExhaustedCampaign({
      brandIds: [brandId],
      brandId,
      acquisitionChannel: "cold_email",
      funnelKey: "sales_meetings_from_conversation",
    });
    mockFetchFunnelBudgets.mockResolvedValue({
      ok: true,
      brandDailyBudgetCents: 5_000,
      funnels: [{ funnelKey: "sales_meetings_from_conversation", dailyBudgetCents: 2_500 }],
    });

    expect(await resumeServeableCampaigns()).toBe(1);
    expect((await read(exhausted.id))?.status).toBe("ongoing");
  });

  it("is idempotent — a second sweep over an already-resumed campaign does nothing", async () => {
    const campaign = await insertExhaustedCampaign();

    expect(await resumeServeableCampaigns()).toBe(1);
    resetResumeSweepThrottle();
    expect(await resumeServeableCampaigns()).toBe(0);

    const rows = await db.query.campaigns.findMany({ where: eq(campaigns.id, campaign.id) });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("ongoing");
  });
});

describe("a brand that is paused or has nothing funded (AC5)", () => {
  it("does not resume a paused brand's campaign, and does once it un-pauses", async () => {
    const brandId = crypto.randomUUID();
    const campaign = await insertExhaustedCampaign({ brandIds: [brandId], brandId });
    await setBrandPause(orgId, brandId, true);

    expect(await resumeServeableCampaigns()).toBe(0);
    expect((await read(campaign.id))?.status).toBe("stopped");

    await setBrandPause(orgId, brandId, false);
    resetResumeSweepThrottle();

    expect(await resumeServeableCampaigns()).toBe(1);
    expect((await read(campaign.id))?.status).toBe("ongoing");
  });

  it("does not resume when the brand's daily budget is zero", async () => {
    const campaign = await insertExhaustedCampaign();
    mockFetchFunnelBudgets.mockResolvedValue({ ok: true, brandDailyBudgetCents: 0, funnels: [] });

    expect(await resumeServeableCampaigns()).toBe(0);
    expect((await read(campaign.id))?.status).toBe("stopped");
  });

  it("does not resume when the brand has no daily budget set at all", async () => {
    const campaign = await insertExhaustedCampaign();
    mockFetchFunnelBudgets.mockResolvedValue({ ok: true, brandDailyBudgetCents: null, funnels: [] });

    expect(await resumeServeableCampaigns()).toBe(0);
    expect((await read(campaign.id))?.status).toBe("stopped");
  });

  it("does not resume a funnel campaign whose funnel is funded at zero", async () => {
    const campaign = await insertExhaustedCampaign({ funnelKey: "sales_meetings_from_conversation" });
    mockFetchFunnelBudgets.mockResolvedValue({
      ok: true,
      brandDailyBudgetCents: 5_000,
      // The brand funds ANOTHER funnel. Falling back to the brand total would let this one spend
      // the other funnel's money, so it stays stopped.
      funnels: [{ funnelKey: "website_purchases", dailyBudgetCents: 5_000 }],
    });

    expect(await resumeServeableCampaigns()).toBe(0);
    expect((await read(campaign.id))?.status).toBe("stopped");
  });

  it("resumes a funnel campaign on the pre-rename spelling billing still emits", async () => {
    // billing names this funnel `reply_meeting`; the campaign states the canonical key. Comparing
    // raw tokens would read a fully funded funnel as unfunded and never bring the campaign back.
    const campaign = await insertExhaustedCampaign({ funnelKey: "sales_meetings_from_conversation" });
    mockFetchFunnelBudgets.mockResolvedValue({
      ok: true,
      brandDailyBudgetCents: 5_000,
      funnels: [{ funnelKey: "sales_meetings_from_conversation", dailyBudgetCents: 2_500 }],
    });

    expect(await resumeServeableCampaigns()).toBe(1);
    expect((await read(campaign.id))?.status).toBe("ongoing");
  });

  it("resumes on the campaign's OWN daily budget without asking billing", async () => {
    const campaign = await insertExhaustedCampaign({ dailyBudgetCents: 1_000 });

    expect(await resumeServeableCampaigns()).toBe(1);
    expect((await read(campaign.id))?.status).toBe("ongoing");
    expect(mockFetchFunnelBudgets).not.toHaveBeenCalled();
  });
});

describe("a resume that cannot be decided safely", () => {
  it("leaves the campaign stopped when billing does not answer", async () => {
    const campaign = await insertExhaustedCampaign();
    mockFetchFunnelBudgets.mockResolvedValue({ ok: false });

    expect(await resumeServeableCampaigns()).toBe(0);
    expect((await read(campaign.id))?.status).toBe("stopped");
  });

  it("leaves the campaign stopped when the audience owner throws", async () => {
    const campaign = await insertExhaustedCampaign();
    mockServeableAudienceIds.mockRejectedValue(new Error("features-service down"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await resumeServeableCampaigns()).toBe(0);
    expect((await read(campaign.id))?.status).toBe("stopped");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("one undecidable campaign does not stop the next one from resuming", async () => {
    const broken = await insertExhaustedCampaign({ updatedAt: new Date(Date.now() - 120_000) });
    const fine = await insertExhaustedCampaign({ updatedAt: new Date(Date.now() - 60_000) });
    mockServeableAudienceIds.mockImplementation(async (c: { id: string }) =>
      c.id === broken.id ? Promise.reject(new Error("boom")) : ["audience-fresh"],
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await resumeServeableCampaigns()).toBe(1);
    expect((await read(broken.id))?.status).toBe("stopped");
    expect((await read(fine.id))?.status).toBe("ongoing");
    warn.mockRestore();
  });
});

describe("the sweep's own cadence", () => {
  it("does not re-ask the audience owner before its interval has passed", async () => {
    await insertExhaustedCampaign();
    mockServeableAudienceIds.mockResolvedValue([]);

    await resumeServeableCampaigns();
    expect(mockServeableAudienceIds).toHaveBeenCalledTimes(1);

    // A scheduler tick a minute later must not turn into a second fan-out.
    await resumeServeableCampaigns(new Date(Date.now() + 60_000));
    expect(mockServeableAudienceIds).toHaveBeenCalledTimes(1);

    await resumeServeableCampaigns(new Date(Date.now() + RESUME_SWEEP_INTERVAL_MS + 1_000));
    expect(mockServeableAudienceIds).toHaveBeenCalledTimes(2);
  });

  it("counts what is waiting so the scheduler does not sleep an hour on it", async () => {
    expect(await countResumableCampaigns()).toBe(0);
    await insertExhaustedCampaign();
    expect(await countResumableCampaigns()).toBe(1);
  });
});
