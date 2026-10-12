import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";

const { mockExecute, mockPlan, mockFunnelMoney, mockSchedule, mockFile, mockCatalogue } = vi.hoisted(() => ({
  mockExecute: vi.fn(),
  mockPlan: vi.fn(),
  mockFunnelMoney: vi.fn(),
  mockSchedule: vi.fn(),
  mockFile: vi.fn(),
  mockCatalogue: vi.fn(),
}));

vi.mock("@distribute/runs-client", () => ({
  createRun: vi.fn(async () => ({ id: crypto.randomUUID() })),
  updateRun: vi.fn(),
  listRuns: vi.fn(async () => ({ runs: [] })),
  getStatsBudget: vi.fn(),
}));
vi.mock("../../src/lib/features-workflow-projection-client.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/lib/features-workflow-projection-client.js")>();
  return {
    ...original,
    resolveSelectionForTrigger: vi.fn(async (a: { fallbackSlug: string }) => ({ workflowSlug: a.fallbackSlug, audienceId: null })),
    fetchLegProjectionRows: vi.fn(async () => []),
  };
});
vi.mock("../../src/lib/brand-runtime-client.js", () => ({ fetchBrandRuntimeContext: vi.fn(async () => ({ brandProfile: null })) }));
vi.mock("../../src/lib/workflows.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/lib/workflows.js")>();
  return { ...original, executeCampaignWorkflow: mockExecute };
});
vi.mock("../../src/lib/startable-pair.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/lib/startable-pair.js")>();
  return { ...original, resolveSalesFunnelPlan: mockPlan };
});
vi.mock("../../src/lib/sales-funnel-campaigns.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/lib/sales-funnel-campaigns.js")>();
  return { ...original, salesFunnelUnitMoney: mockFunnelMoney };
});
vi.mock("../../src/lib/sales-funnel-people.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/lib/sales-funnel-people.js")>();
  return { ...original, scheduleNamedPersonDue: mockSchedule, fileNamedPerson: mockFile };
});
vi.mock("../../src/lib/channel-operator-client.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/lib/channel-operator-client.js")>();
  return { ...original, fetchChannelCatalogue: mockCatalogue };
});

import app from "../../src/index.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { salesFunnelCampaigns, triggerEvents } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import { detectGithubIssueTriggers } from "../../src/lib/github-issue-trigger-detector.js";
import { fireDueTriggerEvents } from "../../src/lib/trigger-events.js";
import type { GithubIssueReads } from "../../src/lib/github-issue-client.js";
import type { GithubIssueFacts } from "../../src/lib/github-issue-trigger.js";

const API_KEY = process.env.CAMPAIGN_SERVICE_API_KEY || "test-api-key";
const ORG = "b645207b-0000-4000-8000-0000000000c1";
const BRAND = "75d7e3e8-0000-4000-8000-0000000000c2";
const OFFER = "231bb036-0000-4000-8000-0000000000c3";
const CHANNEL = "ai-follow-up-email";
const LEG = "issue_in_prod_to_paid_client";
const FUNNEL = `${LEG}@${CHANNEL}`;
const TRIGGER = "github_issue_in_prod";
const MERGE = "a".repeat(40);
const OLD = "b".repeat(40);
const NEW = "c".repeat(40);

const catalogue = () => ({
  ok: true,
  operatorBySlug: new Map(),
  legsBySlug: new Map(),
  stepKeys: new Set(),
  legs: [],
  triggers: new Map([[TRIGGER, { id: TRIGGER, label: "GitHub Issue In Prod", fromStepKey: null, firedBy: "campaign-service", coded: true, kind: "github_issue_in_prod", origin: "code", params: null }]]),
  triggerTransitions: [{ featureSlug: CHANNEL, legKey: LEG, triggerId: TRIGGER }],
});

const plan = {
  ok: true,
  plan: {
    salesFunnelId: FUNNEL,
    salesFunnelName: "Follow-up when an issue ships",
    units: [{ pipeId: `${CHANNEL}|${LEG}`, featureSlug: CHANNEL, legKey: LEG, mode: "reactive", workflowSlug: "ai-follow-up-email-algenib" }],
  },
};

