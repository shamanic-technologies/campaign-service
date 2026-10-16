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
 * features-service serves for its id (a legacy id: the id it resolves to) takes it (row + units' prefix); a retired id
 * takes the stated name; an unreadable funnel never.
 */
const ORG = "b645207b-0000-4000-8000-0000000000f1";
const BRAND = "75d7e3e8-0000-4000-8000-0000000000f2";
const OFFER = "231bb036-0000-4000-8000-0000000000f3";
const MOVED = "start_to_lead_found@sourcing-apollo-cold-filters+lead_found_to_website_visit@sales-cold-email-outreach+website_visit_to_purchase+purchase_to_paid_client";
const LEGACY = "lead_found_to_website_visit@sales-cold-email-outreach+website_visit_to_purchase+purchase_to_paid_client";
const KEY = "start_to_lead_found@lead-sourcing+lead_found_to_website_visit@sales-cold-email-outreach+website_visit_to_purchase+purchase_to_paid_client";
const DOWN = "down@funnel";
const RETIRED = "start_to_email_sent@email-sending";

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
  if (id === RETIRED) return { ok: false as const, notFound: true as const, detail: "features-service 404" };
  if (id === DOWN) return { ok: false as const, notFound: false as const, detail: "features-service HTTP 503" };
  if (id === LEGACY) return { ok: true as const, value: { id: KEY, name: "Epiphany", pipeIds: [], legs: [] } };
  if (id === MOVED) return { ok: true as const, value: { id, name: "Philanthropy", pipeIds: [], legs: [] } };
  return { ok: true as const, value: { id, name: "Epiphany", pipeIds: [], legs: [] } };
});
const run = (apply: boolean, retiredFunnelNames?: Record<string, string>) =>
  runSalesFunnelNameRepair({ apply, orgId: ORG, fetchFunnel, retiredFunnelNames });

describe("sales funnel name repair", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await cleanTestData();
  });
  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("dry run lists the rows the catalogue names otherwise (exact or legacy id); apply renames them and their prefixed units; second run = nothing", async () => {
    const { salesFunnelCampaign: moved } = await born(MOVED);
    const { salesFunnelCampaign: legacy } = await born(LEGACY, "Bliss", randomUUID());
    const { salesFunnelCampaign: key } = await born(KEY, "Epiphany", randomUUID());

    const dry = await run(false);
    expect(dry.renamed.map((r) => r.salesFunnelCampaignId).sort()).toEqual([moved.id, legacy.id].sort());
    expect(dry.renamed.find((r) => r.salesFunnelCampaignId === moved.id)).toMatchObject({ from: "Epiphany", to: "Philanthropy", nameSource: "catalogue", units: [expect.objectContaining({ to: expect.stringMatching(/^Philanthropy /) })] });
    expect(dry.renamed.find((r) => r.salesFunnelCampaignId === moved.id)!.resolvedSalesFunnelId).toBeUndefined();
    expect(dry.renamed.find((r) => r.salesFunnelCampaignId === legacy.id)).toMatchObject({ from: "Bliss", to: "Epiphany", salesFunnelId: LEGACY, resolvedSalesFunnelId: KEY });
    expect(dry.skipped).toEqual([]);
    expect((await db.select().from(salesFunnelCampaigns).where(eq(salesFunnelCampaigns.id, moved.id)))[0].salesFunnelName).toBe("Epiphany");

    const applied = await run(true);
    expect(applied.renamed.map((r) => r.error)).toEqual([undefined, undefined]);
    const [row] = await db.select().from(salesFunnelCampaigns).where(eq(salesFunnelCampaigns.id, moved.id));
    expect(row).toMatchObject({ salesFunnelName: "Philanthropy", salesFunnelId: MOVED, status: "ongoing" });
    const units = await db.select().from(campaigns).where(eq(campaigns.salesFunnelCampaignId, moved.id));
    expect(units.find((u) => u.featureSlug === "your-team-website")!.name).toMatch(new RegExp(`^Philanthropy ${moved.id.slice(0, 8)} - your-team-website - `));
    expect(units.find((u) => u.featureSlug === "sourcing-apollo-cold-filters")!.name).toMatch(/^sourcing-apollo-cold-filters - /);
    expect(await db.select().from(campaignStatusTransitions).where(eq(campaignStatusTransitions.source, "sales_funnel_name_repair"))).toEqual([]);

    // The legacy row reads the resolved funnel's name; its stored id never moves (billing's caps are keyed on it).
    const [legacyRow] = await db.select().from(salesFunnelCampaigns).where(eq(salesFunnelCampaigns.id, legacy.id));
    expect(legacyRow).toMatchObject({ salesFunnelName: "Epiphany", salesFunnelId: LEGACY, status: "ongoing" });
    const legacyUnits = await db.select().from(campaigns).where(eq(campaigns.salesFunnelCampaignId, legacy.id));
    expect(legacyUnits.every((u) => u.salesFunnelId === LEGACY)).toBe(true);
    expect(legacyUnits.find((u) => u.featureSlug === "your-team-website")!.name).toMatch(new RegExp(`^Epiphany ${legacy.id.slice(0, 8)} - your-team-website - `));

    expect((await db.select().from(salesFunnelCampaigns).where(eq(salesFunnelCampaigns.id, key.id)))[0].salesFunnelName).toBe("Epiphany");
    const again = await run(true);
    expect(again.renamed).toEqual([]);
  });

  it("a retired funnel (404) takes the stated name, else is skipped; an unreadable funnel is skipped even with a stated name", async () => {
    const { salesFunnelCampaign: retired } = await born(RETIRED, "Concord");
    await born(DOWN, "Zenith", randomUUID());
    const without = await run(true);
    expect(without.renamed).toEqual([]);
    expect(without.skipped.map((s) => s.reason)).toEqual(expect.arrayContaining([expect.stringContaining("funnel_retired"), expect.stringContaining("funnel_unreadable")]));
    expect((await db.select().from(salesFunnelCampaigns).where(eq(salesFunnelCampaigns.id, retired.id)))[0].salesFunnelName).toBe("Concord");

    const withNames = await run(true, { [RETIRED]: "Email Sending", [DOWN]: "Guessed Name" });
    expect(withNames.renamed).toEqual([expect.objectContaining({ salesFunnelCampaignId: retired.id, from: "Concord", to: "Email Sending", nameSource: "retired" })]);
    expect(withNames.skipped.map((s) => s.reason)).toEqual([expect.stringContaining("funnel_unreadable")]);
    const units = await db.select().from(campaigns).where(eq(campaigns.salesFunnelCampaignId, retired.id));
    expect(units.find((u) => u.featureSlug === "your-team-website")!.name).toMatch(new RegExp(`^Email Sending ${retired.id.slice(0, 8)} - `));
    expect((await run(true, { [RETIRED]: "Email Sending" })).renamed).toEqual([]);
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
