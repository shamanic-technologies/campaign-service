import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import {
  SALES_FUNNEL_KEYS,
  acceptedFunnelKeys,
  funnelForGoal,
  goalForFunnel,
  goalsWithAFunnel,
  toFunnelKey,
} from "../../src/lib/sales-funnel-vocabulary.js";
import { resolveCampaignFunnelKey } from "../../src/lib/funnel-adoption.js";

const PRE_RENAME = {
  visit_form: "form_magnet",
  reply_meeting: "sales_meetings_from_conversation",
  visit_meeting: "sales_meetings_from_website",
  visit_signup: "website_purchases",
} as const;

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
    expect(toFunnelKey("whatsapp_chain")).toBeNull();
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

describe("the funnel a retired goal meant", () => {
  it("form submissions run the Form Magnet funnel", () => {
    expect(funnelForGoal("formSubmission")).toBe("form_magnet");
    expect(funnelForGoal("form_submissions")).toBe("form_magnet");
  });

  it("a booked meeting runs Sales Meeting from Conversation — cold email replies, not the website", () => {
    expect(funnelForGoal("meetingBooked")).toBe("sales_meetings_from_conversation");
    expect(funnelForGoal("booked_meetings")).toBe("sales_meetings_from_conversation");
    expect(funnelForGoal("sales_meetings")).toBe("sales_meetings_from_conversation");
  });

  it("a website purchase runs Website Purchases, under either spelling of that chain", () => {
    expect(funnelForGoal("websitePurchase")).toBe("website_purchases");
    expect(funnelForGoal("website_purchase")).toBe("website_purchases");
    expect(funnelForGoal("purchase")).toBe("website_purchases");
    expect(funnelForGoal("sales")).toBe("website_purchases");
    expect(funnelForGoal("signup")).toBe("website_purchases");
    expect(funnelForGoal("signups")).toBe("website_purchases");
  });

  it("never invents a funnel for a goal that names none", () => {
    for (const goal of ["combinedSales", "websiteVisit", "positiveReply", "whatsappConversation"]) {
      expect(funnelForGoal(goal)).toBeNull();
    }
    expect(funnelForGoal(null)).toBeNull();
    expect(funnelForGoal(undefined)).toBeNull();
    expect(funnelForGoal("")).toBeNull();
    expect(funnelForGoal("something-nobody-has-named")).toBeNull();
  });

  it("emits only canonical funnel keys — never a pre-rename spelling", () => {
    const canonical = new Set<string>(SALES_FUNNEL_KEYS);
    for (const goal of goalsWithAFunnel()) {
      expect(canonical.has(funnelForGoal(goal)!)).toBe(true);
    }
  });
});

describe("the goal a funnel corresponds to — a legacy alias, never read back", () => {
  it("answers what brand-service's catalogue put on each funnel before the retirement", () => {
    expect(goalForFunnel("sales_meetings_from_conversation")).toBe("meetingBooked");
    expect(goalForFunnel("sales_meetings_from_website")).toBe("meetingBooked");
    expect(goalForFunnel("website_purchases")).toBe("signup");
    expect(goalForFunnel("form_magnet")).toBe("formSubmission");
  });

  it("answers the same for a pre-rename spelling of the same funnel", () => {
    for (const [legacy, canonical] of Object.entries(PRE_RENAME)) {
      expect(goalForFunnel(legacy)).toBe(goalForFunnel(canonical));
    }
  });

  it("is a real alias: every funnel it names round-trips to a canonical funnel", () => {
    for (const key of SALES_FUNNEL_KEYS) {
      const goal = goalForFunnel(key)!;
      // Lossy on purpose — both meeting funnels answer one goal — so the round trip lands on A
      // funnel, not necessarily the same one. That loss is exactly why nothing reads it back.
      expect(SALES_FUNNEL_KEYS).toContain(funnelForGoal(goal));
    }
  });

  it("names no funnel for a token no catalogue lists", () => {
    expect(goalForFunnel("whatsapp_chain")).toBeNull();
    expect(goalForFunnel(null)).toBeNull();
  });
});

describe("resolveCampaignFunnelKey", () => {
  it("prefers the campaign's own goal over its brand's", () => {
    expect(resolveCampaignFunnelKey("meetingBooked", "formSubmission")).toBe(
      "sales_meetings_from_conversation",
    );
  });

  it("falls back to the brand's goal when the campaign states none", () => {
    expect(resolveCampaignFunnelKey(null, "formSubmission")).toBe("form_magnet");
  });

  it("stays null when neither names a funnel", () => {
    expect(resolveCampaignFunnelKey(null, "combinedSales")).toBeNull();
    expect(resolveCampaignFunnelKey(null, null)).toBeNull();
  });
});

describe("0042 then 0043: every goal that names a funnel reaches its canonical key", () => {
  const from = (file: string) => readFileSync(resolve(__dirname, "../../drizzle", file), "utf-8");
  const sql0042 = from("0042_campaign_funnel_from_goal.sql").replace(/[ \t]+/g, " ");
  const sql0043 = from("0043_canonical_funnel_keys.sql").replace(/[ \t]+/g, " ");

  it("0042 writes the pre-rename key and 0043 renames it to what the code reads today", () => {
    for (const goal of goalsWithAFunnel()) {
      expect(sql0042).toContain(`'${goal}'`);
      const canonical = funnelForGoal(goal)!;
      const preRename = Object.entries(PRE_RENAME).find(([, c]) => c === canonical)![0];
      expect(sql0042).toContain(`THEN '${preRename}'`);
      expect(sql0043).toContain(`WHEN '${preRename}' THEN '${canonical}'`);
    }
  });

  it("0043 renames every pre-rename spelling, so no row is left on a name nothing agrees on", () => {
    for (const [legacy, canonical] of Object.entries(PRE_RENAME)) {
      expect(sql0043).toContain(`WHEN '${legacy}' THEN '${canonical}'`);
    }
  });

  it("0043 moves the provisioned NAME with the key it contains", () => {
    expect(sql0043).toContain('SET "name" = replace(');
  });

  it("neither migration deletes, stops or reschedules a campaign", () => {
    for (const sql of [sql0042, sql0043]) {
      const upper = sql
        .split("\n")
        .filter((l) => !l.trimStart().startsWith("--"))
        .join("\n")
        .toUpperCase();
      expect(upper).not.toContain("DELETE");
      expect(upper).not.toContain("DROP");
      expect(upper).not.toContain("STATUS");
      expect(upper).not.toContain("NEXT_RUN_AT");
      expect(upper).not.toContain("DAILY_BUDGET");
    }
  });

  it("maps no goal that names several funnels or stops short of a paid client", () => {
    for (const goal of ["combinedSales", "websiteVisit", "positiveReply", "whatsappConversation"]) {
      expect(sql0042).not.toContain(`'${goal}'`);
    }
  });
});
