import { describe, it, expect, vi } from "vitest";
import { resolveStartablePair } from "../../src/lib/startable-pair.js";
import type { ChannelCatalogueRead } from "../../src/lib/channel-operator-client.js";
import type { FunnelBudgetsRead } from "../../src/lib/funnel-budget-client.js";

/**
 * CAN THE CUSTOMER START THE CAMPAIGN FOR A PAIR THEY FUND?
 *
 * The four things that must never happen here: a workflow chosen by the caller, a ceiling accepted
 * from the caller, a leg invented from the funnel, and a refusal a person cannot read.
 */

const CHANNEL = "sales-cold-email-outreach";
const FUNNEL = "sales_meetings_from_conversation";
const OTHER_FUNNEL = "website_purchases";
const ENTRY_LEG = "start_to_conversation";
const SECOND_LEG = "conversation_to_meeting_booked";
const OFFER = "11111111-1111-1111-1111-111111111111";
const BRAND = "22222222-2222-2222-2222-222222222222";

const IDENTITY = {
  orgId: "org_test",
  userId: "user_test",
  runId: "33333333-3333-3333-3333-333333333333",
  brandId: BRAND,
};

function catalogue(overrides: Partial<{
  operator: "platform" | "customer";
  channelLegs: string[];
  legs: Array<{ legKey: string; funnelKeys: string[] }>;
}> = {}): ChannelCatalogueRead {
  const channelLegs = overrides.channelLegs ?? [ENTRY_LEG, SECOND_LEG];
  const legs = overrides.legs ?? [
    { legKey: ENTRY_LEG, funnelKeys: [FUNNEL] },
    { legKey: SECOND_LEG, funnelKeys: [FUNNEL] },
  ];
  return {
    ok: true,
    operatorBySlug: new Map([[CHANNEL, overrides.operator ?? "platform"]]),
    legsBySlug: new Map([[CHANNEL, new Set(channelLegs)]]),
    legs: legs.map((l) => ({
      legKey: l.legKey,
      fromStepKey: null,
      funnelKeys: new Set(l.funnelKeys),
    })),
    stepKeys: new Set<string>(),
  };
}

function budgets(rows: Partial<Extract<FunnelBudgetsRead, { ok: true }>> = {}): FunnelBudgetsRead {
  return {
    ok: true,
    brandDailyBudgetCents: null,
    funnels: [],
    channels: [],
    offers: [],
    legs: [],
    ...rows,
  } as FunnelBudgetsRead;
}

function deps(over: {
  catalogue?: ChannelCatalogueRead;
  budgets?: FunnelBudgetsRead;
  workflow?: unknown;
} = {}) {
  return {
    catalogue: async () => over.catalogue ?? catalogue(),
    budgets: async () => over.budgets ?? budgets(),
    workflow: (over.workflow as any) ?? (async () => ({ ok: true as const, workflowSlug: "aurora" })),
  };
}

function start(input: Partial<Parameters<typeof resolveStartablePair>[0]> = {}, over = {}) {
  return resolveStartablePair(
    { brandId: BRAND, offerId: OFFER, funnelKey: FUNNEL, featureSlug: CHANNEL, ...input },
    IDENTITY,
    deps(over) as any,
  );
}

