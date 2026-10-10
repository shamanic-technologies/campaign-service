import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";

extendZodWithOpenApi(z);

// --- Shared ---

export const ErrorResponse = z.object({
  error: z.string(),
}).openapi("ErrorResponse");

// The runtime optimization goal — an OPAQUE string, deliberately not an enum. This service does
// NOT own the vocabulary and no longer WRITES it: a campaign says what it sells with its OFFER and
// the LEG it is bought for.
//
// The value is still SERVED wherever it is stored, because consumers are still reading it and
// migrate next; nothing sets it any more (it is absent from the create/update bodies). The COLUMN
// is scheduled for removal once those consumers are off it.
//
// Non-empty stays a fail-loud rule rather than a taste: features-service reads an ABSENT goal as
// "default to meeting-booked", so an empty string would forward as a silent default.
export const RuntimeGoalSchema = z.string().min(1).openapi("RuntimeGoal");

export const CampaignSchema = z.object({
  id: z.string().uuid(),
  orgId: z.string(),
  createdByUserId: z.string().nullable(),
  parentRunId: z.string().nullable(),
  name: z.string(),
  // NULL for a campaign whose acquisition channel the CUSTOMER operates: the work is performed by
  // their own team off-platform, so there is no DAG and none is invented. Such a campaign is never
  // scheduled and never runs — it is a budget line, a scope for stats and a thing they can pause.
  // Every platform-operated campaign states one, and CreateCampaignBody still requires one.
  workflowSlug: z.string().nullable(),
  brandIds: z.array(z.string().uuid()).nullable(),
  featureSlug: z.string().nullable(),
  featureInputs: z.record(z.string(), z.unknown()).nullable(),
  activeGoalId: z.string().nullable(),
  brandProfileId: z.string().nullable(),
  audienceId: z.string().nullable(),
  // Per-campaign OWN config (Campaign v2). Null = inherit the brand. audienceIds is the
  // targeted subset. `goal` is a LEGACY read-only field: still served wherever it is stored so
  // consumers reading it keep working, never written any more, and scheduled for removal — a
  // campaign states what it sells with `offerId` + `legKey`.
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
  // The OFFER this campaign sells — a brand-service offer UUID. A campaign is (offer x leg x
  // acquisition channel). Never derived from the goal or the workflow. Null = the campaign states
  // no offer (every campaign created before it could be stated).
  offerId: z.string().nullable(),
  // The single LEG this campaign is bought for — features-service's canonical leg identifier,
  // published on its `GET /public/channels` catalogue as `legs[].legKey`. A leg is the
  // step-to-step move a customer actually buys. OPAQUE — never split into the steps it connects,
  // and never derived from the channel or the workflow. Null = the campaign states no leg.
  legKey: z.string().nullable(),
  // SALES FUNNEL UNIT (owner 2026-10-10): the features-service sales funnel id (its
  // `combinationKey`) this campaign is one pipe of, and the funnel-level campaign that owns it
  // (GET /sales-funnel-campaigns/{id}). Null on both = a pre-funnel (leg x channel) campaign. A
  // unit is run and paused ONLY through its funnel campaign: PATCH /campaigns/{id} refuses its
  // status and identity (409 `sales_funnel_unit`).
  salesFunnelId: z.string().nullable(),
  salesFunnelCampaignId: z.string().nullable(),
  maxLeads: z.number().int().nullable(),
  startDate: z.string().nullable(),
  endDate: z.string().nullable(),
  status: z.string(),
  // WHY the campaign stopped: manual (a person stopped it) | org_teardown | payment_declined
  // (billing cannot charge the org's card — the customer must pay what is owed and add a working
  // card, then start it again; until then every start is refused with reason payment_declined)
  // | no_payment_method (the org has no card billing can charge — removed or never added; the
  // customer must add one, then start it again; until then every start is refused with reason
  // no_payment_method).
  // Null on an ongoing campaign, and on every campaign stopped before the reason was recorded.
  // Nothing restarts a stopped campaign automatically.
  stopReason: z.string().nullable(),
  nextRunAt: z.string().nullable(),
  // RUN-FAILURE STREAK (written only by /end-run). Failed runs in a row since the last success,
  // when the streak started, the latest failure, and the last staff alert for this campaign.
  // 0 / null = healthy. A streak widens the retry interval and alerts staff once per episode;
  // it never changes the status. See GET /internal/campaigns/failing for the derived state.
  consecutiveRunFailures: z.number().int(),
  failingSince: z.string().nullable(),
  lastRunFailureAt: z.string().nullable(),
  failureAlertedAt: z.string().nullable(),
  notifyFrequency: z.string().nullable(),
  notifyChannel: z.string().nullable(),
  notifyDestination: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
}).openapi("Campaign");

// --- Public campaign routes ---

