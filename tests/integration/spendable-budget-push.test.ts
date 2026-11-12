import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { eq } from "drizzle-orm";
import { cleanTestData, closeDb, insertTestCampaign } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { campaigns, salesFunnelCampaigns, spendableBudgetChanges } from "../../src/db/schema.js";
import { pushSpendableBudgetChanges } from "../../src/lib/spendable-budget-push.js";

/**
 * MON-PAGE-SPEED-2-1112: every change of a brand's spendable budget on campaign-service's side is
 * noted by the DATABASE (triggers, migration 0089) and pushed to billing's invalidation route.
 */
const ORG = "a1111111-1111-4111-8111-111111111111";
const BRAND = "b1111111-1111-4111-8111-111111111111";
const BRAND_2 = "b2222222-2222-4222-8222-222222222222";

async function noted() {
  return db.select().from(spendableBudgetChanges);
}

describe("spendable budget changes are noted by the database", () => {
  beforeEach(async () => {
    await cleanTestData();
    process.env.BILLING_SERVICE_URL = "http://billing.test";
    process.env.BILLING_SERVICE_API_KEY = "billing-key";
  });
  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("a campaign created notes every brand it names (brand_id and brand_ids)", async () => {
    await insertTestCampaign(ORG, { brandIds: [BRAND, BRAND_2], brandId: BRAND });
    const rows = await noted();
    expect(rows.map((r) => r.brandId).sort()).toEqual([BRAND, BRAND_2].sort());
    expect(rows.every((r) => r.orgId === ORG)).toBe(true);
  });

  it("a status change is noted; a change to a field the budget never reads is not", async () => {
    const c = await insertTestCampaign(ORG, { brandIds: [BRAND], brandId: BRAND, status: "ongoing" });
    await db.delete(spendableBudgetChanges);

    await db.update(campaigns).set({ name: "renamed" }).where(eq(campaigns.id, c.id));
    expect(await noted()).toHaveLength(0);

    await db.update(campaigns).set({ status: "stopped" }).where(eq(campaigns.id, c.id));
    expect((await noted()).map((r) => r.brandId)).toEqual([BRAND]);
  });

  it("a deleted campaign and a funnel campaign's status change are noted", async () => {
    const c = await insertTestCampaign(ORG, { brandIds: [BRAND], brandId: BRAND });
    const [fc] = await db
      .insert(salesFunnelCampaigns)
      .values({ orgId: ORG, brandId: BRAND_2, offerId: "o", salesFunnelId: "f", salesFunnelName: "F", status: "ongoing" })
      .returning();
    await db.delete(spendableBudgetChanges);

    await db.delete(campaigns).where(eq(campaigns.id, c.id));
    await db.update(salesFunnelCampaigns).set({ status: "paused" }).where(eq(salesFunnelCampaigns.id, fc.id));
    expect((await noted()).map((r) => r.brandId).sort()).toEqual([BRAND, BRAND_2].sort());
  });

  it("the push tells billing every noted pair and forgets them once acknowledged", async () => {
    await insertTestCampaign(ORG, { brandIds: [BRAND], brandId: BRAND });
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ invalidated: 1 }), { status: 200 }));

    const n = await pushSpendableBudgetChanges(fetchImpl as unknown as typeof fetch);

    expect(n).toBe(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://billing.test/internal/spendable-budget-snapshots/invalidate");
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("billing-key");
    expect(JSON.parse(init.body as string)).toEqual({ brands: [{ orgId: ORG, brandId: BRAND }] });
    expect(await noted()).toHaveLength(0);
  });

  it("billing refusing keeps every row for the next pass, and the failure is loud", async () => {
    await insertTestCampaign(ORG, { brandIds: [BRAND], brandId: BRAND });
    const fetchImpl = vi.fn(async () => new Response("down", { status: 502 }));
    await expect(pushSpendableBudgetChanges(fetchImpl as unknown as typeof fetch)).rejects.toThrow("502");
    expect(await noted()).toHaveLength(1);
  });

  it("a change landing while the push is in flight is not forgotten", async () => {
    const c = await insertTestCampaign(ORG, { brandIds: [BRAND], brandId: BRAND, status: "ongoing" });
    const fetchImpl = vi.fn(async () => {
      await db.update(campaigns).set({ status: "stopped" }).where(eq(campaigns.id, c.id));
      return new Response(JSON.stringify({ invalidated: 1 }), { status: 200 });
    });
    await pushSpendableBudgetChanges(fetchImpl as unknown as typeof fetch);
    expect((await noted()).map((r) => r.brandId)).toEqual([BRAND]);
  });

  it("a pair on a non-UUID id (billing cannot hold it) is dropped, never pushed", async () => {
    await insertTestCampaign("org_legacy", { brandIds: ["not-a-uuid"], brandId: null });
    const fetchImpl = vi.fn();
    expect(await pushSpendableBudgetChanges(fetchImpl as unknown as typeof fetch)).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await noted()).toHaveLength(0);
  });
});
