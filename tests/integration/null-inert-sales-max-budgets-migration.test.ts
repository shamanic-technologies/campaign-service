import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { db, sql } from "../../src/db/index.js";
import { campaigns } from "../../src/db/schema.js";
import { cleanTestData, closeDb, insertTestCampaign, randomId } from "../helpers/test-db.js";

/**
 * The migration is applied here exactly as prod will apply it — the file itself, against a
 * database seeded with the shape prod holds — so both halves are measured: WHICH rows it selects
 * (sales family only, whatever their status), and that a second run changes nothing.
 */
const TAG = "0053_null_inert_sales_max_budgets";
const MIGRATION = readFileSync(join(process.cwd(), "drizzle", `${TAG}.sql`), "utf8");

async function applyMigration() {
  await sql.unsafe(MIGRATION);
}

async function rowOf(id: string) {
  const [row] = await db.select().from(campaigns).where(eq(campaigns.id, id));
  return row!;
}

async function auditCount(): Promise<number> {
  const rows = await sql<{ n: string }[]>`
    SELECT count(*)::text AS n FROM campaign_max_budget_decisions WHERE migration_tag = ${TAG}
  `;
  return Number(rows[0]!.n);
}

describe(`migration ${TAG}`, () => {
  beforeEach(async () => {
    await cleanTestData();
    // The audit table is created BY the migration, so it may not exist on the first run.
    await sql.unsafe(`DELETE FROM campaign_max_budget_decisions WHERE true`).catch(() => {});
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("nulls the inert windows on sales campaigns of every status and leaves non-sales rows alone", async () => {
    const org = randomId();

    const liveSales = await insertTestCampaign(org, {
      status: "ongoing",
      brandId: randomId(),
      funnelKey: "sales_meetings_from_conversation",
      acquisitionChannel: "cold_email",
      featureSlug: "sales-cold-email-outreach",
      maxBudgetDailyUsd: "10.00",
      dailyBudgetCents: 5000,
    });

    const stoppedSales = await insertTestCampaign(org, {
      status: "stopped",
      brandId: randomId(),
      funnelKey: "website_purchases",
      acquisitionChannel: "crm_email",
      featureSlug: "sales-crm-email-outreach",
      maxBudgetDailyUsd: "3.00",
      maxBudgetWeeklyUsd: "21.00",
      maxBudgetMonthlyUsd: "90.00",
      maxBudgetTotalUsd: "900.00",
    });

    // Non-sales: the column is live for it and gate-check enforces it. Untouched.
    const pr = await insertTestCampaign(org, {
      status: "ongoing",
      brandId: randomId(),
      acquisitionChannel: "pr_cold_email",
      featureSlug: "pr-expert-quote-outreach",
      maxBudgetDailyUsd: "10.00",
      maxBudgetTotalUsd: "500.00",
    });

    await applyMigration();

    const live = await rowOf(liveSales.id);
    expect(live.maxBudgetDailyUsd).toBeNull();
    // The funding path is untouched: daily_budget_cents is not a budget WINDOW.
    expect(live.dailyBudgetCents).toBe(5000);
    expect(live.status).toBe("ongoing");

    const stopped = await rowOf(stoppedSales.id);
    expect(stopped.maxBudgetDailyUsd).toBeNull();
    expect(stopped.maxBudgetWeeklyUsd).toBeNull();
    expect(stopped.maxBudgetMonthlyUsd).toBeNull();
    expect(stopped.maxBudgetTotalUsd).toBeNull();
    expect(stopped.status).toBe("stopped");

    const untouched = await rowOf(pr.id);
    expect(untouched.maxBudgetDailyUsd).toBe("10.00");
    expect(untouched.maxBudgetTotalUsd).toBe("500.00");

    // One audit row per campaign written, holding what it replaced.
    expect(await auditCount()).toBe(2);

    // Idempotent — a second run selects nothing, because every sales row is already null.
    await applyMigration();
    expect(await auditCount()).toBe(2);
    expect((await rowOf(liveSales.id)).maxBudgetDailyUsd).toBeNull();
    expect((await rowOf(pr.id)).maxBudgetDailyUsd).toBe("10.00");
  });
});