export const CreateCampaignBody = z.object({
  name: z.string().min(1, "Campaign name is required"),
  // The DAG this campaign is born on (the selector's fallback). REQUIRED for every channel a
  // workflow runs; REFUSED for a channel another service performs on an event (`ai-instant-call`:
  // its campaign has no workflow, by design, and a stated one is a 400 rather than stored).
  workflowSlug: z.string().min(1).optional().openapi({
    description: "Required, except for a channel another service performs on an event (ai-instant-call), where it must be omitted: that campaign has no workflow.",
  }),
  orgId: z.string().min(1, "orgId is required"),
  brandIds: z.array(z.string().uuid("each brandId must be a valid UUID")).min(1, "at least one brandId is required"),
  featureSlug: z.string().min(1).optional(),
  featureInputs: z.record(z.string(), z.unknown()).optional(),
  activeGoalId: z.string().min(1).nullable().optional(),
  brandProfileId: z.string().min(1).nullable().optional(),
  audienceId: z.string().min(1).nullable().optional(),
  // The OFFER this campaign sells — a brand-service offer UUID. REQUIRED for the sales family
  // (with `legKey`: that is what billing funds a campaign at); optional for every other feature.
  // Nothing is ever inferred when it is absent.
  offerId: z.string().uuid("offerId must be a valid UUID").nullable().optional(),
  // The single LEG this campaign is bought for — features-service's canonical leg identifier,
  // taken verbatim from its published catalogue (`GET /public/channels` → `legs[].legKey`).
  // REQUIRED for the sales family, optional otherwise. Not validated against a local list,
  // because there is no local list: this service does not own the leg vocabulary.
  legKey: z.string().min(1).nullable().optional(),
  // Per-campaign OWN config (Campaign v2). Omit / null = inherit the brand. audienceIds is the
  // targeted SUBSET (one or more) of the brand's audiences; an empty array is rejected — use
  // null to clear back to inherit.
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

// The two values `campaigns.status` is ever written with. There is no `active` and no
// `running` — a live campaign is `ongoing` (see CLAUDE.md, "Campaign status enum"). The enum
// is what makes an unrecognised status a loud 400 instead of a silently unfiltered list.
export const CampaignStatusEnum = z.enum(["ongoing", "stopped"], {
  error: 'status must be "ongoing" (running) or "stopped"',
}).openapi("CampaignStatusEnum");

export const CampaignsFilterQuery = z.object({
  brandId: z.string().optional(),
  status: CampaignStatusEnum.optional(),
  workflowSlug: z.string().optional(),
  featureSlug: z.string().optional(),
  // Find a campaign by (offer, leg, channel): with featureSlug these three are what a campaign
  // IS. Each is an exact match.
  offerId: z.string().optional(),
  legKey: z.string().optional(),
  // The units of one sales funnel campaign (exact match on `salesFunnelCampaignId`).
  salesFunnelCampaignId: z.string().optional(),
  // Optional cap on how many rows come back. Absent = every match, which is what every
  // existing consumer gets today. When present the response also carries `hasMore`, so a
  // truncated list is never mistaken for a complete one.
  limit: z.coerce.number().int().min(1).max(1000).optional(),
}).openapi("CampaignsFilterQuery");

/**
 * What the CUSTOMER states to start the campaign for a pair they have already funded.
 *
 * Exactly the four things their own screen knows (brand, offer, leg, channel), and nothing else. `.strict()` is load-bearing:
 * a caller reaching for a workflow, a name or a budget is TOLD no rather than having it silently
 * stripped, because each of those would be this service handing back a decision that is not the
 * browser's to make (the workflow), a fact already derivable (the name), or a second
 * representation of billing's money (the ceiling).
 */
export const StartFundedPairBody = z.object({
  brandId: z.string().uuid("brandId must be a valid UUID"),
  // The OFFER whose money funds this campaign — brand-service's UUID, carried and never derived.
  // Required together with `legKey` (refused with `leg_required` otherwise).
  offerId: z.string().uuid("offerId must be a valid UUID").nullable().optional(),
  // The ACQUISITION CHANNEL, as a features-service feature slug. A channel IS a feature slug.
  featureSlug: z.string().min(1, "featureSlug is required"),
  // The LEG the campaign is bought for. REQUIRED, with `offerId`. A leg the channel does not
  // perform is refused rather than stamped.
  legKey: z.string().min(1).nullable().optional(),
}).strict().openapi("StartFundedPairBody");

/**
 * A campaign a person's start turned OFF: the offer's other PROACTIVE campaign (owner 2026-10-05,
 * one proactive campaign on per offer). Stopped with stopReason `manual`, transition source
 * `proactive_switch`, in the same transaction as the start.
 */
export const StoppedCampaignSchema = z.object({
  id: z.string(),
  name: z.string(),
  featureSlug: z.string().nullable(),
  offerId: z.string().nullable(),
  legKey: z.string().nullable(),
}).openapi("StoppedCampaign");

// --- Sales funnel campaigns (owner 2026-10-10, lib/sales-funnel-campaigns.ts) ---

/**
 * A person (or the agent acting for them) launches a SALES FUNNEL as one campaign: brand x offer x
 * sales funnel. Everything else is resolved here: the pipes are features-service's statement of the
 * funnel, each pipe's workflow is this service's choice (re-picked every run), and the money is
 * billing's funnel caps. `.strict()`: a caller reaching for a workflow, a pipe list or a budget is
 * told no rather than having it silently stripped.
 */
export const CreateSalesFunnelCampaignBody = z.object({
  brandId: z.string().uuid("brandId must be a valid UUID"),
  offerId: z.string().uuid("offerId must be a valid UUID"),
  // features-service's sales funnel id (`GET /internal/catalogue/sales-funnels` rows[].id), verbatim.
  salesFunnelId: z.string().min(1, "salesFunnelId is required"),
  // REQUIRED: "ongoing" launches it now, "stopped" creates it switched off. Never defaulted: a
  // campaign the customer did not start must never start.
  status: CampaignStatusEnum,
}).strict().openapi("CreateSalesFunnelCampaignBody");

/** Run or pause the WHOLE funnel: every unit moves with it, in one transaction. */
export const UpdateSalesFunnelCampaignBody = z.object({
  status: z.enum(["activate", "stop"], { error: 'status must be "activate" or "stop"' }),
}).strict().openapi("UpdateSalesFunnelCampaignBody");

export const SalesFunnelCampaignsQuery = z.object({
  brandId: z.string().optional(),
  offerId: z.string().optional(),
  salesFunnelId: z.string().optional(),
  status: CampaignStatusEnum.optional(),
}).openapi("SalesFunnelCampaignsQuery");

/** One pipe of a funnel campaign: the `campaigns` row that runs it. */
export const SalesFunnelUnitSchema = z.object({
  campaignId: z.string(),
  // `<channel slug>|<leg key>`, features-service's pipe id.
  pipeId: z.string(),
  featureSlug: z.string(),
  legKey: z.string(),
  // Always equal to the funnel campaign's status (they move together).
  status: z.string(),
  // The DAG fallback this unit runs (re-picked every run); null for a channel the customer
  // operates or another service performs (it never runs a DAG).
  workflowSlug: z.string().nullable(),
  name: z.string(),
}).openapi("SalesFunnelUnit");

export const SalesFunnelCampaignSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  brandId: z.string(),
  offerId: z.string(),
  salesFunnelId: z.string(),
  salesFunnelName: z.string(),
  // "ongoing" | "stopped", the campaign vocabulary.
  status: z.string(),
  // STOP_REASONS: manual | org_teardown | payment_declined | no_payment_method; null while ongoing.
  stopReason: z.string().nullable(),
  createdByUserId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  units: z.array(SalesFunnelUnitSchema),
}).openapi("SalesFunnelCampaign");

