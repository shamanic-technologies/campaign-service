import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  resolveSelectionForTrigger,
  fetchLegProjectionRows,
  selectAudienceFromProjection,
} from "../../src/lib/features-workflow-projection-client.js";
import { executeCampaignWorkflow } from "../../src/lib/workflows.js";
import { executeCampaignEngine } from "../../src/lib/engine-dispatch.js";
import type { DownstreamIdentity } from "../../src/lib/downstream-headers.js";

// BOX-LOAD-1107: the trigger says "no audience" ONLY when /start-run's own pick over the same body could only be
// null, so /start-run skips its second read of the projection and every decision stays what it was.

const identity: DownstreamIdentity = {
  orgId: "org-1",
  userId: "user-1",
  runId: "11111111-1111-4111-8111-111111111111",
  campaignId: "camp-1",
  brandId: "brand-1",
  workflowSlug: "wf-a",
  featureSlug: "lead-sourcing",
};
const args = {
  featureSlug: "lead-sourcing",
  primaryBrandId: "brand-1",
  identity,
  fallbackSlug: "wf-a",
  campaignId: "camp-1",
  legKey: "start_to_lead_found",
};

const brandRow = (slug: string, opts: { eligible?: boolean } = {}) => ({
  audienceId: null,
  workflow: { workflowDynastySlug: slug, workflowDynastyName: slug },
  resolved: { grain: "brand", costPerOutcomeUsd: 3 },
  rank: 1,
  legAssignment: { state: "active", selectable: true },
  ...(opts.eligible === false ? { modelEligibility: { eligible: false, ineligibleReason: "tier" } } : {}),
});
const audienceRow = (audienceId: string, slug: string) => ({
  audienceId,
  workflow: { workflowDynastySlug: slug, workflowDynastyName: slug },
  estimatesByGrain: { audience: { evidence: { spentUsd: 10, observedContacted: 100, observedClicks: 2, observedPositiveReplies: 1 }, resolvedOutcomeCount: 1 } },
  resolved: { grain: "audience", costPerOutcomeUsd: 10 },
});

function serve(rows: unknown[] | null) {
  const fetchMock = vi.fn(async () =>
    rows === null
      ? { ok: false, status: 503, json: async () => ({}), text: async () => "down" }
      : { ok: true, status: 200, json: async () => ({ rows }), text: async () => "" });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  process.env.FEATURES_SERVICE_URL = "http://features-service";
  process.env.FEATURES_SERVICE_API_KEY = "test-key";
  process.env.WORKFLOW_SERVICE_URL = "http://workflow";
  process.env.WORKFLOW_SERVICE_API_KEY = "k";
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("gridEnumeratesNoAudience", () => {
  it("is true when the read grid lists no audience, and /start-run's pick over it is null on every draw", async () => {
    for (const rows of [[brandRow("wf-a"), brandRow("wf-b")], []]) {
      serve(rows);
      const sel = await resolveSelectionForTrigger({ ...args, excludedAudienceIds: ["aud-x"] });
      expect(sel.audienceId).toBeNull();
      expect(sel.gridEnumeratesNoAudience).toBe(true);
      // Parity: the exact read and pick /start-run would have made.
      const read = await fetchLegProjectionRows({ featureSlug: "lead-sourcing", brandId: "brand-1", legKey: args.legKey, campaignId: "camp-1", identity });
      for (const excludedAudienceIds of [[], ["aud-x"]]) {
        for (let i = 0; i < 50; i++) {
          expect(selectAudienceFromProjection(read, sel.workflowSlug, { excludedAudienceIds })).toBeNull();
        }
      }
    }
  });

  it("is false when the grid lists an audience, even one only an INELIGIBLE workflow carries", async () => {
    serve([brandRow("wf-a"), audienceRow("aud-1", "wf-a")]);
    expect((await resolveSelectionForTrigger(args)).gridEnumeratesNoAudience).toBe(false);

    // The trigger's restricted grid lists none, but /start-run picks over every row: it must still read.
    serve([brandRow("wf-a", { eligible: false }), audienceRow("aud-1", "wf-a")]);
    const sel = await resolveSelectionForTrigger(args);
    expect(sel.audienceId).toBeNull();
    expect(sel.gridEnumeratesNoAudience).toBe(false);
  });

  it("is false when the grid could not be read, or the campaign states no leg", async () => {
    serve(null);
    expect((await resolveSelectionForTrigger(args)).gridEnumeratesNoAudience).toBe(false);
    const fetchMock = serve([]);
    expect((await resolveSelectionForTrigger({ ...args, legKey: null })).gridEnumeratesNoAudience).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("the dispatch carries it", () => {
  const inputs = { campaignId: "camp-1", orgId: "org-1", brandId: "brand-1", userId: "user-1", runId: "run-1", featureSlug: "lead-sourcing" };
  const bodyOf = (m: ReturnType<typeof vi.fn>) => JSON.parse(String((m.mock.calls[0] as unknown as [string, RequestInit])[1].body));

  for (const [name, run] of [
    ["workflow", (i: typeof inputs & { audienceId?: string | null; noAudience?: boolean }) => executeCampaignWorkflow("wf-a", i)],
    ["Engine", (i: typeof inputs & { audienceId?: string | null; noAudience?: boolean }) => executeCampaignEngine({ outcome: "lead_found", fromOutcome: "start" } as never, i)],
  ] as const) {
    it(`${name}: inputs.noAudience only when decided and no audience rides`, async () => {
      const ok = () => vi.fn(async () => new Response(JSON.stringify({ runId: "r" }), { status: 201 }));
      let m = ok(); vi.stubGlobal("fetch", m);
      await run({ ...inputs, audienceId: null, noAudience: true });
      expect(bodyOf(m).inputs.noAudience).toBe(true);

      m = ok(); vi.stubGlobal("fetch", m);
      await run({ ...inputs, audienceId: "aud-1", noAudience: true });
      expect(bodyOf(m).inputs).not.toHaveProperty("noAudience");

      m = ok(); vi.stubGlobal("fetch", m);
      await run({ ...inputs, audienceId: null, noAudience: false });
      expect(bodyOf(m).inputs).not.toHaveProperty("noAudience");
    });
  }
});
