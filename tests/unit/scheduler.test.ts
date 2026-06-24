import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const {
  mockExecuteCampaignWorkflow,
  mockResolveWorkflowSlug,
  mockDbReturning,
  mockDbFindMany,
  mockListRuns,
} = vi.hoisted(() => {
  return {
    mockExecuteCampaignWorkflow: vi.fn(),
    mockResolveWorkflowSlug: vi.fn(),
    mockDbReturning: vi.fn(),
    mockDbFindMany: vi.fn(),
    mockListRuns: vi.fn(),
  };
});

vi.mock("../../src/lib/workflows.js", () => ({
  executeCampaignWorkflow: mockExecuteCampaignWorkflow,
}));

// The workflow bandit resolves to the campaign's configured slug here (the
// fallback), so the existing executeCampaignWorkflow assertions on slug still hold.
vi.mock("../../src/lib/features-candidates-client.js", () => ({
  resolveWorkflowSlugForTrigger: mockResolveWorkflowSlug,
}));

vi.mock("@distribute/runs-client", () => ({
  listRuns: mockListRuns,
}));

vi.mock("../../src/db/index.js", () => ({
  db: {
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: mockDbReturning,
        }),
      }),
    }),
    query: {
      campaigns: {
        findMany: mockDbFindMany,
      },
    },
  },
}));