/** A person saved the offer's sales paths: switch on the reactive campaigns they use. */
export const ReactiveDefaultsBody = z.object({
  brandId: z.string().uuid("brandId must be a valid UUID"),
}).strict().openapi("ReactiveDefaultsBody");

export const ReactiveDefaultsResponse = z.object({
  offerId: z.string(),
  basis: z.enum(["stated", "roi_above_1"]),
  tickedCombinationKeys: z.array(z.string()),
  started: z.array(z.object({ id: z.string(), name: z.string(), featureSlug: z.string().nullable(), legKey: z.string().nullable() })),
  alreadyOn: z.array(z.string()),
  keptOff: z.array(z.string()),
  skipped: z.array(z.object({ legKey: z.string(), featureSlug: z.string(), reason: z.string() })),
}).openapi("ReactiveDefaultsResponse");

export const UpdateCampaignBody = z.object({
  name: z.string().optional(),
  brandIds: z.array(z.string().uuid()).optional(),
  featureSlug: z.string().min(1).optional(),
  featureInputs: z.record(z.string(), z.unknown()).optional(),
  activeGoalId: z.string().min(1).nullable().optional(),
  brandProfileId: z.string().min(1).nullable().optional(),
  audienceId: z.string().min(1).nullable().optional(),
  // State (or clear) the OFFER this campaign sells — a brand-service offer UUID. Omit and it is
  // untouched; null clears it back to "states no offer". This is how a caller that created a
  // campaign before it could state an offer says which one it runs, without a second campaign.
  offerId: z.string().uuid("offerId must be a valid UUID").nullable().optional(),
  // State (or clear) the single LEG this campaign is bought for — features-service's
  // canonical leg identifier, verbatim. Omit and it is untouched; null clears it back to "states
  // no leg". This is how a campaign created before it could state a leg says which one it buys,
  // without a second campaign.
  legKey: z.string().min(1).nullable().optional(),
  // Set / clear this campaign's OWN config (Campaign v2). null clears a field → inherit the
  // brand. Updating these never touches the brand or any sibling campaign. audienceIds must be
  // non-empty when present; use null to clear back to inherit. `goal` is deliberately absent: it
  // is a legacy read-only field nothing writes any more.
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
  // The campaign's OWN config for this run (Campaign v2). `goal` is LEGACY and read-only —
  // served as stored (almost always null), never written, scheduled for removal; the sending
  // runtime reads
  // servicesOffered / clickDestinationUrl as authoritative per-campaign config (null =
  // inherit the brand). audienceIds is the campaign's targeted subset.
  goal: RuntimeGoalSchema.nullable(),
  // The OFFER this campaign sells — brand-service's id, carried and never derived. A brand
  // holding SEVERAL offers refuses every brand-scoped read with 409 SEVERAL_OFFERS, so a
  // downstream DAG node that reads brand-service scopes its call on this rather than guessing
  // one. Null for a campaign older than the offer level.
  offerId: z.string().nullable(),
  audienceIds: z.array(z.string()).nullable(),
  servicesOffered: z.array(z.string()).nullable(),
  clickDestinationUrl: z.string().nullable(),
  searchParams: z.record(z.string(), z.unknown()).nullable(),
}).openapi("StartRunResponse");

