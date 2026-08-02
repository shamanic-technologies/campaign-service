import { describe, it, expect, beforeEach, vi } from "vitest";

const { mockSelectWhere, mockUpdateSet, mockUpdateWhere } = vi.hoisted(() => ({
  mockSelectWhere: vi.fn(),
  mockUpdateSet: vi.fn(),
  mockUpdateWhere: vi.fn(),
}));

vi.mock("../../src/db/index.js", () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({ where: mockSelectWhere }),
    }),
    update: vi.fn().mockReturnValue({
      set: (values: unknown) => {
        mockUpdateSet(values);
        return { where: mockUpdateWhere };
      },
    }),
  },
}));

vi.mock("../../src/db/schema.js", () => ({
  campaigns: {
    id: "id",
    orgId: "org_id",
    brandIds: "brand_ids",
    goal: "goal",
    funnelKey: "funnel_key",
    createdByUserId: "created_by_user_id",
    workflowSlug: "workflow_slug",
    featureSlug: "feature_slug",
  },
}));

vi.mock("drizzle-orm", () => ({
  and: vi.fn(),
  eq: vi.fn(),
  isNull: vi.fn(),
  inArray: vi.fn(),
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { backfillCampaignFunnelKeys } from "../../src/lib/funnel-backfill.js";

const SALES = "sales-cold-email-outreach";

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "c-1",
    orgId: "org-1",
    brandIds: ["brand-1"],
    goal: null,
    createdByUserId: "user-1",
    workflowSlug: "sales-email-cold-outreach",
    featureSlug: SALES,
    ...overrides,
  };
}

function mockBrandGoal(goal: string) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ brand: {}, currentGoal: goal, brandProfile: null }),
  });
}

describe("backfillCampaignFunnelKeys", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.BRAND_SERVICE_URL = "https://brand.test.local";
    process.env.BRAND_SERVICE_API_KEY = "brand-key";
    mockUpdateWhere.mockResolvedValue(undefined);
  });

  it("writes the funnel a campaign runs onto its own row, from the brand's goal", async () => {
    mockSelectWhere.mockResolvedValue([row()]);
    mockBrandGoal("formSubmission");

    const result = await backfillCampaignFunnelKeys();

    expect(mockUpdateSet).toHaveBeenCalledWith({ funnelKey: "visit_form" });
    expect(result).toEqual({ scanned: 1, stamped: 1, undetermined: 0 });
  });

  it("prefers the campaign's own goal when it states one", async () => {
    mockSelectWhere.mockResolvedValue([row({ goal: "meetingBooked" })]);
    mockBrandGoal("formSubmission");

    await backfillCampaignFunnelKeys();

    expect(mockUpdateSet).toHaveBeenCalledWith({ funnelKey: "reply_meeting" });
  });

  it("reads brand-service ONCE per (org, brand) pair, not once per campaign", async () => {
    mockSelectWhere.mockResolvedValue([
      row({ id: "c-1" }),
      row({ id: "c-2" }),
      row({ id: "c-3" }),
    ]);
    mockBrandGoal("formSubmission");

    await backfillCampaignFunnelKeys();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockUpdateSet).toHaveBeenCalledTimes(3);
  });

  it("names the org on the brand read — the goal belongs to the (org, brand) pair", async () => {
    mockSelectWhere.mockResolvedValue([row()]);
    mockBrandGoal("formSubmission");

    await backfillCampaignFunnelKeys();

    const headers = mockFetch.mock.calls[0][1].headers as Record<string, string>;
    expect(headers["x-org-id"]).toBe("org-1");
    expect(headers["x-brand-id"]).toBe("brand-1");
  });

  it("leaves a goal that names no single funnel alone rather than inventing one", async () => {
    mockSelectWhere.mockResolvedValue([row({ goal: "combinedSales" })]);
    mockBrandGoal("combinedSales");

    const result = await backfillCampaignFunnelKeys();

    expect(mockUpdateSet).not.toHaveBeenCalled();
    expect(result).toEqual({ scanned: 1, stamped: 1 - 1, undetermined: 1 });
  });

  it("leaves a campaign alone when the brand cannot be read — the next boot tries again", async () => {
    mockSelectWhere.mockResolvedValue([row()]);
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503, text: async () => "down" });

    const result = await backfillCampaignFunnelKeys();

    expect(mockUpdateSet).not.toHaveBeenCalled();
    expect(result.undetermined).toBe(1);
  });

  it("does nothing at all once every campaign states its funnel", async () => {
    mockSelectWhere.mockResolvedValue([]);

    const result = await backfillCampaignFunnelKeys();

    expect(mockFetch).not.toHaveBeenCalled();
    expect(result).toEqual({ scanned: 0, stamped: 0, undetermined: 0 });
  });
});
