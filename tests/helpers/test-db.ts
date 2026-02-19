import { db, sql } from "../../src/db/index.js";
import { orgs, users, campaigns } from "../../src/db/schema.js";

/**
 * Clean all test data from the database
 */
export async function cleanTestData() {
  await db.delete(campaigns);
  await db.delete(users);
  await db.delete(orgs);
}

/**
 * Insert a test org
 */
export async function insertTestOrg(data: { clerkOrgId?: string } = {}) {
  const [org] = await db
    .insert(orgs)
    .values({
      clerkOrgId: data.clerkOrgId || `test-org-${Date.now()}`,
    })
    .returning();
  return org;
}

/**
 * Insert a test user
 */
export async function insertTestUser(data: { clerkUserId?: string } = {}) {
  const [user] = await db
    .insert(users)
    .values({
      clerkUserId: data.clerkUserId || `test-user-${Date.now()}`,
    })
    .returning();
  return user;
}

/**
 * Insert a test campaign
 */
export async function insertTestCampaign(
  orgId: string,
  data: {
    name?: string;
    type?: string;
    status?: string;
    parentRunId?: string;
    brandUrl?: string;
    brandId?: string;
    appId?: string;
    maxBudgetDailyUsd?: string;
    maxBudgetWeeklyUsd?: string;
    maxBudgetMonthlyUsd?: string;
    maxBudgetTotalUsd?: string;
    maxLeads?: number;
    targetAudience?: string;
    targetOutcome?: string;
    valueForTarget?: string;
  } = {}
) {
  const [campaign] = await db
    .insert(campaigns)
    .values({
      orgId,
      name: data.name || `Test Campaign ${Date.now()}`,
      type: data.type || "cold-email-outreach",
      status: data.status || "ongoing",
      parentRunId: data.parentRunId || null,
      brandUrl: data.brandUrl || null,
      brandId: data.brandId || null,
      appId: data.appId || null,
      maxBudgetDailyUsd: data.maxBudgetDailyUsd || "10.00",
      maxBudgetWeeklyUsd: data.maxBudgetWeeklyUsd || null,
      maxBudgetMonthlyUsd: data.maxBudgetMonthlyUsd || null,
      maxBudgetTotalUsd: data.maxBudgetTotalUsd || null,
      maxLeads: data.maxLeads || null,
      targetAudience: data.targetAudience || null,
      targetOutcome: data.targetOutcome || null,
      valueForTarget: data.valueForTarget || null,
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