export const EndRunBody = z.object({
  success: z.boolean(),
  stopCampaign: z.boolean(),
  /**
   * The run completed normally and found NOTHING TO DO — a channel that answers one interested
   * prospect per run, asked for the next person owed an answer, and nobody was owed one.
   *
   * It changes ONE thing: the campaign is rescheduled on the idle cadence
   * (`NO_WORK_RECHECK_MS`, 10 min) instead of the run cadence, because the answer cannot change
   * in ten seconds. It never stops a campaign and never marks anything exhausted — that is
   * `stopCampaign`'s (audience-scoped, cold-email) vocabulary and it stays separate.
   *
   * OPTIONAL and absent means "this run did work": every caller that does not send it behaves
   * byte-identically to before the field existed.
   */
  noWorkAvailable: z.boolean().optional(),
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
  coBrandedSkipped: z.number().int().describe("Campaigns of the source org naming the source brand AND another brand: left in place, never moved"),
}).openapi("TransferBrandResponse");

// --- Internal: Org Teardown ---

export const DeleteCampaignsByOrgResponse = z.object({
  updatedTables: z.array(z.object({
    tableName: z.string(),
    count: z.number().int(),
  })),
}).openapi("DeleteCampaignsByOrgResponse");

// --- Brand spendable budget (configured vs running) ---

/**
 * "Of the money configured for this brand, how much is attached to a campaign that is actually
 * running?" Both figures are always served: a paused campaign's own settings screen must still
 * show the amount the customer set, or it reads as zero and looks like the setting was lost.
 *
 * Nothing is left for a consumer to add up — the brand total, each offer's total and each
 * campaign's total are all stated, alongside the ceiling rows that produced them.
 */
export const SpendableBudgetRow = z.object({
  featureSlug: z.string().nullable(),
  offerId: z.string().nullable(),
  legKey: z.string().nullable(),
  resolvedOfferId: z.string().nullable(),
  dailyBudgetCents: z.number().int(),
  running: z.boolean(),
  campaignId: z.string().nullable(),
  campaignStatus: z.string().nullable(),
}).openapi("SpendableBudgetRow");

export const SpendableBudgetOffer = z.object({
  offerId: z.string().nullable(),
  // Includes the offer's sales funnels' daily figures (fractional when a weekly / monthly cap is).
  configuredDailyBudgetCents: z.number(),
  runningDailyBudgetCents: z.number(),
  campaignIds: z.array(z.string()),
}).openapi("SpendableBudgetOffer");

export const SpendableBudgetCampaign = z.object({
  campaignId: z.string(),
  status: z.string(),
  running: z.boolean(),
  featureSlug: z.string().nullable(),
  offerId: z.string().nullable(),
  legKey: z.string().nullable(),
  // The SALES FUNNEL campaign owning this unit; null on a pre-funnel campaign. A unit's own
  // figures are always 0: its money is its funnel's, counted under `salesFunnels`.
  salesFunnelCampaignId: z.string().nullable(),
  configuredDailyBudgetCents: z.number(),
  runningDailyBudgetCents: z.number(),
}).openapi("SpendableBudgetCampaign");

/**
 * One SALES FUNNEL with a stated cap (billing `GET /internal/brands/:id/sales-funnel-caps`): its max
 * budget as billing's SERVED daily figure `maxBudget.dailyBudgetCents` (daily x1, weekly / 7,
 * monthly / 30, one_off 0, REACTIVE 0, volume-only 0; never discounted, never recomputed here). Counted in the brand and offer totals; `running` ⟺ its funnel
 * campaign is ongoing. Never resolved onto a per-pipe ceiling.
 */
export const SpendableBudgetSalesFunnel = z.object({
  offerId: z.string(),
  salesFunnelId: z.string(),
  salesFunnelCampaignId: z.string().nullable(),
  status: z.string().nullable(),
  running: z.boolean(),
  maxBudget: z.object({ amountCents: z.number(), period: z.enum(["one_off", "daily", "weekly", "monthly"]) }).nullable(),
  dailyBudgetCents: z.number(),
  recurring: z.boolean(),
  unitCampaignIds: z.array(z.string()),
}).openapi("SpendableBudgetSalesFunnel");

export const SpendableBudgetResponse = z.object({
  orgId: z.string(),
  brandId: z.string(),
  // The grain of the PRE-FUNNEL money (billing's ceilings / pot); sales funnels are `salesFunnels`.
  grain: z.enum(["campaign", "brand", "none"]),
  // Pre-funnel rows + every sales funnel's daily figure; running = rows of ongoing campaigns +
  // funnels whose funnel campaign is ongoing. A funnel caps read billing cannot answer = 502 /
  // `unavailable`, never a smaller figure.
  configuredDailyBudgetCents: z.number(),
  runningDailyBudgetCents: z.number(),
  offers: z.array(SpendableBudgetOffer),
  campaigns: z.array(SpendableBudgetCampaign),
  rows: z.array(SpendableBudgetRow),
  salesFunnels: z.array(SpendableBudgetSalesFunnel),
}).openapi("SpendableBudgetResponse");

