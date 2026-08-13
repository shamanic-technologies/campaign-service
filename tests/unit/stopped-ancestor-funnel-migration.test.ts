import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const TAG = "0048_stopped_ancestors_state_their_campaign_funnel";
const SQL = readFileSync(join(process.cwd(), "drizzle", `${TAG}.sql`), "utf8");

/** The SQL with every comment line stripped — the statements, and nothing the prose says. */
const STATEMENTS = SQL.split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n");

function uuidsIn(text: string): Set<string> {
  return new Set(text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) ?? []);
}

describe("a stopped ancestor answers to its live campaign's identity — the migration that states it", () => {
  it("folds by RULE, never by a list of ids: no campaign, org or brand is named in the statements", () => {
    expect(uuidsIn(STATEMENTS)).toEqual(new Set());
  });

  it("keys the rule on (org, brand, acquisition channel) — the identity, minus the workflow", () => {
    expect(STATEMENTS).toMatch(
      /GROUP BY "org_id", "brand_id", "acquisition_channel"/,
    );
    for (const column of ["org_id", "brand_id", "acquisition_channel"]) {
      expect(STATEMENTS).toMatch(new RegExp(`c\\."${column}" = l\\."${column}"`));
    }
  });

  it("requires EXACTLY ONE live campaign stating a funnel — zero and several are left alone", () => {
    expect(STATEMENTS).toMatch(/HAVING count\(\*\) = 1/);
    // The candidate live set is ongoing campaigns that STATE a funnel; a live campaign stating
    // none cannot be the funnel an ancestor is folded onto.
    expect(STATEMENTS).toMatch(/"status" = 'ongoing'[\s\S]{0,120}"funnel_key" IS NOT NULL/);
  });

  it("fills an ABSENCE only, on a STOPPED row only — a stated funnel is never restated", () => {
    const guarded = STATEMENTS.match(/c\."status" = 'stopped'\s*\n\s*AND c\."funnel_key" IS NULL/g) ?? [];
    // Once in the decision INSERT, once in the campaign UPDATE.
    expect(guarded).toHaveLength(2);
  });

  it("never crosses orgs on a shared brand row — the org is part of every join", () => {
    // A brand row is a global identity; the join is on the pair, so another org's campaigns on the
    // same brand can never be folded onto this org's live funnel.
    expect(STATEMENTS).toMatch(/JOIN "one_live_funnel" l\s*\n\s*ON c\."org_id" = l\."org_id"/);
  });

  it("re-running it is a no-op: every write is guarded on the funnel still being absent", () => {
    expect(STATEMENTS).toMatch(/ON CONFLICT \("campaign_id"\) DO NOTHING/);
    const campaignUpdates = STATEMENTS.match(/UPDATE "campaigns"[\s\S]*?;/g) ?? [];
    expect(campaignUpdates).toHaveLength(1);
    expect(campaignUpdates[0]).toMatch(/c\."funnel_key" IS NULL/);
  });

  it("is reversible: it records the value it replaced, under a source tag an operator can undo by", () => {
    expect(STATEMENTS).toContain('"previous_funnel_key"');
    expect(STATEMENTS).toContain(`'${TAG}'`);
    expect(SQL).toMatch(/SET funnel_key = d\.previous_funnel_key/);
  });

  it("touches the funnel and nothing else — no status, stop_reason, schedule, budget, goal or deletion", () => {
    expect(STATEMENTS).not.toMatch(/\bDELETE\b|\bTRUNCATE\b|\bDROP\b/i);
    for (const column of ["status", "stop_reason", "next_run_at", "goal", "daily_budget_cents", "brand_ids", "audience_ids"]) {
      expect(STATEMENTS).not.toMatch(new RegExp(`SET[\\s\\S]{0,200}"${column}"\\s*=`));
    }
    expect(STATEMENTS).toMatch(/SET "funnel_key" = d\."funnel_key",\s*\n\s*"updated_at" = now\(\)/);
  });

  it("is registered in the migrations journal", () => {
    const journal = JSON.parse(readFileSync(join(process.cwd(), "drizzle", "meta", "_journal.json"), "utf8"));
    expect(journal.entries.some((e: { tag: string }) => e.tag === TAG)).toBe(true);
  });
});
