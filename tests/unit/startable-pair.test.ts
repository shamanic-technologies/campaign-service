import { describe, it, expect, vi } from "vitest";
import { resolveStartablePair } from "../../src/lib/startable-pair.js";
import type { ChannelCatalogueRead } from "../../src/lib/channel-operator-client.js";
import type { CampaignBudgetEntry, CampaignBudgetsRead } from "../../src/lib/campaign-budget-client.js";

/**
 * CAN THE CUSTOMER START THE CAMPAIGN FOR AN (OFFER, LEG, CHANNEL) THEY FUND?
 *
 * The things that must never happen here: a workflow chosen by the caller, a ceiling accepted from
 * the caller, a leg invented, and a refusal a person cannot read.
 */

const CHANNEL = "sales-cold-email-outreach";
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
}> = {}): ChannelCatalogueRead {
  const channelLegs = overrides.channelLegs ?? [ENTRY_LEG, SECOND_LEG];
  return {
    ok: true,
    operatorBySlug: new Map([[CHANNEL, overrides.operator ?? "platform"]]),
    legsBySlug: new Map([[CHANNEL, new Set(channelLegs)]]),
    legs: channelLegs.map((legKey) => ({ legKey, fromStepKey: null, toStepKey: null })),
    stepKeys: new Set<string>(),
  };
}

function budgets(
  campaigns: CampaignBudgetEntry[] = [],
  brandDailyBudgetCents: number | null = null,
): CampaignBudgetsRead {
  return { ok: true, brandDailyBudgetCents, campaigns };
}

const FUNDED: CampaignBudgetEntry = { offerId: OFFER, legKey: ENTRY_LEG, featureSlug: CHANNEL, dailyBudgetCents: 1500 };

function deps(over: {
  catalogue?: ChannelCatalogueRead;
  budgets?: CampaignBudgetsRead;
  workflow?: unknown;
} = {}) {
  return {
    catalogue: async () => over.catalogue ?? catalogue(),
    budgets: async () => over.budgets ?? budgets([FUNDED]),
    workflow: (over.workflow as any) ?? (async () => ({ ok: true as const, workflowSlug: "aurora" })),
  };
}

function start(input: Partial<Parameters<typeof resolveStartablePair>[0]> = {}, over = {}) {
  return resolveStartablePair(
    { brandId: BRAND, offerId: OFFER, legKey: ENTRY_LEG, featureSlug: CHANNEL, ...input },
    IDENTITY,
    deps(over) as any,
  );
}

describe("resolveStartablePair", () => {
  it("resolves a funded (offer, leg, channel) to its ceiling and the channel's workflow", async () => {
    const read = await start();
    expect(read).toEqual({
      ok: true,
      pair: { legKey: ENTRY_LEG, ceilingCents: 1500, workflowSlug: "aurora" },
    });
  });

  it("refuses a start that states no leg or no offer, in words a person can read", async () => {
    for (const input of [{ legKey: null }, { offerId: null }]) {
      const read = await start(input);
      expect(read.ok).toBe(false);
      if (!read.ok) {
        expect(read.refusal).toMatchObject({ status: 400, code: "leg_required" });
        expect(read.refusal.message).not.toMatch(/funnel/i);
      }
    }
  });

  it("refuses a channel outside the sales family — its money is not paced here", async () => {
    const read = await start({ featureSlug: "pr-cold-email-outreach" });
    expect(read.ok || read.refusal.code).toBe("channel_not_paced_here");
  });

  it("refuses a channel the catalogue does not publish", async () => {
    const read = await start({ featureSlug: "google-ads" });
    expect(read.ok || read.refusal.code).toBe("unknown_channel");
  });

  it("refuses a leg the channel does not perform rather than stamping it", async () => {
    const read = await start({}, { catalogue: catalogue({ channelLegs: [SECOND_LEG] }) });
    expect(read.ok || read.refusal.code).toBe("leg_not_performed");
  });

  it("refuses an unfunded campaign with a 409", async () => {
    const read = await start({}, { budgets: budgets([{ ...FUNDED, legKey: SECOND_LEG }]) });
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.refusal).toMatchObject({ status: 409, code: "not_funded" });
  });

  it("an unreadable catalogue is a 502, never a refusal about the channel", async () => {
    const read = await start({}, { catalogue: { ok: false, detail: "HTTP 503" } });
    expect(read.ok || read.refusal).toMatchObject({ status: 502, code: "catalogue_unavailable" });
  });

  it("an unreadable billing is a 502, never `not funded`", async () => {
    const read = await start({}, { budgets: { ok: false } });
    expect(read.ok || read.refusal).toMatchObject({ status: 502, code: "billing_unavailable" });
  });

  it("a channel the CUSTOMER operates starts with NO workflow, and workflow-service is never asked", async () => {
    const workflow = vi.fn();
    const read = await start({}, { catalogue: catalogue({ operator: "customer" }), workflow });
    expect(read).toEqual({ ok: true, pair: { legKey: ENTRY_LEG, ceilingCents: 1500, workflowSlug: null } });
    expect(workflow).not.toHaveBeenCalled();
  });

  it("a platform channel with no active workflow is refused — nothing could run it", async () => {
    const read = await start({}, { workflow: async () => ({ ok: true, workflowSlug: null }) });
    expect(read.ok || read.refusal).toMatchObject({ status: 409, code: "no_workflow" });
  });

  it("an unreadable workflow statement is a 502", async () => {
    const read = await start({}, { workflow: async () => ({ ok: false, detail: "HTTP 500" }) });
    expect(read.ok || read.refusal).toMatchObject({ status: 502, code: "workflow_unavailable" });
  });
});