/**
 * The fleet-wide ask. A staff audit walks every account, so one request per brand is not an
 * option — the pairs come in a body because the answer is per (org, brand) and a staff caller
 * crosses orgs.
 */
export const BatchSpendableBudgetBody = z.object({
  brands: z.array(z.object({
    orgId: z.string().min(1),
    brandId: z.string().min(1),
  })).min(1).max(500),
}).openapi("BatchSpendableBudgetBody");

export const BatchSpendableBudgetResponse = z.object({
  brands: z.array(SpendableBudgetResponse),
  /**
   * The pairs whose ceilings billing could not be read for. They carry NO figures at all — never
   * a zero, which would silently shrink a fleet total — and are named here so a caller knows its
   * sweep is incomplete.
   */
  unavailable: z.array(z.object({
    orgId: z.string(),
    brandId: z.string(),
    reason: z.string(),
  })),
}).openapi("BatchSpendableBudgetResponse");

/**
 * A LEAD JUST REACHED A STEP — run the campaign bought for the leg OUT of it, now.
 *
 * The scope is the (brand, offer) the lead is on plus the step they reached. Nothing is inferred
 * from anything else: the leg is features-service's statement about that step, and the campaign is the one already stating that leg. The org rides on `x-org-id`, like
 * every other per-(org, brand) read in this service.
 */
export const TriggerForStepBody = z.object({
  brandId: z.string().uuid("brandId must be a valid UUID"),
  // The OFFER the lead is on — brand-service's id. Matched exactly against the campaign's own; a
  // campaign that states no offer is not the campaign of the offer named here.
  offerId: z.string().uuid("offerId must be a valid UUID"),
  // The step the lead just REACHED — features-service's step key, carried verbatim and never
  // parsed. A step it does not publish is a 400, never an empty answer.
  step: z.string().min(1, "step is required"),
  // OPTIONAL: the lead that reached the step, recorded on the trigger event (lib/trigger-events.ts).
  leadId: z.string().min(1).optional(),
}).openapi("TriggerForStepBody");

export const TriggerForStepResponse = z.object({
  step: z.string(),
  /** The legs OUT of that step, as features-service names them. */
  legKeys: z.array(z.string()),
  triggered: z.array(z.object({
    campaignId: z.string(),
    legKey: z.string().nullable(),
    workflowSlug: z.string(),
  })),
  /**
   * The campaigns that perform the leg and were NOT run, each saying why. A named skip is what
   * makes "nobody bought this leg" / "it is out of budget" readable as an ordinary answer rather
   * than as a failure.
   */
  skipped: z.array(z.object({
    campaignId: z.string(),
    legKey: z.string().nullable(),
    reason: z.string(),
    detail: z.string(),
  })),
  /** The trigger event this call recorded (null only when the record could not be written: logged). */
  eventId: z.string().nullable(),
  /** The trigger type whose `fromStep` is this step (features-service `triggers[]`), null when none is declared. */
  triggerId: z.string().nullable(),
}).openapi("TriggerForStepResponse");

// ── TRIGGER EVENTS (owner 2026-10-09; src/lib/trigger-events.ts) ─────────────────────────────────

const isoDateTime = (name: string) =>
  z.string().refine((v) => !Number.isNaN(Date.parse(v)), `${name} must be an ISO date-time`);

export const RecordTriggerEventBody = z.object({
  /** A trigger type features-service declares (`GET /public/channels` `triggers[].id`). Unknown = 400 `unknown_trigger`. */
  triggerId: z.string().min(1, "triggerId is required"),
  brandId: z.string().uuid("brandId must be a valid UUID"),
  offerId: z.string().uuid("offerId must be a valid UUID"),
  leadId: z.string().min(1).optional(),
  /** The campaign that ASKED (e.g. the outreach campaign that requested a lead). */
  requestedByCampaignId: z.string().min(1).optional(),
  /** Unique per org: a retried call returns the first event (`replayed: true`), recorded once. */
  idempotencyKey: z.string().min(1).max(200).optional(),
  /** When it happened. Absent = now. */
  occurredAt: isoDateTime("occurredAt").optional(),
  /** When it must fire. Absent = when it occurred. Later than now = recorded `pending`, fired by the tick. */
  dueAt: isoDateTime("dueAt").optional(),
  /**
   * The caller ALREADY performed it in-process and states what happened; nothing is dispatched here.
   * `ran` names the campaign the work was filed under (must be a campaign of the org).
   */
  performed: z.discriminatedUnion("outcome", [
    z.object({ outcome: z.literal("ran"), campaignId: z.string().min(1) }).strict(),
    z.object({ outcome: z.literal("skipped"), reason: z.string().min(1), detail: z.string().optional() }).strict(),
  ]).optional(),
}).strict().refine((b) => !(b.performed && b.dueAt), {
  message: "an event already performed has no due time: send `performed` or `dueAt`, not both",
}).openapi("RecordTriggerEventBody");

