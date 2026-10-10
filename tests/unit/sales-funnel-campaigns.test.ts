import { describe, it, expect, vi } from "vitest";
import {
  orderForSharedPipes,
  salesFunnelUnitMoney,
  sharedSalesFunnelPipes,
  serializeSalesFunnelCampaign,
} from "../../src/lib/sales-funnel-campaigns.js";
import { fundingFromBudgets, campaignFunding } from "../../src/lib/campaign-funding.js";
import { resolveSalesFunnelPlan } from "../../src/lib/startable-pair.js";
import type { ChannelCatalogueRead } from "../../src/lib/channel-operator-client.js";

const COLD = "sales-cold-email-outreach";
const ENTRY = "lead_found_to_website_visit";
const REACTIVE = ["conversation", "to", "meeting", "booked"].join("_");

const at = (iso: string) => new Date(iso);
const row = (o: { id: string; featureSlug?: string; legKey?: string; createdAt: string; unit?: string | null }) => ({
  id: o.id,
  featureSlug: o.featureSlug ?? "ai-meeting-booking",
  legKey: o.legKey ?? REACTIVE,
  createdAt: at(o.createdAt),
  salesFunnelCampaignId: o.unit ?? null,
});

describe("one dispatch per pipe two sales funnels share", () => {
  it("leaves a brand with no shared pipe untouched (pre-funnel behaviour)", () => {
    const list = [
      row({ id: "b", createdAt: "2026-10-02T00:00:00Z" }),
      row({ id: "a", featureSlug: COLD, legKey: ENTRY, createdAt: "2026-10-01T00:00:00Z" }),
    ];
    expect(orderForSharedPipes(list)).toBe(list);
    expect(sharedSalesFunnelPipes(list).size).toBe(0);
  });

  it("does not ration two pre-funnel twins (the identity index already allows only one live)", () => {
    const list = [row({ id: "x", createdAt: "2026-10-02T00:00:00Z" }), row({ id: "y", createdAt: "2026-10-01T00:00:00Z" })];
    expect(sharedSalesFunnelPipes(list).size).toBe(0);
    expect(orderForSharedPipes(list).map((c) => c.id)).toEqual(["x", "y"]);
  });

  it("puts the OLDEST live campaign of a shared pipe first, keeping every other position", () => {
    const list = [
      row({ id: "newer-unit", createdAt: "2026-10-09T00:00:00Z", unit: "F2" }),
      row({ id: "entry", featureSlug: COLD, legKey: ENTRY, createdAt: "2026-10-01T00:00:00Z" }),
      row({ id: "older-unit", createdAt: "2026-10-05T00:00:00Z", unit: "F1" }),
    ];
    expect(sharedSalesFunnelPipes(list).size).toBe(1);
    expect(orderForSharedPipes(list).map((c) => c.id)).toEqual(["older-unit", "entry", "newer-unit"]);
  });
});

describe("a sales funnel unit's money is its funnel's caps", () => {
  it("is held as unfunded while billing serves no funnel cap (fail-closed)", async () => {
    const now = new Date("2026-10-10T10:00:00Z");
    const verdict = await salesFunnelUnitMoney({ id: "u1", salesFunnelCampaignId: "F1", salesFunnelId: "f@x" }, now);
    expect(verdict.run).toBe(false);
    if (verdict.run) return;
    expect(verdict.kind).toBe("unfunded");
    expect(verdict.reason).toBe("Sales funnel not funded");
    expect(verdict.detail).toContain("F1");
    expect(verdict.nextRunAt.getTime()).toBe(now.getTime() + 10 * 60_000);
  });

  it("is never funded by the per-(offer, leg, channel) ceiling of the pre-funnel model", async () => {
    const budgets = {
      ok: true as const,
      brandDailyBudgetCents: 5000,
      campaigns: [{ offerId: "o1", legKey: ENTRY, featureSlug: COLD, dailyBudgetCents: 2500 }],
    } as unknown as Parameters<typeof fundingFromBudgets>[1];
    const preFunnel = { featureSlug: COLD, offerId: "o1", legKey: ENTRY };
    expect(fundingFromBudgets({ ...preFunnel, dailyBudgetCents: 900, salesFunnelCampaignId: "F1" }, budgets).funded).toBe(false);
    expect((await campaignFunding({ ...preFunnel, dailyBudgetCents: 900, salesFunnelCampaignId: "F1" }, "b1", { orgId: "o" })).funded).toBe(false);
    // The same row without a funnel keeps its own daily budget, as before.
    expect(fundingFromBudgets({ ...preFunnel, dailyBudgetCents: 900 }, budgets)).toEqual({ funded: true, ceilingCents: 900 });
  });
});

