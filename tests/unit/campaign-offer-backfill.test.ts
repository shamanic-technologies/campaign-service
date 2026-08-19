import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  backfillCampaignOffers,
  makeOfferResolver,
  type OfferResolution,
} from "../../scripts/backfill-campaign-offer.js";

const TAG = "0050_campaign_offer_id";
const SQL = readFileSync(join(process.cwd(), "drizzle", `${TAG}.sql`), "utf8");

/** The SQL with every comment line stripped — the statements, and nothing the prose says. */
const STATEMENTS = SQL.split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n");

/**
 * Minimal tagged-template mock mimicking postgres `sql`: the first call is the SELECT and
 * returns `rows`; every later call is an UPDATE and is recorded.
 */
function createMockSql(rows: Record<string, unknown>[]) {
  let callCount = 0;
  const updates: Array<{ offerId: unknown; campaignId: unknown }> = [];
  const fn = async (_strings: TemplateStringsArray, ...values: unknown[]) => {
    callCount++;
    if (callCount === 1) return rows;
    updates.push({ offerId: values[0], campaignId: values[1] });
    return [];
  };
  return { sql: fn as unknown as Parameters<typeof backfillCampaignOffers>[0], updates };
}

function row(id: string, orgId = "org-1", brandId: string | null = "brand-1") {
  return { id, org_id: orgId, brand_id: brandId };
}

function resolved(offerId: string): OfferResolution {
  return { offerId };
}

describe("migration 0050 — the column, and nothing else", () => {
  it("adds offer_id idempotently and creates its index idempotently", () => {
    expect(STATEMENTS).toMatch(/ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "offer_id" text;/);
    expect(STATEMENTS).toMatch(/CREATE INDEX IF NOT EXISTS "idx_campaigns_org_offer"/);
  });

  it("backfills NOTHING — resolving a brand to its offer is a brand-service read SQL cannot make", () => {
    expect(STATEMENTS).not.toMatch(/\bUPDATE\b/i);
    expect(STATEMENTS).not.toMatch(/\bINSERT\b/i);
  });

  it("touches no other column and deletes nothing", () => {
    expect(STATEMENTS).not.toMatch(/\bDELETE\b|\bTRUNCATE\b|\bDROP\b/i);
    for (const column of ["status", "next_run_at", "goal", "funnel_key", "daily_budget_cents", "brand_ids"]) {
      expect(STATEMENTS).not.toMatch(new RegExp(`"${column}"\\s*=`));
    }
  });

  it("is registered in the migrations journal", () => {
    const journal = JSON.parse(readFileSync(join(process.cwd(), "drizzle", "meta", "_journal.json"), "utf8"));
    expect(journal.entries.some((e: { tag: string }) => e.tag === TAG)).toBe(true);
  });
});

