import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SALES_FUNNEL_KEYS } from "../../src/lib/sales-funnel-vocabulary.js";

const TAG = "0047_live_campaign_funnel_from_declaration";
const SQL = readFileSync(join(process.cwd(), "drizzle", `${TAG}.sql`), "utf8");

/** The SQL with every comment line stripped — the statements, and nothing the prose says. */
const STATEMENTS = SQL.split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n");

// The three live campaigns this one-off writes, and the value each replaces. Measured in prod on
// 2026-08-12: two carried NO funnel, one carried a funnel derived from a goal by migration 0042
// which its (org, brand) pair does not declare and billing does not fund.
const WRITES: Array<[campaignId: string, previous: string | null, funnel: string]> = [
  ["9bc27ed7-2fd5-4fb4-b523-026eb919e8ae", null, "sales_meetings_from_conversation"],
  ["3922c8e1-3405-46af-8a56-1eef3f221b19", null, "sales_meetings_from_conversation"],
  [
    "2d750eda-1ff5-4aed-b3df-374dc58f9ee5",
    "sales_meetings_from_conversation",
    "sales_meetings_from_website",
  ],
];

function uuidsIn(text: string): Set<string> {
  return new Set(text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) ?? []);
}

describe("every LIVE campaign states its funnel — the one-off that writes the last three", () => {
  it("names EXACTLY the three campaigns whose pair declares exactly one funnel, and nothing else", () => {
    expect(uuidsIn(STATEMENTS)).toEqual(new Set(WRITES.map(([id]) => id)));
  });

  it("writes each campaign the funnel its (org, brand) pair declares, guarded on the value it replaces", () => {
    for (const [campaignId, previous, funnel] of WRITES) {
      const row = new RegExp(
        `\\('${campaignId}',\\s*${previous === null ? "NULL" : `'${previous}'`},\\s*'${funnel}'\\)`,
      );
      expect(STATEMENTS).toMatch(row);
    }
  });

  it("writes only canonical funnel tokens — never a pre-rename spelling", () => {
    const written = STATEMENTS.match(/'(sales_meetings_from_\w+|website_purchases|form_magnet|reply_meeting|visit_\w+)'/g) ?? [];
    expect(written.length).toBeGreaterThan(0);
    for (const token of written) {
      expect(SALES_FUNNEL_KEYS as readonly string[]).toContain(token.slice(1, -1));
    }
  });

  it("touches ONGOING campaigns only — a stopped campaign is history", () => {
    expect(STATEMENTS).toMatch(/c\."status" = 'ongoing'/);
  });

  it("re-running it is a no-op: every write is guarded on the exact value it replaces", () => {
    expect(STATEMENTS).toMatch(/ON CONFLICT \("campaign_id"\) DO NOTHING/);
    const campaignUpdates = STATEMENTS.match(/UPDATE "campaigns"[\s\S]*?;/g) ?? [];
    expect(campaignUpdates).toHaveLength(1);
    expect(campaignUpdates[0]).toMatch(/"funnel_key" IS NOT DISTINCT FROM d\."previous_funnel_key"/);
    // The decision rows are selected on the same guard, so a second run records nothing new.
    expect(STATEMENTS).toMatch(
      /INSERT INTO "campaign_funnel_owner_decisions"[\s\S]*?IS NOT DISTINCT FROM v\."expected_funnel_key"[\s\S]*?;/,
    );
  });

  it("is reversible: it records the value it replaced under a source tag an operator can undo by", () => {
    expect(STATEMENTS).toContain('"previous_funnel_key"');
    expect(STATEMENTS).toContain(`'${TAG}'`);
    expect(SQL).toMatch(/SET funnel_key = d\.previous_funnel_key/);
  });

  it("touches the funnel and nothing else — no status, schedule, budget, goal or deletion", () => {
    expect(STATEMENTS).not.toMatch(/\bDELETE\b|\bTRUNCATE\b|\bDROP\b/i);
    for (const column of ["status", "next_run_at", "goal", "daily_budget_cents", "brand_ids"]) {
      expect(STATEMENTS).not.toMatch(new RegExp(`SET[\\s\\S]{0,200}"${column}"\\s*=`));
    }
    expect(STATEMENTS).toMatch(/SET "funnel_key" = d\."funnel_key",\s*\n\s*"updated_at" = now\(\)/);
  });

  it("is registered in the migrations journal", () => {
    const journal = JSON.parse(readFileSync(join(process.cwd(), "drizzle", "meta", "_journal.json"), "utf8"));
    expect(journal.entries.some((e: { tag: string }) => e.tag === TAG)).toBe(true);
  });
});
