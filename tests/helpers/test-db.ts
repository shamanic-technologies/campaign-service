import { db, sql } from "../../src/db/index.js";
import { campaigns, brandPauseTransitions, campaignAudienceExhaustion } from "../../src/db/schema.js";

/**
 * Clean all test data from the database
 */
export async function cleanTestData() {
  await db.delete(campaigns);
  await db.delete(brandPauseTransitions);
  await db.delete(campaignAudienceExhaustion);
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
    dailyBudgetCents?: number | null;
    maxLeads?: number;
    featureSlug?: string;
    featureInputs?: Record<string, unknown>;
    activeGoalId?: string | null;
    brandProfileId?: string | null;
    audienceId?: string | null;
    goal?: string | null;
    audienceIds?: string[] | null;
    servicesOffered?: string[] | null;
    clickDestinationUrl?: string | null;
    nextRunAt?: Date | null;
    createdByUserId?: string;
    parentRunId?: string;
    // WHY it stopped — only `audience_exhausted` is resumable (src/lib/stop-reason.ts).
    stopReason?: string | null;
    funnelKey?: string | null;
    /** The offer the campaign sells — brand-service's id, carried and never derived. */
    offerId?: string | null;
    /** The single funnel LEG it is bought for — features-service's id, carried and never derived. */
    legKey?: string | null;
    // The two identity columns the partial unique index is built on. Written at creation by
    // campaignIdentityColumns in the routes; stated explicitly here so a test can build the
    // (org, brand, funnel, channel) collision the resume must refuse.
    brandId?: string | null;
    acquisitionChannel?: string | null;
    updatedAt?: Date;
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
      activeGoalId: data.activeGoalId ?? null,
      brandProfileId: data.brandProfileId ?? null,
      audienceId: data.audienceId ?? null,
      goal: data.goal ?? null,
      audienceIds: data.audienceIds ?? null,
      servicesOffered: data.servicesOffered ?? null,
      clickDestinationUrl: data.clickDestinationUrl ?? null,
      maxBudgetDailyUsd: data.maxBudgetDailyUsd || "10.00",
      maxBudgetWeeklyUsd: data.maxBudgetWeeklyUsd || null,
      maxBudgetMonthlyUsd: data.maxBudgetMonthlyUsd || null,
      maxBudgetTotalUsd: data.maxBudgetTotalUsd || null,
      dailyBudgetCents: data.dailyBudgetCents ?? null,
      maxLeads: data.maxLeads || null,
      nextRunAt: data.nextRunAt ?? null,
      createdByUserId: data.createdByUserId || null,
      parentRunId: data.parentRunId || null,
      stopReason: data.stopReason ?? null,
      funnelKey: data.funnelKey ?? null,
      offerId: data.offerId ?? null,
      legKey: data.legKey ?? null,
      brandId: data.brandId ?? null,
      acquisitionChannel: data.acquisitionChannel ?? null,
      ...(data.updatedAt ? { updatedAt: data.updatedAt } : {}),
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
