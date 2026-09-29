import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  shouldSignalStatusMove,
  signalMissionStatusChanged,
  type MissionStatusSignal,
} from "../../src/lib/mission-status-notification.js";
import { TRANSITION_SOURCES } from "../../src/lib/campaign-status-history.js";

const BRAND = "933d4abb-9695-4fcb-b3aa-354d61565798";

function signal(over: Partial<MissionStatusSignal> = {}): MissionStatusSignal {
  return {
    source: TRANSITION_SOURCES.PATCH,
    orgId: "22ffb00a-b7da-4453-9bf2-1784c2d2bf9e",
    campaignId: "11111111-1111-1111-1111-111111111111",
    brandIds: [BRAND],
    featureSlug: "sales-cold-email-outreach",
    offerId: "e59646e4-e351-462d-a8a7-618098e7e5c1",
    legKey: "start_to_conversation",
    fromStatus: "ongoing",
    toStatus: "stopped",
    actor: { userId: "u1", runId: "r1", email: "kevin@distribute.you" },
    ...over,
  };
}

describe("shouldSignalStatusMove — a person's real move only", () => {
  it("a person's pause and restart signal", () => {
    expect(shouldSignalStatusMove(signal())).toBe(true);
    expect(shouldSignalStatusMove(signal({ fromStatus: "stopped", toStatus: "ongoing" }))).toBe(true);
    expect(shouldSignalStatusMove(signal({ source: TRANSITION_SOURCES.CREATE_RESTART, fromStatus: "stopped", toStatus: "ongoing" }))).toBe(true);
    expect(shouldSignalStatusMove(signal({ source: TRANSITION_SOURCES.START_FUNDED_PAIR, fromStatus: "stopped", toStatus: "ongoing" }))).toBe(true);
  });
  it("a no-op, a birth or a system stop sends nothing", () => {
    expect(shouldSignalStatusMove(signal({ fromStatus: "ongoing", toStatus: "ongoing" }))).toBe(false);
    expect(shouldSignalStatusMove(signal({ fromStatus: null, toStatus: "ongoing" }))).toBe(false);
    expect(shouldSignalStatusMove(signal({ source: TRANSITION_SOURCES.PAYMENT_HOLD }))).toBe(false);
    expect(shouldSignalStatusMove(signal({ source: TRANSITION_SOURCES.ORG_TEARDOWN }))).toBe(false);
  });
});

describe("signalMissionStatusChanged", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ notified: true, move: "paused" }), { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    process.env.BILLING_SERVICE_URL = "http://billing.test";
    process.env.BILLING_SERVICE_API_KEY = "k";
  });
  afterEach(() => vi.unstubAllGlobals());

  it("posts the move to billing with the actor's identity", async () => {
    await signalMissionStatusChanged(signal());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`http://billing.test/internal/brands/${BRAND}/mission-status-changed`);
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ "x-org-id": signal().orgId, "x-user-id": "u1", "x-run-id": "r1", "x-email": "kevin@distribute.you" });
    expect(JSON.parse(init.body)).toEqual({
      campaignId: signal().campaignId,
      featureSlug: "sales-cold-email-outreach",
      offerId: "e59646e4-e351-462d-a8a7-618098e7e5c1",
      legKey: "start_to_conversation",
      fromStatus: "ongoing",
      toStatus: "stopped",
    });
  });

  it("a no-op sends nothing", async () => {
    await signalMissionStatusChanged(signal({ toStatus: "ongoing" }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never throws, whatever billing does", async () => {
    fetchMock.mockRejectedValue(new Error("down"));
    await expect(signalMissionStatusChanged(signal())).resolves.toBeUndefined();
    fetchMock.mockResolvedValue(new Response("nope", { status: 500 }));
    await expect(signalMissionStatusChanged(signal())).resolves.toBeUndefined();
  });
});
