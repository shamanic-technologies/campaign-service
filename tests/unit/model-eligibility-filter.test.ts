import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockFetchBrandRuntimeContext = vi.hoisted(() => vi.fn());

vi.mock("../../src/lib/brand-runtime-client.js", () => ({
  fetchBrandRuntimeContext: mockFetchBrandRuntimeContext,
}));

import {
  readLegModelEligibility,
  restrictToEligibleWorkflows,
  resolveSelectionForTrigger,
  selectCellFromProjection,
  selectAudiencePooled,
  type LegModelEligibility,
  type ProjectionRow,
} from "../../src/lib/features-workflow-projection-client.js";
import type { DownstreamIdentity } from "../../src/lib/downstream-headers.js";
import type { Rng } from "../../src/lib/bandit.js";

const ROTATING_FEATURE = "sales-cold-email-outreach";
const BRAND_ID = "75d7e3e8-6926-4f85-a557-976895400666";
const LEG = "start_to_conversation";

const identity: DownstreamIdentity = {
  orgId: "org-1",
  userId: "user-1",
  runId: "11111111-1111-4111-8111-111111111111",
  campaignId: "camp-1",
  brandId: BRAND_ID,
  workflowSlug: "wf-configured",
  featureSlug: ROTATING_FEATURE,
};

/** Always samples 0.5, so arms differing only by COST have exactly one answer. */
const fixedRng: Rng = () => 0.5;

function row(
  audienceId: string | null,
  slug: string,
  costPerOutcomeUsd: number | null,
  evidence: { spentUsd: number; contacted: number; outcomes: number } | null = null,
): ProjectionRow {
  return {
    audienceId,
    workflow: { workflowDynastySlug: slug, workflowDynastyName: slug },
    audienceEvidence: evidence
      ? {
          spentUsd: evidence.spentUsd,
          observedContacted: evidence.contacted,
          observedClicks: 0,
          observedPositiveReplies: 0,
          resolvedOutcomeCount: evidence.outcomes,
        }
      : null,
    resolved: { grain: evidence ? "audience" : "brand", costPerOutcomeUsd },
  };
}

function rawLegRow(
  audienceId: string | null,
  slug: string,
  verdict: { eligible: boolean; modelAlias: string; modelTier: string; ineligibleReason?: string } | null,
) {
  return {
    audienceId,
    workflow: { workflowDynastySlug: slug, workflowDynastyName: slug },
    resolved: { grain: "brand", costPerOutcomeUsd: 21 },
    ...(verdict
      ? {
          modelEligibility: {
            modelAlias: verdict.modelAlias,
            modelTier: verdict.modelTier,
            eligible: verdict.eligible,
            ineligibleReason: verdict.eligible ? null : verdict.ineligibleReason ?? "excluded",
            unknownTierReason: null,
          },
        }
      : {}),
  };
}

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
}

const eligibility = (slugs: string[]): LegModelEligibility => ({
  legKey: LEG,
  ineligible: new Map(slugs.map((s) => [s, `excluded: ${s} writes with a cheap-tier model`])),
});

const ctx = { brandId: BRAND_ID, featureSlug: ROTATING_FEATURE };

// ── The filter itself ────────────────────────────────────────────────────────────────────────

describe("restrictToEligibleWorkflows", () => {
  const grid = [row("aud-A", "cheap-wf", 21), row("aud-A", "strong-wf", 30)];

  it("DIVERGES from the unfiltered grid: the excluded workflow is gone, the rest untouched", () => {
    const kept = restrictToEligibleWorkflows(grid, eligibility(["cheap-wf"]), ctx);
    expect(kept.map((r) => r.workflow.workflowDynastySlug)).toEqual(["strong-wf"]);
    // And every surviving row is the SAME object: this restricts the set and moves no number.
    expect(kept[0]).toBe(grid[1]);
  });

  it("a verdict that could not be READ excludes nothing — the unfiltered grid, loudly", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(restrictToEligibleWorkflows(grid, null, ctx)).toBe(grid);
    warn.mockRestore();
  });

  it("a leg that excludes nobody returns the grid untouched", () => {
    expect(restrictToEligibleWorkflows(grid, eligibility([]), ctx)).toBe(grid);
  });

  it("EVERY workflow excluded → the EMPTY grid, never widened back, and it says so loudly", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const kept = restrictToEligibleWorkflows(grid, eligibility(["cheap-wf", "strong-wf"]), ctx);
    expect(kept).toEqual([]);
    expect(err).toHaveBeenCalledTimes(1);
    expect(String(err.mock.calls[0][0])).toContain(LEG);
    err.mockRestore();
  });

  it("says NOTHING on the routine path — this fires on every dispatch of every campaign", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    restrictToEligibleWorkflows(grid, eligibility(["cheap-wf"]), ctx);
    expect(warn).not.toHaveBeenCalled();
    expect(err).not.toHaveBeenCalled();
    warn.mockRestore();
    err.mockRestore();
  });
});