describe("resolveSalesFunnelPlan — what a funnel campaign is made of", () => {
  const identity = { orgId: "org", userId: "user", runId: "run", brandId: "brand" };
  const catalogue: ChannelCatalogueRead = {
    ok: true,
    legsBySlug: new Map([[COLD, new Set([ENTRY])], ["ai-meeting-booking", new Set([REACTIVE])]]),
    operatorBySlug: new Map(),
  } as unknown as ChannelCatalogueRead;
  const pipes: Record<string, { channelSlug: string; legKey: string; mode: "proactive" | "reactive" }> = {
    [`${COLD}|${ENTRY}`]: { channelSlug: COLD, legKey: ENTRY, mode: "proactive" },
    [`ai-meeting-booking|${REACTIVE}`]: { channelSlug: "ai-meeting-booking", legKey: REACTIVE, mode: "reactive" },
    "sourcing-apollo-cold-filters|start_to_lead_found": { channelSlug: "sourcing-apollo-cold-filters", legKey: "start_to_lead_found", mode: "reactive" },
    "google-ads-unknown|x": { channelSlug: "pr-cold-email-outreach", legKey: ENTRY, mode: "proactive" },
  };
  const deps = (pipeIds: string[] | "404" | "down") => ({
    salesFunnel: vi.fn(async () =>
      pipeIds === "404"
        ? { ok: false as const, notFound: true as const, detail: "404" }
        : pipeIds === "down"
          ? { ok: false as const, notFound: false as const, detail: "HTTP 503" }
          : { ok: true as const, value: { id: "f@x", name: "Epiphany", pipeIds } }),
    pipe: vi.fn(async (id: string) =>
      pipes[id]
        ? { ok: true as const, value: { id, name: "Lumen", ...pipes[id] } }
        : { ok: false as const, notFound: true as const, detail: "404" }),
    catalogue: vi.fn(async () => catalogue),
    workflow: vi.fn(async () => ({ ok: true as const, workflowSlug: "aurora-v3" })),
  });

  it("gives one unit per pipe, each with the DAG it is born on", async () => {
    const res = await resolveSalesFunnelPlan("f@x", identity, deps([`${COLD}|${ENTRY}`, `ai-meeting-booking|${REACTIVE}`]));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.plan.salesFunnelName).toBe("Epiphany");
    expect(res.plan.units.map((u) => [u.featureSlug, u.legKey, u.mode, u.workflowSlug])).toEqual([
      [COLD, ENTRY, "proactive", "aurora-v3"],
      ["ai-meeting-booking", REACTIVE, "reactive", "aurora-v3"],
    ]);
  });

  it("runs a SOURCING pipe as a source campaign unit: no workflow, never asked of workflow-service", async () => {
    const d = deps(["sourcing-apollo-cold-filters|start_to_lead_found", `${COLD}|${ENTRY}`]);
    const res = await resolveSalesFunnelPlan("f@x", identity, d);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.plan.units[0]).toMatchObject({ featureSlug: "sourcing-apollo-cold-filters", legKey: "start_to_lead_found", workflowSlug: null });
    expect(d.workflow).toHaveBeenCalledTimes(1);
  });

  it("refuses the whole launch, naming the pipe, when one pipe cannot be run here", async () => {
    const res = await resolveSalesFunnelPlan("f@x", identity, deps([`${COLD}|${ENTRY}`, "google-ads-unknown|x"]));
    expect(res).toMatchObject({ ok: false, refusal: { status: 400, code: "pipe_not_runnable" } });
  });

  it("names an unknown funnel, a funnel with no pipe and an unreadable catalogue apart", async () => {
    expect(await resolveSalesFunnelPlan("nope", identity, deps("404"))).toMatchObject({ refusal: { status: 400, code: "unknown_sales_funnel" } });
    expect(await resolveSalesFunnelPlan("f@x", identity, deps([]))).toMatchObject({ refusal: { status: 400, code: "no_pipe" } });
    expect(await resolveSalesFunnelPlan("f@x", identity, deps("down"))).toMatchObject({ refusal: { status: 502, code: "catalogue_unavailable" } });
  });
});

describe("serializeSalesFunnelCampaign", () => {
  it("serves each unit with its pipe id", () => {
    const now = new Date("2026-10-10T00:00:00Z");
    const out = serializeSalesFunnelCampaign(
      { id: "F1", orgId: "o", brandId: "b", offerId: "of", salesFunnelId: "f@x", salesFunnelName: "Epiphany", status: "stopped", stopReason: "manual", createdByUserId: "u", parentRunId: null, createdAt: now, updatedAt: now },
      [{ id: "c1", featureSlug: COLD, legKey: ENTRY, status: "stopped", workflowSlug: "aurora-v3", name: "n" } as never],
    );
    expect(out.units).toEqual([{ campaignId: "c1", pipeId: `${COLD}|${ENTRY}`, featureSlug: COLD, legKey: ENTRY, status: "stopped", workflowSlug: "aurora-v3", name: "n" }]);
  });
});
