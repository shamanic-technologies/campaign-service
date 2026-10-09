import { describe, it, expect, vi, afterEach } from "vitest";
import { findLegacyOutboundLegKeys, logLegacyOutboundLegKeys, LEGACY_LEG_KEY_MARKER } from "../../src/lib/legacy-leg-key-log.js";

const COLD = "sales-cold-email-outreach";
const ADS = "google-ads";
const OLD_REPLY = "start_to_conversation";
const NEW_REPLY = "lead_found_to_conversation";
const OLD_VISIT = "start_to_website_visit";

function run(req: { method?: string; path?: string; query?: unknown; body?: unknown; headers?: Record<string, string> }) {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const next = vi.fn();
  logLegacyOutboundLegKeys(
    { method: "POST", path: "/campaigns", query: {}, headers: {}, ...req } as never,
    {} as never,
    next,
  );
  expect(next).toHaveBeenCalledOnce();
  return warn.mock.calls.filter((c) => String(c[0]).includes(LEGACY_LEG_KEY_MARKER));
}

afterEach(() => vi.restoreAllMocks());

describe("legacy-outbound-leg-key log", () => {
  it("logs ONE line for a legacy spelling on an outbound feature, naming key, route and caller", () => {
    const lines = run({
      body: { featureSlug: COLD, legKey: OLD_REPLY, offerId: "o" },
      headers: { "x-run-id": "run-1", "x-org-id": "org-1" },
    });
    expect(lines).toHaveLength(1);
    const detail = JSON.parse(lines[0][1] as string);
    expect(detail.route).toBe("/campaigns");
    expect(detail.keys).toEqual([{ path: "body.legKey", legKey: OLD_REPLY, featureSlug: COLD }]);
    expect(detail.caller).toMatchObject({ runId: "run-1", orgId: "org-1" });
  });

  it("logs one line even when a request carries several legacy keys", () => {
    const lines = run({ query: { featureSlug: COLD, legKey: OLD_VISIT }, body: { legKey: OLD_REPLY } });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0][1] as string).keys).toHaveLength(2);
  });

  it("logs nothing for the new spelling", () => {
    expect(run({ body: { featureSlug: COLD, legKey: NEW_REPLY } })).toHaveLength(0);
  });

  it("logs nothing for a non-outbound start_to_* leg (google-ads)", () => {
    expect(run({ body: { featureSlug: ADS, legKey: OLD_VISIT } })).toHaveLength(0);
    expect(run({ query: { legKey: OLD_VISIT }, headers: { "x-feature-slug": ADS } })).toHaveLength(0);
  });

  it("reads the channel from x-feature-slug when the body states none", () => {
    expect(run({ query: { legKey: OLD_REPLY }, headers: { "x-feature-slug": COLD } })).toHaveLength(1);
  });

  it("logs a channel-less legacy filter (it still widens to outbound rows)", () => {
    const keys = findLegacyOutboundLegKeys({ query: { legKey: OLD_REPLY } }, null);
    expect(keys).toEqual([{ path: "query.legKey", legKey: OLD_REPLY, featureSlug: null }]);
  });

  it("finds a legacy leg embedded in a combination key, by the part's own channel", () => {
    expect(findLegacyOutboundLegKeys({ body: { combinationKeys: [`${OLD_REPLY}@${COLD}+conversation_to_booking_call@ai-instant-call`] } }, ADS))
      .toEqual([{ path: "body.combinationKeys[0]", legKey: OLD_REPLY, featureSlug: COLD }]);
    expect(findLegacyOutboundLegKeys({ body: { combinationKeys: [`${OLD_VISIT}@${ADS}`] } }, COLD)).toEqual([]);
  });

  it("uses each nested item's own featureSlug", () => {
    const keys = findLegacyOutboundLegKeys({
      body: { items: [{ featureSlug: ADS, legKey: OLD_VISIT }, { featureSlug: COLD, legKey: OLD_VISIT }] },
    }, null);
    expect(keys).toEqual([{ path: "body.items[1].legKey", legKey: OLD_VISIT, featureSlug: COLD }]);
  });

  it("never blocks the request when nothing matches or the body is absent", () => {
    expect(run({ body: undefined })).toHaveLength(0);
  });
});
