import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import request from "supertest";

const { mockListRuns, mockUpdateRun } = vi.hoisted(() => ({
  mockListRuns: vi.fn(),
  mockUpdateRun: vi.fn(),
}));

vi.mock("@distribute/runs-client", () => ({
  createRun: vi.fn().mockResolvedValue({ id: "run-x" }),
  updateRun: mockUpdateRun,
  listRuns: mockListRuns,
  getStatsBudget: vi.fn(),
}));

import app from "../../src/index.js";
import { db } from "../../src/db/index.js";
import { campaigns } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import {
  CAMPAIGN_FAILING_EVENT,
  FAILING_ALERT_THRESHOLD,
  FAILURE_RETRY_BASE_MS,
  FAILURE_RETRY_CEILING_MS,
  FAILURE_STREAK_STALE_MS,
  notifyFailingCampaign,
  recordRunFailure,
  recordRunSuccess,
} from "../../src/lib/run-failure-backoff.js";
import { cleanTestData, closeDb, insertTestCampaign } from "../helpers/test-db.js";

const API_KEY = process.env.CAMPAIGN_SERVICE_API_KEY || "test-api-key";
const ORG = "org_backoff_test";
const BRAND = crypto.randomUUID();

function headers(campaignId: string) {
  return {
    "x-api-key": API_KEY,
    "x-org-id": ORG,
    "x-campaign-id": campaignId,
    "x-user-id": "user_test",
    "x-run-id": crypto.randomUUID(),
    "x-workflow-slug": "sales-email-cold-outreach",
    "x-feature-slug": "sales-cold-email-outreach",
  };
}

async function row(id: string) {
  return (await db.query.campaigns.findFirst({ where: eq(campaigns.id, id) }))!;
}

/** The staff alerts sent to transactional-email-service, by campaign. */
function staffAlerts(fetchSpy: ReturnType<typeof vi.spyOn>) {
  return fetchSpy.mock.calls.filter(([url]) => String(url).endsWith("/platform-send"));
}

