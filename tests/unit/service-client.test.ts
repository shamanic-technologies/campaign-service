import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock global fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Import after mocking fetch
const { getAggregatedStats, getStatsByModel } = await import("../../src/lib/service-client.js");

function okResponse(stats: unknown) {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve({ stats }),
  };
}

function errorResponse(status: number) {
  return {
    ok: false,
    status,
    json: () => Promise.resolve({ error: "fail" }),
  };
}

const APOLLO_STATS = { leadsFound: 10, searchesCount: 2, totalPeopleFromSearches: 50 };
const EMAILGEN_STATS = { emailsGenerated: 8 };
const POSTMARK_STATS = {
  emailsSent: 5, emailsOpened: 3, emailsClicked: 1, emailsReplied: 1, emailsBounced: 0,
  repliesWillingToMeet: 1, repliesInterested: 0, repliesNotInterested: 0,
  repliesOutOfOffice: 0, repliesUnsubscribe: 0,
};
const INSTANTLY_STATS = {
  emailsSent: 4, emailsOpened: 2, emailsClicked: 1, emailsReplied: 0, emailsBounced: 1,
  repliesWillingToMeet: 0, repliesInterested: 0, repliesNotInterested: 0,
  repliesOutOfOffice: 0, repliesUnsubscribe: 0,
};

beforeEach(() => {
  mockFetch.mockReset();
});

