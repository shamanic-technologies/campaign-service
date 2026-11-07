import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// MIGRATE-1105 S0: a campaign whose Engine is live is dispatched to it, the SAME way for a proactive tick and a
// reactive occurrence; anything else runs its workflow exactly as before.
const legs = [
  { legKey: "start_to_lead_found", fromStepKey: null, toStepKey: "lead_found" },
  { legKey: "conversation_to_meeting_booked", fromStepKey: "conversation", toStepKey: "meeting_booked" },
  { legKey: "lead_found_to_conversation", fromStepKey: "lead_found", toStepKey: "conversation" },
];
const catalogueRead = { ok: true as const, operatorBySlug: new Map(), legsBySlug: new Map(), legs };
vi.mock("../../src/lib/channel-operator-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/channel-operator-client.js")>()),
  fetchChannelCatalogue: vi.fn(async () => catalogueRead),
}));
const actual = await vi.importActual<typeof import("../../src/lib/engine-dispatch.js")>("../../src/lib/engine-dispatch.js");
const { engineOfLeg, liveEngineFor, executeCampaignEngine, resetEngineStateCache, EngineStateUnreadableError, ENGINE_STATE_CACHE_MS, ENGINE_STATE_STALE_MAX_MS } = actual;
const { fetchChannelCatalogue } = await import("../../src/lib/channel-operator-client.js");

