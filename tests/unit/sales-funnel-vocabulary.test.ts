import { describe, it, expect } from "vitest";
import {
  SALES_FUNNEL_KEYS,
  acceptedFunnelKeys,
  toFunnelKey,
} from "../../src/lib/sales-funnel-vocabulary.js";

const PRE_RENAME = {
  visit_form: "form_magnet",
  reply_meeting: "sales_meetings_from_conversation",
  visit_meeting: "sales_meetings_from_website",
  visit_signup: "website_purchases",
} as const;

import { readFileSync } from "fs";
import { resolve } from "path";

describe("the funnel a value names", () => {
  it("passes a canonical key through untouched", () => {
    for (const key of SALES_FUNNEL_KEYS) {
      expect(toFunnelKey(key)).toBe(key);
    }
  });

  it("resolves every pre-rename spelling — billing still emits them today", () => {
    for (const [legacy, canonical] of Object.entries(PRE_RENAME)) {
      expect(toFunnelKey(legacy)).toBe(canonical);
    }
  });

  it("never invents a funnel for a token no catalogue names", () => {
    expect(toFunnelKey("whatsapp_funnel")).toBeNull();
    expect(toFunnelKey(null)).toBeNull();
    expect(toFunnelKey(undefined)).toBeNull();
    expect(toFunnelKey("")).toBeNull();
  });

  it("accepts the canonical four plus the four pre-rename spellings, and nothing else", () => {
    expect(new Set(acceptedFunnelKeys())).toEqual(
      new Set([...SALES_FUNNEL_KEYS, ...Object.keys(PRE_RENAME)]),
    );
  });
});


describe("the goal vocabulary is gone from this module", () => {
  it("exports no goal→funnel map, no funnel→goal alias, and names no goal at all", async () => {
    const mod: Record<string, unknown> = await import("../../src/lib/sales-funnel-vocabulary.js");
    expect(Object.keys(mod).sort()).toEqual(
      ["SALES_FUNNEL_KEYS", "acceptedFunnelKeys", "toFunnelKey"].sort(),
    );
    const source = readFileSync(
      resolve(__dirname, "../../src/lib/sales-funnel-vocabulary.ts"),
      "utf-8",
    );
    const code = source
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("*") && !l.trimStart().startsWith("/*") && !l.trimStart().startsWith("//"))
      .join("\n");
    expect(code).not.toMatch(/\bgoal\b/i);
    // (`signup` is skipped: it is a substring of the legacy funnel key `visit_signup`.)
    for (const goal of ["meetingBooked", "formSubmission", "websitePurchase", "combinedSales"]) {
      expect(code).not.toContain(goal);
    }
  });
});