// ── BOTH legs of the pick, not just the second one ───────────────────────────────────────────

describe("the restriction binds BOTH argmins", () => {
  // aud-A looks good ONLY because a cheap-tier workflow did well on it; aud-B is mediocre
  // everywhere. Pooled over the WHOLE column A wins; pooled over the ELIGIBLE column B wins.
  const grid: ProjectionRow[] = [
    row("aud-A", "cheap-wf", 1, { spentUsd: 10, contacted: 100, outcomes: 50 }),
    row("aud-A", "strong-wf", 100, { spentUsd: 100, contacted: 100, outcomes: 1 }),
    row("aud-B", "cheap-wf", 50, { spentUsd: 50, contacted: 100, outcomes: 2 }),
    row("aud-B", "strong-wf", 10, { spentUsd: 10, contacted: 100, outcomes: 10 }),
  ];
  const excluded = eligibility(["cheap-wf"]);

  it("the AUDIENCE leg pools the ELIGIBLE column only — and that changes which audience wins", () => {
    // Unfiltered: aud-A's pooled column is $110 over 51 outcomes ≈ $2.16; aud-B's is $60 over 12
    // ≈ $5. A wins.
    expect(selectAudiencePooled(grid, { rng: fixedRng })).toBe("aud-A");

    // Eligible-only: aud-A is $100 over 1 outcome = $100; aud-B is $10 over 10 = $1. B wins.
    const kept = restrictToEligibleWorkflows(grid, excluded, ctx);
    expect(selectAudiencePooled(kept, { rng: fixedRng })).toBe("aud-B");
  });

  it("the WORKFLOW leg can never land on an excluded workflow, on any audience", () => {
    // Unfiltered, the cell pick hands aud-A the cheap workflow.
    expect(selectCellFromProjection(grid, { rng: fixedRng })).toEqual({
      audienceId: "aud-A",
      workflowSlug: "cheap-wf",
    });

    const kept = restrictToEligibleWorkflows(grid, excluded, ctx);
    const cell = selectCellFromProjection(kept, { rng: fixedRng });
    expect(cell.workflowSlug).toBe("strong-wf");

    // And it holds when the campaign is PINNED to the audience the cheap workflow was best on —
    // the global-argmin fallback inside selectCellFromProjection must not smuggle it back in.
    expect(
      selectCellFromProjection(kept, { requiredAudienceIds: ["aud-A"], rng: fixedRng }).workflowSlug,
    ).toBe("strong-wf");
  });

  it("removes no AUDIENCE: every audience enumerated under an eligible workflow survives", () => {
    const kept = restrictToEligibleWorkflows(grid, excluded, ctx);
    expect(new Set(kept.map((r) => r.audienceId))).toEqual(new Set(["aud-A", "aud-B"]));
  });
});

// ── Reading the verdict off the wire ─────────────────────────────────────────────────────────