const inputs = {
  campaignId: "camp-1",
  orgId: "org-1",
  brandId: "brand-1",
  userId: "user-1",
  runId: "run-1",
  featureSlug: "lead-sourcing",
  audienceId: "aud-1",
};

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  resetEngineStateCache();
  process.env.WORKFLOW_SERVICE_URL = "http://workflow";
  process.env.WORKFLOW_SERVICE_API_KEY = "k";
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("the Engine of a campaign", () => {
  it("is the step its leg reaches, read off the catalogue (a leg is never parsed)", () => {
    const c = catalogueRead as never;
    expect(engineOfLeg(c, "lead-sourcing", "start_to_lead_found")).toEqual({ fromOutcome: "start", outcome: "lead_found" });
    expect(engineOfLeg(c, "ai-meeting-booking", "conversation_to_meeting_booked")).toEqual({ fromOutcome: "conversation", outcome: "meeting_booked" });
    expect(engineOfLeg(c, "x", null)).toBeNull();
    expect(engineOfLeg(c, "x", "unpublished_leg")).toBeNull();
    expect(engineOfLeg({ ok: false, detail: "down" } as never, "x", "start_to_lead_found")).toBeNull();
  });

  // MIGRATE-1105 S5 (owner 2026-11-06: the outcome is the WHAT, as fine as possible): a pipe naming a finer outcome.
  it("is the outcome the pipe names when the catalogue states one (either outbound spelling), else its leg's step", () => {
    const c = {
      ...catalogueRead,
      legs: [...legs, { legKey: "start_to_conversation", fromStepKey: null, toStepKey: "conversation" }, { legKey: "start_to_threads_post_published", fromStepKey: null, toStepKey: "threads_post_published" }],
      engineOutcomeBySlug: new Map([
        ["threads-post", new Map([["start_to_threads_post_published", "threads_post_published"]])],
        ["sales-cold-email-outreach", new Map([["lead_found_to_conversation", "email_sequence_sent"]])],
      ]),
    } as never;
    expect(engineOfLeg(c, "threads-post", "start_to_threads_post_published")).toEqual({ fromOutcome: "start", outcome: "threads_post_published" });
    expect(engineOfLeg(c, "sales-cold-email-outreach", "lead_found_to_conversation")).toEqual({ fromOutcome: "lead_found", outcome: "email_sequence_sent" });
    expect(engineOfLeg(c, "sales-cold-email-outreach", "start_to_conversation")?.outcome).toBe("email_sequence_sent");
    // Another channel on the same leg keeps its leg's step.
    expect(engineOfLeg(c, "ai-follow-up-email", "lead_found_to_conversation")).toEqual({ fromOutcome: "lead_found", outcome: "conversation" });
  });

  it("is dispatched only when workflow-service says it is live for the org (cached a minute)", async () => {
    fetchMock.mockResolvedValueOnce(json(200, { live: true }));
    expect(await liveEngineFor({ featureSlug: "lead-sourcing", legKey: "start_to_lead_found" }, "org-1")).toEqual({ fromOutcome: "start", outcome: "lead_found" });
    expect(await liveEngineFor({ featureSlug: "lead-sourcing", legKey: "start_to_lead_found" }, "org-1")).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toBe("http://workflow/internal/engines/lead_found?orgId=org-1&featureSlug=lead-sourcing");
    // Another channel of the same org and Engine is its own read.
    fetchMock.mockResolvedValueOnce(json(200, { live: false }));
    expect(await liveEngineFor({ featureSlug: "sourcing-crm-contacts", legKey: "start_to_lead_found" }, "org-1")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("runs the workflow when the Engine is not live or unknown", async () => {
    fetchMock.mockResolvedValueOnce(json(200, { live: false }));
    expect(await liveEngineFor({ featureSlug: "lead-sourcing", legKey: "start_to_lead_found" }, "org-1")).toBeNull();
    fetchMock.mockResolvedValueOnce(json(404, { error: "Not found" }));
    expect(await liveEngineFor({ featureSlug: "x", legKey: "lead_found_to_conversation" }, "org-1")).toBeNull();
    expect(await liveEngineFor({ featureSlug: "x", legKey: null }, "org-1")).toBeNull();
  });

  // MIGRATE-1105 S2-FALLBACK (prod 2026-11-06, Doc Dinners): a 10 s timeout of this read ran the retired workflow twice.
  it("never reads an unreadable state as not live: it throws, so the dispatcher holds the run", async () => {
    // The catalogue the Engine is keyed on, first read (nothing to stand in).
    vi.mocked(fetchChannelCatalogue).mockResolvedValueOnce({ ok: false, detail: "HTTP 502" } as never);
    await expect(liveEngineFor({ featureSlug: "x", legKey: "conversation_to_meeting_booked" }, "org-1")).rejects.toThrow(/catalogue unreadable/);
    fetchMock.mockRejectedValueOnce(Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }));
    await expect(liveEngineFor({ featureSlug: "x", legKey: "conversation_to_meeting_booked" }, "org-1")).rejects.toBeInstanceOf(EngineStateUnreadableError);
    fetchMock.mockResolvedValueOnce(json(503, { error: "down" }));
    await expect(liveEngineFor({ featureSlug: "x", legKey: "conversation_to_meeting_booked" }, "org-1")).rejects.toThrow(/HTTP 503/);
  });

  it("serves the last answer of the hour while the read fails, then holds", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      fetchMock.mockResolvedValueOnce(json(200, { live: true }));
      const campaign = { featureSlug: "x", legKey: "lead_found_to_conversation" };
      expect(await liveEngineFor(campaign, "org-1")).toEqual({ fromOutcome: "lead_found", outcome: "conversation" });
      vi.setSystemTime(Date.now() + ENGINE_STATE_CACHE_MS + 1);
      fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
      expect(await liveEngineFor(campaign, "org-1")).toEqual({ fromOutcome: "lead_found", outcome: "conversation" });
      vi.setSystemTime(Date.now() + ENGINE_STATE_STALE_MAX_MS);
      fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
      await expect(liveEngineFor(campaign, "org-1")).rejects.toBeInstanceOf(EngineStateUnreadableError);
    } finally {
      vi.useRealTimers();
    }
  });

});

