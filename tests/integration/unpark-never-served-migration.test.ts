import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { db, sql } from "../../src/db/index.js";
import { campaigns, campaignAudienceExhaustion } from "../../src/db/schema.js";
import { cleanTestData, closeDb, insertTestCampaign, randomId } from "../helpers/test-db.js";

/**
 * The migration is applied here exactly as prod will apply it — the file itself, against a
 * database seeded with the shape prod holds — so both halves are measured rather than read off
 * the SQL: WHICH rows it selects, and that a second run changes nothing.
 *
 * The rule it states is the runtime rule (src/lib/audience-exhaustion.ts
 * `isExhaustionStopWarranted`) applied to the rows that already carry the verdict: a campaign
 * stopped for `audience_exhausted` that never marked a single audience exhausted was parked on a
 * conclusion about work that never happened.
 */
const TAG = "0052_unpark_never_served_exhaustion_stops";
const MIGRATION = readFileSync(join(process.cwd(), "drizzle", `${TAG}.sql`), "utf8");

const CONVERSATION = "sales_meetings_from_conversation";
const PURCHASES = "website_purchases";

async function applyMigration() {
  await sql.unsafe(MIGRATION);
}

async function rowOf(id: string) {
  const [row] = await db.select().from(campaigns).where(eq(campaigns.id, id));
  return row!;
}

async function auditCount(): Promise<number> {
  const rows = await sql<{ n: string }[]>`
    SELECT count(*)::text AS n FROM campaign_stop_reason_decisions WHERE decided_by = ${TAG}
  `;
  return Number(rows[0]!.n);
}

describe(`migration ${TAG}`, () => {
  beforeEach(async () => {
    await cleanTestData();
    // The audit table is created BY the migration, so it may not exist on the first run.
    await sql.unsafe(`DELETE FROM campaign_stop_reason_decisions WHERE true`).catch(() => {});
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("un-parks a campaign that stopped for exhaustion having never exhausted an audience, and leaves every other row alone", async () => {
    const org = randomId();
    const brand = randomId();

    // (1) THE CASE — stopped for exhaustion, zero exhaustion marks. Prod's 4769db14.
    const neverServed = await insertTestCampaign(org, {
      status: "stopped",
      stopReason: "audience_exhausted",
      brandId: brand,
      funnelKey: CONVERSATION,
      acquisitionChannel: "feedback_request_email",
      featureSlug: "feedback-request-cold-email-outreach",
    });

    // (2) GENUINELY exhausted — it ran out of people it actually had. Must stay stopped: money is
    // not an answer to exhaustion and this verdict is the true one.
    const genuinelyExhausted = await insertTestCampaign(org, {
      status: "stopped",
      stopReason: "audience_exhausted",
      brandId: randomId(),
      funnelKey: PURCHASES,
      acquisitionChannel: "cold_email",
      featureSlug: "sales-cold-email-outreach",
    });
    await db.insert(campaignAudienceExhaustion).values({
      campaignId: genuinelyExhausted.id,
      audienceId: randomId(),
      exhaustedAt: new Date(),
    });

    // (3) Its identity is already held by a live twin — bringing it back is what the partial
    // unique index exists to refuse.
    const heldBrand = randomId();
    const collides = await insertTestCampaign(org, {
      status: "stopped",
      stopReason: "audience_exhausted",
      brandId: heldBrand,
      funnelKey: PURCHASES,
      acquisitionChannel: "cold_email",
      featureSlug: "sales-cold-email-outreach",
    });
    const incumbent = await insertTestCampaign(org, {
      status: "ongoing",
      brandId: heldBrand,
      funnelKey: PURCHASES,
      acquisitionChannel: "cold_email",
      featureSlug: "sales-cold-email-outreach",
    });

    // (4) Stopped for a reason of its own — a person switched it off. Never touched.
    const manual = await insertTestCampaign(org, {
      status: "stopped",
      stopReason: "manual",
      brandId: randomId(),
      funnelKey: PURCHASES,
      acquisitionChannel: "cold_email",
      featureSlug: "sales-cold-email-outreach",
    });

    await applyMigration();

    const back = await rowOf(neverServed.id);
    expect(back.status).toBe("ongoing");
    expect(back.stopReason).toBeNull();
    // Due now: the next tick treats it like any other live campaign, where funding and the gate
    // decide whether it may actually spend.
    expect(back.nextRunAt).not.toBeNull();

    expect((await rowOf(genuinelyExhausted.id)).status).toBe("stopped");
    expect((await rowOf(collides.id)).status).toBe("stopped");
    expect((await rowOf(incumbent.id)).status).toBe("ongoing");
    expect((await rowOf(manual.id)).stopReason).toBe("manual");

    // Auditable: one row per campaign written, holding what it replaced.
    expect(await auditCount()).toBe(1);

    // Idempotent — a second run selects nothing, because what it wrote is no longer stopped.
    await applyMigration();
    expect(await auditCount()).toBe(1);
    expect((await rowOf(neverServed.id)).status).toBe("ongoing");
  });
});
