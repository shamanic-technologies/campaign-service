import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "../../src/db/index.js";
import { cleanTestData, closeDb, insertTestCampaign, randomId } from "../helpers/test-db.js";

/**
 * Outbound leg-key rename, wave 2: every stored OUTBOUND leg moves to the new spelling (ongoing and
 * stopped), no other channel's leg moves, a replay is a no-op, and the 2026-09-26 snapshot follows.
 */
const TAG = "0063_outbound_leg_key_new_spelling";
const MIGRATION = readFileSync(join(process.cwd(), "drizzle", `${TAG}.sql`), "utf8");
const SNAPSHOT = "campaigns_funnel_key_snapshot_20260926";

async function legOf(id: string): Promise<string | null> {
  const rows = await sql<{ leg_key: string | null }[]>`SELECT leg_key FROM campaigns WHERE id = ${id}`;
  return rows[0]!.leg_key;
}

describe(`migration ${TAG}`, () => {
  beforeEach(async () => {
    await cleanTestData();
    await sql.unsafe(`DROP TABLE IF EXISTS ${SNAPSHOT}`);
  });

  afterAll(async () => {
    await sql.unsafe(`DROP TABLE IF EXISTS ${SNAPSHOT}`);
    await cleanTestData();
    await closeDb();
  });

  it("renames every outbound row, leaves other channels and legs alone, and replays as a no-op", async () => {
    const org = randomId();
    const brandId = randomId();
    const ongoingReply = await insertTestCampaign(org, { status: "ongoing", brandId, featureSlug: "sales-cold-email-outreach", acquisitionChannel: "cold_email", offerId: randomId(), legKey: "start_to_conversation" });
    const stoppedVisit = await insertTestCampaign(org, { status: "stopped", brandId, featureSlug: "sales-crm-email-outreach", acquisitionChannel: "crm_email", offerId: randomId(), legKey: "start_to_website_visit" });
    const feedback = await insertTestCampaign(org, { status: "stopped", brandId, featureSlug: "feedback-request-cold-email-outreach", acquisitionChannel: "feedback_request_email", legKey: "start_to_conversation" });
    const ads = await insertTestCampaign(org, { status: "ongoing", brandId, featureSlug: "google-ads", acquisitionChannel: "google_ads", offerId: randomId(), legKey: "start_to_website_visit" });
    const reactive = await insertTestCampaign(org, { status: "ongoing", brandId, featureSlug: "sales-cold-email-outreach", acquisitionChannel: "cold_email", offerId: randomId(), legKey: "conversation_to_meeting_booked" });
    const source = await insertTestCampaign(org, { status: "ongoing", brandId, featureSlug: "sourcing-apollo-cold-filters", offerId: randomId(), legKey: "start_to_lead_found" });

    await sql.unsafe(`CREATE TABLE ${SNAPSHOT} AS SELECT id, leg_key FROM campaigns`);

    await sql.unsafe(MIGRATION);
    await sql.unsafe(MIGRATION);

    expect(await legOf(ongoingReply.id)).toBe("lead_found_to_conversation");
    expect(await legOf(stoppedVisit.id)).toBe("lead_found_to_website_visit");
    expect(await legOf(feedback.id)).toBe("lead_found_to_conversation");
    expect(await legOf(ads.id)).toBe("start_to_website_visit");
    expect(await legOf(reactive.id)).toBe("conversation_to_meeting_booked");
    expect(await legOf(source.id)).toBe("start_to_lead_found");

    const snap = await sql<{ id: string; leg_key: string }[]>`SELECT id::text AS id, leg_key FROM campaigns_funnel_key_snapshot_20260926`;
    const snapLeg = new Map(snap.map((r) => [r.id, r.leg_key]));
    expect(snapLeg.get(ongoingReply.id)).toBe("lead_found_to_conversation");
    expect(snapLeg.get(ads.id)).toBe("start_to_website_visit");
  });

  it("runs without the snapshot table", async () => {
    const row = await insertTestCampaign(randomId(), { status: "stopped", brandId: randomId(), featureSlug: "sales-cold-email-outreach", acquisitionChannel: "cold_email", legKey: "start_to_website_visit" });
    await sql.unsafe(MIGRATION);
    expect(await legOf(row.id)).toBe("lead_found_to_website_visit");
  });
});
