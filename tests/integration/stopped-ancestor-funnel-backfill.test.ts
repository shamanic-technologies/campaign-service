import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq, inArray } from "drizzle-orm";
import { db, sql } from "../../src/db/index.js";
import { campaigns, campaignFunnelOwnerDecisions } from "../../src/db/schema.js";
import { cleanTestData, closeDb, insertTestCampaign, randomId } from "../helpers/test-db.js";

/**
 * The migration is applied here exactly as prod will apply it — the file itself, against a database
 * seeded with the shape prod holds — so "a second run changes zero rows" is measured, not read off
 * the SQL.
 */
const TAG = "0048_stopped_ancestors_state_their_campaign_funnel";
const MIGRATION = readFileSync(join(process.cwd(), "drizzle", `${TAG}.sql`), "utf8");

const CONVERSATION = "sales_meetings_from_conversation";
const WEBSITE = "sales_meetings_from_website";
const PURCHASES = "website_purchases";

/** The one live campaign of the qualifying triple, and its stopped ancestors. */
const orgA = randomId();
const orgB = randomId();
const brandOneLive = randomId();
const brandSeveralLive = randomId();
const brandNoLive = randomId();

async function applyMigration() {
  await sql.unsafe(MIGRATION);
}

async function funnelOf(id: string): Promise<string | null> {
  const [row] = await db.select().from(campaigns).where(eq(campaigns.id, id));
  return row?.funnelKey ?? null;
}

async function seed() {
  // (1) THE QUALIFYING TRIPLE — one live campaign stating a funnel, on cold_email.
  const live = await insertTestCampaign(orgA, {
    status: "ongoing",
    brandId: brandOneLive,
    acquisitionChannel: "cold_email",
    funnelKey: CONVERSATION,
    featureSlug: "sales-cold-email-outreach",
  });
  const ancestors = [];
  for (let i = 0; i < 3; i++) {
    ancestors.push(
      await insertTestCampaign(orgA, {
        status: "stopped",
        brandId: brandOneLive,
        acquisitionChannel: "cold_email",
        funnelKey: null,
        stopReason: "manual",
        featureSlug: "sales-cold-email-outreach",
      }),
    );
  }
  // A stopped row that already STATES a funnel answers to an identity already.
  const statedAncestor = await insertTestCampaign(orgA, {
    status: "stopped",
    brandId: brandOneLive,
    acquisitionChannel: "cold_email",
    funnelKey: PURCHASES,
  });
  // Same pair, DIFFERENT channel — no live campaign there, so nothing to answer to.
  const otherChannel = await insertTestCampaign(orgA, {
    status: "stopped",
    brandId: brandOneLive,
    acquisitionChannel: "ai_visibility",
    funnelKey: null,
  });
  // ANOTHER org on the SAME brand row — another customer's campaign.
  const otherOrg = await insertTestCampaign(orgB, {
    status: "stopped",
    brandId: brandOneLive,
    acquisitionChannel: "cold_email",
    funnelKey: null,
  });

  // (2) SEVERAL live funnels on one channel — which one an ancestor ran is unknown.
  await insertTestCampaign(orgA, {
    status: "ongoing",
    brandId: brandSeveralLive,
    acquisitionChannel: "cold_email",
    funnelKey: CONVERSATION,
  });
  await insertTestCampaign(orgA, {
    status: "ongoing",
    brandId: brandSeveralLive,
    acquisitionChannel: "cold_email",
    funnelKey: WEBSITE,
  });
  const severalLiveAncestor = await insertTestCampaign(orgA, {
    status: "stopped",
    brandId: brandSeveralLive,
    acquisitionChannel: "cold_email",
    funnelKey: null,
  });

  // (3) NO live campaign at all on the channel.
  const noLiveAncestor = await insertTestCampaign(orgA, {
    status: "stopped",
    brandId: brandNoLive,
    acquisitionChannel: "cold_email",
    funnelKey: null,
  });

  // (4) A live campaign that states NO funnel is not something to fold onto.
  const brandLiveNoFunnel = randomId();
  const liveNoFunnel = await insertTestCampaign(orgA, {
    status: "ongoing",
    brandId: brandLiveNoFunnel,
    acquisitionChannel: "pr_cold_email",
    funnelKey: null,
  });
  const liveNoFunnelAncestor = await insertTestCampaign(orgA, {
    status: "stopped",
    brandId: brandLiveNoFunnel,
    acquisitionChannel: "pr_cold_email",
    funnelKey: null,
  });

  return {
    live,
    ancestors,
    statedAncestor,
    otherChannel,
    otherOrg,
    severalLiveAncestor,
    noLiveAncestor,
    liveNoFunnel,
    liveNoFunnelAncestor,
  };
}