export const TriggerEventSchema = z.object({
  id: z.string(),
  triggerId: z.string().nullable(),
  step: z.string().nullable(),
  orgId: z.string(),
  brandId: z.string(),
  offerId: z.string(),
  leadId: z.string().nullable(),
  requestedByCampaignId: z.string().nullable(),
  /** `trigger_for_step` | `trigger_events` */
  recordedVia: z.string(),
  occurredAt: z.string(),
  dueAt: z.string(),
  /** `pending` (due later) | `firing` | `done` */
  status: z.string(),
  /** `ran` | `skipped`; null until done */
  outcome: z.string().nullable(),
  /**
   * When skipped: a campaign's named skip (`unfunded`, `run_in_flight`, `no_workflow`,
   * `global_sales_budget_reached`, `item_budget_reached`, `cohort_run_in_flight`,
   * `incomplete_campaign`, `dispatch_refused`, `failure_backoff`), else `campaign_off`,
   * `no_campaign`, `no_leg`, `trigger_not_declared`, or the caller's own reason when performed.
   */
  skipReason: z.string().nullable(),
  ranCampaignIds: z.array(z.string()),
  performedByCaller: z.boolean(),
  processedAt: z.string().nullable(),
  /** Every per-campaign answer: `{legKeys, triggered[], skipped[], offCampaignIds}` (or the caller's `performedDetail`). */
  detail: z.any().nullable(),
}).openapi("TriggerEvent");

export const RecordTriggerEventResponse = z.object({
  event: TriggerEventSchema,
  replayed: z.boolean(),
}).openapi("RecordTriggerEventResponse");

export const OfferTriggerEventsSummaryQuery = z.object({
  brandId: z.string().uuid("brandId must be a valid UUID"),
  from: isoDateTime("from"),
  /** Absent = now. */
  to: isoDateTime("to").optional(),
}).openapi("OfferTriggerEventsSummaryQuery");

export const OfferTriggerEventsSummaryResponse = z.object({
  orgId: z.string(),
  brandId: z.string(),
  offerId: z.string(),
  from: z.string(),
  to: z.string(),
  /** Earliest event this service holds anywhere: before it, nothing was recorded (not "nothing fired"). */
  recordedSince: z.string().nullable(),
  /** One row per trigger type that has at least one event in the window (`triggerId` null = a step with no declared type). */
  triggers: z.array(z.object({
    triggerId: z.string().nullable(),
    events: z.number().int(),
    ran: z.number().int(),
    skipped: z.number().int(),
    pending: z.number().int(),
    skippedByReason: z.array(z.object({ reason: z.string(), count: z.number().int() })),
    lastOccurredAt: z.string().nullable(),
  })),
}).openapi("OfferTriggerEventsSummaryResponse");

export const OfferTriggerEventsListQuery = z.object({
  brandId: z.string().uuid("brandId must be a valid UUID"),
  /** 1-200. Absent = 50. */
  limit: z.string().regex(/^\d+$/, "limit must be an integer").optional(),
}).openapi("OfferTriggerEventsListQuery");

export const OfferTriggerEventsListResponse = z.object({
  events: z.array(TriggerEventSchema),
}).openapi("OfferTriggerEventsListResponse");

/**
 * WHICH CAMPAIGN RAN THE LEG THAT ENDS WHERE THIS ONE BEGINS.
 *
 * A journey is several legs and this service mints one campaign per leg, so a campaign bought for a
 * leg that CONTINUES another cannot, on its own, find what it is continuing — while the person, the
 * thread and the record of what is owed them are all filed under the campaign that ran the leg
 * before. This is that lookup, over state this service already holds.
 *
 * `absence` is non-null exactly when `predecessor` is null, and it NAMES why: a campaign at the
 * first leg of a journey has no predecessor and says so, rather than being handed the closest
 * sibling. "There is none" and "it could not be worked out" stay different answers — the second is
 * a 409 or a 502, never a null.
 */
export const PredecessorCampaignResponse = z.object({
  campaignId: z.string(),
  legKey: z.string().nullable(),
  offerId: z.string().nullable(),
  brandId: z.string().nullable(),
  /** The step this campaign's leg takes a lead OUT of — where its predecessor must end. */
  fromStepKey: z.string().nullable(),
  /** Every published leg ending at that step, as features-service names them. */
  precedingLegKeys: z.array(z.string()),
  predecessor: z.object({
    campaignId: z.string(),
    legKey: z.string(),
    status: z.string(),
    acquisitionChannel: z.string().nullable(),
    featureSlug: z.string().nullable(),
    workflowSlug: z.string().nullable(),
  }).nullable(),
  /**
   * `entry_leg` | `campaign_states_no_leg` |
   * `campaign_states_no_offer` | `campaign_states_no_brand` | `no_campaign_for_preceding_leg`
   */
  absence: z.string().nullable(),
}).openapi("PredecessorCampaignResponse");

/**
 * WHO ANSWERS THE PEOPLE THIS CAMPAIGN HOLDS — the inverse of the predecessor lookup.
 *
 * A campaign that ran a leg ending at a step (a prospect asked for a meeting) holds the people owed
 * the next action; the campaign on the leg that continues from that step answers them, by resolving
 * its predecessor and claiming on exactly that id. This answers, for the held campaign, which live
 * campaign that is — derived from the predecessor resolver itself, so it cannot disagree with the
 * claim — or names why there is none. `absence` is non-null exactly when `answeredBy` is null.
 */