vi.mock("../../src/db/schema.js", () => ({
  campaigns: {
    id: "id",
    status: "status",
    nextRunAt: "next_run_at",
    workflowSlug: "workflow_slug",
    orgId: "org_id",
    updatedAt: "updated_at",
    brandIds: "brand_ids",
    createdByUserId: "created_by_user_id",
    parentRunId: "parent_run_id",
    featureSlug: "feature_slug",
    activeGoalId: "active_goal_id",
    brandProfileId: "brand_profile_id",
    audienceId: "audience_id",
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(),
  and: vi.fn(),
  lte: vi.fn(),
  isNotNull: vi.fn(),
  isNull: vi.fn(),
}));

// The pause filter is exercised in tests/integration/brand-pause.test.ts against a real DB.
// Here it's a no-op fragment so the narrowly-mocked db/schema/drizzle-orm stay sufficient.
vi.mock("../../src/lib/brand-pause.js", () => ({
  notPausedBrandClause: vi.fn(() => undefined),
}));

import {
  reRunDueCampaigns,
  claimStuckCampaigns,
  computeNextDelayMs,
  startScheduler,
  wakeScheduler,
  ACTIVE_INTERVAL_MS,
  IDLE_MAX_MS,
} from "../../src/lib/scheduler.js";

describe("Scheduler - reRunDueCampaigns", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecuteCampaignWorkflow.mockResolvedValue(undefined);
    mockResolveWorkflowSlug.mockImplementation(async (a: { fallbackSlug: string }) => a.fallbackSlug);
    mockDbReturning.mockResolvedValue([]);
    mockListRuns.mockResolvedValue({ runs: [], limit: 50, offset: 0 });
  });

  it("should return 0 when no campaigns are due", async () => {
    const count = await reRunDueCampaigns();
    expect(count).toBe(0);
    expect(mockExecuteCampaignWorkflow).not.toHaveBeenCalled();
  });

  it("should re-trigger due campaigns using atomic UPDATE RETURNING", async () => {
    mockDbReturning.mockResolvedValue([
      {
        id: "campaign-1",
        orgId: "org-ext-1",
        workflowSlug: "sales-email-cold-outreach",
        brandIds: ["brand-123"],
        createdByUserId: "user-1",
        parentRunId: null,
        featureSlug: "sales-cold-email-v1",
      },
    ]);

    const count = await reRunDueCampaigns();

    expect(count).toBe(1);
    expect(mockExecuteCampaignWorkflow).toHaveBeenCalledWith(
      "sales-email-cold-outreach",
      expect.objectContaining({
        campaignId: "campaign-1",
        orgId: "org-ext-1",
        brandId: "brand-123",
        userId: "user-1",
        featureSlug: "sales-cold-email-v1",
      }),
    );
  });

  it("should NOT create a run — let the workflow's start-run do it", async () => {
    mockDbReturning.mockResolvedValue([
      {
        id: "campaign-1",
        orgId: "org-ext-1",
        workflowSlug: "sales-email-cold-outreach",
        brandIds: ["brand-123"],
        createdByUserId: "user-1",
        parentRunId: null,
        featureSlug: "sales-cold-email-v1",
      },
    ]);

    await reRunDueCampaigns();

    // No createRun import or call — scheduler delegates run creation to the DAG
    expect(mockExecuteCampaignWorkflow).toHaveBeenCalledTimes(1);
  });

  it("should use parentRunId as runId when available", async () => {
    mockDbReturning.mockResolvedValue([
      {
        id: "campaign-1",
        orgId: "org-ext-1",
        workflowSlug: "sales-email-cold-outreach",
        brandIds: ["brand-123"],
        createdByUserId: "user-1",
        parentRunId: "parent-run-abc",
        featureSlug: "sales-cold-email-v1",
      },
    ]);

    await reRunDueCampaigns();

    expect(mockExecuteCampaignWorkflow).toHaveBeenCalledWith(
      "sales-email-cold-outreach",
      expect.objectContaining({ runId: "parent-run-abc" }),
    );
  });

  it("should preserve persona/profile attribution when re-triggering due campaigns", async () => {
    mockDbReturning.mockResolvedValue([
      {
        id: "campaign-1",
        orgId: "org-ext-1",
        workflowSlug: "sales-email-cold-outreach",
        brandIds: ["brand-123"],
        createdByUserId: "user-1",
        parentRunId: null,
        featureSlug: "sales-cold-email-v1",
        activeGoalId: "goal-1",
        brandProfileId: "brand-profile-1",
        audienceId: "customer-profile-1",
      },
    ]);

    await reRunDueCampaigns();

    expect(mockExecuteCampaignWorkflow).toHaveBeenCalledWith(
      "sales-email-cold-outreach",
      expect.objectContaining({
        activeGoalId: "goal-1",
        brandProfileId: "brand-profile-1",
        audienceId: "customer-profile-1",
      }),
    );
  });

  it("should generate a UUID runId when no parentRunId", async () => {
    mockDbReturning.mockResolvedValue([
      {
        id: "campaign-1",
        orgId: "org-ext-1",
        workflowSlug: "sales-email-cold-outreach",
        brandIds: ["brand-123"],
        createdByUserId: "user-1",
        parentRunId: null,
        featureSlug: "sales-cold-email-v1",
      },
    ]);

    await reRunDueCampaigns();

    const call = mockExecuteCampaignWorkflow.mock.calls[0];
    expect(call[1].runId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("should skip campaigns without brandIds", async () => {
    mockDbReturning.mockResolvedValue([
      {
        id: "campaign-no-brand",
        orgId: "org-ext-1",
        workflowSlug: "sales-email-cold-outreach",
        brandIds: null,
        createdByUserId: "user-1",
        parentRunId: null,
        featureSlug: "sales-cold-email-v1",
      },
    ]);

    const count = await reRunDueCampaigns();

    expect(count).toBe(1);
    expect(mockExecuteCampaignWorkflow).not.toHaveBeenCalled();
  });

  it("should skip campaigns without createdByUserId or featureSlug", async () => {
    mockDbReturning.mockResolvedValue([
      {
        id: "campaign-no-user",
        orgId: "org-ext-1",
        workflowSlug: "sales-email-cold-outreach",
        brandIds: ["brand-1"],
        createdByUserId: null,
        parentRunId: null,
        featureSlug: null,
      },
    ]);

    const count = await reRunDueCampaigns();

    expect(count).toBe(1);
    expect(mockExecuteCampaignWorkflow).not.toHaveBeenCalled();
  });

  it("should handle multiple due campaigns", async () => {
    mockDbReturning.mockResolvedValue([
      {
        id: "campaign-1",
        orgId: "org-ext-1",
        workflowSlug: "sales-email-cold-outreach",
        brandIds: ["brand-1"],
        createdByUserId: "user-1",
        parentRunId: null,
        featureSlug: "sales-cold-email-v1",
      },
      {
        id: "campaign-2",
        orgId: "org-ext-2",
        workflowSlug: "pr-email-cold-outreach",
        brandIds: ["brand-2"],
        createdByUserId: "user-2",
        parentRunId: null,
        featureSlug: "pr-media-pitch-v1",
      },
    ]);

    const count = await reRunDueCampaigns();

    expect(count).toBe(2);
    expect(mockExecuteCampaignWorkflow).toHaveBeenCalledTimes(2);
  });

  it("should NOT fire when a running run already exists for the campaign", async () => {
    mockDbReturning.mockResolvedValue([
      {
        id: "campaign-1",
        orgId: "org-ext-1",
        workflowSlug: "sales-email-cold-outreach",
        brandIds: ["brand-123"],
        createdByUserId: "user-1",
        parentRunId: null,
        featureSlug: "sales-cold-email-v1",
      },
    ]);
    mockListRuns.mockResolvedValue({
      runs: [{ id: "run-inflight", status: "running", startedAt: new Date().toISOString() }],
      limit: 50,
      offset: 0,
    });

    const count = await reRunDueCampaigns();

    expect(count).toBe(1);
    // Guard is scoped to the campaign (any service), NOT the ephemeral
    // (campaign-service, campaignId) marker run — so a live lead-service
    // buffer/next run is seen.
    const guardCall = mockListRuns.mock.calls[0][0];
    expect(guardCall).toEqual(
      expect.objectContaining({
        orgId: "org-ext-1",
        campaignId: "campaign-1",
        status: "running",
        startedAfter: expect.any(String),
      }),
    );
    expect(guardCall.serviceName).toBeUndefined();
    expect(guardCall.taskName).toBeUndefined();
    expect(mockExecuteCampaignWorkflow).not.toHaveBeenCalled();
  });

  it("should detect a live run owned by another service (e.g. lead-service)", async () => {
    mockDbReturning.mockResolvedValue([
      {
        id: "campaign-1",
        orgId: "org-ext-1",
        workflowSlug: "sales-email-cold-outreach",
        brandIds: ["brand-123"],
        createdByUserId: "user-1",
        parentRunId: null,
        featureSlug: "sales-cold-email-v1",
      },
    ]);
    // The campaign-service marker is long dead; the genuinely-alive run is a
    // lead-service buffer/next fill. campaignId-scoped query returns it.
    mockListRuns.mockResolvedValue({
      runs: [{ id: "lead-serve-run", status: "running", startedAt: new Date().toISOString() }],
      limit: 50,
      offset: 0,
    });

    await reRunDueCampaigns();

    expect(mockExecuteCampaignWorkflow).not.toHaveBeenCalled();
  });

  it("should re-fire when the only running run has aged past the freshness threshold", async () => {
    mockDbReturning.mockResolvedValue([
      {
        id: "campaign-1",
        orgId: "org-ext-1",
        workflowSlug: "sales-email-cold-outreach",
        brandIds: ["brand-123"],
        createdByUserId: "user-1",
        parentRunId: null,
        featureSlug: "sales-cold-email-v1",
      },
    ]);
    // runs-service filters by startedAfter=freshnessCutoff; an orphan older than
    // 15min is excluded → empty result → re-fire (orphan recovery).
    mockListRuns.mockResolvedValue({ runs: [], limit: 50, offset: 0 });

    const before = Date.now();
    await reRunDueCampaigns();

    // Freshness cutoff sent to runs-service is ~15min in the past.
    const cutoffIso = mockListRuns.mock.calls[0][0].startedAfter as string;
    const cutoffAgeMs = before - new Date(cutoffIso).getTime();
    expect(cutoffAgeMs).toBeGreaterThanOrEqual(15 * 60_000 - 5_000);
    expect(cutoffAgeMs).toBeLessThanOrEqual(15 * 60_000 + 5_000);
    expect(mockExecuteCampaignWorkflow).toHaveBeenCalledTimes(1);
  });

  it("should reschedule nextRunAt to ~now+60s when skipping due to in-flight run", async () => {
    mockDbReturning.mockResolvedValue([
      {
        id: "campaign-skip",
        orgId: "org-ext-1",
        workflowSlug: "sales-email-cold-outreach",
        brandIds: ["brand-123"],
        createdByUserId: "user-1",
        parentRunId: null,
        featureSlug: "sales-cold-email-v1",
      },
    ]);
    mockListRuns.mockResolvedValue({
      runs: [{ id: "run-inflight", status: "running", startedAt: new Date().toISOString() }],
      limit: 50,
      offset: 0,
    });

    const { db } = await import("../../src/db/index.js");
    const setMock = (db.update as unknown as ReturnType<typeof vi.fn>)().set as unknown as ReturnType<typeof vi.fn>;
    setMock.mockClear();

    const before = Date.now();
    await reRunDueCampaigns();

    // The atomic claim call uses .set({ nextRunAt: null, ... }) → returning(...).
    // The reschedule call uses .set({ nextRunAt: <Date>, ... }) with no .returning() chain.
    // Find the call whose payload has a Date nextRunAt.
    const rescheduleCall = setMock.mock.calls.find((args) => args[0]?.nextRunAt instanceof Date);
    expect(rescheduleCall).toBeDefined();
    const rescheduledAt = rescheduleCall![0].nextRunAt as Date;
    expect(rescheduledAt.getTime()).toBeGreaterThanOrEqual(before + 55_000);
    expect(rescheduledAt.getTime()).toBeLessThan(before + 65_000);
  });

  it("should continue processing other campaigns if one throws", async () => {
    mockDbReturning.mockResolvedValue([
      {
        id: "campaign-1",
        orgId: "org-ext-1",
        workflowSlug: "sales-email-cold-outreach",
        brandIds: ["brand-1"],
        createdByUserId: "user-1",
        parentRunId: null,
        featureSlug: "sales-cold-email-v1",
      },
      {
        id: "campaign-2",
        orgId: "org-ext-2",
        workflowSlug: "pr-email-cold-outreach",
        brandIds: ["brand-2"],
        createdByUserId: "user-2",
        parentRunId: null,
        featureSlug: "pr-media-pitch-v1",
      },
    ]);

    // First workflow execution throws synchronously
    mockExecuteCampaignWorkflow
      .mockImplementationOnce(() => { throw new Error("Workflow error"); })
      .mockResolvedValueOnce(undefined);

    const count = await reRunDueCampaigns();

    expect(count).toBe(2);
    expect(mockExecuteCampaignWorkflow).toHaveBeenCalledTimes(2);
  });
});

describe("Scheduler - claimStuckCampaigns", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbReturning.mockResolvedValue([]);
    mockDbFindMany.mockResolvedValue([]);
    mockListRuns.mockResolvedValue({ runs: [], limit: 50, offset: 0 });
  });

  it("should return 0 and skip runs-service when no candidates", async () => {
    mockDbFindMany.mockResolvedValue([]);

    const count = await claimStuckCampaigns();

    expect(count).toBe(0);
    expect(mockListRuns).not.toHaveBeenCalled();
    expect(mockDbReturning).not.toHaveBeenCalled();
  });

  it("should NOT claim when a fresh running run exists", async () => {
    mockDbFindMany.mockResolvedValue([{ id: "c-running", orgId: "org-1" }]);
    mockListRuns.mockResolvedValue({
      runs: [
        { id: "run-1", status: "running", startedAt: new Date().toISOString() },
      ],
      limit: 50,
      offset: 0,
    });

    const count = await claimStuckCampaigns();

    expect(count).toBe(0);
    // Same campaignId-scoped definition of "alive" as reRunDueCampaigns.
    const guardCall = mockListRuns.mock.calls[0][0];
    expect(guardCall).toEqual(
      expect.objectContaining({
        orgId: "org-1",
        campaignId: "c-running",
        status: "running",
        startedAfter: expect.any(String),
      }),
    );
    expect(guardCall.serviceName).toBeUndefined();
    expect(guardCall.taskName).toBeUndefined();
    expect(mockDbReturning).not.toHaveBeenCalled();
  });

  it("should NOT reclaim a campaign whose run is 10-min-but-alive (within 15-min window)", async () => {
    mockDbFindMany.mockResolvedValue([{ id: "c-long-fill", orgId: "org-1" }]);
    // A 10-min-old buffer/next run is still within the 15-min freshness window,
    // so runs-service (startedAfter filter) returns it → alive → not stuck.
    const tenMinOld = new Date(Date.now() - 10 * 60_000).toISOString();
    mockListRuns.mockResolvedValue({
      runs: [{ id: "lead-serve-run", status: "running", startedAt: tenMinOld }],
      limit: 50,
      offset: 0,
    });

    const count = await claimStuckCampaigns();

    expect(count).toBe(0);
    const cutoffIso = mockListRuns.mock.calls[0][0].startedAfter as string;
    const cutoffAgeMs = Date.now() - new Date(cutoffIso).getTime();
    expect(cutoffAgeMs).toBeGreaterThanOrEqual(15 * 60_000 - 5_000);
    expect(cutoffAgeMs).toBeLessThanOrEqual(15 * 60_000 + 5_000);
    expect(mockDbReturning).not.toHaveBeenCalled();
  });

  it("should claim when no running run exists (true stuck)", async () => {
    mockDbFindMany.mockResolvedValue([{ id: "c-stuck", orgId: "org-2" }]);
    mockListRuns.mockResolvedValue({ runs: [], limit: 50, offset: 0 });
    mockDbReturning.mockResolvedValue([{ id: "c-stuck" }]);

    const count = await claimStuckCampaigns();

    expect(count).toBe(1);
    expect(mockListRuns).toHaveBeenCalledTimes(1);
    expect(mockDbReturning).toHaveBeenCalledTimes(1);
  });

  it("should only claim the stuck candidate when mixed with a running one", async () => {
    mockDbFindMany.mockResolvedValue([
      { id: "c-running", orgId: "org-1" },
      { id: "c-stuck", orgId: "org-2" },
    ]);
    mockListRuns
      .mockResolvedValueOnce({
        runs: [
          { id: "run-1", status: "running", startedAt: new Date().toISOString() },
        ],
        limit: 50,
        offset: 0,
      })
      .mockResolvedValueOnce({ runs: [], limit: 50, offset: 0 });
    mockDbReturning.mockResolvedValue([{ id: "c-stuck" }]);

    const count = await claimStuckCampaigns();

    expect(count).toBe(1);
    expect(mockListRuns).toHaveBeenCalledTimes(2);
    expect(mockDbReturning).toHaveBeenCalledTimes(1);
  });

  it("should propagate listRuns errors (no swallow)", async () => {
    mockDbFindMany.mockResolvedValue([{ id: "c1", orgId: "org-1" }]);
    mockListRuns.mockRejectedValue(new Error("runs-service down"));

    await expect(claimStuckCampaigns()).rejects.toThrow("runs-service down");
    expect(mockDbReturning).not.toHaveBeenCalled();
  });
});

