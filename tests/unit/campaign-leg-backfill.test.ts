import { describe, it, expect, vi } from "vitest";
import {
  backfillCampaignLegs,
  resolveLeg,
  type BackfillResult,
} from "../../scripts/backfill-campaign-leg.js";
import type { ChannelCatalogueRead } from "../../src/lib/channel-operator-client.js";

/**
 * A catalogue exactly as features-service publishes one: which legs each CHANNEL performs, and
 * which funnels each LEG is a leg of. Both statements are its own; this service joins them.
 */
function catalogue(
  legsBySlug: Record<string, string[]>,
  legs: Array<{ legKey: string; funnelKeys: string[] }>,
): Extract<ChannelCatalogueRead, { ok: true }> {
  return {
    ok: true,
    operatorBySlug: new Map(Object.keys(legsBySlug).map((slug) => [slug, "platform" as const])),
    legsBySlug: new Map(Object.entries(legsBySlug).map(([slug, keys]) => [slug, new Set(keys)])),
    legs: legs.map((l) => ({ legKey: l.legKey, fromStepKey: null, funnelKeys: new Set(l.funnelKeys) })),
    stepKeys: new Set<string>(),
  };
}

const CATALOGUE = catalogue(
  {
    "sales-cold-email-outreach": ["entry_leg", "conversation_leg"],
    "google-ads": ["visit_leg"],
    "ai-meeting-booking": ["conversation_leg", "second_leg"],
  },
  [
    { legKey: "entry_leg", funnelKeys: ["sales_meetings_from_conversation"] },
    { legKey: "conversation_leg", funnelKeys: ["sales_meetings_from_conversation", "website_purchases"] },
    { legKey: "second_leg", funnelKeys: ["sales_meetings_from_conversation"] },
    { legKey: "visit_leg", funnelKeys: ["sales_meetings_from_website"] },
  ],
);

/**
 * Minimal tagged-template mock mimicking postgres `sql`: the first call is the SELECT and returns
 * `rows`; every later call is an UPDATE and is recorded.
 */
function createMockSql(rows: Record<string, unknown>[]) {
  let callCount = 0;
  const updates: Array<{ legKey: unknown; campaignId: unknown }> = [];
  const selects: string[] = [];
  const fn = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    callCount++;
    if (callCount === 1) {
      selects.push(strings.join("?"));
      return rows;
    }
    updates.push({ legKey: values[0], campaignId: values[1] });
    return [];
  };
  return { sql: fn as unknown as Parameters<typeof backfillCampaignLegs>[0], updates, selects };
}

function row(
  id: string,
  funnelKey = "sales_meetings_from_conversation",
  featureSlug = "google-ads",
  orgId = "org-1",
) {
  return { id, org_id: orgId, funnel_key: funnelKey, feature_slug: featureSlug };
}

const reading = (read: ChannelCatalogueRead) => () => Promise.resolve(read);

describe("resolveLeg — the rule every consumer already uses", () => {
  it("answers the one leg the channel performs that is a leg of the funnel", () => {
    expect(resolveLeg(CATALOGUE, "sales_meetings_from_website", "google-ads")).toEqual({ legKey: "visit_leg" });
  });

  it("answers nothing when the channel performs no leg of that funnel", () => {
    const r = resolveLeg(CATALOGUE, "website_purchases", "google-ads");
    expect(r.legKey).toBeNull();
    expect(r.reason).toMatch(/no leg of this funnel/);
  });

  it("answers nothing when SEVERAL legs qualify — the funnel does not say which was bought", () => {
    const r = resolveLeg(CATALOGUE, "sales_meetings_from_conversation", "sales-cold-email-outreach");
    expect(r.legKey).toBeNull();
    expect(r.reason).toMatch(/performs 2 legs/);
  });

  it("distinguishes a channel the catalogue does not publish from one that performs no such leg", () => {
    const r = resolveLeg(CATALOGUE, "sales_meetings_from_website", "never-published");
    expect(r.legKey).toBeNull();
    expect(r.reason).toMatch(/publishes no such channel/);
  });
});

