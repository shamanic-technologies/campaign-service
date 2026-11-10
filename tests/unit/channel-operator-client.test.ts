import { describe, it, expect, beforeEach, vi } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { fetchChannelCatalogue, CHANNEL_CATALOGUE_HOLD_MS } from "../../src/lib/channel-operator-client.js";

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
          // A channel that performs no leg states an EMPTY set — a
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
    // Every declared trigger, the inline ones included: this service's own door accepts them all.
    expect(url).toBe("https://features.test.local/public/channels?includeInline=true");
    // Only a deadline (FLEET-STALL-1107): no headers, so no identity.
    expect(Object.keys(init ?? {})).toEqual(["signal"]);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
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

  it("reads the published LEG vocabulary, each leg naming the steps it connects", async () => {
    // The DEPLOYED shape (features-service's leg catalogue): `legs[]` beside `channels[]`,
    // each leg carrying the identifier, the step it takes a lead OUT of (`null` = from nothing),
    // and the step it takes them INTO. Both steps ride BESIDE the
    // identifier, so nothing splits it.
    const entryLeg = ["start", "to", "conversation"].join("_");
    const legOut = ["conversation","to","meeting","booked"].join("_");
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        channels: [],
        legs: [
          { legKey: entryLeg, fromStep: null, toStep: { key: "conversation" } },
          {
            legKey: legOut,
            fromStep: { key: "conversation", label: "Sales interest" },
            toStep: { key: "meeting_booked" },
          },
        ],
        steps: [{ key: "conversation" }, { key: "meeting_booked" }, { key: "conversation" }],
      }),
    });

    const read = await fetchChannelCatalogue();
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.legs).toHaveLength(2);
    // An ENTRY leg is an ordinary leg: the absent step is DATA, not a different spelling.
    expect(read.legs[0]).toEqual({ legKey: entryLeg, fromStepKey: null, toStepKey: "conversation" });
    expect(read.legs[1].fromStepKey).toBe("conversation");
    // The step a leg leads INTO is read too: a campaign bought for a leg that CONTINUES another
    // finds what it continues by the leg whose toStep is its own fromStep.
    expect(read.legs[1].toStepKey).toBe("meeting_booked");
    expect(read.stepKeys.has("conversation")).toBe(true);
    expect(read.stepKeys.has("smoke_signal")).toBe(false);
  });

  // MIGRATE-1105 S8: a campaign on its target alone is NAMED after its outcome's label, read here (never a map of ours).
  it("keeps each step's LABEL as features-service publishes it, and no label where it publishes none", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        channels: [],
        steps: [{ key: "backlink_earned", label: " Backlink earned " }, { key: "industry_news_found", label: "" }, { key: "paid_client" }],
      }),
    });
    const read = await fetchChannelCatalogue();
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.stepLabels?.get("backlink_earned")).toBe("Backlink earned");
    expect(read.stepLabels?.has("industry_news_found")).toBe(false);
    expect(read.stepLabels?.has("paid_client")).toBe(false);
    expect(read.stepKeys.has("paid_client")).toBe(true);
  });

  it("states an EMPTY leg vocabulary rather than throwing when the payload carries none", async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ channels: [], steps: [] }) });
    const read = await fetchChannelCatalogue();
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.legs).toEqual([]);
    expect(read.stepKeys.size).toBe(0);
  });

  it("reads a trigger's `callable` only when stated as a boolean (FUNNEL-HEAD-TRIGGER-1015)", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        channels: [],
        steps: [],
        triggers: [
          { id: "signup_not_paid_24_hours", label: "Signup Not Paid In 24 Hours", kind: "delay", callable: false },
          { id: "follow_up_due", label: "Follow-up Due", kind: "reported", callable: true },
          { id: "lead_requested", label: "Lead requested", kind: "event" },
        ],
      }),
    });
    const read = await fetchChannelCatalogue();
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.triggers?.get("signup_not_paid_24_hours")?.callable).toBe(false);
    expect(read.triggers?.get("follow_up_due")?.callable).toBe(true);
    expect(read.triggers?.get("lead_requested")?.callable).toBeNull();
  });

  it("reads the merged trigger ids and serves a pipe still named on one on its target (STD-VOCAB-CONDITION-1016)", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        channels: [
          {
            slug: "ai-follow-up-email",
            operatedBy: "platform",
            stepTransitions: [
              { legKey: "start_to_conversation", mode: "reactive", triggerId: "follow_up_date_reached" },
              { legKey: "signup_to_paid_client", mode: "reactive", triggerId: "follow_up_due" },
            ],
          },
        ],
        triggers: [{ id: "follow_up_due", label: "Follow-up Due", fromStep: null, firedBy: "campaign-service", coded: true, kind: "reported" }],
        triggerAliases: [{ id: "follow_up_date_reached", mergedInto: "follow_up_due" }, { id: "x" }, { id: "y", mergedInto: "y" }],
      }),
    });
    const read = await fetchChannelCatalogue();
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect([...(read.triggerAliases ?? new Map())]).toEqual([["follow_up_date_reached", "follow_up_due"]]);
    expect(read.triggerTransitions).toEqual([
      { featureSlug: "ai-follow-up-email", legKey: "start_to_conversation", triggerId: "follow_up_due" },
      { featureSlug: "ai-follow-up-email", legKey: "signup_to_paid_client", triggerId: "follow_up_due" },
    ]);
    const { resolveTriggerType } = await import("../../src/lib/trigger-aliases.js");
    expect(resolveTriggerType(read, "follow_up_date_reached")?.id).toBe("follow_up_due");
    expect(resolveTriggerType(read, "follow_up_due")?.id).toBe("follow_up_due");
    expect(resolveTriggerType(read, "nope")).toBeNull();
  });

  it("states NO merged trigger when the catalogue serves none (byte-identical before the merge)", async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ channels: [], triggers: [] }) });
    const read = await fetchChannelCatalogue();
    if (!read.ok) throw new Error("expected ok");
    expect(read.triggerAliases?.size).toBe(0);
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