describe("dispatching the Engine", () => {
  it("a proactive tick: no workflow slug, the leg's start, the run it answers", async () => {
    fetchMock.mockResolvedValueOnce(json(201, { runId: "engine-run" }));
    const out = await executeCampaignEngine({ outcome: "lead_found", fromOutcome: "start" }, inputs);
    expect(out).toEqual({ runId: "engine-run" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("http://workflow/engines/lead_found/execute");
    expect(init.headers["x-workflow-slug"]).toBeUndefined();
    expect(init.headers).toMatchObject({ "x-org-id": "org-1", "x-run-id": "run-1", "x-campaign-id": "camp-1", "x-brand-id": "brand-1", "x-audience-id": "aud-1" });
    expect(JSON.parse(init.body)).toMatchObject({ fromOutcome: "start", inputs: { campaignId: "camp-1", audienceId: "aud-1" } });
  });

  it("a reactive occurrence: the same call, carrying the trigger, the admission and the subject", async () => {
    fetchMock.mockResolvedValueOnce(json(201, { runId: "engine-run-2" }));
    const trigger = { eventId: "ev-1", triggerId: "lead_event", leadId: "lead-1", item: { text: "hi" } };
    await executeCampaignEngine({ outcome: "paid_client", fromOutcome: "start" }, { ...inputs, trigger, conflictPolicy: "reject", executionSubject: "lead:lead-1" });
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body).toMatchObject({ inputs: { trigger }, conflictPolicy: "reject", executionSubject: "lead:lead-1" });
  });

  it("falls back (null) when workflow-service says not live, and throws any other refusal", async () => {
    fetchMock.mockResolvedValueOnce(json(409, { code: "engine_not_live" }));
    expect(await executeCampaignEngine({ outcome: "lead_found", fromOutcome: "start" }, inputs)).toBeNull();
    fetchMock.mockResolvedValueOnce(json(409, { error: "Active execution already exists" }));
    await expect(executeCampaignEngine({ outcome: "lead_found", fromOutcome: "start" }, inputs)).rejects.toMatchObject({ status: 409 });
  });
});

describe("one mechanism for every Engine", () => {
  it("names no outcome, channel or slug", async () => {
    const { readFileSync } = await import("node:fs");
    const code = readFileSync(new URL("../../src/lib/engine-dispatch.ts", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    expect(code).not.toMatch(/["'](lead_found|conversation|meeting_booked|paid_client|message_written)["']/);
  });
});

describe("an Engine run's callbacks", () => {
  it("need no workflow slug and are never stamped with one, not even the campaign's stored one", async () => {
    const { requirePipelineHeaders, trackingHeaders, runWorkflowSlug } = await import("../../src/middleware/auth.js");
    const headers = { "x-org-id": "o", "x-campaign-id": "c", "x-user-id": "u", "x-run-id": "r", "x-feature-slug": "f", "x-engine-outcome": "lead_found", "x-workflow-slug": "stale-slug" };
    const req = { headers, path: "/start-run" } as never;
    const res = { status: vi.fn(() => ({ json: vi.fn() })) } as never;
    const next = vi.fn();
    requirePipelineHeaders(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    const { "x-workflow-slug": _drop, ...noSlug } = headers;
    const next2 = vi.fn();
    requirePipelineHeaders({ headers: noSlug, path: "/start-run" } as never, res, next2);
    expect(next2).toHaveBeenCalledTimes(1);
    trackingHeaders(req, res, vi.fn());
    expect(runWorkflowSlug(req, "stored-campaign-slug")).toBeNull();
    // A workflow run keeps its slug (header, else the campaign's), byte for byte.
    const wf = { headers: { ...noSlug, "x-engine-outcome": undefined } } as never;
    trackingHeaders(wf, res, vi.fn());
    expect(runWorkflowSlug(wf, "stored-campaign-slug")).toBe("stored-campaign-slug");
    const missing = vi.fn();
    const status = vi.fn(() => ({ json: vi.fn() }));
    requirePipelineHeaders({ headers: { ...noSlug, "x-engine-outcome": "" }, path: "/start-run" } as never, { status } as never, missing);
    expect(missing).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(400);
  });
});