describe("backfillCampaignLegs", () => {
  it("writes each campaign the single leg its (funnel, channel) resolves to", async () => {
    const { sql, updates } = createMockSql([
      row("c1", "sales_meetings_from_website", "google-ads"),
      row("c2", "sales_meetings_from_website", "google-ads"),
    ]);

    const result = await backfillCampaignLegs(sql, reading(CATALOGUE), { dryRun: false });

    expect(result.written).toBe(2);
    expect(result.writtenCampaignIds).toEqual(["c1", "c2"]);
    expect(result.unresolved).toEqual([]);
    expect(updates).toEqual([
      { legKey: "visit_leg", campaignId: "c1" },
      { legKey: "visit_leg", campaignId: "c2" },
    ]);
  });

  it("reads the catalogue ONCE for the whole run", async () => {
    const { sql } = createMockSql([
      row("c1", "sales_meetings_from_website", "google-ads"),
      row("c2", "sales_meetings_from_website", "google-ads"),
    ]);
    const read = vi.fn().mockResolvedValue(CATALOGUE);

    await backfillCampaignLegs(sql, read, { dryRun: false });

    expect(read).toHaveBeenCalledTimes(1);
  });

  it("selects only rows still stating NO leg, and restates that guard on the write", async () => {
    const { sql, selects, updates } = createMockSql([row("c1", "sales_meetings_from_website", "google-ads")]);

    await backfillCampaignLegs(sql, reading(CATALOGUE), { dryRun: false });

    expect(selects[0]).toMatch(/"leg_key" IS NULL/);
    expect(updates).toHaveLength(1);
  });

  it("dry-runs by DEFAULT — it resolves, reports, and writes nothing", async () => {
    const { sql, updates } = createMockSql([row("c1", "sales_meetings_from_website", "google-ads")]);

    const result = await backfillCampaignLegs(sql, reading(CATALOGUE));

    expect(result.dryRun).toBe(true);
    expect(result.written).toBe(1);
    expect(updates).toEqual([]);
  });

  it("accepts a LEGACY funnel spelling — a pre-rename row is an ordinary campaign", async () => {
    const { sql, updates } = createMockSql([row("c1", "visit_meeting", "google-ads")]);

    const result = await backfillCampaignLegs(sql, reading(CATALOGUE), { dryRun: false });

    expect(result.written).toBe(1);
    expect(updates).toEqual([{ legKey: "visit_leg", campaignId: "c1" }]);
  });

  it("LEAVES ALONE a campaign whose pair resolves to several legs, naming the pair", async () => {
    const { sql, updates } = createMockSql([
      row("c1", "sales_meetings_from_conversation", "sales-cold-email-outreach"),
    ]);

    const result = await backfillCampaignLegs(sql, reading(CATALOGUE), { dryRun: false });

    expect(result.written).toBe(0);
    expect(updates).toEqual([]);
    expect(result.unresolved).toEqual([
      expect.objectContaining({
        campaignId: "c1",
        funnelKey: "sales_meetings_from_conversation",
        featureSlug: "sales-cold-email-outreach",
      }),
    ]);
  });

  it("LEAVES ALONE a campaign stating a funnel no catalogue names", async () => {
    const { sql, updates } = createMockSql([row("c1", "not_a_funnel", "google-ads")]);

    const result = await backfillCampaignLegs(sql, reading(CATALOGUE), { dryRun: false });

    expect(result.written).toBe(0);
    expect(updates).toEqual([]);
    expect(result.unresolved[0].reason).toMatch(/no catalogue names/);
  });

  it("writes NOTHING and fails LOUD when the catalogue cannot be READ", async () => {
    const { sql, updates } = createMockSql([row("c1", "sales_meetings_from_website", "google-ads")]);

    await expect(
      backfillCampaignLegs(sql, reading({ ok: false, detail: "HTTP 502" }), { dryRun: false }),
    ).rejects.toThrow(/HTTP 502/);
    expect(updates).toEqual([]);
  });

  it("asks nothing at all when no campaign is missing a leg — a second run is a no-op", async () => {
    const { sql, updates } = createMockSql([]);
    const read = vi.fn().mockResolvedValue(CATALOGUE);

    const result: BackfillResult = await backfillCampaignLegs(sql, read, { dryRun: false });

    expect(result.written).toBe(0);
    expect(updates).toEqual([]);
    expect(read).not.toHaveBeenCalled();
  });
});
