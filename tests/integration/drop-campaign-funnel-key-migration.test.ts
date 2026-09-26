import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "../../src/db/index.js";
import { cleanTestData, closeDb, insertTestCampaign, randomId } from "../helpers/test-db.js";

/**
 * Wave C3 drops `campaigns.funnel_key`. The schema no longer declares the column, so each test
 * re-adds it to reproduce the shape production holds, then applies the migration file itself.
 */
const TAG = "0060_drop_campaign_funnel_key";
const MIGRATION = readFileSync(join(process.cwd(), "drizzle", `${TAG}.sql`), "utf8");
const SNAPSHOT = "campaigns_funnel_key_snapshot_20260926";

async function hasFunnelColumn(): Promise<boolean> {
  const rows = await sql<{ n: string }[]>`
    SELECT count(*)::text AS n FROM information_schema.columns
    WHERE table_name = 'campaigns' AND column_name = 'funnel_key'
  `;
  return rows[0]!.n === "1";
}

async function setFunnel(id: string, funnel: string) {
  await sql.unsafe(`UPDATE campaigns SET funnel_key = $1 WHERE id = $2`, [funnel, id]);
}

async function legOf(id: string): Promise<string | null> {
  const rows = await sql<{ leg_key: string | null }[]>`SELECT leg_key FROM campaigns WHERE id = ${id}`;
  return rows[0]!.leg_key;
}

describe(`migration ${TAG}`, () => {
  beforeEach(async () => {
    await cleanTestData();
    await sql.unsafe(`ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS funnel_key text`);
    await sql.unsafe(`DROP TABLE IF EXISTS ${SNAPSHOT}`);
  });

  afterAll(async () => {
    await sql.unsafe(`ALTER TABLE campaigns DROP COLUMN IF EXISTS funnel_key`);
    await sql.unsafe(`DROP TABLE IF EXISTS ${SNAPSHOT}`);
    await cleanTestData();
    await closeDb();
  });

  it("refuses to drop a column holding values when no snapshot exists", async () => {
    const org = randomId();
    const row = await insertTestCampaign(org, { status: "stopped", brandId: randomId(), acquisitionChannel: "cold_email" });
    await setFunnel(row.id, "form_magnet");

    await expect(sql.unsafe(MIGRATION)).rejects.toThrow(/no snapshot/);
    expect(await hasFunnelColumn()).toBe(true);
  });

  it("drops a populated column once its snapshot exists, and a replay is a no-op", async () => {
    const row = await insertTestCampaign(randomId(), { status: "stopped", brandId: randomId(), acquisitionChannel: "cold_email", legKey: "start_to_website_visit" });
    await setFunnel(row.id, "form_magnet");

    await sql.unsafe(`CREATE TABLE ${SNAPSHOT} AS SELECT id, funnel_key, leg_key FROM campaigns WHERE funnel_key IS NOT NULL`);
    await sql.unsafe(MIGRATION);

    expect(await hasFunnelColumn()).toBe(false);
    expect(await legOf(row.id)).toBe("start_to_website_visit");

    await sql.unsafe(MIGRATION);
    expect(await hasFunnelColumn()).toBe(false);
  });

  it("drops an empty column without needing a snapshot", async () => {
    await insertTestCampaign(randomId(), { status: "stopped" });
    await sql.unsafe(MIGRATION);
    expect(await hasFunnelColumn()).toBe(false);
  });

  it("is registered in the migrations journal", () => {
    const journal = JSON.parse(readFileSync(join(process.cwd(), "drizzle", "meta", "_journal.json"), "utf8"));
    expect(journal.entries.some((e: { tag: string }) => e.tag === TAG)).toBe(true);
  });
});
