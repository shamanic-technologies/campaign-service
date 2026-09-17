import { describe, it, expect, beforeEach, vi } from "vitest";

const { mockTraceEvent } = vi.hoisted(() => ({ mockTraceEvent: vi.fn() }));

vi.mock("../../src/lib/trace-event.js", () => ({ traceEvent: mockTraceEvent }));

import { reportCampaignRecovery } from "../../src/lib/recovery-event.js";

const campaign = {
  id: "647572d9-729e-4731-9456-28fa351be92c",
  orgId: "org-1",
  createdByUserId: "user-1",
  parentRunId: "anchor-run-1",
  workflowSlug: "sales-cold-email-outreach-pelican",
  brandIds: ["brand-1"],
  featureSlug: "sales-cold-email-outreach",
};

describe("reportCampaignRecovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTraceEvent.mockResolvedValue(undefined);
  });

  it("rides the campaign's own ancestor run and names what it recovered", async () => {
    await reportCampaignRecovery({
      campaign,
      detail: "Campaign was re-scheduled by the stuck sweep.",
      nextRunAt: new Date("2026-09-17T06:06:05.000Z"),
      orphanedRunIds: ["orphan-1"],
    });

    expect(mockTraceEvent).toHaveBeenCalledTimes(1);
    const [runId, payload, headers] = mockTraceEvent.mock.calls[0];
    // The ancestor run runs-service can resolve — never a minted uuid, which it refuses.
    expect(runId).toBe("anchor-run-1");
    expect(payload.event).toBe("campaign-recovery");
    // A run that died without reporting an end is a FAULT, not an expected business state.
    expect(payload.level).toBe("warn");
    expect(payload.data).toEqual(
      expect.objectContaining({
        reason: "orphaned_run",
        campaignId: campaign.id,
        orphanedRunIds: ["orphan-1"],
      }),
    );
    // run_events.campaign_id comes from this header — it is what makes the recovery readable
    // from run_events alone.
    expect(headers["x-campaign-id"]).toBe(campaign.id);
    expect(headers["x-org-id"]).toBe("org-1");
  });

  it("says so rather than inventing a run when the campaign has no ancestor", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await reportCampaignRecovery({
      campaign: { ...campaign, parentRunId: null },
      detail: "d",
      nextRunAt: new Date(),
      orphanedRunIds: [],
    });

    expect(mockTraceEvent).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