const AnsweringCampaignSchema = z.object({
  campaignId: z.string(),
  legKey: z.string(),
  status: z.string(),
  featureSlug: z.string().nullable(),
  acquisitionChannel: z.string().nullable(),
  /** Null for a channel the customer operates: a person answers, no workflow claims. */
  workflowSlug: z.string().nullable(),
});

export const AnsweringCampaignResponse = z.object({
  campaignId: z.string(),
  legKey: z.string().nullable(),
  offerId: z.string().nullable(),
  brandId: z.string().nullable(),
  /** The step this campaign's leg takes a lead INTO — where an answering leg must start. */
  toStepKey: z.string().nullable(),
  /** Every published leg starting at that step, as features-service names them. */
  continuingLegKeys: z.array(z.string()),
  /** Sales-family features whose channel performs one of those legs: what the customer could start. */
  startableFeatureSlugs: z.array(z.string()),
  answeredBy: AnsweringCampaignSchema.nullable(),
  /**
   * `campaign_states_no_leg` | `campaign_states_no_offer` | `campaign_states_no_brand` |
   * `no_leg_continues` | `no_answering_campaign` | `answering_campaign_stopped` |
   * `answering_campaign_serves_another`
   */
  absence: z.string().nullable(),
  /** The campaign on the continuing leg behind `answering_campaign_stopped` / `_serves_another`. */
  candidate: AnsweringCampaignSchema.nullable(),
  /** For `answering_campaign_serves_another`: whose people that candidate answers instead. */
  candidateAnswersCampaignId: z.string().nullable(),
}).openapi("AnsweringCampaignResponse");

export const AnsweringCampaignsBody = z.object({
  /** Bounded: a consumer asks for the campaigns holding one lead's or one page's owed answers. */
  campaignIds: z.array(z.string().min(1)).min(1).max(200),
}).openapi("AnsweringCampaignsBody");

export const AnsweringCampaignsResponse = z.object({
  /** One entry per requested id, in the order asked. `ok: false` names why that one could not be resolved. */
  campaigns: z.array(z.union([
    AnsweringCampaignResponse.extend({ ok: z.literal(true) }),
    z.object({
      ok: z.literal(false),
      campaignId: z.string(),
      status: z.number(),
      reason: z.string(),
      error: z.string(),
    }),
  ])),
}).openapi("AnsweringCampaignsResponse");

/**
 * WAS THIS CAMPAIGN EARNING, day by day — the request and the answer.
 *
 * A day is a UTC calendar day and is evaluated at its END (or at now, for a day still running):
 * the state a campaign finished the day in is the one a daily run-rate counts.
 */
const UtcDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected a UTC day as YYYY-MM-DD");

export const EarningHistoryQuery = z.object({
  from: UtcDay,
  to: UtcDay,
}).openapi("EarningHistoryQuery");

export const EarningHistoryBody = z.object({
  /**
   * Bounded deliberately: a consumer reconstructing a month reads many campaigns at once, and an
   * unbounded id list is an unbounded response. 500 is a month of a large org in one call.
   */
  campaignIds: z.array(z.string().min(1)).min(1).max(500),
  from: UtcDay,
  to: UtcDay,
}).openapi("EarningHistoryBody");

export const EarningDaySchema = z.object({
  day: z.string(),
  /** `not_recorded` is a real answer: the record had not begun. Never collapse it to stopped. */
  status: z.enum(["ongoing", "stopped", "not_recorded"]),
  audience: z.enum(["available", "exhausted", "not_recorded"]),
  /** Running AND able to reach somebody. `null` = unknown, never a zero. */
  earning: z.boolean().nullable(),
  unknownReason: z
    .enum(["status_not_recorded", "audience_not_recorded", "both_not_recorded"])
    .optional(),
}).openapi("EarningDay");

export const CampaignEarningHistorySchema = z.object({
  campaignId: z.string(),
  /** When each axis started being answerable. Null = nothing recorded for it yet. */
  statusRecordedSince: z.string().nullable(),
  audienceRecordedSince: z.string().nullable(),
  days: z.array(EarningDaySchema),
}).openapi("CampaignEarningHistory");

export const EarningHistoryResponse = z.object({
  campaigns: z.array(CampaignEarningHistorySchema),
}).openapi("EarningHistoryResponse");

/**
 * WHICH CAMPAIGNS COUNT TOWARD RECURRING DAILY SPEND RIGHT NOW — per brand or per org, one call.
 * See `lib/recurring-status.ts`. No money and no payment state: those are billing's.
 */
export const RecurringStatusQuery = z.object({
  orgId: z.string().min(1).optional(),
  brandId: z.string().min(1).optional(),
}).openapi("RecurringStatusQuery");

