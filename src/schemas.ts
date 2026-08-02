import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";

extendZodWithOpenApi(z);

// --- Shared ---

export const ErrorResponse = z.object({
  error: z.string(),
}).openapi("ErrorResponse");

// The runtime optimization goal a campaign paces against — an OPAQUE string, deliberately
// not an enum. campaign-service does NOT own this vocabulary: brand-service owns which goals
// a brand authorizes (its own column already permits values this service never had a name
// for), and features-service owns the spelling and fails loud on a goal it cannot resolve.
// A campaign's own goal, when set, overrides the brand goal for that campaign's
// pacing/candidate-selection; NULL inherits the brand.
//
// This used to be z.enum(["signup", "meetingBooked", "purchase"]), which capped a campaign to
// three of the goals the fleet supports and made the brand's own goal unrepresentable per
// campaign. The brand-goal path never went through this schema (it is read straight off
// brand-service), so the enum constrained nothing except what a caller could ASK for.
//
// Non-empty is the one constraint we keep, and it is a fail-loud rule rather than a taste:
// features-service reads an ABSENT goal as "default to meeting-booked", so an empty string
// would forward as a silent default instead of an error.
export const RuntimeGoalSchema = z.string().min(1).openapi("RuntimeGoal");

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
  audienceId: z.string().nullable(),
  // Per-campaign OWN config (Campaign v2). Null = inherit the brand. `goal` is renderable
  // and drives this campaign's runtime pacing; audienceIds is the targeted subset.
  goal: RuntimeGoalSchema.nullable(),
  audienceIds: z.array(z.string()).nullable(),
  servicesOffered: z.array(z.string()).nullable(),
  clickDestinationUrl: z.string().nullable(),
  maxBudgetDailyUsd: z.string().nullable(),
  maxBudgetWeeklyUsd: z.string().nullable(),
  maxBudgetMonthlyUsd: z.string().nullable(),
  maxBudgetTotalUsd: z.string().nullable(),
  // Per-campaign daily budget for the sales feature (cents). Null = fall back to brand daily budget.
  dailyBudgetCents: z.number().int().nullable(),
  // The sales funnel this campaign works — the ONE word for what it sells, in brand-service's
  // vocabulary (sales_meetings_from_conversation | sales_meetings_from_website |
  // website_purchases | form_magnet). A consumer reads what a campaign buys HERE; it never has to
  // consult `goal`, which survives only as a legacy alias of the same statement and cannot tell
  // the two meeting funnels apart. Null = not funnel-scoped: the campaign paces on
  // the brand-level daily budget as it always has. Set = the campaign is paced on THAT funnel's
  // own daily ceiling in billing, which is what makes a funnel's spend attributable to it.
  // Provisioned by this service from the funnels the customer funds — never set by a caller.
  funnelKey: z.string().nullable(),
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
  audienceId: z.string().min(1).nullable().optional(),
  // Per-campaign OWN config (Campaign v2). Omit / null = inherit the brand. audienceIds is the
  // targeted SUBSET (one or more) of the brand's audiences; an empty array is rejected — use
  // null to clear back to inherit.
  goal: RuntimeGoalSchema.nullable().optional(),
  audienceIds: z.array(z.string().min(1)).min(1, "audienceIds must contain at least one audience (use null to inherit the brand)").nullable().optional(),
  servicesOffered: z.array(z.string().min(1)).nullable().optional(),
  clickDestinationUrl: z.string().min(1).nullable().optional(),
  maxBudgetDailyUsd: z.string().optional(),
  maxBudgetWeeklyUsd: z.string().optional(),
  maxBudgetMonthlyUsd: z.string().optional(),
  maxBudgetTotalUsd: z.string().optional(),
  // Per-campaign daily budget for the sales feature (cents). Omit / null = fall back to brand budget.
  dailyBudgetCents: z.number().int().nonnegative().nullable().optional(),
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
  audienceId: z.string().min(1).nullable().optional(),
  // Set / clear this campaign's OWN config (Campaign v2). null clears a field → inherit the
  // brand. Updating these never touches the brand or any sibling campaign. audienceIds must be
  // non-empty when present; use null to clear back to inherit.
  goal: RuntimeGoalSchema.nullable().optional(),
  audienceIds: z.array(z.string().min(1)).min(1, "audienceIds must contain at least one audience (use null to inherit the brand)").nullable().optional(),
  servicesOffered: z.array(z.string().min(1)).nullable().optional(),
  clickDestinationUrl: z.string().min(1).nullable().optional(),
  maxBudgetDailyUsd: z.string().optional(),
  maxBudgetWeeklyUsd: z.string().optional(),
  maxBudgetMonthlyUsd: z.string().optional(),
  maxBudgetTotalUsd: z.string().optional(),
  // Set / clear this campaign's own daily budget (cents). null clears it → falls back to brand budget.
  dailyBudgetCents: z.number().int().nonnegative().nullable().optional(),
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

// --- Brand-wide campaign daily budget (propagate the brand-page budget to all campaigns) ---

// Set the daily budget (cents) for EVERY sales campaign of a brand at once. null clears each
// campaign's own budget → they fall back to the brand daily budget. Used when a customer edits
// their budget on the brand page and it must propagate down to the brand's campaign(s).
export const SetBrandCampaignsDailyBudgetBody = z.object({
  dailyBudgetCents: z.number().int().nonnegative().nullable(),
}).openapi("SetBrandCampaignsDailyBudgetBody");

export const SetBrandCampaignsDailyBudgetResponse = z.object({
  brandId: z.string(),
  orgId: z.string(),
  dailyBudgetCents: z.number().int().nullable(),
  updatedCount: z.number().int(),
}).openapi("SetBrandCampaignsDailyBudgetResponse");

// One dated pause/resume flip. paused = the new state after the flip.
export const BrandPauseTransition = z.object({
  paused: z.boolean(),
  transitionedAt: z.string(),
}).openapi("BrandPauseTransition");

// Forward-only, per-(org, brand) history of pause on/off transitions, oldest first.
export const BrandPauseHistoryResponse = z.object({
  brandId: z.string(),
  orgId: z.string(),
  transitions: z.array(BrandPauseTransition),
}).openapi("BrandPauseHistoryResponse");

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
  // Priority audience chosen for THIS run (human-service saved filter-set UUID).
  // workflow-service propagates this as x-audience-id to every downstream DAG node
  // so all run costs are attributed to the audience. Null when none is selected.
  audienceId: z.string().nullable(),
  // The campaign's OWN config for this run (Campaign v2). `goal` is the campaign's own
  // optimization goal (null = paced on the brand goal); the sending runtime reads
  // servicesOffered / clickDestinationUrl as authoritative per-campaign config (null =
  // inherit the brand). audienceIds is the campaign's targeted subset.
  goal: RuntimeGoalSchema.nullable(),
  audienceIds: z.array(z.string()).nullable(),
  servicesOffered: z.array(z.string()).nullable(),
  clickDestinationUrl: z.string().nullable(),
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
