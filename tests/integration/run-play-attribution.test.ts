import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { runPlayAttributions } from "../../src/db/schema.js";
import { cleanTestData, closeDb, insertTestCampaign } from "../helpers/test-db.js";
import {
  clearPlayCatalogueCache,
  recordRunPlay,
  resolveUnitPlay,
  type PlayCatalogueDeps,
} from "../../src/lib/run-play-attribution.js";
import { openOnDemandRun } from "../../src/lib/on-demand-runs.js";

// STRATEGY-ATTRIBUTION-1018: every run keeps the play (pipe x lead strategy) it went out under, written once.

const FUNNEL =
  "start_to_lead_found@lead-sourcing~valid-catch-all-unknown+lead_found_to_conversation@sales-cold-email-outreach+conversation_to_paid_client";
const SOURCE_PLAY = "lead-sourcing|start_to_lead_found~valid-catch-all-unknown";
const OUTREACH_PLAY = "sales-cold-email-outreach|lead_found_to_conversation";
const TEAM_PLAY = "your-team-reply-closing|conversation_to_paid_client";

/** features-service's answers, as prod served them on 2026-10-18 for this funnel. */
function catalogue(opts: { outreachStrategy?: { id: string; name: string; default: boolean } } = {}): PlayCatalogueDeps {
  const outreach = opts.outreachStrategy ?? { id: "valid-only", name: "Valid only", default: true };
  const pipes: Record<string, unknown> = {
    [SOURCE_PLAY]: {
      id: SOURCE_PLAY, name: "Lead Sourcing", channelSlug: "lead-sourcing", legKey: "start_to_lead_found", mode: "proactive",
      play: {
        pipeId: "lead-sourcing|start_to_lead_found", strategyId: "valid-catch-all-unknown", strategyName: "Valid + Catch-all + Unknown",
        default: false, allowedActiveWorkflowCount: 1, excludedWorkflowDynastySlugs: ["lead-sourcing-mebsuta"],
      },
    },
    [OUTREACH_PLAY]: {
      id: OUTREACH_PLAY, name: "Sales Cold Email Outreach", channelSlug: "sales-cold-email-outreach", legKey: "lead_found_to_conversation", mode: "proactive",
      play: {
        pipeId: OUTREACH_PLAY, strategyId: outreach.id, strategyName: outreach.name, default: outreach.default,
        allowedActiveWorkflowCount: 21, excludedWorkflowDynastySlugs: ["sales-cold-email-outreach-alcor"],
      },
    },
    [TEAM_PLAY]: { id: TEAM_PLAY, name: "Your team", channelSlug: "your-team-reply-closing", legKey: "conversation_to_paid_client", mode: "reactive", play: null },
  };
  return {
    salesFunnel: vi.fn(async (id: string) =>
      id === FUNNEL
        ? { ok: true as const, value: { id, name: "Funnel", pipeIds: [SOURCE_PLAY, OUTREACH_PLAY, TEAM_PLAY], legs: [], triggerId: null } }
        : { ok: false as const, notFound: true as const, detail: "features-service 404" }),
    pipe: vi.fn(async (id: string) =>
      pipes[id] ? { ok: true as const, value: pipes[id] as never } : { ok: false as const, notFound: true as const, detail: "404" }),
  };
}

const unit = (featureSlug: string, legKey: string, salesFunnelId: string | null = FUNNEL) => ({
  id: crypto.randomUUID(),
  salesFunnelId,
  salesFunnelCampaignId: "sfc-1",
  featureSlug,
  legKey,
});

describe("resolveUnitPlay", () => {
  beforeEach(() => clearPlayCatalogueCache());

  it("states the DEFAULT play with its strategy (no null-means-default)", async () => {
    const play = await resolveUnitPlay(unit("sales-cold-email-outreach", "lead_found_to_conversation"), catalogue());
    expect(play).toMatchObject({
      state: "resolved", playId: OUTREACH_PLAY, pipeId: OUTREACH_PLAY,
      strategyId: "valid-only", strategyName: "Valid only", isDefault: true,
    });
  });

  it("states a NON-default play: the play id names the strategy, the base pipe is kept", async () => {
    const play = await resolveUnitPlay(unit("lead-sourcing", "start_to_lead_found"), catalogue());
    expect(play).toMatchObject({
      state: "resolved", playId: SOURCE_PLAY, pipeId: "lead-sourcing|start_to_lead_found",
      strategyId: "valid-catch-all-unknown", isDefault: false, excludedWorkflowDynastySlugs: ["lead-sourcing-mebsuta"],
    });
  });

  it("matches the legacy outbound leg spelling", async () => {
    const play = await resolveUnitPlay(unit("sales-cold-email-outreach", "start_to_conversation"), catalogue());
    expect(play.strategyId).toBe("valid-only");
  });

  it("names a pipe cataloguing no strategy, a non-unit and an unreadable catalogue apart", async () => {
    expect((await resolveUnitPlay(unit("your-team-reply-closing", "conversation_to_paid_client"), catalogue())).state).toBe("no_play");
    expect((await resolveUnitPlay(unit("sales-cold-email-outreach", "lead_found_to_conversation", null), catalogue())).state)
      .toBe("not_a_sales_funnel_unit");
    const unreadable = await resolveUnitPlay(unit("sales-cold-email-outreach", "lead_found_to_conversation", "gone"), catalogue());
    expect(unreadable).toMatchObject({ state: "unreadable", strategyId: null });
    expect(unreadable.detail).toContain("gone");
  });
});

