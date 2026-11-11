import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// NEXT-STEPS-TRUE-REASON-1111: every hold of ours is stated on the campaign's next steps (features-service), and the
// next Engine dispatch clears it. tests/setup.ts stubs the statement fleet-wide; this file reads the real module.
vi.mock("../../src/lib/engine-answer.js", async () => await vi.importActual("../../src/lib/engine-answer.js"));
const legs = [{ legKey: "lead_found_to_conversation", fromStepKey: "lead_found", toStepKey: "conversation" }];
vi.mock("../../src/lib/channel-operator-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/channel-operator-client.js")>()),
  fetchChannelCatalogue: vi.fn(async () => ({ ok: true, operatorBySlug: new Map(), legsBySlug: new Map(), legs })),
}));

const { stateEngineAnswer, isCampaignHold, isGateHold, RUN_IN_PROGRESS_REASON } = await import("../../src/lib/engine-answer.js");
const { reportTurnHolds } = await import("../../src/lib/turn-hold-event.js");
const { executeCampaignWorkflow } = await import("../../src/lib/workflows.js");
const { resetEngineStateCache } = await import("../../src/lib/engine-dispatch.js");

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  resetEngineStateCache();
  process.env.FEATURES_SERVICE_URL = "http://features";
  process.env.FEATURES_SERVICE_API_KEY = "fk";
  process.env.WORKFLOW_SERVICE_URL = "http://workflow";
  process.env.WORKFLOW_SERVICE_API_KEY = "wk";
  fetchMock = vi.fn(async () => new Response(JSON.stringify({}), { status: 202 }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const answers = () =>
  fetchMock.mock.calls
    .filter(([url]) => String(url) === "http://features/internal/campaign-engine-answers")
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)));

const unit = {
  id: "unit-1",
  orgId: "org-1",
  createdByUserId: "user-1",
  parentRunId: null,
  workflowSlug: "engine:conversation",
  brandIds: ["brand-1"],
  featureSlug: "sales-cold-email-outreach",
  legKey: "lead_found_to_conversation",
};

describe("a hold of ours on a campaign's Engine run", () => {
  it("a run held for budget states {unit, Engine, reason}; the next run that dispatches states null", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await reportTurnHolds([{ campaign: unit, reason: "daily_ceiling_reached", detail: "spent", nextRunAt: new Date() }]);
    expect(answers()).toEqual([{ campaignId: "unit-1", outcome: "conversation", heldReason: "daily_ceiling_reached" }]);
    const [, init] = fetchMock.mock.calls.find(([url]) => String(url).startsWith("http://features"))!;
    expect((init as RequestInit).headers).toMatchObject({ "x-api-key": "fk" });

    fetchMock.mockImplementation(async (url: unknown) =>
      String(url).startsWith("http://workflow")
        ? new Response(JSON.stringify({ runId: "run-9" }), { status: 200 })
        : new Response("{}", { status: 202 }));
    const ran = await executeCampaignWorkflow("engine:conversation", {
      campaignId: "unit-1", orgId: "org-1", brandId: "brand-1", userId: "user-1", runId: "anchor-1", featureSlug: "sales-cold-email-outreach",
    }, { outcome: "conversation", fromOutcome: "lead_found" });
    expect(ran).toEqual({ runId: "run-9" });
    await vi.waitFor(() => expect(answers()).toHaveLength(2));
    expect(answers()[1]).toEqual({ campaignId: "unit-1", outcome: "conversation", heldReason: null });
  });

  it("states nothing for a campaign with no Engine (no leg)", async () => {
    await stateEngineAnswer({ id: "c", featureSlug: "x", legKey: null, workflowSlug: "wf" }, "unfunded");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails soft: a refused or failed statement is logged, never thrown", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(new Response("nope", { status: 500 }));
    await expect(stateEngineAnswer(unit, "unfunded")).resolves.toBeUndefined();
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(stateEngineAnswer(unit, "unfunded")).resolves.toBeUndefined();
    expect(err).toHaveBeenCalledTimes(2);
  });

  it("a queue turn (a run in flight) is not a hold; money, pacing and an unreadable state are", () => {
    for (const r of ["sales_funnel_cap", "unfunded", "sales_funnel_caps_unavailable", "failure_backoff", "engine_state_unreadable"]) expect(isCampaignHold(r)).toBe(true);
    for (const r of ["run_in_flight", "cohort_run_in_flight", "event_names_another_person", "person_suppressed"]) expect(isCampaignHold(r)).toBe(false);
    expect(isGateHold(RUN_IN_PROGRESS_REASON)).toBe(false);
    expect(isGateHold("Insufficient credits")).toBe(true);
  });
});
