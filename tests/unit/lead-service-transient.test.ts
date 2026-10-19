import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { fileNamedPerson, isTransientStatus, scheduleNamedPersonDue } from "../../src/lib/sales-funnel-people.js";
import { PERSON_EVENT_RETRY_SKIPS, YOUNG_ONLY_RETRY_SKIPS, OWED_UNTIL_ROOM_SKIPS } from "../../src/lib/trigger-person.js";
import { STEP_TRIGGER_SKIPS } from "../../src/lib/step-trigger.js";

/**
 * TRIGGER-TRANSIENT-FILING-1019: prod hot_lead 7b63f943 ended skipped `followup_unavailable` on
 * "The operation was aborted due to timeout"; replayed 10 min later it ran. lead-service NOT ANSWERING is a
 * passing condition (`lead_service_unavailable`, retried); a refusal it states stays final.
 */
const mockFetch = vi.fn();
const realFetch = globalThis.fetch;
const env = { url: process.env.LEAD_SERVICE_URL, key: process.env.LEAD_SERVICE_API_KEY };

describe("lead-service not answering vs refusing (filing / making due)", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    globalThis.fetch = mockFetch as unknown as typeof fetch;
    process.env.LEAD_SERVICE_URL = "http://lead.test";
    process.env.LEAD_SERVICE_API_KEY = "k";
  });
  afterAll(() => {
    globalThis.fetch = realFetch;
    process.env.LEAD_SERVICE_URL = env.url;
    process.env.LEAD_SERVICE_API_KEY = env.key;
  });
  const file = () => fileNamedPerson({ orgId: "o", campaignId: "c", email: "a@x.com" });
  const due = () => scheduleNamedPersonDue({ orgId: "o", campaignId: "c", email: "a@x.com" });

  it("a timeout / transport error is `lead_service_unavailable` on both doors", async () => {
    mockFetch.mockRejectedValue(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
    expect(await file()).toMatchObject({ ok: false, code: "lead_service_unavailable", detail: "The operation was aborted due to timeout" });
    expect(await due()).toMatchObject({ ok: false, code: "lead_service_unavailable" });
  });

  it("a 5xx / 429 is `lead_service_unavailable`", async () => {
    mockFetch.mockImplementation(async () => new Response("bad gateway", { status: 502 }));
    expect(await file()).toMatchObject({ ok: false, code: "lead_service_unavailable" });
    expect(await due()).toMatchObject({ ok: false, code: "lead_service_unavailable" });
    mockFetch.mockImplementation(async () => new Response("slow down", { status: 429 }));
    expect(await file()).toMatchObject({ ok: false, code: "lead_service_unavailable" });
  });

  it("a 4xx refusal stays final (`filing_unavailable` / `followup_unavailable`)", async () => {
    mockFetch.mockImplementation(async () => new Response(JSON.stringify({ error: "bad" }), { status: 400 }));
    expect(await file()).toMatchObject({ ok: false, code: "filing_unavailable" });
    expect(await due()).toMatchObject({ ok: false, code: "followup_unavailable" });
  });

  it("which statuses are transient", () => {
    for (const s of [500, 502, 503, 504, 408, 429]) expect(isTransientStatus(s)).toBe(true);
    for (const s of [400, 401, 403, 404, 409, 422]) expect(isTransientStatus(s)).toBe(false);
  });

  it("the transient skip retries for a bounded window only; a refusal is never retried", () => {
    expect(PERSON_EVENT_RETRY_SKIPS.has(STEP_TRIGGER_SKIPS.LEAD_SERVICE_UNAVAILABLE)).toBe(true);
    expect(YOUNG_ONLY_RETRY_SKIPS.has(STEP_TRIGGER_SKIPS.LEAD_SERVICE_UNAVAILABLE)).toBe(true);
    expect(OWED_UNTIL_ROOM_SKIPS.has(STEP_TRIGGER_SKIPS.LEAD_SERVICE_UNAVAILABLE)).toBe(false);
    expect(PERSON_EVENT_RETRY_SKIPS.has(STEP_TRIGGER_SKIPS.FOLLOWUP_UNAVAILABLE)).toBe(false);
  });
});