describe("resolveStartablePair", () => {
  it("refuses a sales funnel no catalogue names, in words a person can read", async () => {
    const result = await start({ funnelKey: "meetings_maybe" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe("unknown_funnel");
    expect(result.refusal.status).toBe(400);
    expect(result.refusal.message).toMatch(/don't recognise the sales funnel/);
  });

  it("refuses a channel whose ceiling this service does not pace", async () => {
    const result = await start({ featureSlug: "ai-visibility-scoring" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe("channel_not_paced_here");
  });

  it("says try again rather than no when the catalogue cannot be read", async () => {
    const result = await start({}, { catalogue: { ok: false, detail: "HTTP 503" } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe("catalogue_unavailable");
    expect(result.refusal.status).toBe(502);
    expect(result.refusal.message).toMatch(/try again/i);
  });

  it("refuses a channel the catalogue does not publish", async () => {
    const result = await start({ featureSlug: "sales-crm-email-outreach" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe("unknown_channel");
  });

  it("refuses a funnel this channel does not sell", async () => {
    const result = await start({ funnelKey: OTHER_FUNNEL });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe("channel_does_not_sell_funnel");
  });

  it("says try again rather than no when billing cannot be read", async () => {
    const result = await start({}, { budgets: { ok: false } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe("billing_unavailable");
    expect(result.refusal.status).toBe(502);
  });

  it("refuses a pair the customer funds nothing for", async () => {
    const result = await start({}, {
      budgets: budgets({
        funnels: [{ funnelKey: FUNNEL, dailyBudgetCents: 0 } as any],
        channels: [{ funnelKey: FUNNEL, featureSlug: CHANNEL, dailyBudgetCents: 0 } as any],
      }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe("not_funded");
    expect(result.refusal.status).toBe(409);
    expect(result.refusal.message).toMatch(/daily budget/);
  });

  it("states NO leg when the customer's money for the pair names none", async () => {
    // The pre-leg population: a leg is never fabricated for it, and the campaign paces on the
    // offer figure exactly as it always has.
    const result = await start({}, {
      budgets: budgets({
        funnels: [{ funnelKey: FUNNEL, dailyBudgetCents: 4000 } as any],
        channels: [{ funnelKey: FUNNEL, featureSlug: CHANNEL, dailyBudgetCents: 4000 } as any],
        offers: [{ funnelKey: FUNNEL, featureSlug: CHANNEL, offerId: OFFER, dailyBudgetCents: 4000 } as any],
      }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pair.legKey).toBeNull();
    expect(result.pair.ceilingCents).toBe(4000);
    expect(result.pair.workflowSlug).toBe("aurora");
  });

  it("takes the leg from the MONEY, and paces on that leg's own ceiling", async () => {
    const result = await start({}, {
      budgets: budgets({
        funnels: [{ funnelKey: FUNNEL, dailyBudgetCents: 4000 } as any],
        channels: [{ funnelKey: FUNNEL, featureSlug: CHANNEL, dailyBudgetCents: 4000 } as any],
        offers: [{ funnelKey: FUNNEL, featureSlug: CHANNEL, offerId: OFFER, dailyBudgetCents: 4000 } as any],
        legs: [
          { funnelKey: FUNNEL, featureSlug: CHANNEL, offerId: OFFER, legKey: ENTRY_LEG, dailyBudgetCents: 2500 } as any,
        ],
      }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pair.legKey).toBe(ENTRY_LEG);
    // NOT 4000: the offer figure is the SUM, and spending it would take a sibling leg's money.
    expect(result.pair.ceilingCents).toBe(2500);
  });

  it("refuses to guess when TWO legs of the pair are funded, and takes the caller's answer", async () => {
    const twoLegs = budgets({
      funnels: [{ funnelKey: FUNNEL, dailyBudgetCents: 4000 } as any],
      channels: [{ funnelKey: FUNNEL, featureSlug: CHANNEL, dailyBudgetCents: 4000 } as any],
      offers: [{ funnelKey: FUNNEL, featureSlug: CHANNEL, offerId: OFFER, dailyBudgetCents: 4000 } as any],
      legs: [
        { funnelKey: FUNNEL, featureSlug: CHANNEL, offerId: OFFER, legKey: ENTRY_LEG, dailyBudgetCents: 2500 } as any,
        { funnelKey: FUNNEL, featureSlug: CHANNEL, offerId: OFFER, legKey: SECOND_LEG, dailyBudgetCents: 1500 } as any,
      ],
    });

    const ambiguous = await start({}, { budgets: twoLegs });
    expect(ambiguous.ok).toBe(false);
    if (ambiguous.ok) return;
    expect(ambiguous.refusal.code).toBe("several_funded_legs");

    const answered = await start({ legKey: SECOND_LEG }, { budgets: twoLegs });
    expect(answered.ok).toBe(true);
    if (!answered.ok) return;
    expect(answered.pair.legKey).toBe(SECOND_LEG);
    expect(answered.pair.ceilingCents).toBe(1500);
  });

  it("refuses a stated leg the channel does not perform", async () => {
    const result = await start({ legKey: "meeting_booked_to_deal_closed" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe("leg_not_performed");
  });

  it("never falls back to the offer figure when the money IS leg-scoped and this leg is not funded", async () => {
    const result = await start({ legKey: SECOND_LEG }, {
      budgets: budgets({
        funnels: [{ funnelKey: FUNNEL, dailyBudgetCents: 2500 } as any],
        channels: [{ funnelKey: FUNNEL, featureSlug: CHANNEL, dailyBudgetCents: 2500 } as any],
        offers: [{ funnelKey: FUNNEL, featureSlug: CHANNEL, offerId: OFFER, dailyBudgetCents: 2500 } as any],
        legs: [
          { funnelKey: FUNNEL, featureSlug: CHANNEL, offerId: OFFER, legKey: ENTRY_LEG, dailyBudgetCents: 2500 } as any,
        ],
      }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe("not_funded");
  });

  const funded = () => budgets({
    funnels: [{ funnelKey: FUNNEL, dailyBudgetCents: 4000 } as any],
    channels: [{ funnelKey: FUNNEL, featureSlug: CHANNEL, dailyBudgetCents: 4000 } as any],
  });

  it("refuses a channel nothing can run yet, and says so as a different answer from an outage", async () => {
    const result = await start({}, {
      budgets: funded(),
      workflow: async () => ({ ok: true, workflowSlug: null }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe("no_workflow");
    expect(result.refusal.status).toBe(409);
  });

  it("says try again when workflow-service could not be read", async () => {
    const result = await start({}, {
      budgets: funded(),
      workflow: async () => ({ ok: false, detail: "HTTP 500" }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe("workflow_unavailable");
    expect(result.refusal.status).toBe(502);
  });

  it("gives a CUSTOMER-operated channel no workflow, and asks workflow-service nothing", async () => {
    const workflow = vi.fn(async () => ({ ok: true as const, workflowSlug: "aurora" }));
    const result = await start({}, {
      catalogue: catalogue({ operator: "customer" }),
      budgets: funded(),
      workflow,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pair.workflowSlug).toBeNull();
    expect(workflow).not.toHaveBeenCalled();
  });

  it("accepts a pre-rename funnel spelling and answers in the canonical one", async () => {
    const result = await start({ funnelKey: "reply_meeting" }, { budgets: funded() });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pair.funnelKey).toBe(FUNNEL);
  });
});
