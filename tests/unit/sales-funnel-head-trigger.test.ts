import { describe, it, expect, vi, afterEach } from "vitest";
import { doorRefusal, runsOnTrigger, unitRunsOnTrigger } from "../../src/lib/sales-funnel-head-trigger.js";
import { answersOnDemand } from "../../src/lib/on-demand-mode.js";
import { resolveSalesFunnelPlan } from "../../src/lib/startable-pair.js";
import { fetchSalesFunnel } from "../../src/lib/sales-funnel-catalogue-client.js";
import type { ChannelCatalogueRead } from "../../src/lib/channel-operator-client.js";

/**
 * FUNNEL-HEAD-TRIGGER-1015 (owner 2026-10-15): a funnel features-service HEADS with a trigger runs its head unit and
 * its proactive pipes on that trigger only; a legacy reactive funnel (its first pipe already answers the trigger) is
 * untouched; the door refuses a trigger served `callable: false`.
 */

const COLD = "sales-cold-email-outreach";
const LEAD_LEG = "lead_found_to_conversation";
const REPLY_LEG = "conversation_to_meeting_booked";
const LEAD = "lead_found";
const REPLY = "positive_reply_received";

const catalogue = {
  ok: true,
  operatorBySlug: new Map(),
  legsBySlug: new Map([[COLD, new Set([LEAD_LEG])], ["ai-meeting-booking", new Set([REPLY_LEG])]]),
  legs: [],
  stepKeys: new Set(),
  triggerTransitions: [{ featureSlug: "ai-meeting-booking", legKey: REPLY_LEG, triggerId: REPLY }],
} as unknown as Extract<ChannelCatalogueRead, { ok: true }>;

const coldPipe = { pipeId: `${COLD}|${LEAD_LEG}`, featureSlug: COLD, legKey: LEAD_LEG, mode: "proactive" as const };
const replyPipe = { pipeId: `ai-meeting-booking|${REPLY_LEG}`, featureSlug: "ai-meeting-booking", legKey: REPLY_LEG, mode: "reactive" as const };

describe("which unit runs on its funnel's trigger (unitRunsOnTrigger)", () => {
  it("⚡ Lead -> cold email: the proactive head unit runs on lead_found", () => {
    expect(unitRunsOnTrigger({ triggerId: LEAD, headPipeId: coldPipe.pipeId }, coldPipe, catalogue)).toBe(LEAD);
  });

  it("a later REACTIVE pipe keeps its own trigger (a positive reply runs AI Meeting Booking, never ⚡ Lead)", () => {
    expect(unitRunsOnTrigger({ triggerId: LEAD, headPipeId: coldPipe.pipeId }, replyPipe, catalogue)).toBeNull();
  });

  it("a later PROACTIVE pipe of a trigger-headed funnel runs on the trigger too (never on its own budget)", () => {
    const later = { ...coldPipe, pipeId: "linkedin|conversation_to_x", featureSlug: "linkedin", legKey: "conversation_to_x" };
    expect(unitRunsOnTrigger({ triggerId: LEAD, headPipeId: coldPipe.pipeId }, later, catalogue)).toBe(LEAD);
  });

  it("a legacy reactive funnel (Positive reply -> AI meeting booking): its head pipe already answers it, nothing stored", () => {
    expect(unitRunsOnTrigger({ triggerId: REPLY, headPipeId: replyPipe.pipeId }, replyPipe, catalogue)).toBeNull();
  });

  it("a proactive funnel (no trigger served) is unchanged", () => {
    expect(unitRunsOnTrigger({ triggerId: null, headPipeId: coldPipe.pipeId }, coldPipe, catalogue)).toBeNull();
  });

  it("runsOnTrigger matches the stored trigger only", () => {
    expect(runsOnTrigger({ runsOnTriggerId: LEAD }, LEAD)).toBe(true);
    expect(runsOnTrigger({ runsOnTriggerId: LEAD }, REPLY)).toBe(false);
    expect(runsOnTrigger({ runsOnTriggerId: null }, LEAD)).toBe(false);
    expect(runsOnTrigger({ runsOnTriggerId: LEAD }, null)).toBe(false);
  });
});

describe("a unit running on a trigger is never dispatched on its own (answersOnDemand)", () => {
  it("parked whatever the catalogue answers; an ordinary unit is unchanged", () => {
    const unit = { featureSlug: COLD, legKey: LEAD_LEG, salesFunnelCampaignId: "sfc", runsOnTriggerId: LEAD };
    expect(answersOnDemand(unit, catalogue)).toBe(true);
    expect(answersOnDemand(unit, { ok: false, detail: "HTTP 503" })).toBe(true);
    expect(answersOnDemand({ ...unit, runsOnTriggerId: null }, catalogue)).toBe(false);
    expect(answersOnDemand({ ...unit, runsOnTriggerId: null }, { ok: false, detail: "HTTP 503" })).toBe(false);
  });
});