const launch = (body: Record<string, unknown>) =>
  request(app).post("/sales-funnel-campaigns")
    .set("x-api-key", API_KEY).set("x-org-id", ORG).set("x-user-id", "user_copilot").set("x-run-id", crypto.randomUUID())
    .send({ brandId: BRAND, offerId: OFFER, salesFunnelId: FUNNEL, status: "ongoing", people: [{ email: "staff@distribute.you" }], instruction: "Tell them the exact figure.", ...body });

const ISSUE = { repo: "Shamanic-Technologies/Chat-Service", number: 42 };

let facts: GithubIssueFacts;
let served: Array<{ target: string; sha: string }>;
const reads: GithubIssueReads = {
  facts: async () => facts,
  served: async () => served,
  contains: async (_r, merge, sha) => merge === MERGE && sha === NEW,
};
const open: GithubIssueFacts = { isPullRequest: false, state: "open", stateReason: null, defaultBranch: "main", closer: { type: "none" } };
const merged: GithubIssueFacts = {
  isPullRequest: false, state: "closed", stateReason: "completed", defaultBranch: "main",
  closer: { type: "pull_request", number: 9, merged: true, baseRef: "main", mergeSha: MERGE },
};

describe("github_issue_in_prod: a funnel campaign waiting on a GitHub issue", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    await cleanTestData();
    mockPlan.mockResolvedValue(plan);
    mockCatalogue.mockResolvedValue(catalogue());
    mockExecute.mockResolvedValue(undefined);
    mockFunnelMoney.mockResolvedValue({ run: true });
    mockSchedule.mockResolvedValue({ ok: true });
    mockFile.mockImplementation(async ({ email }: { email: string }) => ({ ok: true, leadId: `lead-${email}`, filed: true }));
    facts = open;
    served = [{ target: "chat-service", sha: OLD }];
  });
  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("is born waiting on the canonical issue; the same issue again is handed back, another issue is another campaign", async () => {
    const res = await launch({ githubIssue: ISSUE }).expect(201);
    expect(res.body.salesFunnelCampaign.githubIssue).toEqual({ repo: "shamanic-technologies/chat-service", number: 42 });
    expect(res.body.salesFunnelCampaign.githubIssueCheck).toBeNull();
    const again = await launch({ githubIssue: { repo: "shamanic-technologies/chat-service", number: 42 } }).expect(200);
    expect(again.body.salesFunnelCampaign.id).toBe(res.body.salesFunnelCampaign.id);
    const other = await launch({ githubIssue: { ...ISSUE, number: 43 } }).expect(201);
    expect(other.body.salesFunnelCampaign.id).not.toBe(res.body.salesFunnelCampaign.id);
  });

  it("refuses an issue on a funnel no github_issue_in_prod trigger fires, writing nothing", async () => {
    mockCatalogue.mockResolvedValue({ ...catalogue(), triggerTransitions: [] });
    const res = await launch({ githubIssue: ISSUE }).expect(400);
    expect(res.body.reason).toBe("github_issue_needs_github_trigger");
    expect(await db.select().from(salesFunnelCampaigns).where(eq(salesFunnelCampaigns.orgId, ORG))).toHaveLength(0);
  });

  it("open: nothing; merged not deployed: nothing; deployed: exactly one dispatch, never again", async () => {
    const res = await launch({ githubIssue: ISSUE }).expect(201);
    const id = res.body.salesFunnelCampaign.id;
    const unit = res.body.salesFunnelCampaign.units[0].campaignId;

    let s = await detectGithubIssueTriggers(catalogue() as never, new Date(), reads);
    expect(s).toMatchObject({ triggers: 1, waiting: 1, checked: 1, fired: 0, failed: 0 });
    expect(mockExecute).not.toHaveBeenCalled();
    let [row] = await db.select().from(salesFunnelCampaigns).where(eq(salesFunnelCampaigns.id, id));
    expect((row.githubIssueCheck as { state: string }).state).toBe("open");

    facts = merged;
    s = await detectGithubIssueTriggers(catalogue() as never, new Date(), reads);
    expect(s.fired).toBe(0);
    expect(mockExecute).not.toHaveBeenCalled();
    [row] = await db.select().from(salesFunnelCampaigns).where(eq(salesFunnelCampaigns.id, id));
    expect((row.githubIssueCheck as { state: string }).state).toBe("merged_not_deployed");
    expect(await db.select().from(triggerEvents).where(eq(triggerEvents.orgId, ORG))).toHaveLength(0);

    served = [{ target: "chat-service", sha: NEW }];
    s = await detectGithubIssueTriggers(catalogue() as never, new Date(), reads);
    expect(s).toMatchObject({ fired: 1, failed: 0 });
    expect(mockSchedule).toHaveBeenCalledWith(expect.objectContaining({ campaignId: unit, email: "staff@distribute.you" }));
    expect(mockExecute).toHaveBeenCalledTimes(1);
    const inputs = mockExecute.mock.calls[0][1] as { campaignId: string; trigger: { item: { githubIssue: string } } };
    expect(inputs.campaignId).toBe(unit);
    expect(inputs.trigger.item.githubIssue).toBe("shamanic-technologies/chat-service#42");
    const events = await db.select().from(triggerEvents).where(eq(triggerEvents.orgId, ORG));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ triggerId: TRIGGER, outcome: "ran", ranCampaignIds: [unit] });

    s = await detectGithubIssueTriggers(catalogue() as never, new Date(), reads);
    expect(s).toMatchObject({ waiting: 0, checked: 0, fired: 0 });
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  it("an issue in prod runs only the campaign waiting on IT, never another campaign on the same pipe", async () => {
    const mine = await launch({ githubIssue: ISSUE }).expect(201);
    const other = await launch({ githubIssue: { ...ISSUE, number: 99 }, people: [{ email: "other@distribute.you" }] }).expect(201);
    facts = merged;
    served = [{ target: "chat-service", sha: NEW }];
    const factsByIssue: GithubIssueReads = { ...reads, facts: async (ref) => (ref.number === 42 ? merged : open) };
    await detectGithubIssueTriggers(catalogue() as never, new Date(), factsByIssue);
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect((mockExecute.mock.calls[0][1] as { campaignId: string }).campaignId).toBe(mine.body.salesFunnelCampaign.units[0].campaignId);
    expect(mockSchedule).not.toHaveBeenCalledWith(expect.objectContaining({ campaignId: other.body.salesFunnelCampaign.units[0].campaignId }));
  });

  it("a cancelled (stopped) campaign is not checked; an unreadable source is counted failed, nothing fired", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await launch({ githubIssue: ISSUE }).expect(201);
    const failing: GithubIssueReads = { ...reads, facts: async () => { throw new Error("GitHub 401"); } };
    const s = await detectGithubIssueTriggers(catalogue() as never, new Date(), failing);
    expect(s).toMatchObject({ checked: 1, failed: 1, fired: 0 });
    const [row] = await db.select().from(salesFunnelCampaigns).where(eq(salesFunnelCampaigns.id, res.body.salesFunnelCampaign.id));
    expect(row.githubIssueCheck).toMatchObject({ state: "github_unreadable" });

    await request(app).patch(`/sales-funnel-campaigns/${res.body.salesFunnelCampaign.id}`)
      .set("x-api-key", API_KEY).set("x-org-id", ORG).send({ status: "stop" }).expect(200);
    const after = await detectGithubIssueTriggers(catalogue() as never, new Date(), failing);
    expect(after).toMatchObject({ waiting: 0, checked: 0 });
  });

  it("a fire that throws is retried by the due-event tick with the same issue and campaign", async () => {
    const res = await launch({ githubIssue: ISSUE }).expect(201);
    const unit = res.body.salesFunnelCampaign.units[0].campaignId;
    facts = merged;
    served = [{ target: "chat-service", sha: NEW }];
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockSchedule.mockRejectedValueOnce(new Error("boom"));
    await detectGithubIssueTriggers(catalogue() as never, new Date(), reads);
    const [pending] = await db.select().from(triggerEvents).where(eq(triggerEvents.orgId, ORG));
    expect(pending.status).toBe("pending");
    await fireDueTriggerEvents(new Date(Date.now() + 11 * 60_000));
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect((mockExecute.mock.calls[0][1] as { campaignId: string; trigger: { item: { githubIssue: string } } }).trigger.item.githubIssue)
      .toBe("shamanic-technologies/chat-service#42");
    expect((mockExecute.mock.calls[0][1] as { campaignId: string }).campaignId).toBe(unit);
  });
});
