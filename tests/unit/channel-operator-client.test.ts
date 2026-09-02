import { describe, it, expect, beforeEach, vi } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { fetchChannelCatalogue } from "../../src/lib/channel-operator-client.js";

/**
 * WHO operates a channel is features-service's statement, read from its PUBLIC catalogue. These
 * tests pin the read to the shape the DEPLOYED service serves (`GET /public/channels` ->
 * `{ channels: [{ slug, operatedBy }] }`, verified on the api-registry contract) — a client that
 * only ever agrees with its own mock is what took the sales-funnels read out of production for
 * its whole life.
 */
describe("fetchChannelCatalogue", () => {
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

    const read = await fetchChannelCatalogue();
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.operatorBySlug.get("sales-cold-email-outreach")).toBe("platform");
    expect(read.operatorBySlug.get("in-house-meeting-booking")).toBe("customer");
  });

  it("reads the LEGS each channel performs, carrying the identifier verbatim", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        channels: [
          {
            slug: "sales-cold-email-outreach",
            operatedBy: "platform",
            // The two steps ride BESIDE the identifier, which is why nothing ever splits it.
            stepTransitions: [
              { legKey: "start_to_conversation", from: null, to: { key: "conversation" } },
            ],
          },
          {
            slug: "in-house-meeting-booking",
            operatedBy: "customer",
            stepTransitions: [
              { legKey: "conversation_to_meeting_booked" },
              { legKey: "meeting_booked_to_meeting_attended" },
            ],
          },
          // A channel that performs no leg of any declared funnel states an EMPTY set — a
          // truthful answer, and not the same thing as a slug the catalogue never names.
          { slug: "press-kit-page-generation", operatedBy: "platform", stepTransitions: [] },
        ],
        legs: [],
        steps: [],
      }),
    });

    const read = await fetchChannelCatalogue();
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect([...read.legsBySlug.get("sales-cold-email-outreach")!]).toEqual(["start_to_conversation"]);
    expect([...read.legsBySlug.get("in-house-meeting-booking")!].sort()).toEqual([
      "conversation_to_meeting_booked",
      "meeting_booked_to_meeting_attended",
    ]);
    expect([...read.legsBySlug.get("press-kit-page-generation")!]).toEqual([]);
    // A slug the catalogue does not publish is ABSENT, never an empty set.
    expect(read.legsBySlug.has("google-ads")).toBe(false);
  });

  it("carries NO identity — no customer identity ever appears on that path", async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ channels: [], steps: [] }) });
    await fetchChannelCatalogue();
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit | undefined];
    expect(url).toBe("https://features.test.local/public/channels");
    expect(init).toBeUndefined();
  });

  it("does not answer for a channel it has never been told about", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ channels: [{ slug: "google-ads", operatedBy: "platform" }], steps: [] }),
    });
    const read = await fetchChannelCatalogue();
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
    const read = await fetchChannelCatalogue();
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.operatorBySlug.has("partner-run-thing")).toBe(false);
  });

  it("reads the published LEG vocabulary, each leg naming the step it leaves and its funnels", async () => {
    // The DEPLOYED shape (features-service `funnelLegCatalogue()`): `legs[]` beside `channels[]`,
    // each leg carrying the identifier, the step it takes a lead OUT of (`null` = from nothing),
    // and every funnel it is a leg of. The steps ride BESIDE the identifier, so nothing splits it.
    const entryLeg = ["start", "to", "conversation"].join("_");
    const legOut = ["sales", "interest", "to", "meeting", "booked"].join("_");
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        channels: [],
        legs: [
          { legKey: entryLeg, fromStep: null, toStep: { key: "conversation" }, funnelKeys: ["sales_meetings_from_conversation"] },
          {
            legKey: legOut,
            fromStep: { key: "sales_interest", label: "Sales interest" },
            toStep: { key: "meeting_booked" },
            funnelKeys: ["sales_meetings_from_conversation", "sales_meetings_from_website"],
          },
        ],
        steps: [{ key: "sales_interest" }, { key: "meeting_booked" }, { key: "conversation" }],
      }),
    });

    const read = await fetchChannelCatalogue();
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.legs).toHaveLength(2);
    // An ENTRY leg is an ordinary leg: the absent step is DATA, not a different spelling.
    expect(read.legs[0]).toEqual({ legKey: entryLeg, fromStepKey: null, funnelKeys: new Set(["sales_meetings_from_conversation"]) });
    expect(read.legs[1].fromStepKey).toBe("sales_interest");
    expect([...read.legs[1].funnelKeys]).toEqual([
      "sales_meetings_from_conversation",
      "sales_meetings_from_website",
    ]);
    expect(read.stepKeys.has("sales_interest")).toBe(true);
    expect(read.stepKeys.has("smoke_signal")).toBe(false);
  });

  it("states an EMPTY leg vocabulary rather than throwing when the payload carries none", async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ channels: [], steps: [] }) });
    const read = await fetchChannelCatalogue();
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.legs).toEqual([]);
    expect(read.stepKeys.size).toBe(0);
  });

  it("says a failure is a failure — never an empty catalogue", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 503, text: async () => "unavailable" });
    const read = await fetchChannelCatalogue();
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.detail).toContain("503");
  });

  it("refuses a payload that states no channels array", async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ steps: [] }) });
    const read = await fetchChannelCatalogue();
    expect(read.ok).toBe(false);
  });

  it("says so when features-service is not configured", async () => {
    delete process.env.FEATURES_SERVICE_URL;
    const read = await fetchChannelCatalogue();
    expect(read.ok).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