export const RecurringCampaignStatusSchema = z.object({
  campaignId: z.string(),
  orgId: z.string(),
  brandId: z.string().nullable(),
  offerId: z.string().nullable(),
  legKey: z.string().nullable(),
  featureSlug: z.string().nullable(),
  acquisitionChannel: z.string().nullable(),
  status: z.string(),
  running: z.boolean(),
  /** False = a customer-operated channel with no DAG: never scheduled, never spends. */
  executedByPlatform: z.boolean(),
  /** proactive = an ENTRY leg (no step before it); reactive = fires from a step a lead reached. */
  kind: z.enum(["proactive", "reactive"]).nullable(),
  kindUnknownReason: z.enum(["campaign_states_no_leg", "leg_not_published"]).optional(),
  /** The current audience-availability period /end-run records. `not_recorded` is never `available`. */
  audience: z.enum(["available", "exhausted", "not_recorded"]),
  allAudiencesExhausted: z.boolean().nullable(),
  audienceSince: z.string().nullable(),
  audienceLastObservedAt: z.string().nullable(),
  /** running AND platform-executed AND proactive AND not exhausted; null only when it turns on an unknown. */
  recurring: z.boolean().nullable(),
  recurringUnknownReason: z.enum(["kind_unknown", "audience_not_recorded"]).optional(),
}).openapi("RecurringCampaignStatus");

export const RecurringStatusResponse = z.object({
  campaigns: z.array(RecurringCampaignStatusSchema),
}).openapi("RecurringStatusResponse");

// --- Internal: failing campaigns ---

export const RunHealthSchema = z.object({
  state: z.enum(["healthy", "retrying", "failing"]).openapi({
    description: "healthy: no failed run since the last success. retrying: the last run(s) failed, fewer than the alert threshold in a row. failing: the alert threshold or more in a row; staff were told.",
  }),
  consecutiveFailures: z.number().int(),
  failingSince: z.string().nullable(),
  lastFailureAt: z.string().nullable(),
  retryIntervalMs: z.number().int().nullable().openapi({ description: "The delay applied after the latest failure; null when healthy" }),
  alertedAt: z.string().nullable().openapi({ description: "The last staff alert for this campaign; survives a reset" }),
}).openapi("RunHealth");

export const FailingCampaignsResponse = z.object({
  thresholds: z.object({
    failuresAtBaseCadence: z.number().int(),
    baseRetryMs: z.number().int(),
    retryCeilingMs: z.number().int(),
    failingAlertThreshold: z.number().int(),
    alertCooldownMs: z.number().int(),
  }),
  campaigns: z.array(z.object({
    id: z.string(),
    orgId: z.string(),
    name: z.string(),
    brandIds: z.array(z.string()).nullable(),
    featureSlug: z.string().nullable(),
    status: z.string(),
    nextRunAt: z.string().nullable(),
    runHealth: RunHealthSchema,
  })),
}).openapi("FailingCampaignsResponse");

// === SOURCE CAMPAIGNS (lib/source-campaigns.ts) ===

export const SourceCampaignsQuery = z.object({
  brandId: z.string().min(1, "brandId is required"),
}).openapi("SourceCampaignsQuery");

export const SourceCampaignsMirrorBody = z.object({
  apply: z.boolean().optional(),
}).strict().openapi("SourceCampaignsMirrorBody");

export const OfferSourceCampaignSchema = z.object({
  featureSlug: z.string(),
  legKey: z.string(),
  campaignKey: z.string(),
  live: z.boolean(),
  campaignId: z.string().nullable(),
  name: z.string().nullable(),
  status: z.string().nullable(),
  running: z.boolean(),
  stopReason: z.string().nullable(),
}).openapi("OfferSourceCampaign");

export const RunningSourceCampaignSchema = z.object({
  featureSlug: z.string(),
  campaignId: z.string(),
  campaignKey: z.string(),
}).openapi("RunningSourceCampaign");

export const OfferSourceCampaignsResponse = z.object({
  orgId: z.string(),
  brandId: z.string(),
  offerId: z.string(),
  sourceLegKey: z.string(),
  leadFoundStep: z.literal("lead_found"),
  sourceCampaigns: z.array(OfferSourceCampaignSchema),
  runningSourceCampaigns: z.array(RunningSourceCampaignSchema),
}).openapi("OfferSourceCampaignsResponse");

export const CampaignSourceCampaignsResponse = z.object({
  campaignId: z.string(),
  orgId: z.string(),
  offerId: z.string().nullable(),
  featureSlug: z.string().nullable(),
  sourced: z.boolean(),
  servedOrigins: z.array(z.string()),
  sourceCampaigns: z.array(z.object({
    featureSlug: z.string(),
    campaignId: z.string(),
    campaignKey: z.string(),
    status: z.string(),
    running: z.boolean(),
  })),
}).openapi("CampaignSourceCampaignsResponse");

export const SourceCampaignsMirrorResponse = z.object({
  applied: z.boolean(),
  offers: z.number(),
  alreadyPresent: z.number(),
  counts: z.object({ ongoing: z.number(), stopped: z.number(), observed: z.number() }),
  plan: z.array(z.object({
    orgId: z.string(),
    brandId: z.string(),
    offerId: z.string(),
    featureSlug: z.string(),
    status: z.enum(["ongoing", "stopped"]),
    stopReason: z.string().nullable(),
    basis: z.enum(["default", "observed"]),
    mirrors: z.array(z.string()),
    campaignId: z.string().optional(),
  })),
}).openapi("SourceCampaignsMirrorResponse");