describe("a stopped ancestor answers to its live campaign's identity", () => {
  beforeEach(async () => {
    await cleanTestData();
    await db.delete(campaignFunnelOwnerDecisions);
  });

  afterAll(async () => {
    await cleanTestData();
    await db.delete(campaignFunnelOwnerDecisions);
    await closeDb();
  });

  it("folds the stopped ancestors of the ONE live campaign of an (org, brand, channel)", async () => {
    const seeded = await seed();
    await applyMigration();

    for (const ancestor of seeded.ancestors) {
      expect(await funnelOf(ancestor.id)).toBe(CONVERSATION);
    }
    // The live campaign itself is untouched — it already stated it.
    expect(await funnelOf(seeded.live.id)).toBe(CONVERSATION);
  });

  it("leaves alone a triple with SEVERAL live funnels, and one with NONE", async () => {
    const seeded = await seed();
    await applyMigration();

    expect(await funnelOf(seeded.severalLiveAncestor.id)).toBeNull();
    expect(await funnelOf(seeded.noLiveAncestor.id)).toBeNull();
    // A live campaign stating no funnel is not a funnel to fold onto either.
    expect(await funnelOf(seeded.liveNoFunnelAncestor.id)).toBeNull();
    expect(await funnelOf(seeded.liveNoFunnel.id)).toBeNull();
  });

  it("never restates a stopped row that already states a funnel", async () => {
    const seeded = await seed();
    await applyMigration();

    expect(await funnelOf(seeded.statedAncestor.id)).toBe(PURCHASES);
  });

  it("never crosses a channel, and never another org's campaigns on the same brand row", async () => {
    const seeded = await seed();
    await applyMigration();

    expect(await funnelOf(seeded.otherChannel.id)).toBeNull();
    expect(await funnelOf(seeded.otherOrg.id)).toBeNull();
  });

  it("records every write, with the value it replaced, under a tag an operator undoes by", async () => {
    const seeded = await seed();
    await applyMigration();

    const decisions = await db
      .select()
      .from(campaignFunnelOwnerDecisions)
      .where(eq(campaignFunnelOwnerDecisions.source, TAG));

    expect(decisions.map((d) => d.campaignId).sort()).toEqual(
      seeded.ancestors.map((a) => a.id).sort(),
    );
    for (const decision of decisions) {
      expect(decision.previousFunnelKey).toBeNull();
      expect(decision.funnelKey).toBe(CONVERSATION);
      expect(decision.orgId).toBe(orgA);
      expect(decision.brandId).toBe(brandOneLive);
    }

    // ...and the undo the file spells out returns every row to what it carried.
    await sql.unsafe(`
      UPDATE "campaigns" c
      SET "funnel_key" = d."previous_funnel_key"
      FROM "campaign_funnel_owner_decisions" d
      WHERE c."id"::text = d."campaign_id"
        AND d."source" = '${TAG}'
        AND c."funnel_key" = d."funnel_key";
    `);
    for (const ancestor of seeded.ancestors) {
      expect(await funnelOf(ancestor.id)).toBeNull();
    }
  });

  it("a second run changes ZERO rows", async () => {
    const seeded = await seed();
    await applyMigration();

    const ids = [
      seeded.live.id,
      ...seeded.ancestors.map((a) => a.id),
      seeded.statedAncestor.id,
      seeded.otherChannel.id,
      seeded.otherOrg.id,
      seeded.severalLiveAncestor.id,
      seeded.noLiveAncestor.id,
      seeded.liveNoFunnel.id,
      seeded.liveNoFunnelAncestor.id,
    ];
    const snapshot = async () =>
      (await db.select().from(campaigns).where(inArray(campaigns.id, ids)))
        .map((c) => `${c.id}:${c.funnelKey}:${c.status}:${c.updatedAt?.toISOString()}`)
        .sort();

    const afterFirst = await snapshot();
    const decisionsAfterFirst = await db.select().from(campaignFunnelOwnerDecisions);

    await applyMigration();

    expect(await snapshot()).toEqual(afterFirst);
    expect(await db.select().from(campaignFunnelOwnerDecisions)).toHaveLength(
      decisionsAfterFirst.length,
    );
  });
});
