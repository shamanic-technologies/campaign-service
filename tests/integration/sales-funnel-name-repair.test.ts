import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { campaigns, campaignStatusTransitions, salesFunnelCampaigns } from "../../src/db/schema.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { insertSalesFunnelCampaignWithUnits } from "../../src/lib/campaign-status-history.js";
import { runSalesFunnelNameRepair } from "../../src/lib/sales-funnel-name.js";

/**
 * A sales funnel name follows its id (owner 2026-10-13): a funnel campaign whose stored name differs from the name
 * features-service serves for its EXACT id takes it (row + units' prefix); a legacy id and an unreadable funnel never.
 */
const ORG = "b645207b-0000-4000-8000-0000000000f1";
const BRAND = "75d7e3e8-0000-4000-8000-0000000000f2";
const OFFER = "231bb036-0000-4000-8000-0000000000f3";
const MOVED = "start_to_lead_found@sourcing-apollo-cold-filters+lead_found_to_website_visit@sales-cold-email-outreach+website_visit_to_purchase+purchase_to_paid_client";
const LEGACY = "lead_found_to_website_visit@sales-cold-email-outreach+website_visit_to_purchase+purchase_to_paid_client";
const KEY = "start_to_lead_found@lead-sourcing+lead_found_to_website_visit@sales-cold-email-outreach+website_visit_to_purchase+purchase_to_paid_client";
const DOWN = "down@funnel";

const born = (salesFunnelId: string, name = "Epiphany", offerId = OFFER) => {
  const id = randomUUID();
  const tag = id.slice(0, 8);
  return insertSalesFunnelCampaignWithUnits({
    id, orgId: ORG, brandId: BRAND, offerId, salesFunnelId, salesFunnelName: name,
    status: "ongoing", createdByUserId: null, parentRunId: null,
    units: [
      { featureSlug: "your-team-website", legKey: "website_visit_to_purchase", workflowSlug: null, acquisitionChannel: "your_team_website", name: `${name} ${tag} - your-team-website - ${randomUUID()}` },
      { featureSlug: "sourcing-apollo-cold-filters", legKey: "start_to_lead_found", workflowSlug: null, acquisitionChannel: "sourcing_apollo_cold_filters", name: `sourcing-apollo-cold-filters - ${randomUUID()}` },
    ],
  });
};

const fetchFunnel = vi.fn(async (id: string) => {
  if (id === DOWN) return { ok: false as const, notFound: false as const, detail: "features-service HTTP 503" };
  if (id === LEGACY) return { ok: true as const, value: { id: KEY, name: "Epiphany", pipeIds: [], legs: [] } };
  if (id === MOVED) return { ok: true as const, value: { id, name: "Philanthropy", pipeIds: [], legs: [] } };
  return { ok: true as const, value: { id, name: "Epiphany", pipeIds: [], legs: [] } };
});
const run = (apply: boolean) => runSalesFunnelNameRepair({ apply, orgId: ORG, fetchFunnel });

describe("sales funnel name repair", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await cleanTestData();
  });
  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("dry run lists only the row whose exact id the catalogue names otherwise; apply renames it and its prefixed units; second run = nothing", async () => {
    const { salesFunnelCampaign: moved } = await born(MOVED);
    const { salesFunnelCampaign: legacy } = await born(LEGACY, "Epiphany", randomUUID());
    const { salesFunnelCampaign: key } = await born(KEY, "Epiphany", randomUUID());

    const dry = await run(false);
    expect(dry.renamed.map((r) => r.salesFunnelCampaignId)).toEqual([moved.id]);
    expect(dry.renamed[0]).toMatchObject({ from: "Epiphany", to: "Philanthropy", units: [expect.objectContaining({ to: expect.stringMatching(/^Philanthropy /) })] });
    expect(dry.skipped).toEqual([]);
    expect((await db.select().from(salesFunnelCampaigns).where(eq(salesFunnelCampaigns.id, moved.id)))[0].salesFunnelName).toBe("Epiphany");

    const applied = await run(true);
    expect(applied.renamed[0].error).toBeUndefined();
    const [row] = await db.select().from(salesFunnelCampaigns).where(eq(salesFunnelCampaigns.id, moved.id));
    expect(row).toMatchObject({ salesFunnelName: "Philanthropy", salesFunnelId: MOVED, status: "ongoing" });
    const units = await db.select().from(campaigns).where(eq(campaigns.salesFunnelCampaignId, moved.id));
    expect(units.find((u) => u.featureSlug === "your-team-website")!.name).toMatch(new RegExp(`^Philanthropy ${moved.id.slice(0, 8)} - your-team-website - `));
    expect(units.find((u) => u.featureSlug === "sourcing-apollo-cold-filters")!.name).toMatch(/^sourcing-apollo-cold-filters - /);
    expect(await db.select().from(campaignStatusTransitions).where(eq(campaignStatusTransitions.source, "sales_funnel_name_repair"))).toEqual([]);

    for (const untouched of [legacy, key]) {
      expect((await db.select().from(salesFunnelCampaigns).where(eq(salesFunnelCampaigns.id, untouched.id)))[0].salesFunnelName).toBe("Epiphany");
    }
    const again = await run(true);
    expect(again.renamed).toEqual([]);
  });

  it("a legacy id resolving to ANOTHER name is listed, never renamed; an unreadable funnel is skipped", async () => {
    const { salesFunnelCampaign: legacy } = await born(LEGACY, "Bliss");
    await born(DOWN, "Zenith", randomUUID());
    const res = await run(true);
    expect(res.renamed).toEqual([]);
    expect(res.skipped.map((s) => s.reason)).toEqual(expect.arrayContaining([expect.stringContaining("legacy_id_resolves_to"), expect.stringContaining("funnel_unreadable")]));
    expect((await db.select().from(salesFunnelCampaigns).where(eq(salesFunnelCampaigns.id, legacy.id)))[0].salesFunnelName).toBe("Bliss");
  });

  it("a new unit name already taken in the org: that funnel campaign is rolled back, said why", async () => {
    const { salesFunnelCampaign: moved, units } = await born(MOVED);
    const website = units.find((u) => u.featureSlug === "your-team-website")!;
    await db.insert(campaigns).values({
      ...website, id: randomUUID(), salesFunnelCampaignId: null, salesFunnelId: null, status: "stopped",
      name: website.name.replace(/^Epiphany /, "Philanthropy "), featureSlug: "your-team-website-old",
    });
    const res = await run(true);
    expect(res.renamed[0].error).toContain("unit_name_taken");
    expect((await db.select().from(salesFunnelCampaigns).where(eq(salesFunnelCampaigns.id, moved.id)))[0].salesFunnelName).toBe("Epiphany");
  });
});
