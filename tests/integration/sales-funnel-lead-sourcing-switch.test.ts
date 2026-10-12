import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { campaigns, campaignStatusTransitions, salesFunnelCampaigns } from "../../src/db/schema.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { insertSalesFunnelCampaignWithUnits } from "../../src/lib/campaign-status-history.js";
import { runLeadSourcingSwitch } from "../../src/lib/sales-funnel-lead-sourcing-switch.js";

/**
 * THE LEAD SOURCING SWITCH (owner GO 2026-10-11, "Migration A"): a funnel campaign running several sources gets ONE
 * Lead Sourcing unit, the old source units stopped in the same transaction; the funnel id, its status and its
 * other units do not move. A single-source funnel under a legacy id moves to the id naming its source.
 */
const ORG = "b645207b-0000-4000-8000-0000000000e1";
const BRAND = "75d7e3e8-0000-4000-8000-0000000000e2";
const OFFER = "231bb036-0000-4000-8000-0000000000e3";
const COLD = "sales-cold-email-outreach";
const ENTRY = ["lead", "found", "to", "conversation"].join("_");
const SRC_LEG = "start_to_lead_found";
const CF = "sourcing-apollo-cold-filters";
const BS = "sourcing-apollo-buying-signals";
const LI = "sourcing-linkedin-engagement-signals";
const BLISS = `${ENTRY}@${COLD}+closing`;

// A launch names a unit `<funnel name> <idTag> - <derived>`; a source unit linked by the conversion carries no prefix.
const unit = (featureSlug: string, legKey: string, workflowSlug: string | null, prefix = "") => ({
  featureSlug,
  legKey,
  workflowSlug,
  name: `${prefix}${featureSlug} ${randomUUID()}`,
  acquisitionChannel: featureSlug.replace(/-/g, "_"),
});

const born = (sources: string[], status: "ongoing" | "stopped" = "ongoing", salesFunnelId = BLISS) => {
  const id = randomUUID();
  return insertSalesFunnelCampaignWithUnits({
    id, orgId: ORG, brandId: BRAND, offerId: OFFER, salesFunnelId, salesFunnelName: "Bliss",
    status, createdByUserId: null, parentRunId: null,
    units: [unit(COLD, ENTRY, "cold-v1", `Bliss ${id.slice(0, 8)} - `), ...sources.map((s) => unit(s, SRC_LEG, null))],
  });
};

const WORKFLOWS: Record<string, string> = { "lead-sourcing": "lead-sourcing-vega", [CF]: "sourcing-apollo-cold-filters-rigel", [BS]: "sourcing-apollo-buying-signals-deneb" };
const noCaps = vi.fn(async () => ({ ok: true as const, caps: { stated: false } as never }));
const run = (apply: boolean, extra: Record<string, unknown> = {}) =>
  runLeadSourcingSwitch({ apply, orgId: ORG, workflowOf: async (s) => WORKFLOWS[s] ?? null, capsOf: noCaps, ...extra });

