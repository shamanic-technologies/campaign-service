import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SALES_FUNNEL_KEYS } from "../../src/lib/sales-funnel-vocabulary.js";
import { SALES_OUTREACH_FEATURE_SLUGS } from "../../src/lib/sales-outreach-campaign.js";

const TAG = "0045_owner_funnel_decision_f4d73dab";
const SQL = readFileSync(join(process.cwd(), "drizzle", `${TAG}.sql`), "utf8");

// The pair the owner answered for, and the one campaign of it that is alive.
const ORG_ID = "f0420eb5-8f72-4f0a-a150-f473746df1e6";
const BRAND_ID = "f4d73dab-1f9d-49b2-b16e-63ecde76a5eb";
const LIVE_CAMPAIGN_ID = "d5a759bf-6729-4325-b3cd-f1ff357d0538";

/** The SQL with every comment line stripped — the statements, and nothing the prose says. */
const STATEMENTS = SQL.split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n");

function uuidsIn(text: string): Set<string> {
  return new Set(text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) ?? []);
}

describe("the funnel of a brand that sells through several is UNKNOWN until its owner answers it", () => {
  it("names exactly one (org, brand) pair — every other brand in the same unattributable state is untouched", () => {
    const uuids = uuidsIn(STATEMENTS);
    expect(uuids).toEqual(new Set([ORG_ID, BRAND_ID, LIVE_CAMPAIGN_ID]));
  });

  it("scopes to the sales-outreach feature family — a brand's PR / AI-visibility / VC campaigns run no sales funnel", () => {
    for (const slug of SALES_OUTREACH_FEATURE_SLUGS) {
      expect(STATEMENTS).toContain(`'${slug}'`);
    }
    const quotedFeatureSlugs = STATEMENTS.match(/'[a-z]+(?:-[a-z]+)+'/g) ?? [];
    for (const quoted of quotedFeatureSlugs) {
      expect(SALES_OUTREACH_FEATURE_SLUGS.has(quoted.slice(1, -1))).toBe(true);
    }
  });

  it("writes only canonical funnel tokens, and gives the live campaign the meeting funnel", () => {
    const written = STATEMENTS.match(/'(sales_meetings_from_\w+|website_purchases|form_magnet|reply_meeting|visit_\w+)'/g) ?? [];
    expect(written.length).toBeGreaterThan(0);
    for (const token of written) {
      expect(SALES_FUNNEL_KEYS as readonly string[]).toContain(token.slice(1, -1));
    }
    expect(STATEMENTS).toMatch(
      new RegExp(`'${LIVE_CAMPAIGN_ID}'[\\s\\S]{0,80}'sales_meetings_from_conversation'`),
    );
    // Everything else of the pair — its stopped history — states the funnel it ran before.
    expect(STATEMENTS).toMatch(/ELSE\s+'website_purchases'/);
  });

  it("re-running it is a no-op: every write is guarded on the funnel still being NULL", () => {
    // One INSERT of the decision rows, one UPDATE of the campaigns. Both guarded.
    expect(STATEMENTS).toMatch(/ON CONFLICT \("campaign_id"\) DO NOTHING/);
    const campaignUpdates = STATEMENTS.match(/UPDATE "campaigns"[\s\S]*?;/g) ?? [];
    expect(campaignUpdates).toHaveLength(1);
    for (const stmt of campaignUpdates) {
      expect(stmt).toMatch(/"funnel_key" IS NULL/);
    }
    // The decision rows are selected on the same guard, so a second run records nothing new.
    expect(STATEMENTS).toMatch(/INSERT INTO "campaign_funnel_owner_decisions"[\s\S]*?"funnel_key" IS NULL[\s\S]*?;/);
  });

  it("is reversible: it records the value it replaced, under a source tag an operator can undo by", () => {
    expect(STATEMENTS).toMatch(/CREATE TABLE IF NOT EXISTS "campaign_funnel_owner_decisions"/);
    expect(STATEMENTS).toContain('"previous_funnel_key"');
    expect(STATEMENTS).toContain(`'${TAG}'`);
    // The undo an operator runs is spelled out in the file itself.
    expect(SQL).toMatch(/SET funnel_key = d\.previous_funnel_key/);
  });

  it("touches the funnel and nothing else — no status, schedule, budget, goal or deletion", () => {
    expect(STATEMENTS).not.toMatch(/\bDELETE\b|\bTRUNCATE\b|\bDROP\b/i);
    for (const column of ["status", "next_run_at", "goal", "daily_budget_cents", "brand_ids"]) {
      expect(STATEMENTS).not.toMatch(new RegExp(`SET[\\s\\S]{0,200}"${column}"\\s*=`));
    }
    // Only `funnel_key` and the write stamp move on a campaign row.
    expect(STATEMENTS).toMatch(/SET "funnel_key" = d\."funnel_key",\s*\n\s*"updated_at" = now\(\)/);
  });

  it("is registered in the migrations journal", () => {
    const journal = JSON.parse(readFileSync(join(process.cwd(), "drizzle", "meta", "_journal.json"), "utf8"));
    expect(journal.entries.some((e: { tag: string }) => e.tag === TAG)).toBe(true);
  });
});