describe("getAggregatedStats", () => {
  it("returns empty stats with no errors for empty runIds", async () => {
    const result = await getAggregatedStats([], "org-1");
    expect(result.stats.leadsFound).toBe(0);
    expect(result.stats.emailsSent).toBe(0);
    expect(result.errors).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns correct stats when all 4 services respond", async () => {
    mockFetch
      .mockResolvedValueOnce(okResponse(APOLLO_STATS))
      .mockResolvedValueOnce(okResponse(EMAILGEN_STATS))
      .mockResolvedValueOnce(okResponse(POSTMARK_STATS))
      .mockResolvedValueOnce(okResponse(INSTANTLY_STATS));

    const result = await getAggregatedStats(["run-1"], "org-1");

    expect(result.errors).toEqual([]);
    expect(result.stats.leadsFound).toBe(10);
    expect(result.stats.emailsGenerated).toBe(8);
    // Postmark + Instantly summed
    expect(result.stats.emailsSent).toBe(9);
    expect(result.stats.emailsOpened).toBe(5);
    expect(result.stats.emailsClicked).toBe(2);
    expect(result.stats.emailsReplied).toBe(1);
    expect(result.stats.emailsBounced).toBe(1);
    expect(result.stats.repliesWillingToMeet).toBe(1);
  });

  it("reports error when one service fails, keeps other stats", async () => {
    mockFetch
      .mockResolvedValueOnce(okResponse(APOLLO_STATS))
      .mockResolvedValueOnce(okResponse(EMAILGEN_STATS))
      .mockResolvedValueOnce(errorResponse(500)) // postmark fails
      .mockResolvedValueOnce(okResponse(INSTANTLY_STATS));

    const result = await getAggregatedStats(["run-1"], "org-1");

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].service).toBe("postmark");
    expect(result.errors[0].error).toBe("HTTP 500");
    // Apollo and emailgen stats still present
    expect(result.stats.leadsFound).toBe(10);
    expect(result.stats.emailsGenerated).toBe(8);
    // Only instantly stats (postmark failed)
    expect(result.stats.emailsSent).toBe(4);
  });

  it("reports 4 errors when all services fail", async () => {
    mockFetch
      .mockResolvedValueOnce(errorResponse(503))
      .mockResolvedValueOnce(errorResponse(503))
      .mockResolvedValueOnce(errorResponse(503))
      .mockResolvedValueOnce(errorResponse(503));

    const result = await getAggregatedStats(["run-1"], "org-1");

    expect(result.errors).toHaveLength(4);
    expect(result.errors.map(e => e.service).sort()).toEqual(["apollo", "emailgen", "instantly", "postmark"]);
    expect(result.stats.leadsFound).toBe(0);
    expect(result.stats.emailsSent).toBe(0);
  });

  it("handles connection refused errors", async () => {
    const connError = new Error("fetch failed");
    (connError as any).cause = { code: "ECONNREFUSED" };

    mockFetch
      .mockRejectedValueOnce(connError) // apollo
      .mockResolvedValueOnce(okResponse(EMAILGEN_STATS))
      .mockResolvedValueOnce(okResponse(POSTMARK_STATS))
      .mockResolvedValueOnce(okResponse(INSTANTLY_STATS));

    const result = await getAggregatedStats(["run-1"], "org-1");

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toEqual({ service: "apollo", error: "connection refused" });
    expect(result.stats.leadsFound).toBe(0);
    expect(result.stats.emailsSent).toBe(9); // postmark + instantly still work
  });

  it("sums postmark and instantly when both succeed", async () => {
    mockFetch
      .mockResolvedValueOnce(okResponse(APOLLO_STATS))
      .mockResolvedValueOnce(okResponse(EMAILGEN_STATS))
      .mockResolvedValueOnce(okResponse({ ...POSTMARK_STATS, emailsSent: 10 }))
      .mockResolvedValueOnce(okResponse({ ...INSTANTLY_STATS, emailsSent: 7 }));

    const result = await getAggregatedStats(["run-1"], "org-1");
    expect(result.stats.emailsSent).toBe(17);
  });

  it("treats missing stats in response as error (not crash)", async () => {
    // Service returns 200 but { stats: undefined } or {}
    const emptyOk = { ok: true, status: 200, json: () => Promise.resolve({}) };
    const nullStats = { ok: true, status: 200, json: () => Promise.resolve({ stats: null }) };

    mockFetch
      .mockResolvedValueOnce(okResponse(APOLLO_STATS))
      .mockResolvedValueOnce(emptyOk)       // emailgen returns no stats field
      .mockResolvedValueOnce(nullStats)      // postmark returns stats: null
      .mockResolvedValueOnce(okResponse(INSTANTLY_STATS));

    const result = await getAggregatedStats(["run-1"], "org-1");

    expect(result.errors).toHaveLength(2);
    expect(result.errors.map(e => e.service).sort()).toEqual(["emailgen", "postmark"]);
    expect(result.stats.leadsFound).toBe(10);
    expect(result.stats.emailsSent).toBe(4); // only instantly
  });

  it("uses only postmark stats when instantly fails", async () => {
    mockFetch
      .mockResolvedValueOnce(okResponse(APOLLO_STATS))
      .mockResolvedValueOnce(okResponse(EMAILGEN_STATS))
      .mockResolvedValueOnce(okResponse(POSTMARK_STATS))
      .mockResolvedValueOnce(errorResponse(500)); // instantly fails

    const result = await getAggregatedStats(["run-1"], "org-1");

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].service).toBe("instantly");
    expect(result.stats.emailsSent).toBe(5); // only postmark
  });
});

describe("getStatsByModel", () => {
  it("returns empty stats for empty runIds", async () => {
    const result = await getStatsByModel([]);
    expect(result.stats).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns model stats on success", async () => {
    const modelData = [
      { model: "gpt-4o", count: 5, runIds: ["run-1"] },
      { model: "claude-sonnet", count: 3, runIds: ["run-2"] },
    ];
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ stats: modelData }),
    });

    const result = await getStatsByModel(["run-1", "run-2"]);
    expect(result.stats).toEqual(modelData);
    expect(result.errors).toEqual([]);
  });

  it("returns error on failure", async () => {
    mockFetch.mockResolvedValueOnce(errorResponse(500));

    const result = await getStatsByModel(["run-1"]);
    expect(result.stats).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].service).toBe("emailgen");
  });
});
