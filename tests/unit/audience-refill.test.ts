import { describe, it, expect, beforeEach, vi } from "vitest";

// The episode claim is DB-bound (tests/integration/audience-refill-claim.test.ts); this file covers
// the human-service call and the staff alert.
vi.mock("../../src/db/index.js", () => ({ db: {} }));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { requestBrandAudienceRefill, notifyRefillFailed } from "../../src/lib/audience-refill.js";

process.env.HUMAN_SERVICE_URL = "https://human.test.local";
process.env.HUMAN_SERVICE_API_KEY = "human-key";
process.env.TRANSACTIONAL_EMAIL_SERVICE_URL = "https://te.test.local";
process.env.TRANSACTIONAL_EMAIL_SERVICE_API_KEY = "te-key";

function json(status: number, body: unknown) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

function outcome(over: Record<string, unknown> = {}) {
  return {
    orgId: "org-1",
    brandId: "brand-1",
    remaining: 0,
    dailyPace: 40,
    billingState: "will_charge",
    action: "refilled",
    reason: null,
    detail: null,
    created: [{ id: "a1", name: "A", description: null }, { id: "a2", name: "B", description: null }],
    ...over,
  };
}

describe("requestBrandAudienceRefill", () => {
  beforeEach(() => mockFetch.mockReset());

  it("asks human-service for THIS brand only, with its api key", async () => {
    mockFetch.mockReturnValue(json(200, { dryRun: false, scanned: 1, low: 1, refilled: 1, outcomes: [outcome()] }));
    const v = await requestBrandAudienceRefill("org-1", "brand-1");
    expect(v).toEqual({ refilled: true, created: 2 });
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("https://human.test.local/internal/audience-refill?brandId=brand-1");
    expect(init.method).toBe("POST");
    expect(init.headers["x-api-key"]).toBe("human-key");
    // Never a dry run: absent = real run.
    expect(String(url)).not.toContain("dryRun");
  });

  it("a skip carries human-service's own reason verbatim", async () => {
    mockFetch.mockReturnValue(json(200, { outcomes: [outcome({ action: "skipped", reason: "not_chargeable", detail: "past_due", created: [] })] }));
    expect(await requestBrandAudienceRefill("org-1", "brand-1")).toEqual({
      refilled: false,
      outcome: "not_chargeable",
      detail: "past_due",
    });
  });

  it("'refilled' with zero audiences created is not a refill", async () => {
    mockFetch.mockReturnValue(json(200, { outcomes: [outcome({ created: [] })] }));
    expect((await requestBrandAudienceRefill("org-1", "brand-1")).refilled).toBe(false);
  });

  it("an outcome for the same brand under ANOTHER org is not ours", async () => {
    mockFetch.mockReturnValue(json(200, { outcomes: [outcome({ orgId: "org-2" })] }));
    expect(await requestBrandAudienceRefill("org-1", "brand-1")).toMatchObject({
      refilled: false,
      outcome: "not_served_recently",
    });
  });

  it("retries while a refill is already running (409), then reads the answer", async () => {
    mockFetch
      .mockReturnValueOnce(json(409, { error: "already running" }))
      .mockReturnValueOnce(json(200, { outcomes: [outcome()] }));
    expect(await requestBrandAudienceRefill("org-1", "brand-1", { busyRetryDelayMs: 0 })).toEqual({ refilled: true, created: 2 });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("gives up as 'busy' after repeated 409s", async () => {
    mockFetch.mockReturnValue(json(409, { error: "already running" }));
    expect(await requestBrandAudienceRefill("org-1", "brand-1", { busyRetryDelayMs: 0 })).toMatchObject({ refilled: false, outcome: "busy" });
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it("a non-2xx or a thrown fetch is an 'error' verdict, never a throw", async () => {
    mockFetch.mockReturnValueOnce(json(500, { error: "boom" }));
    expect(await requestBrandAudienceRefill("org-1", "brand-1")).toMatchObject({ refilled: false, outcome: "error" });
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    expect(await requestBrandAudienceRefill("org-1", "brand-1")).toEqual({ refilled: false, outcome: "error", detail: "ECONNREFUSED" });
  });

  it("no human-service config is an 'error' verdict", async () => {
    const url = process.env.HUMAN_SERVICE_URL;
    delete process.env.HUMAN_SERVICE_URL;
    expect(await requestBrandAudienceRefill("org-1", "brand-1")).toMatchObject({ refilled: false, outcome: "error" });
    expect(mockFetch).not.toHaveBeenCalled();
    process.env.HUMAN_SERVICE_URL = url;
  });
});

describe("notifyRefillFailed", () => {
  beforeEach(() => mockFetch.mockReset());
  const campaign = { id: "c-1", orgId: "org-1", name: "Q4 <push>", brandIds: ["brand-1"], featureSlug: "sales-cold-email-outreach" };

  it("raises the staff event on /platform-send with the campaign owner as acting user", async () => {
    mockFetch.mockReturnValue(json(200, {}));
    const ok = await notifyRefillFailed({
      campaign,
      userId: "user-1",
      runId: "run-1",
      brandName: "Shockwave",
      verdict: { refilled: false, outcome: "cooldown", detail: null },
    });
    expect(ok).toBe(true);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("https://te.test.local/platform-send");
    expect(init.headers).toMatchObject({ "x-user-id": "user-1", "x-org-id": "org-1", "x-run-id": "run-1", "x-brand-id": "brand-1" });
    const body = JSON.parse(init.body);
    expect(body.eventType).toBe("audience_refill_failed");
    expect(body.metadata.campaignName).toBe("Q4 &lt;push&gt;");
    expect(body.metadata.refillOutcome).toBe("cooldown");
  });

  it("a refused send returns false and never throws", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockFetch.mockReturnValue(json(400, { error: "unknown eventType" }));
    expect(
      await notifyRefillFailed({ campaign, userId: "u", runId: "r", brandName: null, verdict: { refilled: false, outcome: "error", detail: "x" } }),
    ).toBe(false);
    errSpy.mockRestore();
  });
});
