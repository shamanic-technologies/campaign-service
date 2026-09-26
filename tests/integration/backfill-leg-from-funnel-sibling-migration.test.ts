import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "../../src/db/index.js";
import { cleanTestData, closeDb, insertTestCampaign, randomId } from "../helpers/test-db.js";

const TAG = "0059_backfill_leg_from_funnel_sibling";
const MIGRATION = readFileSync(join(process.cwd(), "drizzle", `${TAG}.sql`), "utf8");

async function legOf(id: string): Promise<string | null> {
  const rows = await sql<{ leg_key: string | null }[]>`SELECT leg_key FROM campaigns WHERE id = ${id}`;
  return rows[0]!.leg_key;
}

describe(`migration ${TAG}`, () => {
  beforeEach(async () => {
    await cleanTestData();
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("gives a stopped leg-less row the ONE leg its same-funnel sibling states, and nothing else", async () => {
    const org = randomId();
    const offer = randomId();
    const on = (brandId: string) => ({ brandId, offerId: offer, acquisitionChannel: "cold_email" });

    const brand = randomId();
    const ancestor = await insertTestCampaign(org, { ...on(brand), status: "stopped", funnelKey: "form_magnet" });
    await insertTestCampaign(org, { ...on(brand), status: "ongoing", funnelKey: "form_magnet", legKey: "start_to_website_visit" });

    // Siblings that DISAGREE on the leg: nothing is picked.
    const brand2 = randomId();
    const ambiguous = await insertTestCampaign(org, { ...on(brand2), status: "stopped", funnelKey: "sales_meetings_from_conversation" });
    await insertTestCampaign(org, { ...on(brand2), status: "stopped", funnelKey: "sales_meetings_from_conversation", legKey: "start_to_conversation" });
    await insertTestCampaign(org, { ...on(brand2), status: "stopped", funnelKey: "sales_meetings_from_conversation", legKey: "start_to_website_visit" });

    // A sibling on ANOTHER funnel is not evidence.
    const brand3 = randomId();
    const otherFunnel = await insertTestCampaign(org, { ...on(brand3), status: "stopped", funnelKey: "form_magnet" });
    await insertTestCampaign(org, { ...on(brand3), status: "stopped", funnelKey: "sales_meetings_from_conversation", legKey: "start_to_conversation" });

    // A LIVE leg-less row is not touched (only stopped history is filled).
    const brand4 = randomId();
    const liveLegless = await insertTestCampaign(org, { ...on(brand4), status: "ongoing", funnelKey: "form_magnet" });
    await insertTestCampaign(org, { ...on(brand4), status: "stopped", funnelKey: "form_magnet", legKey: "start_to_website_visit" });

    // A leg already stated is never overwritten.
    const brand5 = randomId();
    const stated = await insertTestCampaign(org, { ...on(brand5), status: "stopped", funnelKey: "form_magnet", legKey: "conversation_to_meeting_booked" });
    await insertTestCampaign(org, { ...on(brand5), status: "stopped", funnelKey: "form_magnet", legKey: "start_to_website_visit" });

    await sql.unsafe(MIGRATION);

    expect(await legOf(ancestor.id)).toBe("start_to_website_visit");
    expect(await legOf(ambiguous.id)).toBeNull();
    expect(await legOf(otherFunnel.id)).toBeNull();
    expect(await legOf(liveLegless.id)).toBeNull();
    expect(await legOf(stated.id)).toBe("conversation_to_meeting_booked");

    // Idempotent.
    await sql.unsafe(MIGRATION);
    expect(await legOf(ancestor.id)).toBe("start_to_website_visit");
    expect(await legOf(ambiguous.id)).toBeNull();
  });

  it("is registered in the migrations journal", () => {
    const journal = JSON.parse(readFileSync(join(process.cwd(), "drizzle", "meta", "_journal.json"), "utf8"));
    expect(journal.entries.some((e: { tag: string }) => e.tag === TAG)).toBe(true);
  });
});
