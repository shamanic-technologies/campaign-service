import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "../../src/db/index.js";
import { cleanTestData, closeDb, insertTestCampaign, randomId } from "../helpers/test-db.js";
import { insertSalesFunnelCampaignWithUnits } from "../../src/lib/campaign-status-history.js";

/**
 * DELETE-POST-PUBLISHED-1107: every stored leg key / funnel id / pipe id naming the retired coarse `post_published`
 * moves to its fine spelling in place, the old values land in the snapshot, fine keys and other rows never move, and
 * a replay is a no-op.
 */
const TAG = "0088_fine_threads_post_published_keys";
const MIGRATION = readFileSync(join(process.cwd(), "drizzle", `${TAG}.sql`), "utf8");
const SNAPSHOT = "post_published_rekey_snapshot_20261107";
const OLD_FUNNEL = "start_to_post_published@threads-post+post_published_to_paid_client";
const NEW_FUNNEL = "start_to_threads_post_published@threads-post+threads_post_published_to_paid_client";

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

  it("re-keys the Threads units and attributions, keeps fine and other keys, snapshots the old values, replays as a no-op", async () => {
    const org = randomId();
    const brandId = randomId();
    const offerId = randomId();
    const post = await insertTestCampaign(org, { status: "ongoing", brandId, offerId, featureSlug: "threads-post", legKey: "start_to_post_published", name: "Threads 7f - threads-post - start_to_post_published" });
    const closing = await insertTestCampaign(org, { status: "ongoing", brandId, offerId, featureSlug: "your-team-closing-calls", legKey: "post_published_to_paid_client" });
    const fine = await insertTestCampaign(org, { status: "ongoing", brandId, offerId, featureSlug: "x-post", legKey: "start_to_x_post_published" });
    const other = await insertTestCampaign(org, { status: "stopped", brandId, offerId, featureSlug: "sales-cold-email-outreach", legKey: "lead_found_to_conversation" });
    await sql`UPDATE campaigns SET sales_funnel_id = ${OLD_FUNNEL} WHERE id::text IN (${post.id}, ${closing.id})`;
    const attribution = randomId();
    await sql`INSERT INTO run_play_attributions (id, run_id, run_kind, dispatched_by, campaign_id, sales_funnel_id, feature_slug, leg_key, play_state, play_id, pipe_id, detail)
      VALUES (${attribution}, ${randomId()}, 'execution', 'scheduler', ${post.id}, ${OLD_FUNNEL}, 'threads-post', 'start_to_post_published', 'no_play',
        'threads-post|start_to_post_published', 'threads-post|start_to_post_published', 'pipe threads-post|start_to_post_published catalogues no strategy')`;

    await sql.unsafe(MIGRATION);
    await sql.unsafe(MIGRATION);

    const rows = await sql<{ id: string; leg_key: string; sales_funnel_id: string | null; name: string }[]>`
      SELECT id::text AS id, leg_key, sales_funnel_id, name FROM campaigns WHERE org_id::text = ${org}`;
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(post.id)).toMatchObject({ leg_key: "start_to_threads_post_published", sales_funnel_id: NEW_FUNNEL, name: "Threads 7f - threads-post - start_to_threads_post_published" });
    expect(byId.get(closing.id)).toMatchObject({ leg_key: "threads_post_published_to_paid_client", sales_funnel_id: NEW_FUNNEL });
    expect(byId.get(fine.id)?.leg_key).toBe("start_to_x_post_published");
    expect(byId.get(other.id)?.leg_key).toBe("lead_found_to_conversation");

    const [att] = await sql<{ leg_key: string; pipe_id: string; play_id: string; sales_funnel_id: string; detail: string }[]>`
      SELECT leg_key, pipe_id, play_id, sales_funnel_id, detail FROM run_play_attributions WHERE id = ${attribution}`;
    expect(att).toEqual({
      leg_key: "start_to_threads_post_published",
      pipe_id: "threads-post|start_to_threads_post_published",
      play_id: "threads-post|start_to_threads_post_published",
      sales_funnel_id: NEW_FUNNEL,
      detail: "pipe threads-post|start_to_threads_post_published catalogues no strategy",
    });

    const snap = await sql<{ table_name: string; row_id: string; column_name: string; old_value: string }[]>`
      SELECT table_name, row_id, column_name, old_value FROM post_published_rekey_snapshot_20261107 ORDER BY table_name, row_id, column_name`;
    expect(snap).toContainEqual({ table_name: "campaigns", row_id: post.id, column_name: "leg_key", old_value: "start_to_post_published" });
    expect(snap).toContainEqual({ table_name: "campaigns", row_id: closing.id, column_name: "sales_funnel_id", old_value: OLD_FUNNEL });
    expect(snap).toContainEqual({ table_name: "run_play_attributions", row_id: attribution, column_name: "pipe_id", old_value: "threads-post|start_to_post_published" });
    expect(snap.some((s) => s.row_id === fine.id || s.row_id === other.id)).toBe(false);
  });

  it("re-keys the funnel campaign's own ids, its plan check and its plan history (jsonb included)", async () => {
    const org = randomId();
    const id = crypto.randomUUID();
    const PLAN = "start_to_post_published@threads-post+post_published_to_website_visit+website_visit_to_signup+signup_to_paid_client";
    const NEW_PLAN = "start_to_threads_post_published@threads-post+threads_post_published_to_website_visit+website_visit_to_signup+signup_to_paid_client";
    const born = await insertSalesFunnelCampaignWithUnits({
      id, orgId: org, brandId: randomId(), offerId: randomId(), salesFunnelId: OLD_FUNNEL, salesFunnelName: "Threads", status: "ongoing",
      createdByUserId: randomId(), parentRunId: randomId(), followsPlan: true,
      units: [{ featureSlug: "threads-post", legKey: "start_to_post_published", workflowSlug: null, acquisitionChannel: "threads", name: `Threads ${id.slice(0, 8)} - threads-post - start_to_post_published` }],
    });
    await sql`UPDATE sales_funnel_campaigns SET running_sales_funnel_id = ${PLAN},
      plan_check = ${JSON.stringify({ state: "following", detail: `It runs its plan ${PLAN}.`, planSalesFunnelId: PLAN })}::jsonb WHERE id = ${id}`;
    const change = randomId();
    await sql`INSERT INTO sales_funnel_plan_changes (id, sales_funnel_campaign_id, org_id, from_sales_funnel_id, to_sales_funnel_id, units)
      VALUES (${change}, ${id}, ${org}, ${OLD_FUNNEL}, ${PLAN}, ${JSON.stringify([{ action: "kept", pipeId: "threads-post|start_to_post_published", campaignId: born.units[0]!.id }])}::jsonb)`;

    await sql.unsafe(MIGRATION);
    await sql.unsafe(MIGRATION);

    const [sfc] = await sql<{ sales_funnel_id: string; running_sales_funnel_id: string; plan_check: { planSalesFunnelId: string; detail: string } }[]>`
      SELECT sales_funnel_id, running_sales_funnel_id, plan_check FROM sales_funnel_campaigns WHERE id = ${id}`;
    expect(sfc!.sales_funnel_id).toBe(NEW_FUNNEL);
    expect(sfc!.running_sales_funnel_id).toBe(NEW_PLAN);
    expect(sfc!.plan_check.planSalesFunnelId).toBe(NEW_PLAN);
    expect(sfc!.plan_check.detail).toBe(`It runs its plan ${NEW_PLAN}.`);
    const [pc] = await sql<{ from_sales_funnel_id: string; to_sales_funnel_id: string; units: Array<{ pipeId: string }> }[]>`
      SELECT from_sales_funnel_id, to_sales_funnel_id, units FROM sales_funnel_plan_changes WHERE id = ${change}`;
    expect(pc).toMatchObject({ from_sales_funnel_id: NEW_FUNNEL, to_sales_funnel_id: NEW_PLAN });
    expect(pc!.units[0]!.pipeId).toBe("threads-post|start_to_threads_post_published");
    const [unit] = await sql<{ leg_key: string }[]>`SELECT leg_key FROM campaigns WHERE id::text = ${born.units[0]!.id}`;
    expect(unit!.leg_key).toBe("start_to_threads_post_published");
    const [snap] = await sql<{ old_value: string }[]>`
      SELECT old_value FROM post_published_rekey_snapshot_20261107 WHERE table_name = 'sales_funnel_campaigns' AND row_id = ${id} AND column_name = 'plan_check'`;
    expect(JSON.parse(snap!.old_value).planSalesFunnelId).toBe(PLAN);
  });
});
