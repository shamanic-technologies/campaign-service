import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";

extendZodWithOpenApi(z);

// --- Shared ---

export const ErrorResponse = z.object({
  error: z.string(),
}).openapi("ErrorResponse");

export const CampaignSchema = z.object({
  id: z.string().uuid(),
  orgId: z.string(),
  createdByUserId: z.string().nullable(),
  parentRunId: z.string().nullable(),
  name: z.string(),
  workflowSlug: z.string(),
  brandIds: z.array(z.string().uuid()).nullable(),
  featureSlug: z.string().nullable(),
  featureInputs: z.record(z.string(), z.unknown()).nullable(),
  activeGoalId: z.string().nullable(),
  brandProfileId: z.string().nullable(),
  customerPersonaId: z.string().nullable(),
  customerProfileId: z.string().nullable(),
  maxBudgetDailyUsd: z.string().nullable(),
  maxBudgetWeeklyUsd: z.string().nullable(),
  maxBudgetMonthlyUsd: z.string().nullable(),
  maxBudgetTotalUsd: z.string().nullable(),
  maxLeads: z.number().int().nullable(),
  startDate: z.string().nullable(),
  endDate: z.string().nullable(),
  status: z.string(),
  nextRunAt: z.string().nullable(),
  notifyFrequency: z.string().nullable(),
  notifyChannel: z.string().nullable(),
  notifyDestination: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
}).openapi("Campaign");

// --- Public campaign routes ---

export const CreateCampaignBody = z.object({
  name: z.string().min(1, "Campaign name is required"),
  workflowSlug: z.string().min(1),
  orgId: z.string().min(1, "orgId is required"),
  brandIds: z.array(z.string().uuid("each brandId must be a valid UUID")).min(1, "at least one brandId is required"),
  featureSlug: z.string().min(1).optional(),
  featureInputs: z.record(z.string(), z.unknown()).optional(),
  activeGoalId: z.string().min(1).nullable().optional(),
  brandProfileId: z.string().min(1).nullable().optional(),
  customerPersonaId: z.string().min(1).nullable().optional(),
  customerProfileId: z.string().min(1).nullable().optional(),
  maxBudgetDailyUsd: z.string().optional(),
  maxBudgetWeeklyUsd: z.string().optional(),
  maxBudgetMonthlyUsd: z.string().optional(),
  maxBudgetTotalUsd: z.string().optional(),
  maxLeads: z.number().int().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  notifyFrequency: z.string().optional(),
  notifyChannel: z.string().optional(),
  notifyDestination: z.string().optional(),
}).openapi("CreateCampaignBody");

export const CampaignsFilterQuery = z.object({
  brandId: z.string().optional(),
  workflowSlug: z.string().optional(),
  featureSlug: z.string().optional(),
}).openapi("CampaignsFilterQuery");

export const UpdateCampaignBody = z.object({
  name: z.string().optional(),
  brandIds: z.array(z.string().uuid()).optional(),
  featureSlug: z.string().min(1).optional(),
  featureInputs: z.record(z.string(), z.unknown()).optional(),
  activeGoalId: z.string().min(1).nullable().optional(),
  brandProfileId: z.string().min(1).nullable().optional(),
  customerPersonaId: z.string().min(1).nullable().optional(),
  customerProfileId: z.string().min(1).nullable().optional(),
  maxBudgetDailyUsd: z.string().optional(),
  maxBudgetWeeklyUsd: z.string().optional(),
  maxBudgetMonthlyUsd: z.string().optional(),
  maxBudgetTotalUsd: z.string().optional(),
  maxLeads: z.number().int().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  status: z.enum(["activate", "stop"]).optional(),
  notifyFrequency: z.string().optional(),
  notifyChannel: z.string().optional(),
  notifyDestination: z.string().optional(),
}).openapi("UpdateCampaignBody");

// --- Brand pause ---

export const UpdateBrandPauseBody = z.object({
  paused: z.boolean(),
}).openapi("UpdateBrandPauseBody");

export const BrandPauseResponse = z.object({
  brandId: z.string(),
  orgId: z.string(),
  paused: z.boolean(),
  updatedAt: z.string().nullable(),
}).openapi("BrandPauseResponse");

// --- Stats ---

export const StatsGroupByEnum = z.enum([
  "workflowSlug",
  "featureSlug",
]).openapi("StatsGroupByEnum");

export const StatsFilterQuery = z.object({
  orgId: z.string().optional(),
  brandId: z.string().optional(),
  campaignId: z.string().optional(),
  workflowSlug: z.string().optional(),
  featureSlug: z.string().optional(),
  groupBy: StatsGroupByEnum.optional(),
}).refine(
  (data) => data.orgId || data.brandId || data.campaignId,
  { message: "At least one filter required: orgId, brandId, or campaignId" }
).openapi("StatsFilterQuery");

export const StatsEntry = z.object({
  totalCampaigns: z.number(),
  byStatus: z.record(z.string(), z.number()),
  budgetTotalUsd: z.number().nullable(),
  maxLeadsTotal: z.number().nullable(),
}).openapi("StatsEntry");

export const StatsResponse = z.object({
  stats: StatsEntry,
}).openapi("StatsResponse");

export const GroupedStatsResponse = z.object({
  groupedStats: z.record(z.string(), StatsEntry),
}).openapi("GroupedStatsResponse");

// --- Batch budget usage ---

export const BatchBudgetUsageBody = z.object({
  campaignIds: z.array(z.string()).min(1, "campaignIds array is required"),
}).openapi("BatchBudgetUsageBody");

// --- Pipeline endpoints (called by DAG) ---

export const GateCheckBody = z.object({}).openapi("GateCheckBody");

export const GateCheckResponse = z.object({
  allowed: z.boolean(),
  reason: z.string().optional(),
  autoStopped: z.boolean().optional(),
}).openapi("GateCheckResponse");

export const StartRunBody = z.object({}).openapi("StartRunBody");

export const StartRunResponse = z.object({
  runId: z.string().uuid(),
  campaignId: z.string().uuid(),
  orgId: z.string(),
  brandIds: z.array(z.string().uuid()),
  workflowSlug: z.string(),
  userId: z.string().nullable(),
  featureSlug: z.string().nullable(),
  featureInputs: z.record(z.string(), z.unknown()).nullable(),
  activeGoalId: z.string().nullable(),
  brandProfileId: z.string().nullable(),
  customerPersonaId: z.string().nullable(),
  customerProfileId: z.string().nullable(),
  searchParams: z.record(z.string(), z.unknown()).nullable(),
}).openapi("StartRunResponse");

export const EndRunBody = z.object({
  success: z.boolean(),
  stopCampaign: z.boolean(),
}).openapi("EndRunBody");

export const EndRunResponse = z.object({
  status: z.string(),
}).openapi("EndRunResponse");

// --- Internal: Brand Transfer ---

export const TransferBrandBody = z.object({
  sourceBrandId: z.string().uuid(),
  sourceOrgId: z.string().min(1),
  targetOrgId: z.string().min(1),
  targetBrandId: z.string().uuid().optional(),
}).openapi("TransferBrandBody");

export const TransferBrandResponse = z.object({
  updatedTables: z.array(z.object({
    tableName: z.string(),
    count: z.number().int(),
  })),
}).openapi("TransferBrandResponse");

// --- Internal: Org Teardown ---

export const DeleteCampaignsByOrgResponse = z.object({
  updatedTables: z.array(z.object({
    tableName: z.string(),
    count: z.number().int(),
  })),
}).openapi("DeleteCampaignsByOrgResponse");