/**
 * THE HOLD (BOX-LOAD-1107): ~142 reads a minute of the same ~233 KB catalogue became one read a minute. A readable
 * answer is shared for CHANNEL_CATALOGUE_HOLD_MS; an unreadable one is never held.
 */
describe("fetchChannelCatalogue hold", () => {
  const body = (slug: string) => ({
    ok: true,
    json: async () => ({ channels: [{ slug, operatedBy: "platform" }], steps: [] }),
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    process.env.FEATURES_SERVICE_URL = "https://features.test.local";
  });

  it("answers every caller inside the hold from ONE read", async () => {
    mockFetch.mockResolvedValue(body("a"));
    const reads = await Promise.all([fetchChannelCatalogue(), fetchChannelCatalogue(), fetchChannelCatalogue()]);
    const later = await fetchChannelCatalogue();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    for (const r of [...reads, later]) expect(r.ok && r.operatorBySlug.get("a")).toBe("platform");
  });

  it("reads again once the hold has passed, so an upstream edit reaches dispatch within it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    mockFetch.mockResolvedValueOnce(body("a")).mockResolvedValueOnce(body("b"));
    const first = await fetchChannelCatalogue();
    vi.setSystemTime(Date.now() + CHANNEL_CATALOGUE_HOLD_MS - 1);
    const still = await fetchChannelCatalogue();
    vi.setSystemTime(Date.now() + 2);
    const next = await fetchChannelCatalogue();
    vi.useRealTimers();
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(first.ok && first.operatorBySlug.has("a")).toBe(true);
    expect(still).toBe(first);
    expect(next.ok && next.operatorBySlug.has("b")).toBe(true);
  });

  it("never holds an unreadable answer: the next caller asks again", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 502, text: async () => "down" }).mockResolvedValueOnce(body("a"));
    const down = await fetchChannelCatalogue();
    const up = await fetchChannelCatalogue();
    expect(down.ok).toBe(false);
    expect(up.ok && up.operatorBySlug.get("a")).toBe("platform");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("a failed read serves the last good one while it is under 30 minutes old, never older (MIGRATE-1105 S6)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-08T07:00:00Z"));
    mockFetch.mockResolvedValueOnce(body("a"));
    expect((await fetchChannelCatalogue()).ok).toBe(true);
    vi.setSystemTime(new Date("2026-11-08T07:10:00Z"));
    mockFetch.mockRejectedValueOnce(new Error("fetch failed"));
    const stale = await fetchChannelCatalogue();
    expect(stale.ok && stale.operatorBySlug.get("a")).toBe("platform");
    vi.setSystemTime(new Date("2026-11-08T07:31:00Z"));
    mockFetch.mockRejectedValueOnce(new Error("fetch failed"));
    expect((await fetchChannelCatalogue()).ok).toBe(false);
    vi.useRealTimers();
  });

  it("never holds a thrown read either", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ECONNRESET")).mockResolvedValueOnce(body("a"));
    expect((await fetchChannelCatalogue()).ok).toBe(false);
    expect((await fetchChannelCatalogue()).ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