describe("readLegModelEligibility", () => {
  const originalFetch = global.fetch;
  beforeEach(() => {
    process.env.FEATURES_SERVICE_URL = "https://features.test";
    process.env.FEATURES_SERVICE_API_KEY = "k";
  });
  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("names the LEG and never a funnel — features-service refuses both at once", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ rows: [] }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await readLegModelEligibility({ featureSlug: ROTATING_FEATURE, brandId: BRAND_ID, legKey: LEG, identity });

    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.searchParams.get("leg")).toBe(LEG);
    expect(url.searchParams.get("brandId")).toBe(BRAND_ID);
    expect(url.searchParams.has("funnel")).toBe(false);
    expect(url.searchParams.has("goal")).toBe(false);
    expect(url.searchParams.has("campaignId")).toBe(false);
  });

  it("names the CAMPAIGN beside the leg when one is given — it names the offer the read is priced on", async () => {
    // A campaign sells exactly ONE offer, so features-service resolves the offer transitively
    // and brand-service answers instead of refusing a multi-offer brand with 409 several_offers.
    const fetchMock = vi.fn(async () => jsonResponse({ rows: [] }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await readLegModelEligibility({
      featureSlug: ROTATING_FEATURE,
      brandId: BRAND_ID,
      legKey: LEG,
      campaignId: "647572d9-729e-4731-9456-28fa351be92c",
      identity,
    });

    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.searchParams.get("leg")).toBe(LEG);
    expect(url.searchParams.get("campaignId")).toBe("647572d9-729e-4731-9456-28fa351be92c");
  });

  it("collects ONLY eligible:false — an unknowable tier and a verdict-less row exclude nothing", async () => {
    global.fetch = vi.fn(async () =>
      jsonResponse({
        rows: [
          rawLegRow("a", "cheap-wf", { eligible: false, modelAlias: "flash", modelTier: "cheap" }),
          rawLegRow("a", "strong-wf", { eligible: true, modelAlias: "pro", modelTier: "strong" }),
          // Unknowable tier — features-service serves it ELIGIBLE on purpose.
          rawLegRow("a", "unknown-wf", { eligible: true, modelAlias: "mystery", modelTier: "" }),
          // A body with no verdict block at all: the absence of a statement is not a statement.
          rawLegRow("a", "blockless-wf", null),
        ],
      }),
    ) as unknown as typeof fetch;

    const out = await readLegModelEligibility({
      featureSlug: ROTATING_FEATURE,
      brandId: BRAND_ID,
      legKey: LEG,
      identity,
    });
    expect([...out!.ineligible.keys()]).toEqual(["cheap-wf"]);
  });

  it("DIVERGES from the alias string — the verdict is read, never derived from the name", async () => {
    // `flash-pro` contains "pro" and is CHEAP; `glm-pro` is STRONG. Only the verdict decides.
    global.fetch = vi.fn(async () =>
      jsonResponse({
        rows: [
          rawLegRow("a", "pelican", { eligible: false, modelAlias: "flash-pro", modelTier: "cheap" }),
          rawLegRow("a", "nobelium", { eligible: true, modelAlias: "glm-pro", modelTier: "strong" }),
        ],
      }),
    ) as unknown as typeof fetch;

    const out = await readLegModelEligibility({
      featureSlug: ROTATING_FEATURE,
      brandId: BRAND_ID,
      legKey: LEG,
      identity,
    });
    expect([...out!.ineligible.keys()]).toEqual(["pelican"]);
  });

  it("a non-2xx is null (fail OPEN) and warns — never an exclusion on our own failed read", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 502,
      text: async () => "upstream down",
    })) as unknown as typeof fetch;

    const out = await readLegModelEligibility({
      featureSlug: ROTATING_FEATURE,
      brandId: BRAND_ID,
      legKey: LEG,
      identity,
    });
    expect(out).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

// ── End to end through the trigger ───────────────────────────────────────────────────────────

