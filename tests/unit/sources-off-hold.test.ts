import { describe, it, expect, beforeEach, vi } from "vitest";

const { mockFeeding, mockCatalogue } = vi.hoisted(() => ({
  mockFeeding: vi.fn(),
  mockCatalogue: vi.fn(),
}));

vi.mock("../../src/lib/source-campaign-store.js", () => ({ sourceCampaignsFeeding: mockFeeding }));
vi.mock("../../src/lib/channel-operator-client.js", () => ({ fetchChannelCatalogue: mockCatalogue }));

import { sourcesOffHold } from "../../src/lib/sources-off-hold.js";

const outreach = { id: "c1", featureSlug: "sales-cold-email-outreach", legKey: "lead_found_to_conversation" };
const catalogue = (reactive: boolean) => ({
  ok: true,
  legs: [],
  reactiveBySlug: new Map([["sales-cold-email-outreach", new Map([["lead_found_to_conversation", reactive]])]]),
});

describe("sourcesOffHold (STUCK-DEPRECATED-RUDDER-1009)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCatalogue.mockResolvedValue(catalogue(false));
  });

  it("holds an entry-leg outreach campaign whose every source is off", async () => {
    mockFeeding.mockResolvedValue([{ id: "s1", featureSlug: "sourcing-apollo-cold-filters", status: "stopped" }]);
    expect(await sourcesOffHold(outreach)).toEqual({ sourceCampaignIds: ["s1"] });
  });

  it("does not hold when one source is on", async () => {
    mockFeeding.mockResolvedValue([
      { id: "s1", featureSlug: "sourcing-apollo-cold-filters", status: "stopped" },
      { id: "s2", featureSlug: "sourcing-apollo-buying-signals", status: "ongoing" },
    ]);
    expect(await sourcesOffHold(outreach)).toBeNull();
    expect(mockCatalogue).not.toHaveBeenCalled();
  });

  it("does not hold an offer with no source campaign at all (legacy serve)", async () => {
    mockFeeding.mockResolvedValue([]);
    expect(await sourcesOffHold(outreach)).toBeNull();
  });

  it("does not hold a channel that sources nothing, without reading anything", async () => {
    expect(await sourcesOffHold({ id: "c2", featureSlug: "ai-meeting-booking", legKey: "conversation_to_meeting_booked" })).toBeNull();
    expect(mockFeeding).not.toHaveBeenCalled();
  });

  it("never holds a reactive leg, and holds nothing when the catalogue is unreadable", async () => {
    mockFeeding.mockResolvedValue([{ id: "s1", featureSlug: "sourcing-apollo-cold-filters", status: "stopped" }]);
    mockCatalogue.mockResolvedValueOnce(catalogue(true));
    expect(await sourcesOffHold(outreach)).toBeNull();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockCatalogue.mockResolvedValueOnce({ ok: false, detail: "HTTP 502" });
    expect(await sourcesOffHold(outreach)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
