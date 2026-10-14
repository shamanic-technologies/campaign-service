import { describe, it, expect, vi } from "vitest";
import type { Request, Response } from "express";
import { refuseRetiredAudienceIds } from "../../src/lib/retired-audience-ids.js";

function run(body: unknown) {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  const next = vi.fn();
  refuseRetiredAudienceIds({ body } as Request, { status } as unknown as Response, next);
  return { status, json, next };
}

describe("refuseRetiredAudienceIds — the per-campaign audience subset is retired (2026-10-14)", () => {
  it("refuses a stated list by name, an empty one included", () => {
    for (const audienceIds of [["aud-1"], []]) {
      const { status, json, next } = run({ name: "x", audienceIds });
      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith(expect.objectContaining({ reason: "audience_ids_retired" }));
      expect(next).not.toHaveBeenCalled();
    }
  });

  it("lets through a body that omits it or states null (what every campaign does now)", () => {
    expect(run({ name: "x" }).next).toHaveBeenCalled();
    expect(run({ name: "x", audienceIds: null }).next).toHaveBeenCalled();
    expect(run(undefined).next).toHaveBeenCalled();
  });
});
