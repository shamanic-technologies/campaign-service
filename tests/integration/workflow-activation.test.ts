import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";

const { mockExecuteColdEmailOutreach } = vi.hoisted(() => ({
  mockExecuteColdEmailOutreach: vi.fn(),
}));

vi.mock("../../src/lib/workflows.js", () => ({
  executeColdEmailOutreach: mockExecuteColdEmailOutreach,
  deployWorkflows: vi.fn(),
}));

import app from "../../src/index.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";

const API_KEY = process.env.CAMPAIGN_SERVICE_API_KEY || "test-api-key";

const validBody = {
  name: "Activation Test Campaign",
  clerkOrgId: "org_activation_test",
  brandUrl: "https://example.com",
  brandId: crypto.randomUUID(),
  appId: "mcpfactory",
  targetOutcome: "Book sales demos",
  valueForTarget: "Enterprise analytics at startup pricing",
  targetAudience: "CTOs at SaaS companies",
};

describe("Workflow activation on PATCH", () => {
  beforeEach(async () => {
    await cleanTestData();
    vi.clearAllMocks();
    mockExecuteColdEmailOutreach.mockResolvedValue(undefined);
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("should trigger workflow when status is set to activate", async () => {
    // Create campaign
    const createRes = await request(app)
      .post("/campaigns")
      .set("x-api-key", API_KEY)
      .set("x-clerk-org-id", "org_activation_test")
      .send(validBody)
      .expect(201);

    const campaignId = createRes.body.campaign.id;

    // Stop it first so we can activate
    await request(app)
      .patch(`/campaigns/${campaignId}`)
      .set("x-api-key", API_KEY)
      .set("x-clerk-org-id", "org_activation_test")
      .send({ status: "stop" })
      .expect(200);

    vi.clearAllMocks();
    mockExecuteColdEmailOutreach.mockResolvedValue(undefined);

    // Activate
    const activateRes = await request(app)
      .patch(`/campaigns/${campaignId}`)
      .set("x-api-key", API_KEY)
      .set("x-clerk-org-id", "org_activation_test")
      .send({ status: "activate" })
      .expect(200);

    expect(activateRes.body.campaign.status).toBe("ongoing");

    // Wait a tick for the fire-and-forget promise
    await new Promise((r) => setTimeout(r, 50));

    expect(mockExecuteColdEmailOutreach).toHaveBeenCalledOnce();
    expect(mockExecuteColdEmailOutreach).toHaveBeenCalledWith(
      expect.objectContaining({
        brandId: validBody.brandId,
        brandUrl: "https://example.com",
        campaignId,
        clerkOrgId: "org_activation_test",
        targetAudience: "CTOs at SaaS companies",
        targetOutcome: "Book sales demos",
        valueForTarget: "Enterprise analytics at startup pricing",
      })
    );
  });

  it("should NOT trigger workflow when status is set to stop", async () => {
    const createRes = await request(app)
      .post("/campaigns")
      .set("x-api-key", API_KEY)
      .set("x-clerk-org-id", "org_activation_test")
      .send(validBody)
      .expect(201);

    const campaignId = createRes.body.campaign.id;

    await request(app)
      .patch(`/campaigns/${campaignId}`)
      .set("x-api-key", API_KEY)
      .set("x-clerk-org-id", "org_activation_test")
      .send({ status: "stop" })
      .expect(200);

    await new Promise((r) => setTimeout(r, 50));

    expect(mockExecuteColdEmailOutreach).not.toHaveBeenCalled();
  });

  it("should NOT trigger workflow when updating non-status fields", async () => {
    const createRes = await request(app)
      .post("/campaigns")
      .set("x-api-key", API_KEY)
      .set("x-clerk-org-id", "org_activation_test")
      .send(validBody)
      .expect(201);

    const campaignId = createRes.body.campaign.id;

    await request(app)
      .patch(`/campaigns/${campaignId}`)
      .set("x-api-key", API_KEY)
      .set("x-clerk-org-id", "org_activation_test")
      .send({ name: "Updated Name" })
      .expect(200);

    await new Promise((r) => setTimeout(r, 50));

    expect(mockExecuteColdEmailOutreach).not.toHaveBeenCalled();
  });

  it("should still return 200 even if workflow execution fails", async () => {
    mockExecuteColdEmailOutreach.mockRejectedValue(new Error("Windmill down"));

    const createRes = await request(app)
      .post("/campaigns")
      .set("x-api-key", API_KEY)
      .set("x-clerk-org-id", "org_activation_test")
      .send(validBody)
      .expect(201);

    const campaignId = createRes.body.campaign.id;

    // Stop then activate
    await request(app)
      .patch(`/campaigns/${campaignId}`)
      .set("x-api-key", API_KEY)
      .set("x-clerk-org-id", "org_activation_test")
      .send({ status: "stop" })
      .expect(200);

    const activateRes = await request(app)
      .patch(`/campaigns/${campaignId}`)
      .set("x-api-key", API_KEY)
      .set("x-clerk-org-id", "org_activation_test")
      .send({ status: "activate" })
      .expect(200);

    expect(activateRes.body.campaign.status).toBe("ongoing");
  });
});
