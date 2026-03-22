import { db, sql } from "../../src/db/index.js";
import { campaigns, discoveredOutlets, discoveredJournalists } from "../../src/db/schema.js";

/**
 * Clean all test data from the database
 */
export async function cleanTestData() {
  await db.delete(discoveredOutlets);
  await db.delete(discoveredJournalists);
  await db.delete(campaigns);
}

/**
 * Insert a test campaign.
 * orgId is now the external org ID (client-service UUID) stored directly.
 */
export async function insertTestCampaign(
  orgId: string,
  data: {
    name?: string;
    workflowName?: string;
    status?: string;
    brandUrl?: string;
    brandId?: string;
    maxBudgetDailyUsd?: string;
    maxBudgetWeeklyUsd?: string;
    maxBudgetMonthlyUsd?: string;
    maxBudgetTotalUsd?: string;
    maxLeads?: number;
    targetAudience?: string;
    targetOutcome?: string;
    valueForTarget?: string;
    toResumeAt?: Date | null;
    createdByUserId?: string;
  } = {}
) {
  const [campaign] = await db
    .insert(campaigns)
    .values({
      orgId,
      name: data.name || `Test Campaign ${Date.now()}`,
      workflowName: data.workflowName || "sales-email-cold-outreach",
      status: data.status || "ongoing",
      brandUrl: data.brandUrl || null,
      brandId: "brandId" in data ? (data.brandId || null) : crypto.randomUUID(),
      maxBudgetDailyUsd: data.maxBudgetDailyUsd || "10.00",
      maxBudgetWeeklyUsd: data.maxBudgetWeeklyUsd || null,
      maxBudgetMonthlyUsd: data.maxBudgetMonthlyUsd || null,
      maxBudgetTotalUsd: data.maxBudgetTotalUsd || null,
      maxLeads: data.maxLeads || null,
      targetAudience: data.targetAudience || null,
      targetOutcome: data.targetOutcome || null,
      valueForTarget: data.valueForTarget || null,
      toResumeAt: data.toResumeAt ?? null,
      createdByUserId: data.createdByUserId || null,
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
