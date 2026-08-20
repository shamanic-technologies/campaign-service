import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq, inArray } from "drizzle-orm";
import { db, sql } from "../../src/db/index.js";
import { campaigns, campaignFunnelOwnerDecisions } from "../../src/db/schema.js";
import { cleanTestData, closeDb, insertTestCampaign, randomId } from "../helpers/test-db.js";
import {
  adoptFunnellessAncestors,
  ANCESTOR_ADOPTION_SOURCE,
} from "../../src/lib/funnel-ancestor-adoption.js";

/**
 * Migration 0051 and the RUNTIME rule it is the last migration for.
 *
 * The migration is applied here exactly as prod will apply it — the file itself, against a database
 * seeded with the shape prod holds — so "a second run changes zero rows" is measured, not read off
 * the SQL. The runtime rule is then run over the SAME seed and asserted to reach the SAME verdict
 * on every row, which is what stops the two copies of one rule drifting apart.
 */
const TAG = "0051_stopped_ancestors_state_their_campaign_funnel_again";
const MIGRATION = readFileSync(join(process.cwd(), "drizzle", `${TAG}.sql`), "utf8");

const CONVERSATION = "sales_meetings_from_conversation";
const WEBSITE = "sales_meetings_from_website";
const PURCHASES = "website_purchases";

const orgA = randomId();
const orgB = randomId();
const brandOneLive = randomId();
const brandSeveralLive = randomId();
const brandNoLive = randomId();
const brandLiveNoFunnel = randomId();

async function applyMigration() {
  await sql.unsafe(MIGRATION);
}

async function funnelOf(id: string): Promise<string | null> {
  const [row] = await db.select().from(campaigns).where(eq(campaigns.id, id));
  return row?.funnelKey ?? null;
}

async function statusOf(id: string): Promise<string | undefined> {
  const [row] = await db.select().from(campaigns).where(eq(campaigns.id, id));
  return row?.status;
}

