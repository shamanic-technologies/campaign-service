import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { funnelForGoal, goalsWithAFunnel } from "../../src/lib/sales-funnel-vocabulary.js";
import { resolveCampaignFunnelKey } from "../../src/lib/funnel-adoption.js";

describe("the funnel a goal means", () => {
  it("form submissions run the Form Magnet funnel", () => {
    expect(funnelForGoal("formSubmission")).toBe("visit_form");
    expect(funnelForGoal("form_submissions")).toBe("visit_form");
  });

  it("a booked meeting runs Sales Meeting from Conversation — cold email replies, not the website", () => {
    expect(funnelForGoal("meetingBooked")).toBe("reply_meeting");
    expect(funnelForGoal("booked_meetings")).toBe("reply_meeting");
    expect(funnelForGoal("sales_meetings")).toBe("reply_meeting");
  });

  it("a website purchase runs Website Purchase, under either spelling of that chain", () => {
    expect(funnelForGoal("websitePurchase")).toBe("visit_signup");
    expect(funnelForGoal("website_purchase")).toBe("visit_signup");
    expect(funnelForGoal("purchase")).toBe("visit_signup");
    expect(funnelForGoal("sales")).toBe("visit_signup");
    expect(funnelForGoal("signup")).toBe("visit_signup");
    expect(funnelForGoal("signups")).toBe("visit_signup");
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

  it("emits only funnel keys brand-service's catalogue declares", () => {
    const catalogue = new Set(["reply_meeting", "visit_meeting", "visit_signup", "visit_form"]);
    for (const goal of goalsWithAFunnel()) {
      expect(catalogue.has(funnelForGoal(goal)!)).toBe(true);
    }
  });
});

describe("resolveCampaignFunnelKey", () => {
  it("prefers the campaign's own goal over its brand's", () => {
    expect(resolveCampaignFunnelKey("meetingBooked", "formSubmission")).toBe("reply_meeting");
  });

  it("falls back to the brand's goal when the campaign states none", () => {
    expect(resolveCampaignFunnelKey(null, "formSubmission")).toBe("visit_form");
  });

  it("stays null when neither names a funnel", () => {
    expect(resolveCampaignFunnelKey(null, "combinedSales")).toBeNull();
    expect(resolveCampaignFunnelKey(null, null)).toBeNull();
  });
});

describe("0042_campaign_funnel_from_goal migration", () => {
  const sql = readFileSync(
    resolve(__dirname, "../../drizzle/0042_campaign_funnel_from_goal.sql"),
    "utf-8",
  );

  it("writes the same funnel the code reads for every goal that names one", () => {
    for (const goal of goalsWithAFunnel()) {
      expect(sql).toContain(`'${goal}'`);
      expect(sql).toContain(`THEN '${funnelForGoal(goal)}'`);
    }
  });

  it("only touches rows that state no funnel yet — idempotent, re-runnable", () => {
    expect(sql).toContain('"funnel_key" IS NULL');
  });

  it("never deletes, stops or reschedules a campaign", () => {
    const statements = sql
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("--"))
      .join("\n");
    const upper = statements.toUpperCase();
    expect(upper).not.toContain("DELETE");
    expect(upper).not.toContain("DROP");
    expect(upper).not.toContain("STATUS");
    expect(upper).not.toContain("NEXT_RUN_AT");
  });

  it("maps no goal that names several funnels or stops short of a paid client", () => {
    for (const goal of ["combinedSales", "websiteVisit", "positiveReply", "whatsappConversation"]) {
      expect(sql).not.toContain(`'${goal}'`);
    }
  });
});