describe("Scheduler - logging hygiene", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExecuteCampaignWorkflow.mockResolvedValue(undefined);
    mockResolveWorkflowSlug.mockImplementation(async (a: { fallbackSlug: string }) => a.fallbackSlug);
    mockDbReturning.mockResolvedValue([]);
    mockDbFindMany.mockResolvedValue([]);
    mockListRuns.mockResolvedValue({ runs: [], limit: 50, offset: 0 });
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it("reRunDueCampaigns should NOT log 'Claimed N campaign(s) for re-run'", async () => {
    mockDbReturning.mockResolvedValue([
      {
        id: "campaign-1",
        orgId: "org-1",
        workflowSlug: "sales-email-cold-outreach",
        brandIds: ["brand-1"],
        createdByUserId: "user-1",
        parentRunId: null,
        featureSlug: "sales-cold-email-v1",
      },
    ]);

    await reRunDueCampaigns();

    const allLogs = [
      ...logSpy.mock.calls.flat(),
      ...warnSpy.mock.calls.flat(),
    ].join(" ");
    expect(allLogs).not.toMatch(/Claimed \d+ campaign\(s\) for re-run/);
  });

  it("claimStuckCampaigns should NOT emit a warn and should log per claim", async () => {
    mockDbFindMany.mockResolvedValue([{ id: "c-stuck", orgId: "org-2" }]);
    mockListRuns.mockResolvedValue({ runs: [], limit: 50, offset: 0 });
    mockDbReturning.mockResolvedValue([{ id: "c-stuck" }]);

    await claimStuckCampaigns();

    expect(warnSpy).not.toHaveBeenCalled();
    const allLogs = logSpy.mock.calls.flat().join(" ");
    expect(allLogs).toMatch(/Claimed stuck campaign c-stuck/);
  });

  it("claimStuckCampaigns should NOT log when nothing claimed", async () => {
    mockDbFindMany.mockResolvedValue([{ id: "c-running", orgId: "org-1" }]);
    mockListRuns.mockResolvedValue({
      runs: [
        { id: "run-1", status: "running", startedAt: new Date().toISOString() },
      ],
      limit: 50,
      offset: 0,
    });

    await claimStuckCampaigns();

    expect(warnSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
  });
});

