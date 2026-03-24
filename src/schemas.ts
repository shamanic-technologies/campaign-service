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
  name: z.string(),
  workflowName: z.string(),
  brandUrl: z.string().nullable(),
  brandId: z.string().uuid().nullable(),
  featureSlug: z.string().nullable(),
  featureInputs: z.record(z.string(), z.unknown()).nullable(),
  maxBudgetDailyUsd: z.string().nullable(),
  maxBudgetWeeklyUsd: z.string().nullable(),
  maxBudgetMonthlyUsd: z.string().nullable(),
  maxBudgetTotalUsd: z.string().nullable(),
  maxLeads: z.number().int().nullable(),
  startDate: z.string().nullable(),
  endDate: z.string().nullable(),
  status: z.string(),
  toResumeAt: z.string().nullable(),
  notifyFrequency: z.string().nullable(),
  notifyChannel: z.string().nullable(),
  notifyDestination: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
}).openapi("Campaign");

// --- Public campaign routes ---

export const CreateCampaignBody = z.object({
  name: z.string().min(1, "Campaign name is required"),
  workflowName: z.string().min(1, "workflowName is required"),
  orgId: z.string().min(1, "orgId is required"),
  brandUrl: z.string().min(1, "brandUrl is required"),
  brandId: z.string().uuid("brandId must be a valid UUID"),
  featureSlug: z.string().min(1).optional(),
  featureInputs: z.record(z.string(), z.unknown()).optional(),
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

export const UpdateCampaignBody = z.object({
  name: z.string().optional(),
  brandUrl: z.string().optional(),
  brandId: z.string().uuid().optional(),
  featureSlug: z.string().min(1).optional(),
  featureInputs: z.record(z.string(), z.unknown()).optional(),
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

// --- Stats ---

export const StatsFilterQuery = z.object({
  orgId: z.string().optional(),
  brandId: z.string().optional(),
  campaignId: z.string().optional(),
}).refine(
  (data) => data.orgId || data.brandId || data.campaignId,
  { message: "At least one filter required: orgId, brandId, or campaignId" }
).openapi("StatsFilterQuery");

export const StatsResponse = z.object({
  stats: z.object({
    totalCampaigns: z.number(),
    byStatus: z.record(z.string(), z.number()),
    budgetTotalUsd: z.number().nullable(),
    maxLeadsTotal: z.number().nullable(),
  }),
}).openapi("StatsResponse");

// --- Batch budget usage ---

export const BatchBudgetUsageBody = z.object({
  campaignIds: z.array(z.string()).min(1, "campaignIds array is required"),
}).openapi("BatchBudgetUsageBody");

// --- Pipeline endpoints (called by DAG) ---

export const GateCheckBody = z.object({
  campaignId: z.string().uuid("campaignId must be a valid UUID"),
  orgId: z.string().min(1, "orgId is required"),
}).openapi("GateCheckBody");

export const GateCheckResponse = z.object({
  allowed: z.boolean(),
  reason: z.string().optional(),
  autoStopped: z.boolean().optional(),
}).openapi("GateCheckResponse");

export const StartRunBody = z.object({
  campaignId: z.string().uuid("campaignId must be a valid UUID"),
  orgId: z.string().min(1, "orgId is required"),
}).openapi("StartRunBody");

export const StartRunResponse = z.object({
  runId: z.string().uuid(),
  campaignId: z.string().uuid(),
  orgId: z.string(),
  brandId: z.string().uuid(),
  brandUrl: z.string(),
  brandDomain: z.string(),
  workflowName: z.string(),
  userId: z.string().nullable(),
  featureSlug: z.string().nullable(),
  featureInputs: z.record(z.string(), z.unknown()).nullable(),
  searchParams: z.record(z.string(), z.unknown()).nullable(),
}).openapi("StartRunResponse");

export const EndRunBody = z.object({
  campaignId: z.string().uuid("campaignId must be a valid UUID"),
  orgId: z.string().min(1, "orgId is required"),
  success: z.boolean(),
  leadFound: z.boolean().optional(),
}).openapi("EndRunBody");

export const EndRunResponse = z.object({
  status: z.string(),
}).openapi("EndRunResponse");