describe("resolveSelectionForTrigger — the verdict reaches the pick", () => {
  const originalFetch = global.fetch;
  const baseArgs = {
    featureSlug: ROTATING_FEATURE,
    primaryBrandId: BRAND_ID,
    identity,
    fallbackSlug: "wf-configured",
    funnelKey: "sales_meetings_from_conversation",
  };

  beforeEach(() => {
    process.env.FEATURES_SERVICE_URL = "https://features.test";
    process.env.FEATURES_SERVICE_API_KEY = "k";
  });
  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  /** Serve the funnel-keyed pricing body and the leg-keyed verdict body off one mock. */
  function routeFetch(opts: { legRows: unknown[] }) {
    return vi.fn(async (url: URL | string) => {
      const u = new URL(String(url));
      if (u.searchParams.has("leg")) return jsonResponse({ rows: opts.legRows });
      return jsonResponse({
        rows: [
          {
            audienceId: "aud-A",
            workflow: { workflowDynastySlug: "cheap-wf", workflowDynastyName: "cheap-wf" },
            estimatesByGrain: {
              audience: {
                evidence: { spentUsd: 10, observedContacted: 100, observedClicks: 0, observedPositiveReplies: 0 },
                resolvedOutcomeCount: 5,
              },
            },
            resolved: { grain: "audience", costPerOutcomeUsd: 1 },
          },
          {
            audienceId: "aud-A",
            workflow: { workflowDynastySlug: "strong-wf", workflowDynastyName: "strong-wf" },
            estimatesByGrain: {
              audience: {
                evidence: { spentUsd: 100, observedContacted: 100, observedClicks: 0, observedPositiveReplies: 0 },
                resolvedOutcomeCount: 5,
              },
            },
            resolved: { grain: "audience", costPerOutcomeUsd: 50 },
          },
        ],
      });
    });
  }

  it("DIVERGES on the leg: the same grid picks the cheap workflow without one and the strong one with", async () => {
    // No leg stated → no verdict read at all, and the cheapest cell wins as it always did.
    global.fetch = routeFetch({ legRows: [] }) as unknown as typeof fetch;
    await expect(resolveSelectionForTrigger(baseArgs)).resolves.toMatchObject({
      workflowSlug: "cheap-wf",
    });
    expect((global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);

    // Leg stated, cheap-wf excluded → the leg body yields the strong workflow.
    const withLeg = routeFetch({
      legRows: [
        rawLegRow("aud-A", "cheap-wf", { eligible: false, modelAlias: "flash", modelTier: "cheap" }),
        rawLegRow("aud-A", "strong-wf", { eligible: true, modelAlias: "pro", modelTier: "strong" }),
      ],
    });
    global.fetch = withLeg as unknown as typeof fetch;
    await expect(resolveSelectionForTrigger({ ...baseArgs, legKey: LEG })).resolves.toMatchObject({
      workflowSlug: "strong-wf",
      audienceId: "aud-A",
    });
    // ONE read: the leg-keyed body both prices and restricts, and no funnel is asked for.
    const urls = withLeg.mock.calls.map((c) => new URL(String(c[0])));
    expect(urls).toHaveLength(1);
    expect(urls[0]?.searchParams.get("leg")).toBe(LEG);
    expect(urls[0]?.searchParams.has("funnel")).toBe(false);
  });

  it("threads the campaign's campaignId and offerId so multi-offer brands answer instead of 409ing", async () => {
    const withLeg = routeFetch({ legRows: [] });
    global.fetch = withLeg as unknown as typeof fetch;
    await resolveSelectionForTrigger({
      ...baseArgs,
      legKey: LEG,
      campaignId: "647572d9-729e-4731-9456-28fa351be92c",
      offerId: "832126f3-f3f1-4601-885d-bc8e101e5680",
    });
    const urls = withLeg.mock.calls.map((c) => new URL(String(c[0])));
    // The verdict read names the campaign (→ its offer, transitively).
    const legUrl = urls.find((u) => u.searchParams.has("leg"))!;
    expect(legUrl.searchParams.get("campaignId")).toBe("647572d9-729e-4731-9456-28fa351be92c");
  });

  it("a leg excluding EVERY workflow falls back to the configured slug — never an ineligible one", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    global.fetch = routeFetch({
      legRows: [
        rawLegRow("aud-A", "cheap-wf", { eligible: false, modelAlias: "flash", modelTier: "cheap" }),
        rawLegRow("aud-A", "strong-wf", { eligible: false, modelAlias: "flash", modelTier: "cheap" }),
      ],
    }) as unknown as typeof fetch;

    await expect(resolveSelectionForTrigger({ ...baseArgs, legKey: LEG })).resolves.toEqual({
      workflowSlug: "wf-configured",
      audienceId: null,
    });
    expect(err).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });

  it("an unreadable verdict selects over the unfiltered grid — a failed read never blocks a run", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    global.fetch = vi.fn(async (url: URL | string) => {
      const u = new URL(String(url));
      if (u.searchParams.has("leg")) return { ok: false, status: 500, text: async () => "boom" };
      return routeFetch({ legRows: [] })(url);
    }) as unknown as typeof fetch;

    await expect(resolveSelectionForTrigger({ ...baseArgs, legKey: LEG })).resolves.toMatchObject({
      workflowSlug: "cheap-wf",
    });
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
