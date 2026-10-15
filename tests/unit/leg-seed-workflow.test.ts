import { describe, it, expect, vi, afterEach } from "vitest";
import { assignedWorkflowsInRankOrder, fetchLegAssignedWorkflows } from "../../src/lib/features-workflow-projection-client.js";
import { fetchLegSeedWorkflowSlug, legSeedFrom } from "../../src/lib/leg-seed-workflow.js";

// CAMPAIGN-FALLBACK-WORKFLOW-LEG-1015: the workflow a unit stores is features-service's first choice ON ITS LEG.

const row = (slug: string, rank: number, state: string, selectable = state === "active", audienceId: string | null = null) => ({
  audienceId,
  workflow: { workflowDynastySlug: slug, workflowDynastyName: null },
  resolved: { grain: "brand", costPerOutcomeUsd: null },
  rank,
  legAssignment: { state, selectable },
});

// The positive-reply leg as features-service served it for "Merrily" (prod 2026-10-15), trimmed.
const REPLY_LEG = [
  row("pelican", 33, "deprecated"),
  row("azalea", 20, "active"),
  row("uklun", 1, "active"),
  row("uklun", 1, "active", true, "aud-1"),
  row("miaplacidus", 2, "active"),
  // Ruled out by the DEFAULT play's strategy: still assigned to the leg.
  row("mebsuta", 27, "active", false),
  row("denebola", 22, "unassigned"),
];

describe("assignedWorkflowsInRankOrder", () => {
  it("lists the workflows ASSIGNED to the leg, features-service's rank first, one per workflow", () => {
    expect(assignedWorkflowsInRankOrder(REPLY_LEG as never, { playApplied: false })).toEqual(["uklun", "miaplacidus", "azalea", "mebsuta"]);
  });

  it("a read naming the campaign is judged on its own play already: `selectable` decides", () => {
    expect(assignedWorkflowsInRankOrder(REPLY_LEG as never, { playApplied: true })).toEqual(["uklun", "miaplacidus", "azalea"]);
  });

  it("a row with no assignment verdict is never a candidate", () => {
    expect(assignedWorkflowsInRankOrder([{ ...row("x", 1, "active"), legAssignment: undefined }] as never, { playApplied: false })).toEqual([]);
  });
});

describe("legSeedFrom", () => {
  it("is the first assigned workflow the play does not rule out, never a workflow of another leg", () => {
    const assigned = assignedWorkflowsInRankOrder(REPLY_LEG as never, { playApplied: false });
    expect(legSeedFrom(assigned, [])).toBe("uklun");
    expect(legSeedFrom(assigned, ["uklun"])).toBe("miaplacidus");
    expect(legSeedFrom(assigned, assigned)).toBeNull();
    expect(assigned).not.toContain("denebola");
  });
});

describe("fetchLegSeedWorkflowSlug", () => {
  const identity = { orgId: "o", userId: "u", runId: "r", brandId: "b", offerId: "off" };

  it("reads the leg priced for the OFFER at a launch (no campaign yet) and seeds its first choice", async () => {
    const assigned = vi.fn(async () => ["uklun", "miaplacidus"]);
    const out = await fetchLegSeedWorkflowSlug("sales-cold-email-outreach", "lead_found_to_conversation", identity, ["uklun"], { assigned });
    expect(out).toEqual({ ok: true, workflowSlug: "miaplacidus" });
    expect(assigned).toHaveBeenCalledWith(expect.objectContaining({ legKey: "lead_found_to_conversation", brandId: "b", offerId: "off", campaignId: null }));
  });

  it("an unreadable ranking is NOT 'no workflow': nothing is seeded on a guess", async () => {
    const assigned = vi.fn(async () => { throw new Error("workflow-projection (leg) failed (503): down"); });
    const out = await fetchLegSeedWorkflowSlug("c", "l", identity, [], { assigned });
    expect(out.ok).toBe(false);
  });

  it("a channel features-service does not rank keeps the channel's newest workflow, loudly", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const channelNewest = vi.fn(async () => ({ ok: true as const, workflowSlug: "email-sending-bubup" }));
    const out = await fetchLegSeedWorkflowSlug("email-sending", "start_to_conversation", identity, [], { assigned: async () => null, channelNewest });
    expect(out).toEqual({ ok: true, workflowSlug: "email-sending-bubup" });
    expect(err).toHaveBeenCalled();
  });
});

describe("fetchLegAssignedWorkflows", () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
    vi.unstubAllGlobals();
  });
  const input = {
    featureSlug: "email-sending",
    brandId: "b",
    legKey: "start_to_conversation",
    offerId: "off",
    identity: { orgId: "o", userId: "u", runId: "r", brandId: "b", campaignId: "", featureSlug: "email-sending", workflowSlug: null },
  };

  it("asks the leg for the OFFER without a campaign header, and a 404 `Feature not found` = no ranking (null)", async () => {
    process.env.FEATURES_SERVICE_URL = "http://features";
    process.env.FEATURES_SERVICE_API_KEY = "k";
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: "Feature not found" }), { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await fetchLegAssignedWorkflows(input)).toBeNull();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.searchParams.get("offerId")).toBe("off");
    expect(url.searchParams.get("leg")).toBe("start_to_conversation");
    expect((init.headers as Record<string, string>)["x-campaign-id"]).toBeUndefined();
  });

  it("any other failure throws", async () => {
    process.env.FEATURES_SERVICE_URL = "http://features";
    process.env.FEATURES_SERVICE_API_KEY = "k";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
    await expect(fetchLegAssignedWorkflows(input)).rejects.toThrow(/500/);
  });
});
