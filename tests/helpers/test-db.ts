import { db, sql } from "../../src/db/index.js";
import { campaigns, brandPause } from "../../src/db/schema.js";

/**
 * Clean all test data from the database
 */
export async function cleanTestData() {
  await db.delete(campaigns);
  await db.delete(brandPause);
}

/** Upsert a brand_pause row (mirror the route's upsert-in-place semantics). */
export async function setBrandPause(orgId: string, brandId: string, paused: boolean) {
  await db
    .insert(brandPause)
    .values({ brandId, orgId, paused, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: brandPause.brandId,
      set: { orgId, paused, updatedAt: new Date() },
    });
}

/**
 * Insert a test campaign.
 * orgId is now the external org ID (client-service UUID) stored directly.
 */
export async function insertTestCampaign(
  orgId: string,
  data: {
    name?: string;
    workflowSlug?: string;
    status?: string;
    brandIds?: string[];
    maxBudgetDailyUsd?: string;
    maxBudgetWeeklyUsd?: string;
    maxBudgetMonthlyUsd?: string;
    maxBudgetTotalUsd?: string;
    maxLeads?: number;
    featureSlug?: string;
    featureInputs?: Record<string, unknown>;
    nextRunAt?: Date | null;
    createdByUserId?: string;
    parentRunId?: string;
  } = {}
) {
  const [campaign] = await db
    .insert(campaigns)
    .values({
      orgId,
      name: data.name || `Test Campaign ${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
      workflowSlug: data.workflowSlug || "sales-email-cold-outreach",
      status: data.status || "ongoing",
      brandIds: "brandIds" in data ? (data.brandIds || null) : [crypto.randomUUID()],
      featureSlug: data.featureSlug || null,
      featureInputs: data.featureInputs || null,
      maxBudgetDailyUsd: data.maxBudgetDailyUsd || "10.00",
      maxBudgetWeeklyUsd: data.maxBudgetWeeklyUsd || null,
      maxBudgetMonthlyUsd: data.maxBudgetMonthlyUsd || null,
      maxBudgetTotalUsd: data.maxBudgetTotalUsd || null,
      maxLeads: data.maxLeads || null,
      nextRunAt: data.nextRunAt ?? null,
      createdByUserId: data.createdByUserId || null,
      parentRunId: data.parentRunId || null,
    })
    .returning();
  return campaign;
}

/**
 * Close database connection
 */
export async function closeDb() {
  await sql.end();
}

/**
 * Generate a random UUID
 */
export function randomId(): string {
  return crypto.randomUUID();
}
