import { describe, it, expect, beforeEach, vi } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { fetchChannelOperators } from "../../src/lib/channel-operator-client.js";

/**
 * WHO operates a channel is features-service's statement, read from its PUBLIC catalogue. These
 * tests pin the read to the shape the DEPLOYED service serves (`GET /public/channels` ->
 * `{ channels: [{ slug, operatedBy }] }`, verified on the api-registry contract) — a client that
 * only ever agrees with its own mock is what took the sales-funnels read out of production for
 * its whole life.
 */
describe("fetchChannelOperators", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.FEATURES_SERVICE_URL = "https://features.test.local";
  });

  it("reads operatedBy per channel from the public catalogue", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        channels: [
          { slug: "sales-cold-email-outreach", operatedBy: "platform" },
          { slug: "in-house-meeting-booking", operatedBy: "customer" },
        ],
        steps: [],
      }),
    });

    const read = await fetchChannelOperators();
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.operatorBySlug.get("sales-cold-email-outreach")).toBe("platform");
    expect(read.operatorBySlug.get("in-house-meeting-booking")).toBe("customer");
  });

  it("carries NO identity — no customer identity ever appears on that path", async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ channels: [], steps: [] }) });
    await fetchChannelOperators();
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit | undefined];
    expect(url).toBe("https://features.test.local/public/channels");
    expect(init).toBeUndefined();
  });

  it("does not answer for a channel it has never been told about", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ channels: [{ slug: "google-ads", operatedBy: "platform" }], steps: [] }),
    });
    const read = await fetchChannelOperators();
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    // An unpublished slug is absent rather than defaulted here: the CALLER decides what an
    // unknown channel means (platform, i.e. today's behaviour), and it says so where it decides.
    expect(read.operatorBySlug.has("some-unpublished-channel")).toBe(false);
  });

  it("leaves out an operator value it has never heard of rather than guessing", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        channels: [{ slug: "partner-run-thing", operatedBy: "partner" }],
        steps: [],
      }),
    });
    const read = await fetchChannelOperators();
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.operatorBySlug.has("partner-run-thing")).toBe(false);
  });

  it("says a failure is a failure — never an empty catalogue", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 503, text: async () => "unavailable" });
    const read = await fetchChannelOperators();
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.detail).toContain("503");
  });

  it("refuses a payload that states no channels array", async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ steps: [] }) });
    const read = await fetchChannelOperators();
    expect(read.ok).toBe(false);
  });

  it("says so when features-service is not configured", async () => {
    delete process.env.FEATURES_SERVICE_URL;
    const read = await fetchChannelOperators();
    expect(read.ok).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
