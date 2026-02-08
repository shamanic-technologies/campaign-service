import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";

extendZodWithOpenApi(z);

// --- Shared ---

export const ErrorResponse = z.object({
  error: z.string(),
}).openapi("ErrorResponse");

export const CampaignSchema = z.object({
  id: z.string().uuid(),
  orgId: z.string().uuid(),
  createdByUserId: z.string().uuid().nullable(),
  name: z.string(),
  brandUrl: z.string().nullable(),
  brandId: z.string().uuid().nullable(),
  appId: z.string().nullable(),
  personTitles: z.array(z.string()).nullable(),
  qOrganizationKeywordTags: z.array(z.string()).nullable(),
  organizationLocations: z.array(z.string()).nullable(),
  organizationNumEmployeesRanges: z.array(z.string()).nullable(),
  qOrganizationIndustryTagIds: z.array(z.string()).nullable(),
  qKeywords: z.string().nullable(),
  requestRaw: z.unknown().nullable(),
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
  brandUrl: z.string().min(1, "brandUrl is required"),
  personTitles: z.array(z.string()).optional(),
  qOrganizationKeywordTags: z.array(z.string()).optional(),
  organizationLocations: z.array(z.string()).optional(),
  organizationNumEmployeesRanges: z.array(z.string()).optional(),
  qOrganizationIndustryTagIds: z.array(z.string()).optional(),
  qKeywords: z.string().optional(),
  maxBudgetDailyUsd: z.string().optional(),
  maxBudgetWeeklyUsd: z.string().optional(),
  maxBudgetMonthlyUsd: z.string().optional(),
  maxBudgetTotalUsd: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  notifyFrequency: z.string().optional(),
  notifyChannel: z.string().optional(),
  notifyDestination: z.string().optional(),
  appId: z.string().optional(),
}).openapi("CreateCampaignBody");

export const UpdateCampaignBody = z.object({
  name: z.string().optional(),
  brandUrl: z.string().optional(),
  personTitles: z.array(z.string()).optional(),
  qOrganizationKeywordTags: z.array(z.string()).optional(),
  organizationLocations: z.array(z.string()).optional(),
  organizationNumEmployeesRanges: z.array(z.string()).optional(),
  qOrganizationIndustryTagIds: z.array(z.string()).optional(),
  qKeywords: z.string().optional(),
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
  appId: z.string().optional(),
}).openapi("UpdateCampaignBody");

// --- Stats ---

export const StatsFilterBody = z.object({
  clerkOrgId: z.string().optional(),
  appId: z.string().optional(),
  brandId: z.string().optional(),
  campaignId: z.string().optional(),
}).refine(
  (data) => data.clerkOrgId || data.appId || data.brandId || data.campaignId,
  { message: "At least one filter required: clerkOrgId, appId, brandId, or campaignId" }
).openapi("StatsFilterBody");

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

// --- Run status ---

export const RunStatusUpdate = z.object({
  status: z.enum(["completed", "failed"]),
}).openapi("RunStatusUpdate");
