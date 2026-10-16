import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockPredecessor, mockDue } = vi.hoisted(() => ({ mockPredecessor: vi.fn(), mockDue: vi.fn() }));
vi.mock("../../src/lib/predecessor-campaign.js", () => ({ resolvePredecessorCampaign: mockPredecessor }));
vi.mock("../../src/lib/followup-due-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/followup-due-client.js")>()),
  fetchFollowupDue: mockDue,
}));

import { answersATrigger, reactiveWake, REACTIVE_RECHECK_MS } from "../../src/lib/reactive-wake.js";
import { parseFollowupDue } from "../../src/lib/followup-due-client.js";
import type { ChannelCatalogueRead } from "../../src/lib/channel-operator-client.js";

const catalogue: ChannelCatalogueRead = {
  ok: true,
  operatorBySlug: new Map(),
  legsBySlug: new Map([["cold-whatsapp-outreach", new Set(["start_to_signup", "lead_found_to_conversation"])]]),
  legs: [],
  stepKeys: new Set(),
  triggerTransitions: [{ featureSlug: "cold-whatsapp-outreach", legKey: "start_to_signup", triggerId: "whatsapp_number_given" }],
};
const unit = { id: "c1", orgId: "o1", featureSlug: "cold-whatsapp-outreach", legKey: "start_to_signup" };
const now = new Date("2026-10-16T10:00:00Z");

describe("answersATrigger", () => {
  it("is true for a pipe whose transition answers a trigger", () => {
    expect(answersATrigger(unit, catalogue)).toBe(true);
  });
  it("is false for a proactive leg of the same channel", () => {
    expect(answersATrigger({ ...unit, legKey: "lead_found_to_conversation" }, catalogue)).toBe(false);
  });
  it("is true for a unit running on its funnel's head trigger, whatever the catalogue", () => {
    expect(answersATrigger({ ...unit, legKey: "lead_found_to_conversation", runsOnTriggerId: "t" }, { ok: false, detail: "x" })).toBe(true);
  });
  it("is false when the catalogue cannot be read (runs as before)", () => {
    expect(answersATrigger(unit, { ok: false, detail: "down" })).toBe(false);
  });
});

describe("reactiveWake", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPredecessor.mockResolvedValue({ predecessors: [{ campaignId: "p1" }, { campaignId: "p2" }] });
  });

  it("runs when someone is owed now, asking on its own queue and its predecessors'", async () => {
    mockDue.mockResolvedValue({ owedNow: true, nextDueAt: null });
    expect(await reactiveWake(unit, catalogue, now)).toEqual({ run: true });
    expect(mockDue).toHaveBeenCalledWith(expect.objectContaining({ orgId: "o1", actingCampaignId: "c1", campaignIds: ["c1", "p1", "p2"] }));
  });

  it("parks on the recheck when nobody is owed and nobody is scheduled", async () => {
    mockDue.mockResolvedValue({ owedNow: false, nextDueAt: null });
    expect(await reactiveWake(unit, catalogue, now)).toEqual({ run: false, nextRunAt: new Date(now.getTime() + REACTIVE_RECHECK_MS) });
  });

  it("parks until the next owed moment when it comes before the recheck", async () => {
    const next = new Date(now.getTime() + 3 * 60_000);
    mockDue.mockResolvedValue({ owedNow: false, nextDueAt: next });
    expect(await reactiveWake(unit, catalogue, now)).toEqual({ run: false, nextRunAt: next });
  });

  it("runs as before when who is owed cannot be read", async () => {
    mockDue.mockRejectedValue(new Error("lead-service down"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await reactiveWake(unit, catalogue, now)).toEqual({ run: true });
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});

describe("parseFollowupDue", () => {
  it("reads owedNow and nextDueAt", () => {
    expect(parseFollowupDue({ asOf: "x", answers: [{ campaignId: "c1", owedNow: false, nextOwedAt: "2026-10-16T10:05:00.000Z" }] }, "c1")).toEqual({
      owedNow: false,
      nextDueAt: new Date("2026-10-16T10:05:00.000Z"),
    });
  });
  it("throws on a malformed answer", () => {
    expect(() => parseFollowupDue({}, "c1")).toThrow();
    expect(() => parseFollowupDue({ answers: [{ campaignId: "other", owedNow: true }] }, "c1")).toThrow();
  });
});
