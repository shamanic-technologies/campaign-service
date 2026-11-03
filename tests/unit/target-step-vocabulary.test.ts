import { readFileSync } from "fs";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchChannelCatalogue } from "../../src/lib/channel-operator-client.js";
import { checkTargetStep } from "../../src/lib/sales-funnel-target.js";
import {
  TARGET_STEP_DESCRIPTION,
  TARGET_STEPS_CATALOGUE_PATH,
  TARGET_STEPS_PUBLIC_READ,
} from "../../src/lib/target-step-vocabulary.js";

// CLIENT-FRICTION-API-1103-CAMPAIGN: the served doc of `target` names the read validation makes, and the refusal
// lists exactly the keys that read returned, so documented values = accepted values by construction.

const openapi = JSON.parse(readFileSync(join(__dirname, "../../openapi.json"), "utf8"));

describe("target documentation", () => {
  for (const body of ["CreateSalesFunnelCampaignBody", "UpdateSalesFunnelCampaignBody"]) {
    it(`${body}.target says it accepts only the channel catalogue's step keys, and where to read them`, () => {
      const target = openapi.components.schemas[body].properties.target;
      expect(target.description).toBe(TARGET_STEP_DESCRIPTION);
      expect(target.description).toContain("GET /v1/public/channels");
      expect(target.description).toContain("steps[].key");
      expect(target.description).toContain("acceptedTargets");
    });
  }

  it("the documented read is the path validation fetches", () => {
    expect(TARGET_STEPS_PUBLIC_READ).toBe(`GET /v1${TARGET_STEPS_CATALOGUE_PATH}`);
  });
});

describe("documented values = accepted values", () => {
  afterEach(() => vi.unstubAllGlobals());

  const keys = ["lead_found", "meeting_booked", "paid_client", "signup"];

  it("validation reads steps[].key from the documented path and accepts every one of them, nothing else", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ channels: [], legs: [], steps: keys.map((key) => ({ key })) }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const catalogue = () => fetchChannelCatalogue();
    for (const key of keys) expect(await checkTargetStep(key, { catalogue })).toEqual({ ok: true });

    const refused = await checkTargetStep("Local shop owners in Astana found on Google Maps", { catalogue });
    expect(refused).toMatchObject({ ok: false, status: 400, body: { reason: "unknown_target_step", acceptedTargets: [...keys].sort() } });

    const url = new URL(String((fetchMock.mock.calls[0] as unknown[])[0]));
    expect(url.pathname).toBe(TARGET_STEPS_CATALOGUE_PATH);
  });
});
