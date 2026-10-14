import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// This file is about the REAL client: the fleet-wide stub in tests/setup.ts is lifted here.
vi.unmock("../../src/lib/sourcing-origins-client.js");

import {
  deriveSourcingMap,
  readSourcingMap,
  resetSourcingMapCache,
  SOURCING_MAP_FRESH_MS,
  SOURCING_MAP_STALE_MAX_MS,
  SourcingMapUnavailableError,
} from "../../src/lib/sourcing-origins-client.js";
import { isSourcedChannel } from "../../src/lib/source-campaigns.js";

/** features-service `GET /public/sourcing-origins`, as served in prod on 2026-10-12. */
const PROD = JSON.parse(readFileSync(fileURLToPath(new URL("../fixtures/features-sourcing-origins.json", import.meta.url)), "utf8"));

/**
 * The hand-kept tables this service held until 2026-10-12 (src/lib/source-campaigns.ts at v0.75.42), frozen here as
 * the reference the read must reproduce byte for byte (order included) for every channel features lists today.
 */
const SEARCH_AND_SIGNAL = ["sourcing-apollo-cold-filters", "sourcing-apollo-buying-signals", "sourcing-linkedin-engagement-signals", "sourcing-apify-search"];
const LEGACY_ORIGINS: Record<string, string[]> = {
  "sales-cold-email-outreach": [...SEARCH_AND_SIGNAL, "sourcing-crm-contacts"],
  "feedback-request-cold-email-outreach": SEARCH_AND_SIGNAL,
  "sales-crm-email-outreach": ["sourcing-crm-contacts"],
  "cold-whatsapp-outreach": ["sourcing-crm-contacts"],
};
const LEGACY_FEEDING: Record<string, string[]> = Object.fromEntries(
  Object.entries(LEGACY_ORIGINS).map(([c, o]) => [c, o.length > 1 ? [...o, "lead-sourcing"] : [...o]]),
);
const LEGACY_DEFAULT: Record<string, string> = {
  "sales-cold-email-outreach": "sourcing-apollo-cold-filters",
  "feedback-request-cold-email-outreach": "sourcing-apollo-cold-filters",
  "sales-crm-email-outreach": "sourcing-crm-contacts",
  "cold-whatsapp-outreach": "sourcing-crm-contacts",
};

function answer(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

const fetchMock = vi.fn();

beforeEach(() => {
  resetSourcingMapCache();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("deriveSourcingMap: byte-identical to the retired copy", () => {
  it("reproduces every table, order included, for features-service's prod answer", () => {
    const map = deriveSourcingMap(PROD);
    expect(map.originsByChannel).toEqual(LEGACY_ORIGINS);
    expect(map.feedingByChannel).toEqual(LEGACY_FEEDING);
    expect(map.defaultOriginByChannel).toEqual(LEGACY_DEFAULT);
  });

  it("the default origin is the channel's live origin with the lowest displayOrder; none live = none", () => {
    const body = structuredClone(PROD);
    body.originsByChannel["retired-only-outreach"] = ["sourcing-apify-search"];
    body.originsByChannel["sales-crm-email-outreach"] = ["sourcing-crm-contacts", "sourcing-apollo-buying-signals"];
    const map = deriveSourcingMap(body);
    expect(map.defaultOriginByChannel["retired-only-outreach"]).toBeUndefined();
    expect(map.feedingByChannel["retired-only-outreach"]).toEqual(["sourcing-apify-search"]);
    expect(map.defaultOriginByChannel["sales-crm-email-outreach"]).toBe("sourcing-apollo-buying-signals");
  });

  it("refuses an answer missing the map", () => {
    expect(() => deriveSourcingMap({ origins: [] })).toThrow();
  });
});

describe("a channel features-service starts sourcing is sourced here with no code change", () => {
  it("a new channel -> origin pair feeds and births its default", async () => {
    const body = structuredClone(PROD);
    body.originsByChannel["cold-sms-outreach"] = ["sourcing-crm-contacts"];
    fetchMock.mockResolvedValue(answer(body));

    expect(await isSourcedChannel("cold-sms-outreach")).toBe(true);
    const map = await readSourcingMap();
    expect(map.feedingByChannel["cold-sms-outreach"]).toEqual(["sourcing-crm-contacts"]);
    expect(map.defaultOriginByChannel["cold-sms-outreach"]).toBe("sourcing-crm-contacts");
    expect(await isSourcedChannel("ai-meeting-booking")).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://features.test.local/public/sourcing-origins");
  });
});

describe("cache and failure policy", () => {
  it("serves a fresh answer without re-reading, then re-reads in the background once it is a minute old", async () => {
    fetchMock.mockResolvedValue(answer(PROD));
    const t0 = Date.now();
    await readSourcingMap(t0);
    await readSourcingMap(t0 + SOURCING_MAP_FRESH_MS - 1);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const body = structuredClone(PROD);
    body.originsByChannel["cold-sms-outreach"] = ["sourcing-crm-contacts"];
    fetchMock.mockResolvedValue(answer(body));
    // Past fresh: the cached answer is served at once, the re-read lands for the next caller.
    const stale = await readSourcingMap(Date.now() + SOURCING_MAP_FRESH_MS);
    expect(stale.feedingByChannel["cold-sms-outreach"]).toBeUndefined();
    await vi.waitFor(async () => expect((await readSourcingMap()).feedingByChannel["cold-sms-outreach"]).toEqual(["sourcing-crm-contacts"]));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("a failed re-read keeps serving the last good answer, loud", async () => {
    fetchMock.mockResolvedValueOnce(answer(PROD));
    await readSourcingMap();
    fetchMock.mockResolvedValue(answer({ error: "down" }, 503));
    const map = await readSourcingMap(Date.now() + SOURCING_MAP_FRESH_MS);
    expect(map.feedingByChannel["cold-whatsapp-outreach"]).toEqual(["sourcing-crm-contacts"]);
    await vi.waitFor(() => expect(console.error).toHaveBeenCalledWith(expect.stringContaining("re-read FAILED")));
  });

  it("COLD failure throws: never read as 'no origins'", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(readSourcingMap()).rejects.toBeInstanceOf(SourcingMapUnavailableError);
    await expect(isSourcedChannel("cold-whatsapp-outreach")).rejects.toBeInstanceOf(SourcingMapUnavailableError);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("UNREADABLE"));
  });

  it("an hour of failures stops serving the old answer", async () => {
    fetchMock.mockResolvedValueOnce(answer(PROD));
    await readSourcingMap();
    fetchMock.mockResolvedValue(answer({}, 500));
    await expect(readSourcingMap(Date.now() + SOURCING_MAP_STALE_MAX_MS + 1)).rejects.toBeInstanceOf(SourcingMapUnavailableError);
  });
});
