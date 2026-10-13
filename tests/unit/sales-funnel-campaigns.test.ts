import { describe, it, expect, vi } from "vitest";
import {
  orderForSharedPipes,
  salesFunnelUnitMoney,
  salesFunnelPollRoom,
  sharedSalesFunnelPipes,
  resetSalesFunnelCapsCache,
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
  const unit = {
    id: "u1", orgId: "org", brandId: "brand", offerId: "offer", featureSlug: COLD, legKey: ENTRY,
    salesFunnelCampaignId: "F1", salesFunnelId: "f@x",
  };
  const answer = (body: unknown, ok = true) =>
    vi.fn(async () => ({ ok, status: ok ? 200 : 503, json: async () => body }));
  const budget = (amountCents: string, consumedCents: string | null, reached: boolean | null, period = "weekly") => ({
    amountCents, period, periodStart: "2026-10-05T00:00:00Z", periodEnd: null, consumedCents, remainingCents: null, reached,
    consumedUnavailableReason: consumedCents === null ? "runs_unavailable" : null, consumedUnavailableDetail: null,
  });
  const withCaps = async (body: unknown, ok = true, u = unit) => {
    process.env.BILLING_SERVICE_URL = "https://billing.test.local";
    process.env.BILLING_SERVICE_API_KEY = "k";
    resetSalesFunnelCapsCache();
    const fetchMock = answer(body, ok);
    vi.stubGlobal("fetch", fetchMock);
    try {
      return { verdict: await salesFunnelUnitMoney(u, new Date("2026-10-10T10:00:00Z")), fetchMock };
    } finally {
      vi.unstubAllGlobals();
    }
  };

  it("is unfunded while the customer states no max budget (money starts nothing)", async () => {
    const { verdict, fetchMock } = await withCaps({ stated: false, funded: false, fundedBy: null, maxBudget: null, maxVolume: null, pipes: null });
    expect(verdict).toMatchObject({ run: false, kind: "unfunded", reason: "Sales funnel not funded" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
    expect(url).toBe("https://billing.test.local/internal/brands/brand/offers/offer/sales-funnels/f%40x/campaigns/F1/caps");
    expect(init.headers["x-org-id"]).toBe("org");
  });

  it("never remembers a 'not funded' answer: a cap written a second later is read at once (prod 2026-10-13)", async () => {
    process.env.BILLING_SERVICE_URL = "https://billing.test.local";
    process.env.BILLING_SERVICE_API_KEY = "k";
    resetSalesFunnelCapsCache();
    const unfunded = { stated: false, funded: false, fundedBy: null, maxBudget: null, maxVolume: null, pipes: null };
    const funded = { stated: true, funded: true, fundedBy: "max_budget", maxBudget: budget("200", "0", false, "daily"), maxVolume: null, pipes: null };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => unfunded })
      .mockResolvedValue({ ok: true, status: 200, json: async () => funded });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const t = new Date("2026-10-10T10:00:00Z");
      expect(await salesFunnelUnitMoney(unit, t)).toMatchObject({ run: false, kind: "unfunded" });
      expect(await salesFunnelUnitMoney(unit, new Date(t.getTime() + 2_000))).toMatchObject({ run: true });
      // A funded answer is still cached.
      expect(await salesFunnelUnitMoney(unit, new Date(t.getTime() + 4_000))).toMatchObject({ run: true });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  describe("billing's funding verdict (owner 2026-10-11: a max $ AND/OR a max volume)", () => {
    const volume = (consumed: number | null, reached: boolean | null, count = 10) => ({
      count, period: "daily", unit: "first_contacts", consumed, reached,
      consumedUnavailableReason: consumed === null ? "volume_not_measured_on_channel" : null,
    });
    const volumeOnly = (v: unknown, pipes: unknown = null) => ({ stated: true, funded: true, fundedBy: "max_volume", maxBudget: null, maxVolume: v, pipes });

    it("runs a VOLUME-ONLY proactive pipe, paced on volume consumed / max volume (no $ figure made up)", async () => {
      expect((await withCaps(volumeOnly(volume(3, false)))).verdict).toEqual({ run: true, pace: { spentCents: 3, ceilingCents: 10 } });
    });

    it("runs a volume-only REACTIVE pipe first in its cohort", async () => {
      const reactive = { ...unit, featureSlug: "ai-meeting-booking", legKey: REACTIVE };
      const pipes = [{ channelSlug: "ai-meeting-booking", legKey: REACTIVE, mode: "reactive" }];
      expect((await withCaps(volumeOnly(volume(3, false), pipes), true, reactive)).verdict).toEqual({ run: true, pace: { spentCents: 0, ceilingCents: 1 } });
    });

    it("holds a volume-only funnel once its max volume is reached, and LOUDLY when it cannot be measured", async () => {
      expect((await withCaps(volumeOnly(volume(10, true)))).verdict).toMatchObject({ run: false, kind: "cap_reached", reason: "Sales funnel max volume reached" });
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      expect((await withCaps(volumeOnly(volume(null, null)))).verdict).toMatchObject({ run: false, kind: "unreadable", reason: "Sales funnel volume unavailable" });
      expect(errors.mock.calls.flat().join(" ")).toContain("volume_not_measured_on_channel");
      errors.mockRestore();
    });

    it("holds unfunded when billing says not funded, whatever caps it shows", async () => {
      expect((await withCaps({ stated: false, funded: false, fundedBy: null, maxBudget: null, maxVolume: null, pipes: null })).verdict)
        .toMatchObject({ run: false, kind: "unfunded", reason: "Sales funnel not funded" });
      expect((await withCaps({ stated: true, funded: false, fundedBy: null, maxBudget: budget("0", "0", false), maxVolume: volume(0, false), pipes: null })).verdict)
        .toMatchObject({ run: false, kind: "unfunded" });
    });

    it("leaves a max-budget or both funnel byte-identical", async () => {
      expect((await withCaps({ stated: true, funded: true, fundedBy: "max_budget", maxBudget: budget("1000", "250", false), maxVolume: null, pipes: null })).verdict)
        .toEqual({ run: true, pace: { spentCents: 250, ceilingCents: 1000 } });
      expect((await withCaps({ stated: true, funded: true, fundedBy: "both", maxBudget: budget("1000", "250", false), maxVolume: volume(3, false), pipes: null })).verdict)
        .toEqual({ run: true, pace: { spentCents: 250, ceilingCents: 1000 } });
      expect((await withCaps({ stated: true, funded: true, fundedBy: "both", maxBudget: budget("1000", "1000", true), maxVolume: volume(3, false), pipes: null })).verdict)
        .toMatchObject({ run: false, kind: "cap_reached", reason: "Sales funnel max budget reached" });
    });

    it("holds (fail-closed) when billing names a funding cap it does not serve", async () => {
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      expect((await withCaps({ stated: true, funded: true, fundedBy: "max_volume", maxBudget: null, maxVolume: null, pipes: null })).verdict)
        .toMatchObject({ run: false, kind: "unreadable" });
      errors.mockRestore();
    });

    it("gives a volume-only unit poll-read room while its volume is measured and not reached", async () => {
      process.env.BILLING_SERVICE_URL = "https://billing.test.local";
      process.env.BILLING_SERVICE_API_KEY = "k";
      const room = async (body: unknown) => {
        resetSalesFunnelCapsCache();
        vi.stubGlobal("fetch", answer(body));
        try { return await salesFunnelPollRoom(unit, 5, new Date("2026-10-10T10:00:00Z")); } finally { vi.unstubAllGlobals(); }
      };
      expect(await room(volumeOnly(volume(3, false)))).toEqual({ ok: true });
      expect(await room(volumeOnly(volume(10, true)))).toMatchObject({ ok: false });
      expect(await room(volumeOnly(volume(null, null)))).toMatchObject({ ok: false });
      expect(await room({ stated: false, funded: false, fundedBy: null, maxBudget: null, maxVolume: null, pipes: null })).toMatchObject({ ok: false });
      // A budget still binds the read when one funds the funnel.
      expect(await room({ stated: true, funded: true, fundedBy: "both", maxBudget: budget("1000", "998", false), maxVolume: volume(3, false), pipes: null })).toMatchObject({ ok: false });
      expect(await room({ stated: true, funded: true, fundedBy: "both", maxBudget: budget("1000", "10", false), maxVolume: volume(3, false), pipes: null })).toEqual({ ok: true });
    });
  });

  it("runs a proactive pipe under both caps, paced on the funnel's consumed / max budget", async () => {
    const { verdict } = await withCaps({ stated: true, funded: true, fundedBy: "both", maxBudget: budget("1000", "250", false), maxVolume: { count: 100, period: "monthly", unit: "first_contacts", consumed: 3, reached: false, consumedUnavailableReason: null }, pipes: null });
    expect(verdict).toEqual({ run: true, pace: { spentCents: 250, ceilingCents: 1000 } });
  });

  it("holds a proactive pipe when EITHER cap is reached: new first touches stop", async () => {
    expect((await withCaps({ stated: true, funded: true, fundedBy: "max_budget", maxBudget: budget("1000", "1000", true), maxVolume: null, pipes: null })).verdict)
      .toMatchObject({ run: false, kind: "cap_reached", reason: "Sales funnel max budget reached" });
    expect((await withCaps({ stated: true, funded: true, fundedBy: "both", maxBudget: budget("1000", "10", false), maxVolume: { count: 5, period: "daily", unit: "first_contacts", consumed: 5, reached: true, consumedUnavailableReason: null }, pipes: null })).verdict)
      .toMatchObject({ run: false, kind: "cap_reached", reason: "Sales funnel max volume reached" });
  });

  it("holds a proactive pipe LOUDLY when a consumption cannot be measured (never read as not reached)", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { verdict } = await withCaps({ stated: true, funded: true, fundedBy: "both", maxBudget: budget("1000", "10", false), maxVolume: { count: 5, period: "daily", unit: "first_contacts", consumed: null, reached: null, consumedUnavailableReason: "volume_not_measured_on_channel" }, pipes: null });
    expect(verdict).toMatchObject({ run: false, kind: "unreadable" });
    expect(errors.mock.calls.flat().join(" ")).toContain("volume_not_measured_on_channel");
    errors.mockRestore();
  });

  it("holds a REACTIVE pipe too once the max budget is reached (owner: always respect the user budget)", async () => {
    const reactive = { ...unit, featureSlug: "ai-meeting-booking", legKey: REACTIVE };
    const pipes = [{ pipeId: "p", channelSlug: "ai-meeting-booking", legKey: REACTIVE, mode: "reactive", campaignIds: [] }];
    const reached = await withCaps({ stated: true, funded: true, fundedBy: "max_budget", maxBudget: budget("1000", "1200", true), maxVolume: null, pipes }, true, reactive);
    expect(reached.verdict).toMatchObject({ run: false, kind: "cap_reached", reason: "Sales funnel max budget reached" });
    // Volume reached: no new event either.
    const volume = await withCaps({ stated: true, funded: true, fundedBy: "both", maxBudget: budget("1000", "10", false), maxVolume: { count: 5, period: "daily", unit: "first_contacts", consumed: 5, reached: true, consumedUnavailableReason: null }, pipes }, true, reactive);
    expect(volume.verdict).toMatchObject({ run: false, kind: "cap_reached", reason: "Sales funnel max volume reached" });
    // Under both caps it answers, first in its cohort's turn.
    const under = await withCaps({ stated: true, funded: true, fundedBy: "max_budget", maxBudget: budget("1000", "10", false), maxVolume: null, pipes }, true, reactive);
    expect(under.verdict).toEqual({ run: true, pace: { spentCents: 0, ceilingCents: 1 } });
  });

  it("holds every unit when billing cannot be read (fail-closed)", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { verdict } = await withCaps({}, false);
    expect(verdict).toMatchObject({ run: false, kind: "unreadable", reason: "Sales funnel caps unavailable" });
    errors.mockRestore();
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
  const identity = { orgId: "org", userId: "user", runId: "run", brandId: "brand", offerId: "offer" };
  const catalogue: ChannelCatalogueRead = {
    ok: true,
    legsBySlug: new Map([[COLD, new Set([ENTRY])], ["ai-meeting-booking", new Set([REACTIVE])], ["sourcing-apollo-cold-filters", new Set(["start_to_lead_found"])]]),
    operatorBySlug: new Map(),
  } as unknown as ChannelCatalogueRead;
  const pipes: Record<string, { channelSlug: string; legKey: string; mode: "proactive" | "reactive" }> = {
    [`${COLD}|${ENTRY}`]: { channelSlug: COLD, legKey: ENTRY, mode: "proactive" },
    [`ai-meeting-booking|${REACTIVE}`]: { channelSlug: "ai-meeting-booking", legKey: REACTIVE, mode: "reactive" },
    "sourcing-apollo-cold-filters|start_to_lead_found": { channelSlug: "sourcing-apollo-cold-filters", legKey: "start_to_lead_found", mode: "reactive" },
    "google-ads-unknown|x": { channelSlug: "pr-cold-email-outreach", legKey: ENTRY, mode: "proactive" },
  };
  const deps = (pipeIds: string[] | "404" | "down") => ({
    offerSteps: vi.fn(async () => ({ ok: true as const, stated: false as const })),
    salesFunnel: vi.fn(async () =>
      pipeIds === "404"
        ? { ok: false as const, notFound: true as const, detail: "404" }
        : pipeIds === "down"
          ? { ok: false as const, notFound: false as const, detail: "HTTP 503" }
          : { ok: true as const, value: { id: "f@x", name: "Epiphany", pipeIds, legs: pipeIds.map((id) => ({ legKey: id.split("|")[1], pipe: { id, mode: "proactive" as const }, channelIds: [id.split("|")[0]] })) } }),
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

  it("a SOURCING pipe's unit takes its pipe's workflow like every pipe (owner 2026-10-11); a retired source is refused", async () => {
    const d = deps(["sourcing-apollo-cold-filters|start_to_lead_found", `${COLD}|${ENTRY}`]);
    const res = await resolveSalesFunnelPlan("f@x", identity, d);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.plan.units[0]).toMatchObject({ featureSlug: "sourcing-apollo-cold-filters", legKey: "start_to_lead_found", workflowSlug: "aurora-v3" });
    expect(d.workflow).toHaveBeenCalledTimes(2);
  });

  it("launches a pipe OUTSIDE the sales family (LinkedIn Posting, #608): its funnel's caps pace it", async () => {
    const LI = "organic-linkedin-publishing";
    const LI_LEG = "start_to_website_visit";
    const liCatalogue = {
      ok: true,
      legsBySlug: new Map([[LI, new Set([LI_LEG])]]),
      operatorBySlug: new Map([[LI, "platform"]]),
    } as unknown as ChannelCatalogueRead;
    const d = {
      ...deps([`${LI}|${LI_LEG}`]),
      pipe: vi.fn(async (id: string) => ({ ok: true as const, value: { id, name: "Sunrise", channelSlug: LI, legKey: LI_LEG, mode: "proactive" as const } })),
      catalogue: vi.fn(async () => liCatalogue),
    };
    const ok = await resolveSalesFunnelPlan("f@li", identity, d);
    expect(ok).toMatchObject({ ok: true, plan: { units: [{ featureSlug: LI, legKey: LI_LEG, workflowSlug: "aurora-v3" }] } });

    // Nothing can run the channel yet (workflow-service has no dynasty for it): the TRUE answer,
    // not "not paced here".
    d.workflow = vi.fn(async () => ({ ok: true as const, workflowSlug: null }));
    expect(await resolveSalesFunnelPlan("f@li", identity, d)).toMatchObject({ ok: false, refusal: { status: 409, code: "no_workflow" } });
  });

  it("refuses the whole launch, naming the pipe, when one pipe cannot be run here", async () => {
    const res = await resolveSalesFunnelPlan("f@x", identity, deps([`${COLD}|${ENTRY}`, "google-ads-unknown|x"]));
    expect(res).toMatchObject({ ok: false, refusal: { status: 400, code: "pipe_not_runnable" } });
  });

  it("refuses a funnel with a leg NOBODY works; a lead-source leg naming no single pipe is fine (owner 2026-10-11)", async () => {
    const funnelWith = (extra: { legKey: string; pipe: null; channelIds: string[] }) => ({
      ...deps([`${COLD}|${ENTRY}`]),
      salesFunnel: vi.fn(async () => ({
        ok: true as const,
        value: { id: "f@x", name: "Bliss", pipeIds: [`${COLD}|${ENTRY}`], legs: [extra, { legKey: ENTRY, pipe: { id: `${COLD}|${ENTRY}`, mode: "proactive" as const }, channelIds: [COLD] }] },
      })),
    });
    const holed = await resolveSalesFunnelPlan("f@x", identity, funnelWith({ legKey: REACTIVE, pipe: null, channelIds: [] }));
    expect(holed).toMatchObject({ ok: false, refusal: { status: 400, code: "leg_without_channel" } });
    const sourced = await resolveSalesFunnelPlan("f@x", identity, funnelWith({ legKey: "start_to_lead_found", pipe: null, channelIds: ["sourcing-apollo-cold-filters", "sourcing-crm-contacts"] }));
    expect(sourced.ok).toBe(true);
  });

  it("names an unknown funnel, a funnel with no pipe and an unreadable catalogue apart", async () => {
    expect(await resolveSalesFunnelPlan("nope", identity, deps("404"))).toMatchObject({ refusal: { status: 400, code: "unknown_sales_funnel" } });
    expect(await resolveSalesFunnelPlan("f@x", identity, deps([]))).toMatchObject({ refusal: { status: 400, code: "no_pipe" } });
    expect(await resolveSalesFunnelPlan("f@x", identity, deps("down"))).toMatchObject({ refusal: { status: 502, code: "catalogue_unavailable" } });
  });
});

describe("resolveSalesFunnelPlan — the steps the offer's business has (owner 2026-10-12)", () => {
  const identity = { orgId: "org", userId: "user", runId: "run", brandId: "brand", offerId: "offer" };
  const step = (key: string | null) => key;
  // The catalogue's published legs, as features-service served them on 2026-10-12.
  const legs = [
    { legKey: "start_to_website_visit", fromStepKey: step(null), toStepKey: "website_visit" },
    { legKey: "website_visit_to_purchase", fromStepKey: "website_visit", toStepKey: "purchase" },
    { legKey: "purchase_to_paid_client", fromStepKey: "purchase", toStepKey: "paid_client" },
    { legKey: "website_visit_to_meeting_booked", fromStepKey: "website_visit", toStepKey: "meeting_booked" },
    { legKey: "meeting_booked_to_meeting_attended", fromStepKey: "meeting_booked", toStepKey: "meeting_attended" },
    { legKey: "meeting_attended_to_paid_client", fromStepKey: "meeting_attended", toStepKey: "paid_client" },
    { legKey: "start_to_lead_found", fromStepKey: null, toStepKey: "lead_found" },
    { legKey: "lead_found_to_website_visit", fromStepKey: "lead_found", toStepKey: "website_visit" },
  ];
  const LI = "organic-linkedin-publishing";
  const catalogue = {
    ok: true,
    legsBySlug: new Map([[LI, new Set(["start_to_website_visit"])], ["your-team", new Set(legs.map((l) => l.legKey))]]),
    operatorBySlug: new Map([[LI, "platform"], ["your-team", "customer"]]),
    legs,
    stepKeys: new Set(["website_visit", "purchase", "meeting_booked", "meeting_attended", "paid_client", "lead_found"]),
  } as unknown as ChannelCatalogueRead;
  // Every leg is one pipe here (the entry by LinkedIn, the rest by the customer's own team).
  const funnelOf = (name: string, legKeys: string[]) => ({
    ok: true as const,
    value: {
      id: legKeys.join("+"),
      name,
      pipeIds: legKeys.map((k) => (k.startsWith("start_") ? `${LI}|${k}` : `your-team|${k}`)),
      legs: legKeys.map((k) => ({ legKey: k, pipe: { id: k.startsWith("start_") ? `${LI}|${k}` : `your-team|${k}`, mode: "proactive" as const }, channelIds: [k.startsWith("start_") ? LI : "your-team"] })),
    },
  });
  const PURCHASE = ["start_to_website_visit", "website_visit_to_purchase", "purchase_to_paid_client"];
  const MEETING = ["start_to_website_visit", "website_visit_to_meeting_booked", "meeting_booked_to_meeting_attended", "meeting_attended_to_paid_client"];
  const DOC_DINNERS = ["conversation", "booking_call", "meeting_booked", "meeting_attended", "website_visit"];
  const deps = (legKeys: string[], offerSteps: Awaited<ReturnType<typeof import("../../src/lib/sales-funnel-offer-steps.js").fetchOfferSteps>>) => ({
    offerSteps: vi.fn(async () => offerSteps),
    salesFunnel: vi.fn(async () => funnelOf("Philanthropy", legKeys)),
    pipe: vi.fn(async (id: string) => {
      const [channelSlug, legKey] = id.split("|");
      return { ok: true as const, value: { id, name: null, channelSlug, legKey, mode: "proactive" as const } };
    }),
    catalogue: vi.fn(async () => catalogue),
    workflow: vi.fn(async () => ({ ok: true as const, workflowSlug: "aurora-v3" })),
  });

  it("refuses a funnel through a step the offer's business has not stated, naming it, and asks for nothing else", async () => {
    const d = deps(PURCHASE, { ok: true, stated: true, steps: DOC_DINNERS });
    const res = await resolveSalesFunnelPlan("f", identity, d);
    expect(res).toMatchObject({
      ok: false,
      refusal: { status: 409, code: "offer_lacks_steps", missingSteps: ["purchase"], offerSteps: DOC_DINNERS },
    });
    if (res.ok) return;
    expect(res.refusal.message).toContain("purchase");
    expect(res.refusal.message).toContain("Philanthropy");
    expect(d.offerSteps).toHaveBeenCalledWith("brand", "offer", identity);
    // Refused before any pipe's workflow is resolved.
    expect(d.workflow).not.toHaveBeenCalled();
  });

  it("launches a funnel whose every step is stated; Start, lead found and paid client always count as present", async () => {
    expect((await resolveSalesFunnelPlan("f", identity, deps(MEETING, { ok: true, stated: true, steps: DOC_DINNERS }))).ok).toBe(true);
    const sourced = ["lead_found_to_website_visit", "website_visit_to_meeting_booked", "meeting_booked_to_meeting_attended", "meeting_attended_to_paid_client"];
    expect((await resolveSalesFunnelPlan("f", identity, deps(sourced, { ok: true, stated: true, steps: ["website_visit", "meeting_booked", "meeting_attended"] }))).ok).toBe(true);
  });

  it("names every missing step once, in funnel order; a stated EMPTY list is a statement too", async () => {
    const res = await resolveSalesFunnelPlan("f", identity, deps(MEETING, { ok: true, stated: true, steps: [] }));
    expect(res).toMatchObject({ refusal: { code: "offer_lacks_steps", missingSteps: ["website_visit", "meeting_booked", "meeting_attended"], offerSteps: [] } });
  });

  it("leaves an offer that never stated its steps unchanged (nothing filtered)", async () => {
    expect((await resolveSalesFunnelPlan("f", identity, deps(PURCHASE, { ok: true, stated: false }))).ok).toBe(true);
  });

  it("fails LOUD when the steps cannot be read, and names an offer not on the brand apart", async () => {
    expect(await resolveSalesFunnelPlan("f", identity, deps(PURCHASE, { ok: false, notFound: false, detail: "HTTP 503" })))
      .toMatchObject({ ok: false, refusal: { status: 502, code: "offer_steps_unavailable" } });
    expect(await resolveSalesFunnelPlan("f", identity, deps(PURCHASE, { ok: false, notFound: true, detail: "HTTP 404" })))
      .toMatchObject({ ok: false, refusal: { status: 400, code: "offer_not_found" } });
  });

  it("refuses rather than guesses when a leg of the funnel is not in the catalogue (steps unknown)", async () => {
    const d = deps(["start_to_website_visit", "website_visit_to_mystery"], { ok: true, stated: true, steps: DOC_DINNERS });
    expect(await resolveSalesFunnelPlan("f", identity, d)).toMatchObject({ ok: false, refusal: { status: 502, code: "sales_funnel_steps_unknown" } });
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