describe("playRationKeys (RATION-PER-PLAY-1029)", () => {
  beforeEach(() => clearPlayCatalogueCache());
  it("keys each unit on its play (a non-default strategy apart from the default); an unreadable one gets no key", async () => {
    const { playRationKeys } = await vi.importActual<typeof import("../../src/lib/run-play-attribution.js")>("../../src/lib/run-play-attribution.js");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const source = unit("lead-sourcing", "start_to_lead_found");
    const outreach = unit("sales-cold-email-outreach", "lead_found_to_conversation");
    const gone = unit("sales-cold-email-outreach", "lead_found_to_conversation", "gone");
    const keys = await playRationKeys([source, outreach, gone], catalogue());
    expect(keys.get(source.id)).toBe(`play:${SOURCE_PLAY}`);
    expect(keys.get(outreach.id)).toBe(`play:${OUTREACH_PLAY}`);
    expect(keys.has(gone.id)).toBe(false);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("rationed on its pipe"));
    errors.mockRestore();
  });
});

describe("recordRunPlay", () => {
  beforeEach(async () => {
    clearPlayCatalogueCache();
    await cleanTestData();
  });
  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("keeps the play a run went out under: editing the play afterwards never rewrites it", async () => {
    const outreach = unit("sales-cold-email-outreach", "lead_found_to_conversation");
    await recordRunPlay(
      { runId: "run-1", runKind: "execution", dispatchedBy: "scheduler", campaign: outreach, workflowSlug: "wf-a", audienceId: "aud-1" },
      catalogue(),
    );
    // The owner switches the pipe's default strategy; the same run reported again changes nothing.
    clearPlayCatalogueCache();
    const edited = catalogue({ outreachStrategy: { id: "valid-catch-all", name: "Valid + Catch-all", default: true } });
    await recordRunPlay(
      { runId: "run-1", runKind: "execution", dispatchedBy: "scheduler", campaign: outreach, workflowSlug: "wf-a", audienceId: "aud-1" },
      edited,
    );
    await recordRunPlay(
      { runId: "run-2", runKind: "execution", dispatchedBy: "step_trigger", campaign: outreach, workflowSlug: "wf-a", audienceId: null },
      edited,
    );

    const rows = await db.select().from(runPlayAttributions).orderBy(runPlayAttributions.runId);
    expect(rows.map((r) => [r.runId, r.strategyId, r.playIsDefault])).toEqual([
      ["run-1", "valid-only", true],
      ["run-2", "valid-catch-all", true],
    ]);
  });

  it("joins a serve to the strategy that found the lead AND the one that wrote to it, by run id", async () => {
    const source = unit("lead-sourcing", "start_to_lead_found");
    const outreach = unit("sales-cold-email-outreach", "lead_found_to_conversation");
    const deps = catalogue();
    await recordRunPlay({ runId: "outreach-run", runKind: "execution", dispatchedBy: "scheduler", campaign: outreach, workflowSlug: "wf", audienceId: null }, deps);
    await recordRunPlay(
      { runId: "source-run", runKind: "on_demand", dispatchedBy: "on_demand", callerRunId: "outreach-run", campaign: source, workflowSlug: "ls", audienceId: null },
      deps,
    );

    // What a read-only extract does: lead-service files the serve under the source's run (`parent_run_id`).
    const joined = await db.execute(sql`
      WITH serve(parent_run_id) AS (VALUES ('source-run'))
      SELECT found.strategy_id AS found_by, found.play_is_default AS found_default,
             wrote.strategy_id AS written_by, wrote.play_is_default AS written_default
      FROM serve
      JOIN run_play_attributions found ON found.run_id = serve.parent_run_id
      JOIN run_play_attributions wrote ON wrote.run_id = found.caller_run_id`);
    expect((joined as unknown as Array<Record<string, unknown>>)[0]).toEqual({
      found_by: "valid-catch-all-unknown", found_default: false,
      written_by: "valid-only", written_default: true,
    });
  });

  it("records an unreadable play out loud, never throws", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const play = await recordRunPlay(
      { runId: "run-x", runKind: "execution", dispatchedBy: "person_start", campaign: unit("sales-cold-email-outreach", "lead_found_to_conversation", "gone"), workflowSlug: null, audienceId: null },
      catalogue(),
    );
    expect(play?.state).toBe("unreadable");
    const [row] = await db.select().from(runPlayAttributions).where(eq(runPlayAttributions.runId, "run-x"));
    expect(row.playState).toBe("unreadable");
    expect(row.detail).toContain("gone");
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("an on-demand source run is attributed with the outreach run that asked", async () => {
    const orgId = crypto.randomUUID();
    const campaign = await insertTestCampaign(orgId, {
      featureSlug: "lead-sourcing",
      status: "ongoing",
      brandIds: [crypto.randomUUID()],
      workflowSlug: "lead-sourcing-alpha",
    });
    const attribute = vi.fn();
    const run = await openOnDemandRun(
      { orgId, userId: crypto.randomUUID(), callerRunId: "outreach-run", campaignId: campaign.id },
      { createRun: vi.fn().mockResolvedValue({ id: "od-run" }) as never, attribute },
    );
    expect(run.runId).toBe("od-run");
    expect(attribute).toHaveBeenCalledWith(expect.objectContaining({
      runId: "od-run", runKind: "on_demand", dispatchedBy: "on_demand", callerRunId: "outreach-run",
      workflowSlug: "lead-sourcing-alpha",
    }));
  });
});