describe("the Lead Sourcing switch", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await cleanTestData();
  });
  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("a funnel on three sources: dry run lists it, apply gives ONE Lead Sourcing unit and stops the three; nothing else moves", async () => {
    const { salesFunnelCampaign: parent, units } = await born([CF, BS, LI]);
    const dry = await run(false);
    expect(dry.switches).toEqual([expect.objectContaining({ salesFunnelCampaignId: parent.id, replaces: [{ campaignId: expect.any(String), featureSlug: BS }, { campaignId: expect.any(String), featureSlug: CF }, { campaignId: expect.any(String), featureSlug: LI }] })]);
    expect((await db.select().from(campaigns).where(eq(campaigns.featureSlug, "lead-sourcing")))).toHaveLength(0);

    const applied = await run(true);
    const lsId = applied.switches[0].leadSourcingCampaignId!;
    const [ls] = await db.select().from(campaigns).where(eq(campaigns.id, lsId));
    expect(ls).toMatchObject({
      featureSlug: "lead-sourcing", legKey: SRC_LEG, status: "ongoing", workflowSlug: "lead-sourcing-vega",
      salesFunnelId: BLISS, salesFunnelCampaignId: parent.id, offerId: OFFER, brandId: BRAND,
      // Due at birth like every unit: the scheduler parks it while its leg answers on demand (lib/on-demand-mode.ts).
      nextRunAt: expect.any(Date),
    });
    const after = await db.select().from(campaigns).where(eq(campaigns.salesFunnelCampaignId, parent.id));
    for (const s of units.filter((u) => u.legKey === SRC_LEG)) {
      expect(after.find((u) => u.id === s.id)).toMatchObject({ status: "stopped", stopReason: "replaced_by_lead_sourcing", nextRunAt: null });
    }
    const cold = units.find((u) => u.featureSlug === COLD)!;
    expect(after.find((u) => u.id === cold.id)).toMatchObject({ status: "ongoing", workflowSlug: "cold-v1" });
    const [funnel] = await db.select().from(salesFunnelCampaigns).where(eq(salesFunnelCampaigns.id, parent.id));
    expect(funnel).toMatchObject({ status: "ongoing", salesFunnelId: BLISS });
    const transitions = await db.select().from(campaignStatusTransitions).where(eq(campaignStatusTransitions.source, "lead_sourcing_switch"));
    expect(transitions).toHaveLength(4);

    // Idempotent.
    const again = await run(true);
    expect(again.switches).toEqual([]);
  });

  it("a STOPPED funnel on two sources still switches: its Lead Sourcing unit is born stopped", async () => {
    const { salesFunnelCampaign: parent } = await born([CF, BS], "ongoing");
    await db.update(salesFunnelCampaigns).set({ status: "stopped", stopReason: "manual" }).where(eq(salesFunnelCampaigns.id, parent.id));
    const applied = await run(true);
    const [ls] = await db.select().from(campaigns).where(eq(campaigns.id, applied.switches[0].leadSourcingCampaignId!));
    expect(ls).toMatchObject({ status: "stopped", nextRunAt: null });
  });

  it("no Lead Sourcing workflow: nothing switched, said why", async () => {
    await born([CF, BS]);
    const res = await runLeadSourcingSwitch({ apply: true, orgId: ORG, workflowOf: async () => null, capsOf: noCaps });
    expect(res.switches[0].error).toContain("no_workflow");
    expect((await db.select().from(campaigns).where(eq(campaigns.featureSlug, "lead-sourcing")))).toHaveLength(0);
  });

  it("a single-source funnel the catalogue answers with another id moves to the id naming its source, AND to that id's name; with a billing cap it does not", async () => {
    const { salesFunnelCampaign: parent } = await born([CF]);
    const fetchSalesFunnel = vi.fn(async (id: string) => id.startsWith("minted:") ? ({
      ok: true as const,
      value: { id, name: "Philanthropy", pipeIds: [], legs: [] },
    }) : ({
      ok: true as const,
      value: {
        id: `${SRC_LEG}@lead-sourcing+${BLISS}`, name: "Bliss", pipeIds: [],
        legs: [
          { legKey: SRC_LEG, pipe: { id: `lead-sourcing|${SRC_LEG}`, mode: "reactive" as const }, channelIds: ["lead-sourcing"] },
          { legKey: ENTRY, pipe: { id: `${COLD}|${ENTRY}`, mode: "proactive" as const }, channelIds: [COLD] },
          { legKey: "closing", pipe: { id: "your-team-closing-calls|closing", mode: "reactive" as const }, channelIds: ["your-team-closing-calls"] },
        ],
      },
    }));
    const declareSalesFunnel = vi.fn(async (pipeIds: string[]) => ({ ok: true as const, value: { id: `minted:${pipeIds.join(",")}` } }));
    const capped = vi.fn(async () => ({ ok: true as const, caps: { stated: true } as never }));
    const blocked = await run(true, { capsOf: capped, catalogue: { fetchSalesFunnel, declareSalesFunnel } });
    expect(blocked.respelled[0]).toMatchObject({ skipped: "billing_cap_on_this_id" });
    expect(declareSalesFunnel).toHaveBeenCalledWith([`${CF}|${SRC_LEG}`, `${COLD}|${ENTRY}`, "your-team-closing-calls|closing"], expect.any(String));

    const moved = await run(true, { catalogue: { fetchSalesFunnel, declareSalesFunnel } });
    const to = `minted:${CF}|${SRC_LEG},${COLD}|${ENTRY},your-team-closing-calls|closing`;
    expect(moved.respelled[0]).toMatchObject({ from: BLISS, to });
    const [funnel] = await db.select().from(salesFunnelCampaigns).where(eq(salesFunnelCampaigns.id, parent.id));
    expect(funnel.salesFunnelId).toBe(to);
    expect(funnel.salesFunnelName).toBe("Philanthropy");
    expect(moved.respelled[0]).toMatchObject({ toName: "Philanthropy" });
    const units = await db.select().from(campaigns).where(eq(campaigns.salesFunnelCampaignId, parent.id));
    expect(units.every((u) => u.salesFunnelId === to)).toBe(true);
    const tag = parent.id.slice(0, 8);
    expect(units.find((u) => u.featureSlug === COLD)!.name).toMatch(new RegExp(`^Philanthropy ${tag} - ${COLD} `));
    // A unit carrying no funnel prefix keeps its name.
    expect(units.find((u) => u.featureSlug === CF)!.name).toMatch(new RegExp(`^${CF} `));
  });

  it("the new id's name unreadable: nothing moves, said why", async () => {
    const { salesFunnelCampaign: parent } = await born([CF]);
    const fetchSalesFunnel = vi.fn(async (id: string) => id.startsWith("minted:")
      ? ({ ok: false as const, notFound: false as const, detail: "features-service HTTP 503" })
      : ({ ok: true as const, value: { id: `${SRC_LEG}@lead-sourcing+${BLISS}`, name: "Bliss", pipeIds: [], legs: [
          { legKey: SRC_LEG, pipe: { id: `lead-sourcing|${SRC_LEG}`, mode: "reactive" as const }, channelIds: ["lead-sourcing"] },
          { legKey: ENTRY, pipe: { id: `${COLD}|${ENTRY}`, mode: "proactive" as const }, channelIds: [COLD] },
        ] } }));
    const declareSalesFunnel = vi.fn(async (pipeIds: string[]) => ({ ok: true as const, value: { id: `minted:${pipeIds.join(",")}` } }));
    const res = await run(true, { catalogue: { fetchSalesFunnel, declareSalesFunnel } });
    expect(res.respelled[0].skipped).toContain("funnel_name_unreadable");
    const [funnel] = await db.select().from(salesFunnelCampaigns).where(eq(salesFunnelCampaigns.id, parent.id));
    expect(funnel).toMatchObject({ salesFunnelId: BLISS, salesFunnelName: "Bliss" });
  });

  it("every ON source unit with no workflow takes its pipe's, due now (the scheduler decides who dispatches it)", async () => {
    await born([CF]);
    const res = await run(true, { catalogue: { fetchSalesFunnel: async () => ({ ok: true as const, value: { id: BLISS, name: "Bliss", pipeIds: [], legs: [] } }) } });
    expect(res.workflowBackfill).toEqual([expect.objectContaining({ featureSlug: CF, workflowSlug: "sourcing-apollo-cold-filters-rigel" })]);
    const [cf] = await db.select().from(campaigns).where(and(eq(campaigns.featureSlug, CF), eq(campaigns.status, "ongoing")));
    expect(cf).toMatchObject({ workflowSlug: "sourcing-apollo-cold-filters-rigel", nextRunAt: expect.any(Date) });
  });
});
