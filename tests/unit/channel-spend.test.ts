import { describe, it, expect, beforeEach, vi } from "vitest";

// runs-service spend keyed by feature slug, the way `POST /v1/stats/budget` filters it: a run carries
// exactly ONE slug, so each slug answers only the runs labelled with it.
const { mockGetStatsBudget, spendBySlug } = vi.hoisted(() => ({
  mockGetStatsBudget: vi.fn(),
  spendBySlug: {} as Record<string, string | undefined>,
}));

vi.mock("@distribute/runs-client", () => ({ getStatsBudget: mockGetStatsBudget }));
vi.mock("../../src/db/index.js", () => ({ db: { query: { campaigns: { findMany: vi.fn() } } } }));
vi.mock("../../src/db/schema.js", () => ({ campaigns: {} }));

import { addDecimalStrings, getChannelStatsBudget, spendFeatureSlugs, SOURCING_ORIGINS_BY_CHANNEL } from "../../src/lib/channel-spend.js";
import { readSpentTodayCents } from "../../src/lib/global-sales-pot.js";
import { readItemSpend } from "../../src/lib/sales-items-pace.js";

const SALES = "sales-cold-email-outreach";
const APOLLO = "sourcing-apollo-cold-filters";
const SIGNALS = "sourcing-linkedin-engagement-signals";
const TODAY = [{ label: "today", since: "2026-10-07T00:00:00.000Z" }];

function window(cents: string) {
  return { label: "today", totalCostInUsdCents: cents, actualCostInUsdCents: cents, provisionedCostInUsdCents: "0.0000000000", netTotalCostInUsdCents: cents, netActualCostInUsdCents: cents, netProvisionedCostInUsdCents: "0.0000000000" };
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(spendBySlug)) delete spendBySlug[k];
  mockGetStatsBudget.mockImplementation(async ({ featureSlug }: { featureSlug?: string }) => {
    const cents = featureSlug ? spendBySlug[featureSlug] : undefined;
    return { windows: cents === undefined ? [] : [window(cents)] };
  });
});

describe("a channel's spend includes the sourcing that found its leads", () => {
  it("counts a run labelled with a sourcing origin under the campaign in the campaign's spend", async () => {
    spendBySlug[SALES] = "300.0000000000"; // outreach, still labelled with the channel
    spendBySlug[APOLLO] = "250.5000000000"; // sourcing, relabelled with its origin
    const r = await getChannelStatsBudget({ orgId: "org-1", campaignId: "c-1", featureSlug: SALES, windows: TODAY });
    expect(r.windows).toEqual([{ ...window("550.5000000000"), provisionedCostInUsdCents: "0.0000000000", netProvisionedCostInUsdCents: "0.0000000000" }]);
    // One read per slug, everything else byte-equal to the caller's params.
    const asked = mockGetStatsBudget.mock.calls.map((c) => c[0]);
    expect(asked.map((p) => p.featureSlug)).toEqual(spendFeatureSlugs(SALES));
    for (const p of asked) expect({ ...p, featureSlug: undefined }).toEqual({ orgId: "org-1", campaignId: "c-1", featureSlug: undefined, windows: TODAY });
  });

  it("reads the same total before and after the relabel (the money never moves)", async () => {
    spendBySlug[SALES] = "550.5000000000";
    const before = await getChannelStatsBudget({ orgId: "org-1", campaignId: "c-1", featureSlug: SALES, windows: TODAY });
    spendBySlug[SALES] = "300.0000000000";
    spendBySlug[APOLLO] = "200.0000000000";
    spendBySlug[SIGNALS] = "50.5000000000";
    const after = await getChannelStatsBudget({ orgId: "org-1", campaignId: "c-1", featureSlug: SALES, windows: TODAY });
    expect(after.windows[0].netTotalCostInUsdCents).toBe(before.windows[0].netTotalCostInUsdCents);
    expect(after.windows[0].totalCostInUsdCents).toBe("550.5000000000");
  });

  it("feeds the global pot and the item pacing reads", async () => {
    spendBySlug[SALES] = "100";
    spendBySlug[APOLLO] = "40";
    expect(await readSpentTodayCents("org-1", "c-1", SALES)).toBe(140);
    const item = await readItemSpend("org-1", "c-1", SALES, null, new Date("2026-10-07T12:00:00Z"));
    expect(item).toEqual({ todayCents: 140 });
  });

  it("an unreadable origin read makes the whole figure unreadable (fail-closed callers hold)", async () => {
    spendBySlug[SALES] = "100";
    mockGetStatsBudget.mockImplementation(async ({ featureSlug }: { featureSlug?: string }) => {
      if (featureSlug === APOLLO) throw new Error("runs-service down");
      return { windows: [window(spendBySlug[featureSlug!] ?? "0")] };
    });
    expect(await readSpentTodayCents("org-1", "c-1", SALES)).toBeNull();
  });

  it("a channel that sources nothing is ONE read, its answer returned untouched", async () => {
    const answer = { windows: [{ label: "today", totalCostInUsdCents: "7" }] };
    mockGetStatsBudget.mockResolvedValueOnce(answer);
    const params = { orgId: "org-1", campaignId: "c-1", featureSlug: "google-ads", windows: TODAY };
    expect(await getChannelStatsBudget(params)).toBe(answer);
    expect(mockGetStatsBudget).toHaveBeenCalledTimes(1);
    expect(mockGetStatsBudget).toHaveBeenCalledWith(params);
  });

  it("a read with no feature slug is ONE read", async () => {
    await getChannelStatsBudget({ orgId: "org-1", campaignId: "c-1", windows: TODAY });
    expect(mockGetStatsBudget).toHaveBeenCalledTimes(1);
  });

  it("omits a net twin unless every part states it (callers fall back to gross)", async () => {
    mockGetStatsBudget.mockImplementation(async ({ featureSlug }: { featureSlug?: string }) => ({
      windows: [featureSlug === SALES ? { label: "today", totalCostInUsdCents: "5", actualCostInUsdCents: "5", provisionedCostInUsdCents: "0" } : window("1")],
    }));
    const [w] = (await getChannelStatsBudget({ orgId: "org-1", campaignId: "c-1", featureSlug: SALES, windows: TODAY })).windows;
    expect(w.totalCostInUsdCents).toBe("9.0000000000");
    expect(w.netTotalCostInUsdCents).toBeUndefined();
  });

  it("each channel counts only its own origins", () => {
    expect(spendFeatureSlugs("sales-crm-email-outreach")).toEqual(["sales-crm-email-outreach", "sourcing-crm-contacts"]);
    expect(spendFeatureSlugs(SALES)).not.toContain("sourcing-crm-contacts");
    expect(spendFeatureSlugs("ai-meeting-booking")).toEqual(["ai-meeting-booking"]);
    for (const origins of Object.values(SOURCING_ORIGINS_BY_CHANNEL)) for (const o of origins) expect(o.startsWith("sourcing-")).toBe(true);
  });
});

describe("addDecimalStrings", () => {
  it("sums runs-service decimals exactly", () => {
    expect(addDecimalStrings(["0.1000000000", "0.2000000000"])).toBe("0.3000000000");
    expect(addDecimalStrings(["123.4567890123", "1", "-0.0000000123"])).toBe("124.4567890000");
    expect(addDecimalStrings([])).toBe("0.0000000000");
  });
  it("refuses an unreadable amount", () => {
    expect(() => addDecimalStrings(["abc"])).toThrow(/unreadable amount/);
  });
});