describe("Scheduler - computeNextDelayMs (cadence)", () => {
  const NOW = 1_000_000_000_000;

  it("returns IDLE_MAX_MS when no campaigns are ongoing (Neon can suspend)", () => {
    expect(computeNextDelayMs([], NOW)).toBe(IDLE_MAX_MS);
  });

  it("returns ACTIVE_INTERVAL_MS when a campaign is in-flight and no scheduled campaign is due sooner", () => {
    const delay = computeNextDelayMs(
      [{ nextRunAt: null }, { nextRunAt: new Date(NOW + 5 * 60_000) }],
      NOW,
    );
    expect(delay).toBe(ACTIVE_INTERVAL_MS);
  });

  it("sleeps until a sooner scheduled nextRunAt even while another campaign is in-flight", () => {
    const delay = computeNextDelayMs(
      [{ nextRunAt: null }, { nextRunAt: new Date(NOW + 10_000) }],
      NOW,
    );
    expect(delay).toBe(10_000);
  });

  it("sleeps until the soonest future nextRunAt when all are waiting", () => {
    const delay = computeNextDelayMs(
      [
        { nextRunAt: new Date(NOW + 5 * 60_000) },
        { nextRunAt: new Date(NOW + 30 * 60_000) },
      ],
      NOW,
    );
    expect(delay).toBe(5 * 60_000);
  });

  it("caps the delay at IDLE_MAX_MS for a far-future nextRunAt (setTimeout-overflow safe)", () => {
    const delay = computeNextDelayMs(
      [{ nextRunAt: new Date(NOW + 6 * 60 * 60_000) }], // 6h away
      NOW,
    );
    expect(delay).toBe(IDLE_MAX_MS);
  });

  it("floors the delay at 1s for a due/past nextRunAt (no busy-spin)", () => {
    expect(computeNextDelayMs([{ nextRunAt: new Date(NOW - 10_000) }], NOW)).toBe(1_000);
    expect(computeNextDelayMs([{ nextRunAt: new Date(NOW + 500) }], NOW)).toBe(1_000);
  });
});

