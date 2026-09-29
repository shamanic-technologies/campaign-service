import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

vi.mock("../../src/lib/workflows.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/lib/workflows.js")>();
  return { ...original, executeCampaignWorkflow: vi.fn(async () => undefined) };
});
vi.mock("../../src/lib/features-workflow-projection-client.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/lib/features-workflow-projection-client.js")>();
  return {
    ...original,
    resolveSelectionForTrigger: vi.fn(async (a: { fallbackSlug: string }) => ({ workflowSlug: a.fallbackSlug, audienceId: null })),
  };
});
// The signal to billing is what is under test: capture it instead of calling out.
vi.mock("../../src/lib/mission-status-notification.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/lib/mission-status-notification.js")>();
  return { ...original, signalMissionStatusChanged: vi.fn(async () => undefined) };
});
// Starting a campaign asks billing whether the org can be charged; answer "yes".
vi.mock("../../src/lib/payment-hold.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/lib/payment-hold.js")>();
  return { ...original, paymentStartRefusal: vi.fn(async () => null) };
});

import request from "supertest";
import app from "../../src/index.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import {
  signalMissionStatusChanged,
  shouldSignalStatusMove,
} from "../../src/lib/mission-status-notification.js";

const API_KEY = process.env.CAMPAIGN_SERVICE_API_KEY || "test-api-key";
const ORG = "org_test_status_signal";
const signal = vi.mocked(signalMissionStatusChanged);

// A person pausing or restarting a mission is signalled to billing (which sends the staff
// budget-change email) after the write commits; a write that moves nothing sends nothing.
describe("PATCH /campaigns/:id status → billing signal", () => {
  beforeEach(async () => {
    await cleanTestData();
    signal.mockClear();
  });
  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  async function create() {
    const res = await request(app)
      .post("/campaigns")
      .set("x-api-key", API_KEY)
      .set("x-org-id", ORG)
      .set("x-user-id", "user_signal")
      .set("x-run-id", crypto.randomUUID())
      .set("x-feature-slug", "sales-cold-email-v1")
      .send({ name: "Signal", workflowSlug: "sales-email-cold-outreach", orgId: ORG, brandIds: [crypto.randomUUID()] })
      .expect(201);
    return res.body.campaign;
  }

  function patch(id: string, status: string) {
    return request(app)
      .patch(`/campaigns/${id}`)
      .set("x-api-key", API_KEY)
      .set("x-org-id", ORG)
      .set("x-user-id", "user_signal")
      .set("x-run-id", crypto.randomUUID())
      .set("x-feature-slug", "sales-cold-email-v1")
      .set("x-email", "kevin@distribute.you")
      .send({ status });
  }

  it("a pause and a restart each signal a real move, with the person", async () => {
    const campaign = await create();
    signal.mockClear();

    await patch(campaign.id, "stop").expect(200);
    expect(signal).toHaveBeenCalledTimes(1);
    const paused = signal.mock.calls[0][0];
    expect(paused).toMatchObject({
      source: "patch",
      campaignId: campaign.id,
      brandIds: campaign.brandIds,
      fromStatus: "ongoing",
      toStatus: "stopped",
      actor: { userId: "user_signal", email: "kevin@distribute.you" },
    });
    expect(shouldSignalStatusMove(paused)).toBe(true);

    await patch(campaign.id, "activate").expect(200);
    const restarted = signal.mock.calls[1][0];
    expect(restarted).toMatchObject({ fromStatus: "stopped", toStatus: "ongoing" });
    expect(shouldSignalStatusMove(restarted)).toBe(true);
  });

  it("stopping an already stopped campaign moves nothing, so nothing is sent", async () => {
    const campaign = await create();
    await patch(campaign.id, "stop").expect(200);
    signal.mockClear();

    await patch(campaign.id, "stop").expect(200);
    const noop = signal.mock.calls[0][0];
    expect(noop).toMatchObject({ fromStatus: "stopped", toStatus: "stopped" });
    expect(shouldSignalStatusMove(noop)).toBe(false);
  });
});