describe("the public door (doorRefusal)", () => {
  it("refuses a trigger served callable: false, naming it", () => {
    const refused = doorRefusal({ id: "signup_not_paid_24_hours", label: "Signup Not Paid In 24 Hours", callable: false });
    expect(refused).toContain("signup_not_paid_24_hours");
    expect(refused).toContain("cannot be reported through the API");
  });

  it("accepts a callable trigger, and one with no callable served yet", () => {
    expect(doorRefusal({ id: "follow_up_due", label: "Follow-up Due", callable: true })).toBeNull();
    expect(doorRefusal({ id: "lead_requested", label: "Lead requested", callable: null })).toBeNull();
    expect(doorRefusal({ id: "lead_requested", label: "Lead requested" })).toBeNull();
  });
});

describe("resolveSalesFunnelPlan stamps the trigger on the units of a trigger-headed funnel", () => {
  const identity = { orgId: "org", userId: "user", runId: "run", brandId: "brand", offerId: "offer" };
  const pipes: Record<string, { channelSlug: string; legKey: string; mode: "proactive" | "reactive" }> = {
    [coldPipe.pipeId]: { channelSlug: COLD, legKey: LEAD_LEG, mode: "proactive" },
    [replyPipe.pipeId]: { channelSlug: "ai-meeting-booking", legKey: REPLY_LEG, mode: "reactive" },
  };
  const deps = (pipeIds: string[], triggerId: string | null) => ({
    offerSteps: vi.fn(async () => ({ ok: true as const, stated: false as const })),
    salesFunnel: vi.fn(async () => ({
      ok: true as const,
      value: {
        id: "f",
        name: "Radiance",
        triggerId,
        pipeIds,
        legs: pipeIds.map((id) => ({ legKey: pipes[id].legKey, pipe: { id, mode: pipes[id].mode }, channelIds: [pipes[id].channelSlug] })),
      },
    })),
    pipe: vi.fn(async (id: string) => ({ ok: true as const, value: { id, name: "Wren", ...pipes[id] } })),
    catalogue: vi.fn(async () => catalogue as ChannelCatalogueRead),
    workflow: vi.fn(async () => ({ ok: true as const, workflowSlug: "aurora-v3" })),
  });

  it("⚡ Lead -> cold email -> AI meeting booking: cold email on lead_found, AI meeting booking on its own trigger", async () => {
    const res = await resolveSalesFunnelPlan("trigger:lead_found+x", identity, deps([coldPipe.pipeId, replyPipe.pipeId], LEAD));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.plan.units.map((u) => [u.featureSlug, u.runsOnTriggerId])).toEqual([
      [COLD, LEAD],
      ["ai-meeting-booking", null],
    ]);
  });

  it("a proactive funnel and a legacy reactive funnel stamp nothing", async () => {
    const proactive = await resolveSalesFunnelPlan("f", identity, deps([coldPipe.pipeId, replyPipe.pipeId], null));
    const reactive = await resolveSalesFunnelPlan("f", identity, deps([replyPipe.pipeId], REPLY));
    expect(proactive.ok && proactive.plan.units.every((u) => u.runsOnTriggerId === null)).toBe(true);
    expect(reactive.ok && reactive.plan.units.every((u) => u.runsOnTriggerId === null)).toBe(true);
  });
});

describe("fetchSalesFunnel reads the served trigger", () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
    vi.unstubAllGlobals();
  });

  const serve = (body: unknown) => {
    process.env.FEATURES_SERVICE_URL = "https://features.test";
    process.env.FEATURES_SERVICE_API_KEY = "k";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));
  };
  const legs = [{ legKey: LEAD_LEG, pipe: { id: coldPipe.pipeId, mode: "proactive" }, channels: [{ id: COLD }] }];

  it("trigger {slug, name} = the trigger id; null and absent read as no trigger", async () => {
    serve({ id: "trigger:lead_found+x", name: "Radiance", trigger: { slug: LEAD, name: "Lead" }, legs });
    expect(await fetchSalesFunnel("trigger:lead_found+x")).toMatchObject({ ok: true, value: { triggerId: LEAD } });
    serve({ id: "f", name: "Radiance", trigger: null, legs });
    expect(await fetchSalesFunnel("f")).toMatchObject({ ok: true, value: { triggerId: null } });
    serve({ id: "f", name: "Radiance", legs });
    expect(await fetchSalesFunnel("f")).toMatchObject({ ok: true, value: { triggerId: null } });
  });
});
