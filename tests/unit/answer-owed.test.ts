import { describe, it, expect, beforeEach, vi } from "vitest";

// REPLY-NO-BALANCE-1118: a run that carries a person waiting on our answer is admitted at an empty balance.
const { mockSelectRows } = vi.hoisted(() => ({ mockSelectRows: vi.fn() }));
vi.mock("../../src/db/index.js", () => ({
  db: {
    select: () => ({ from: () => ({ innerJoin: () => ({ where: () => ({ limit: () => mockSelectRows() }) }) }) }),
  },
}));
vi.mock("../../src/db/schema.js", () => ({
  triggerEventDeliveries: { runId: "run_id", eventId: "event_id" },
  triggerEvents: { id: "id", leadId: "lead_id", brandId: "brand_id" },
}));
vi.mock("drizzle-orm", () => ({ eq: vi.fn() }));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { admitAnswerOwed } from "../../src/lib/answer-owed.js";

const input = { orgId: "org-1", campaignId: "camp-1", runId: "run-1" };

describe("admitAnswerOwed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.LEAD_SERVICE_URL = "http://lead.test";
    process.env.LEAD_SERVICE_API_KEY = "k";
    process.env.BILLING_SERVICE_URL = "http://billing.test";
    process.env.BILLING_SERVICE_API_KEY = "b";
  });

  it("admits a run whose person waits on us, and grants billing's pass for its spends", async () => {
    mockSelectRows.mockResolvedValue([{ leadId: "lead-1", brandId: "brand-1" }]);
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ total: 1, people: [{ leadId: "lead-1" }] }) })
      .mockResolvedValueOnce({ status: 201, ok: true, json: async () => ({}) });
    const r = await admitAnswerOwed(input, 0);
    expect(r).toEqual({ owed: true, answer: { leadId: "lead-1", brandId: "brand-1" } });
    expect(String(mockFetch.mock.calls[0][0])).toBe("http://lead.test/orgs/leads/awaiting-reply?brandId=brand-1&leadId=lead-1");
    expect(String(mockFetch.mock.calls[1][0])).toBe("http://billing.test/internal/answer-passes");
    expect(JSON.parse(mockFetch.mock.calls[1][1].body)).toEqual({ orgId: "org-1", campaignId: "camp-1", runId: "run-1", leadId: "lead-1", brandId: "brand-1" });
  });

  it("refuses a person not waiting on us (new outreach stays blocked)", async () => {
    mockSelectRows.mockResolvedValue([{ leadId: "lead-1", brandId: "brand-1" }]);
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ total: 0, people: [] }) });
    const r = await admitAnswerOwed(input, 0);
    expect(r.owed).toBe(false);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("refuses a run carrying nobody (a scheduled population run)", async () => {
    mockSelectRows.mockResolvedValue([]);
    const r = await admitAnswerOwed(input, 0);
    expect(r).toEqual({ owed: false, why: "the run carries no occurrence" });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("lead-service unreadable or billing refusing the pass = the old refusal, never a default-allow", async () => {
    mockSelectRows.mockResolvedValue([{ leadId: "lead-1", brandId: "brand-1" }]);
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) });
    expect((await admitAnswerOwed(input, 0)).owed).toBe(false);
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ people: [{ leadId: "lead-1" }] }) })
      .mockResolvedValueOnce({ status: 500, ok: false, json: async () => ({}) });
    expect((await admitAnswerOwed(input, 0)).owed).toBe(false);
  });

  it("no run id = nothing to answer", async () => {
    expect((await admitAnswerOwed({ orgId: "o", campaignId: "c" }, 0)).owed).toBe(false);
  });
});