async function seed() {
  // (1) THE QUALIFYING TRIPLE — one live campaign stating a funnel, on cold_email. This is the
  // prod shape: 9570e3ce ongoing on sales_meetings_from_conversation, 2bd9ec88 its stopped
  // funnel-less ancestor carrying the spend.
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
        // NULL on the prod row — the pre-funnel population. Unlike the funding-resume path in
        // funnel-campaigns.ts, the reason is irrelevant here: this restates an attribution, it
        // never resumes anything, so a row that stopped for a reason of its own folds too.
        stopReason: i === 0 ? null : "manual",
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

/** Every (org, brand, channel) the seed holds — the runtime rule is scoped, so it is asked per triple. */
const SCOPES = () => [
  { orgId: orgA, brandId: brandOneLive, acquisitionChannel: "cold_email" },
  { orgId: orgA, brandId: brandOneLive, acquisitionChannel: "ai_visibility" },
  { orgId: orgB, brandId: brandOneLive, acquisitionChannel: "cold_email" },
  { orgId: orgA, brandId: brandSeveralLive, acquisitionChannel: "cold_email" },
  { orgId: orgA, brandId: brandNoLive, acquisitionChannel: "cold_email" },
  { orgId: orgA, brandId: brandLiveNoFunnel, acquisitionChannel: "pr_cold_email" },
];

async function applyRuntimeRule(): Promise<number> {
  let total = 0;
  for (const scope of SCOPES()) total += await adoptFunnellessAncestors(scope);
  return total;
}

beforeEach(async () => {
  await cleanTestData();
  await db.delete(campaignFunnelOwnerDecisions);
});

afterAll(async () => {
  await cleanTestData();
  await db.delete(campaignFunnelOwnerDecisions);
  await closeDb();
});

describe("migration 0051 — the 0048 rule, applied to what is eligible now", () => {
  it("folds the stopped ancestors of the ONE live campaign of an (org, brand, channel)", async () => {
    const seeded = await seed();
    await applyMigration();

    for (const ancestor of seeded.ancestors) {
      expect(await funnelOf(ancestor.id)).toBe(CONVERSATION);
      // The ancestor stays STOPPED. Folding it onto the live member of the identity is the point;
      // resuming it would put a second campaign in the running.
      expect(await statusOf(ancestor.id)).toBe("stopped");
    }
    expect(await funnelOf(seeded.live.id)).toBe(CONVERSATION);
  });

  it("leaves alone a triple with SEVERAL live funnels, and one with NONE", async () => {
    const seeded = await seed();
    await applyMigration();

    expect(await funnelOf(seeded.severalLiveAncestor.id)).toBeNull();
    expect(await funnelOf(seeded.noLiveAncestor.id)).toBeNull();
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

describe("the runtime rule reaches the SAME verdict as the migration", () => {
  it("selects exactly the rows the migration selects, and nothing else", async () => {
    const seeded = await seed();
    await applyRuntimeRule();

    for (const ancestor of seeded.ancestors) {
      expect(await funnelOf(ancestor.id)).toBe(CONVERSATION);
      expect(await statusOf(ancestor.id)).toBe("stopped");
    }
    expect(await funnelOf(seeded.statedAncestor.id)).toBe(PURCHASES);
    expect(await funnelOf(seeded.otherChannel.id)).toBeNull();
    expect(await funnelOf(seeded.otherOrg.id)).toBeNull();
    expect(await funnelOf(seeded.severalLiveAncestor.id)).toBeNull();
    expect(await funnelOf(seeded.noLiveAncestor.id)).toBeNull();
    expect(await funnelOf(seeded.liveNoFunnelAncestor.id)).toBeNull();
    expect(await funnelOf(seeded.live.id)).toBe(CONVERSATION);
    expect(await funnelOf(seeded.liveNoFunnel.id)).toBeNull();
  });

  it("a second run changes ZERO rows and writes no second decision", async () => {
    const seeded = await seed();
    const first = await applyRuntimeRule();
    expect(first).toBe(seeded.ancestors.length);

    const ids = [seeded.live.id, ...seeded.ancestors.map((a) => a.id)];
    const snapshot = async () =>
      (await db.select().from(campaigns).where(inArray(campaigns.id, ids)))
        .map((c) => `${c.id}:${c.funnelKey}:${c.status}:${c.updatedAt?.toISOString()}`)
        .sort();

    const afterFirst = await snapshot();
    const decisionsAfterFirst = await db.select().from(campaignFunnelOwnerDecisions);

    expect(await applyRuntimeRule()).toBe(0);
    expect(await snapshot()).toEqual(afterFirst);
    expect(await db.select().from(campaignFunnelOwnerDecisions)).toHaveLength(
      decisionsAfterFirst.length,
    );
  });

  it("records every write with the value it replaced, and the undo returns every row", async () => {
    const seeded = await seed();
    await applyRuntimeRule();

    const decisions = await db
      .select()
      .from(campaignFunnelOwnerDecisions)
      .where(eq(campaignFunnelOwnerDecisions.source, ANCESTOR_ADOPTION_SOURCE));

    expect(decisions.map((d) => d.campaignId).sort()).toEqual(
      seeded.ancestors.map((a) => a.id).sort(),
    );
    for (const decision of decisions) {
      expect(decision.previousFunnelKey).toBeNull();
      expect(decision.funnelKey).toBe(CONVERSATION);
      expect(decision.orgId).toBe(orgA);
      expect(decision.brandId).toBe(brandOneLive);
      expect(decision.decidedBy).toBe("campaign-identity");
    }

    await sql.unsafe(`
      UPDATE "campaigns" c
      SET "funnel_key" = d."previous_funnel_key"
      FROM "campaign_funnel_owner_decisions" d
      WHERE c."id"::text = d."campaign_id"
        AND d."source" = '${ANCESTOR_ADOPTION_SOURCE}'
        AND c."funnel_key" = d."funnel_key";
    `);
    for (const ancestor of seeded.ancestors) {
      expect(await funnelOf(ancestor.id)).toBeNull();
    }
  });

  it("a live campaign appearing on a triple LATER is what makes its ancestors eligible", async () => {
    // The recurrence, in one test: on the day the migration runs the ancestor is still LIVE, so
    // the rule correctly declines it. It becomes eligible only afterwards — which a one-shot
    // migration can never revisit and the runtime rule catches on the next tick.
    const ancestor = await insertTestCampaign(orgA, {
      status: "ongoing",
      brandId: brandNoLive,
      acquisitionChannel: "cold_email",
      funnelKey: null,
      featureSlug: "sales-cold-email-outreach",
    });
    const scope = { orgId: orgA, brandId: brandNoLive, acquisitionChannel: "cold_email" };

    await applyMigration();
    expect(await funnelOf(ancestor.id)).toBeNull();

    // The funnel gets funded: a twin is provisioned...
    await insertTestCampaign(orgA, {
      status: "ongoing",
      brandId: brandNoLive,
      acquisitionChannel: "cold_email",
      funnelKey: CONVERSATION,
      featureSlug: "sales-cold-email-outreach",
    });
    // ...and the funnel-less original is stopped.
    await db.update(campaigns).set({ status: "stopped" }).where(eq(campaigns.id, ancestor.id));

    expect(await adoptFunnellessAncestors(scope)).toBe(1);
    expect(await funnelOf(ancestor.id)).toBe(CONVERSATION);
    expect(await statusOf(ancestor.id)).toBe("stopped");
  });
});