describe("Scheduler - lifecycle (timers)", () => {
  let stop: (() => void) | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExecuteCampaignWorkflow.mockResolvedValue(undefined);
    mockResolveWorkflowSlug.mockImplementation(async (a: { fallbackSlug: string }) => a.fallbackSlug);
    mockDbReturning.mockResolvedValue([]);
    mockDbFindMany.mockResolvedValue([]);
    mockListRuns.mockResolvedValue({ runs: [], limit: 50, offset: 0 });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.useFakeTimers();
  });

  afterEach(() => {
    if (stop) {
      stop();
      stop = null;
    }
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("runs an immediate tick on start (queries ongoing campaigns)", async () => {
    stop = startScheduler();
    await vi.advanceTimersByTimeAsync(0);
    expect(mockDbFindMany).toHaveBeenCalled();
  });

  it("wakeScheduler() triggers a prompt tick", async () => {
    stop = startScheduler();
    await vi.advanceTimersByTimeAsync(0); // boot tick (0 ongoing → next tick in IDLE_MAX_MS)
    mockDbFindMany.mockClear();

    wakeScheduler();
    await vi.advanceTimersByTimeAsync(0);
    expect(mockDbFindMany).toHaveBeenCalled();
  });

  it("with 0 ongoing campaigns, does NOT re-poll at the 60s active cadence", async () => {
    stop = startScheduler();
    await vi.advanceTimersByTimeAsync(0); // boot tick: 0 ongoing → schedules IDLE_MAX_MS
    mockDbFindMany.mockClear();

    // No tick should fire at the old 60s interval — Neon stays asleep.
    await vi.advanceTimersByTimeAsync(ACTIVE_INTERVAL_MS + 5_000);
    expect(mockDbFindMany).not.toHaveBeenCalled();

    // The idle backstop tick fires only once IDLE_MAX_MS has elapsed.
    await vi.advanceTimersByTimeAsync(IDLE_MAX_MS);
    expect(mockDbFindMany).toHaveBeenCalled();
  });

  it("wakeScheduler() is a no-op when the scheduler is not started", async () => {
    // Note: no startScheduler() call here.
    wakeScheduler();
    await vi.advanceTimersByTimeAsync(IDLE_MAX_MS + ACTIVE_INTERVAL_MS);
    expect(mockDbFindMany).not.toHaveBeenCalled();
  });
});