describe("run-failure backoff", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    await cleanTestData();
    vi.clearAllMocks();
    mockListRuns.mockResolvedValue({ runs: [] });
    mockUpdateRun.mockResolvedValue({});
    process.env.TRANSACTIONAL_EMAIL_SERVICE_URL = "https://transactional-email.test.local";
    process.env.TRANSACTIONAL_EMAIL_SERVICE_API_KEY = "tes-key";
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify({ results: [{ sent: true }] }), { status: 200 }),
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("N consecutive failures widen the interval up to the ceiling", async () => {
    const c = await insertTestCampaign(ORG, { brandIds: [BRAND] });
    const delays: number[] = [];
    for (let i = 0; i < 12; i++) {
      const f = await recordRunFailure(c.id);
      delays.push(f!.retryDelayMs / 60_000);
    }
    expect(delays).toEqual([1, 1, 1, 2, 4, 8, 16, 30, 30, 30, 30, 30]);
    const r = await row(c.id);
    expect(r.consecutiveRunFailures).toBe(12);
    expect(r.failingSince).not.toBeNull();
  });

  it("one success resets the streak, and the next failure starts over at the base cadence", async () => {
    const c = await insertTestCampaign(ORG, { brandIds: [BRAND] });
    for (let i = 0; i < 6; i++) await recordRunFailure(c.id);
    expect(await recordRunSuccess(c.id)).toBe(true);
    const r = await row(c.id);
    expect(r.consecutiveRunFailures).toBe(0);
    expect(r.failingSince).toBeNull();
    const next = await recordRunFailure(c.id);
    expect(next!.consecutiveFailures).toBe(1);
    expect(next!.retryDelayMs).toBe(FAILURE_RETRY_BASE_MS);
  });

  it("a success on a healthy campaign writes nothing", async () => {
    const c = await insertTestCampaign(ORG, { brandIds: [BRAND] });
    expect(await recordRunSuccess(c.id)).toBe(false);
  });

  it("a stale streak is not continued: a failure long after the last one starts over", async () => {
    const c = await insertTestCampaign(ORG, { brandIds: [BRAND] });
    for (let i = 0; i < 9; i++) await recordRunFailure(c.id);
    await db.update(campaigns)
      .set({ lastRunFailureAt: new Date(Date.now() - FAILURE_STREAK_STALE_MS - 60_000) })
      .where(eq(campaigns.id, c.id));
    const f = await recordRunFailure(c.id);
    expect(f!.consecutiveFailures).toBe(1);
  });

  it("the staff alert is claimed exactly once per failing episode, not per run", async () => {
    const c = await insertTestCampaign(ORG, { brandIds: [BRAND] });
    const claims: number[] = [];
    for (let i = 1; i <= 30; i++) {
      const f = await recordRunFailure(c.id);
      if (f!.alertClaimedAt) claims.push(i);
    }
    expect(claims).toEqual([FAILING_ALERT_THRESHOLD]);
  });

  it("concurrent failures crossing the threshold still claim one alert", async () => {
    const c = await insertTestCampaign(ORG, { brandIds: [BRAND] });
    for (let i = 1; i < FAILING_ALERT_THRESHOLD - 1; i++) await recordRunFailure(c.id);
    const results = await Promise.all(Array.from({ length: 5 }, () => recordRunFailure(c.id)));
    expect(results.filter((f) => f!.alertClaimedAt).length).toBe(1);
  });

  it("a campaign flapping between failure and success alerts once within the cooldown", async () => {
    const c = await insertTestCampaign(ORG, { brandIds: [BRAND] });
    let claims = 0;
    for (let episode = 0; episode < 4; episode++) {
      for (let i = 0; i < FAILING_ALERT_THRESHOLD + 2; i++) {
        if ((await recordRunFailure(c.id))!.alertClaimedAt) claims++;
      }
      await recordRunSuccess(c.id);
    }
    expect(claims).toBe(1);
  });

  it("re-alerts once the cooldown has passed", async () => {
    const c = await insertTestCampaign(ORG, { brandIds: [BRAND] });
    for (let i = 0; i < FAILING_ALERT_THRESHOLD; i++) await recordRunFailure(c.id);
    await db.update(campaigns)
      .set({ failureAlertedAt: new Date(Date.now() - 25 * 60 * 60_000) })
      .where(eq(campaigns.id, c.id));
    expect((await recordRunFailure(c.id))!.alertClaimedAt).not.toBeNull();
  });

  it("an undeliverable alert releases the claim so the next failure retries it", async () => {
    const c = await insertTestCampaign(ORG, { brandIds: [BRAND] });
    let f = null;
    for (let i = 0; i < FAILING_ALERT_THRESHOLD; i++) f = await recordRunFailure(c.id);
    expect(f!.alertClaimedAt).not.toBeNull();

    fetchSpy.mockResolvedValueOnce(new Response("nope", { status: 400 }));
    const delivered = await notifyFailingCampaign({ campaign: await row(c.id), failure: f! });
    expect(delivered).toBe(false);
    expect((await row(c.id)).failureAlertedAt).toBeNull();

    const retry = await recordRunFailure(c.id);
    expect(retry!.alertClaimedAt).not.toBeNull();
  });

  it("an alert with no user to state is not sent and the claim is released", async () => {
    const c = await insertTestCampaign(ORG, { brandIds: [BRAND] });
    let f = null;
    for (let i = 0; i < FAILING_ALERT_THRESHOLD; i++) f = await recordRunFailure(c.id);
    const delivered = await notifyFailingCampaign({ campaign: { ...(await row(c.id)), createdByUserId: null }, failure: f! });
    expect(delivered).toBe(false);
    expect(staffAlerts(fetchSpy)).toHaveLength(0);
    expect((await row(c.id)).failureAlertedAt).toBeNull();
  });

  describe("through POST /end-run", () => {
    async function endRun(campaignId: string, success: boolean) {
      await request(app)
        .post("/end-run")
        .set(headers(campaignId))
        .send({ success, stopCampaign: false })
        .expect(200);
      // /end-run answers first and reschedules after; let the async tail land.
      await new Promise((r) => setTimeout(r, 120));
    }

    it("widens nextRunAt with the streak, alerts staff once, and resets on success", async () => {
      const c = await insertTestCampaign(ORG, {
        brandIds: [BRAND],
        name: "Shockwave <cold> email",
        status: "ongoing",
        workflowSlug: "sales-email-cold-outreach",
        featureSlug: "sales-cold-email-outreach",
        createdByUserId: "user_test",
      });

      for (let i = 0; i < 10; i++) await endRun(c.id, false);

      let r = await row(c.id);
      expect(r.status).toBe("ongoing"); // never stopped on failures
      expect(r.consecutiveRunFailures).toBe(10);
      const wait = r.nextRunAt!.getTime() - Date.now();
      expect(wait).toBeGreaterThan(FAILURE_RETRY_CEILING_MS - 60_000);
      expect(wait).toBeLessThanOrEqual(FAILURE_RETRY_CEILING_MS);

      const alerts = staffAlerts(fetchSpy);
      expect(alerts).toHaveLength(1);
      const [url, init] = alerts[0];
      expect(String(url)).toBe("https://transactional-email.test.local/platform-send");
      const body = JSON.parse(String((init as RequestInit).body));
      expect(body.eventType).toBe(CAMPAIGN_FAILING_EVENT);
      expect(body.recipientEmail).toBeUndefined(); // staff list only, never the customer
      expect(body.metadata).toMatchObject({
        campaignId: c.id,
        campaignName: "Shockwave &lt;cold&gt; email",
        consecutiveFailures: String(FAILING_ALERT_THRESHOLD),
        retryInterval: "30 min",
        brandId: BRAND,
      });
      // A user is stated: one hop down, billing refuses an email send with no user UUID.
      expect((init as RequestInit).headers).toMatchObject({ "x-org-id": ORG, "x-campaign-id": c.id, "x-user-id": "user_test" });

      // The readable state
      const failing = await request(app)
        .get("/internal/campaigns/failing")
        .set("x-api-key", API_KEY)
        .expect(200);
      const entry = failing.body.campaigns.find((x: { id: string }) => x.id === c.id);
      expect(entry.runHealth).toMatchObject({
        state: "failing",
        consecutiveFailures: 10,
        retryIntervalMs: FAILURE_RETRY_CEILING_MS,
      });
      expect(entry.runHealth.alertedAt).not.toBeNull();
      expect(failing.body.thresholds.failingAlertThreshold).toBe(FAILING_ALERT_THRESHOLD);

      // First success: cadence back to normal
      await endRun(c.id, true);
      r = await row(c.id);
      expect(r.consecutiveRunFailures).toBe(0);
      expect(r.nextRunAt!.getTime() - Date.now()).toBeLessThan(60_000);
      const after = await request(app).get("/internal/campaigns/failing").set("x-api-key", API_KEY).expect(200);
      expect(after.body.campaigns.find((x: { id: string }) => x.id === c.id)).toBeUndefined();
    });

    it("a single failure then a success: no alert, cadence unchanged", async () => {
      const c = await insertTestCampaign(ORG, {
        brandIds: [BRAND],
        status: "ongoing",
        workflowSlug: "sales-email-cold-outreach",
        featureSlug: "sales-cold-email-outreach",
        createdByUserId: "user_test",
      });
      await endRun(c.id, false);
      const r1 = await row(c.id);
      const wait = r1.nextRunAt!.getTime() - Date.now();
      expect(wait).toBeGreaterThan(FAILURE_RETRY_BASE_MS - 5_000);
      expect(wait).toBeLessThanOrEqual(FAILURE_RETRY_BASE_MS);
      await endRun(c.id, true);
      expect((await row(c.id)).consecutiveRunFailures).toBe(0);
      expect(staffAlerts(fetchSpy)).toHaveLength(0);
    });

    it("a stopped campaign's failures are not counted (it is not retrying)", async () => {
      const c = await insertTestCampaign(ORG, { brandIds: [BRAND], status: "stopped" });
      for (let i = 0; i < 10; i++) await endRun(c.id, false);
      expect((await row(c.id)).consecutiveRunFailures).toBe(0);
      expect(staffAlerts(fetchSpy)).toHaveLength(0);
    });
  });
});