describe("backfillCampaignOffers", () => {
  it("writes each campaign the single offer its (org, brand) pair resolves to", async () => {
    const { sql, updates } = createMockSql([row("c1"), row("c2")]);
    const resolve = vi.fn().mockResolvedValue(resolved("offer-a"));

    const result = await backfillCampaignOffers(sql, resolve, { dryRun: false });

    expect(result.written).toBe(2);
    expect(result.writtenCampaignIds).toEqual(["c1", "c2"]);
    expect(result.unresolved).toEqual([]);
    expect(updates).toEqual([
      { offerId: "offer-a", campaignId: "c1" },
      { offerId: "offer-a", campaignId: "c2" },
    ]);
  });

  it("asks brand-service ONCE per (org, brand) pair, not once per campaign", async () => {
    const { sql } = createMockSql([
      row("c1", "org-1", "brand-1"),
      row("c2", "org-1", "brand-1"),
      row("c3", "org-2", "brand-1"),
    ]);
    const resolve = vi.fn().mockResolvedValue(resolved("offer-a"));

    await backfillCampaignOffers(sql, resolve, { dryRun: false });

    // Same brand under a DIFFERENT org is a different question — per-brand config is per pair.
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(resolve).toHaveBeenCalledWith("brand-1", "org-1");
    expect(resolve).toHaveBeenCalledWith("brand-1", "org-2");
  });

  it("leaves a campaign alone and REPORTS it when the brand does not resolve to exactly one offer", async () => {
    const { sql, updates } = createMockSql([row("c1"), row("c2", "org-2", "brand-2")]);
    const resolve = vi.fn(async (brandId: string) =>
      brandId === "brand-1"
        ? resolved("offer-a")
        : ({ offerId: null, reason: "brand declares 2 offers" } as OfferResolution),
    );

    const result = await backfillCampaignOffers(sql, resolve, { dryRun: false });

    expect(result.written).toBe(1);
    expect(updates).toEqual([{ offerId: "offer-a", campaignId: "c1" }]);
    expect(result.unresolved).toEqual([
      { campaignId: "c2", orgId: "org-2", brandId: "brand-2", reason: "brand declares 2 offers" },
    ]);
  });

  it("never invents an attribution for a campaign that states no brand", async () => {
    const { sql, updates } = createMockSql([row("c1", "org-1", null)]);
    const resolve = vi.fn();

    const result = await backfillCampaignOffers(sql, resolve, { dryRun: false });

    expect(resolve).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
    expect(result.unresolved).toEqual([
      { campaignId: "c1", orgId: "org-1", brandId: null, reason: "campaign states no brand" },
    ]);
  });

  it("re-running changes nothing: it selects and writes only rows whose offer is still NULL", async () => {
    // Second run — every campaign now states an offer, so the SELECT returns nothing.
    const { sql, updates } = createMockSql([]);
    const resolve = vi.fn();

    const result = await backfillCampaignOffers(sql, resolve, { dryRun: false });

    expect(result).toMatchObject({ written: 0, writtenCampaignIds: [], unresolved: [] });
    expect(updates).toEqual([]);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("guards BOTH the read and the write on offer_id IS NULL, so a live create is never overwritten", async () => {
    const seen: string[] = [];
    const sql = (async (strings: TemplateStringsArray) => {
      const text = strings.join("?");
      seen.push(text);
      return seen.length === 1 ? [row("c1")] : [];
    }) as unknown as Parameters<typeof backfillCampaignOffers>[0];

    await backfillCampaignOffers(sql, async () => resolved("offer-a"), { dryRun: false });

    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatch(/"offer_id" IS NULL/);
    expect(seen[1]).toMatch(/UPDATE "campaigns"[\s\S]*"offer_id" IS NULL/);
  });

  it("dry run resolves and reports the exact same set, and writes nothing", async () => {
    const { sql, updates } = createMockSql([row("c1"), row("c2")]);
    const resolve = vi.fn().mockResolvedValue(resolved("offer-a"));

    const result = await backfillCampaignOffers(sql, resolve, { dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.writtenCampaignIds).toEqual(["c1", "c2"]);
    expect(updates).toEqual([]);
  });

  it("dry run is the DEFAULT — a backfill that writes unasked is one nobody inspected", async () => {
    const { sql, updates } = createMockSql([row("c1")]);

    const result = await backfillCampaignOffers(sql, async () => resolved("offer-a"));

    expect(result.dryRun).toBe(true);
    expect(updates).toEqual([]);
  });
});

describe("makeOfferResolver", () => {
  function withFetch(impl: () => Promise<unknown>) {
    return vi.spyOn(globalThis, "fetch").mockImplementation(impl as never);
  }

  function jsonResponse(body: unknown, ok = true, status = 200) {
    return Promise.resolve({ ok, status, json: async () => body } as Response);
  }

  // The fixtures below carry brand-service's REAL wire shape, read off its deployed
  // route: { offers: [{ offerId, brandId, name, createdAt, updatedAt }] }. They used
  // to carry a guessed one ({ id, active }), written before that route existed.
  const wireOffer = (offerId: string, name: string) => ({
    offerId,
    brandId: "brand-1",
    name,
    createdAt: "2026-08-19T00:00:00.000Z",
    updatedAt: "2026-08-19T00:00:00.000Z",
  });

  it("resolves a brand declaring exactly one offer, naming the org on the wire", async () => {
    const spy = withFetch(() => jsonResponse({ offers: [wireOffer("offer-a", "Starter")] }));

    const result = await makeOfferResolver("https://brand.test.local", "key")("brand-1", "org-1");

    expect(result).toEqual({ offerId: "offer-a" });
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://brand.test.local/internal/brands/brand-1/offers");
    // Per-brand configuration belongs to the (org, brand) pair — never let brand-service pick.
    expect((init.headers as Record<string, string>)["x-org-id"]).toBe("org-1");
    spy.mockRestore();
  });

  it("refuses to pick when a brand declares several — no offer is invented", async () => {
    const spy = withFetch(() =>
      jsonResponse({ offers: [wireOffer("offer-a", "Starter"), wireOffer("offer-b", "Enterprise")] }),
    );

    const result = await makeOfferResolver("https://brand.test.local", "key")("brand-1", "org-1");

    expect(result.offerId).toBeNull();
    expect(result.reason).toContain("2 offers");
    spy.mockRestore();
  });

  // An offer has no liveness flag: it is the FUNNELS under it that switch on and off.
  // A resolver that filtered on one would do nothing today and silently drop offers the
  // day brand-service adds an unrelated field by that name.
  it("does not filter on a liveness flag an offer does not have", async () => {
    const spy = withFetch(() =>
      jsonResponse({ offers: [{ ...wireOffer("offer-a", "Starter"), active: false }] }),
    );

    expect(await makeOfferResolver("https://brand.test.local", "key")("brand-1", "org-1")).toEqual({
      offerId: "offer-a",
    });
    spy.mockRestore();
  });

  it("a brand declaring none, and an unreadable answer, are both left unresolved", async () => {
    const resolver = makeOfferResolver("https://brand.test.local", "key");

    let spy = withFetch(() => jsonResponse({ offers: [] }));
    expect((await resolver("brand-1", "org-1")).offerId).toBeNull();
    spy.mockRestore();

    spy = withFetch(() => jsonResponse({ error: "boom" }, false, 500));
    expect(await resolver("brand-1", "org-1")).toEqual({ offerId: null, reason: "brand-service returned 500" });
    spy.mockRestore();

    spy = withFetch(() => Promise.reject(new Error("ECONNRESET")));
    expect((await resolver("brand-1", "org-1")).reason).toContain("unreachable");
    spy.mockRestore();
  });
});
