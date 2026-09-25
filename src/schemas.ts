import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";

extendZodWithOpenApi(z);

// --- Shared ---

export const ErrorResponse = z.object({
  error: z.string(),
}).openapi("ErrorResponse");

// The runtime optimization goal — an OPAQUE string, deliberately not an enum. This service does
// NOT own the vocabulary and no longer WRITES it: a campaign says what it sells with its SALES
// FUNNEL (`funnelKey`), which is the only word that separates a meeting bought with a positive
// reply from one bought with a click onto the site. The goal collapsed both onto `meetingBooked`.
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
  // campaign states what it sells with `funnelKey`.
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
  // website_purchases | form_magnet). A consumer reads what a campaign buys HERE and nowhere else.
  // STATED at creation for every sales campaign; null only for a feature that sells through no
  // sales funnel (PR, hiring, VC, AI-visibility) and for sales rows created before it was
  // required. A stated funnel paces the campaign on THAT funnel's own daily ceiling in billing —
  // unless billing holds no per-funnel ceilings for the brand at all, in which case the brand has
  // one pot and the campaign paces on the brand daily budget exactly as it always has.
  funnelKey: z.string().nullable(),
  // The OFFER this campaign sells — a brand-service offer UUID. An offer is one distinct thing a
  // brand sells, so a campaign is (offer x sales funnel x acquisition channel) and this is the
  // word that separates two campaigns a brand runs on one funnel through one channel for two
  // different offers. Never derived from the funnel, the goal or the workflow — several offers
  // sell through one funnel, which is why the dimension exists. Null = the campaign states no
  // offer, which is every campaign created before it could be stated and every caller that has
  // not migrated yet; nothing reads it for pacing, funding, selection or identity.
  offerId: z.string().nullable(),
  // The single funnel LEG this campaign is bought for — features-service's canonical leg
  // identifier, published on its `GET /public/channels` catalogue as `legs[].legKey`. A leg is the
  // step-to-step move a customer actually buys, and it identifies itself: two campaigns on one
  // channel buying two different legs are told apart by this value alone, with no funnel involved.
  // OPAQUE — never split into the steps it connects (the catalogue serves those beside it), and
  // never derived from the funnel, the channel or the workflow. Null = the campaign states no leg,
  // which is every campaign created before it could state one and every caller that has not
  // migrated yet; nothing reads it for pacing, funding, provisioning, scheduling or identity.
  legKey: z.string().nullable(),
  maxLeads: z.number().int().nullable(),
  startDate: z.string().nullable(),
  endDate: z.string().nullable(),
  status: z.string(),
  // WHY the campaign stopped: audience_exhausted | max_leads_reached | manual | org_teardown.
  // Null on an ongoing campaign, and on every campaign stopped before the reason was recorded.
  // A campaign that stopped because it ran out of people to contact (audience_exhausted) comes
  // back by itself once the brand has somebody to contact again; no other reason does.
  stopReason: z.string().nullable(),
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
  // The SALES FUNNEL this campaign sells, stated at birth. For every sales-outreach feature the
  // route requires EITHER this OR both `offerId` and `legKey`: a campaign stating the offer and the
  // leg and no funnel is identified by (offer, leg, channel) alone — the model the funnel is being
  // retired in favour of — and one already doing that work under any funnel is handed back rather
  // than twinned. Ignored for every other feature, which sells through no sales funnel. Accepts the canonical four (sales_meetings_from_conversation |
  // sales_meetings_from_website | website_purchases | form_magnet) and the pre-rename spellings
  // (reply_meeting | visit_meeting | visit_signup | visit_form), stored canonical. Nothing is ever
  // inferred: a creator provisions per funded funnel, so it already knows the answer.
  funnelKey: z.string().min(1).optional(),
  // The OFFER this campaign sells — a brand-service offer UUID.
  //
  // OPTIONAL, on purpose and for now: making it required is a breaking request-contract change,
  // so callers state it as they migrate and a create without one behaves exactly as it did
  // before the field existed. It becomes required in a later wave, once they have.
  //
  // Nothing is ever inferred when it is absent — not from the funnel (several offers sell through
  // one funnel), not from the goal, not from the workflow. Absent means the campaign states no
  // offer, and that is stored as NULL.
  offerId: z.string().uuid("offerId must be a valid UUID").nullable().optional(),
  // The single funnel LEG this campaign is bought for — features-service's canonical leg
  // identifier, taken verbatim from its published catalogue (`GET /public/channels` →
  // `legs[].legKey`). A leg that STARTS a funnel is spelled exactly like every other one, so a
  // caller never branches on it.
  //
  // OPTIONAL, on purpose and for now: making it required is a breaking request-contract change,
  // so callers state it as they migrate and a create without one behaves exactly as it did before
  // the field existed. The sales funnel stays required for the sales family and the identity is
  // unchanged; a later ship makes this the identity and drops the funnel.
  //
  // Not validated against a local list, because there is no local list: this service does not own
  // the leg vocabulary and must not mint a second one. The value is carried verbatim, exactly as
  // the goal and the offer id are.
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
  // IS once the funnel stops being part of it. Each is an exact match; any funnel is returned.
  offerId: z.string().optional(),
  legKey: z.string().optional(),
  // Optional cap on how many rows come back. Absent = every match, which is what every
  // existing consumer gets today. When present the response also carries `hasMore`, so a
  // truncated list is never mistaken for a complete one.
  limit: z.coerce.number().int().min(1).max(1000).optional(),
}).openapi("CampaignsFilterQuery");

/**
 * What the CUSTOMER states to start the campaign for a pair they have already funded.
 *
 * Exactly the four things their own screen knows, and nothing else. `.strict()` is load-bearing:
 * a caller reaching for a workflow, a name or a budget is TOLD no rather than having it silently
 * stripped, because each of those would be this service handing back a decision that is not the
 * browser's to make (the workflow), a fact already derivable (the name), or a second
 * representation of billing's money (the ceiling).
 */
export const StartFundedPairBody = z.object({
  brandId: z.string().uuid("brandId must be a valid UUID"),
  // The OFFER whose money funds this pair — brand-service's UUID, carried and never derived.
  // Absent is the pre-offer population, which resolves on the pair figure exactly as it always has.
  offerId: z.string().uuid("offerId must be a valid UUID").nullable().optional(),
  // OPTIONAL since wave C1 (the sales funnel is retiring). A caller naming one (any accepted
  // spelling) is resolved exactly as before. A caller naming none must state `offerId` AND
  // `legKey` — the campaign's identity — or is refused with `leg_required`.
  funnelKey: z.string().min(1).optional(),
  // The ACQUISITION CHANNEL, as a features-service feature slug. A channel IS a feature slug.
  featureSlug: z.string().min(1, "featureSlug is required"),
  // With a funnel: OPTIONAL and only a disambiguation between two funded legs of one (funnel,
  // channel, offer). Without one: REQUIRED, with `offerId` — it is what the campaign is bought for.
  // A leg the channel does not perform is refused rather than stamped.
  legKey: z.string().min(1).nullable().optional(),
}).strict().openapi("StartFundedPairBody");

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
  // State (or clear) the single funnel LEG this campaign is bought for — features-service's
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
  funnelKey: z.string().nullable(),
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
  configuredDailyBudgetCents: z.number().int(),
  runningDailyBudgetCents: z.number().int(),
  campaignIds: z.array(z.string()),
}).openapi("SpendableBudgetOffer");

export const SpendableBudgetCampaign = z.object({
  campaignId: z.string(),
  status: z.string(),
  running: z.boolean(),
  funnelKey: z.string().nullable(),
  featureSlug: z.string().nullable(),
  offerId: z.string().nullable(),
  legKey: z.string().nullable(),
  configuredDailyBudgetCents: z.number().int(),
  runningDailyBudgetCents: z.number().int(),
}).openapi("SpendableBudgetCampaign");

export const SpendableBudgetResponse = z.object({
  orgId: z.string(),
  brandId: z.string(),
  grain: z.enum(["leg", "offer", "channel", "funnel", "brand", "none"]),
  configuredDailyBudgetCents: z.number().int(),
  runningDailyBudgetCents: z.number().int(),
  offers: z.array(SpendableBudgetOffer),
  campaigns: z.array(SpendableBudgetCampaign),
  rows: z.array(SpendableBudgetRow),
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
 * The scope is the (brand, offer, funnel) the lead is on plus the step they reached. Nothing is
 * inferred from anything else: the leg is features-service's statement about that step and that
 * funnel, and the campaign is the one already stating that leg. The org rides on `x-org-id`, like
 * every other per-(org, brand) read in this service.
 */
export const TriggerForStepBody = z.object({
  brandId: z.string().uuid("brandId must be a valid UUID"),
  // The OFFER the lead is on — brand-service's id. Matched exactly against the campaign's own; a
  // campaign that states no offer is not the campaign of the offer named here.
  offerId: z.string().uuid("offerId must be a valid UUID"),
  // OPTIONAL since wave C1 (the sales funnel is retiring). When sent — the canonical four or a
  // pre-rename spelling — it narrows the legs out of the step to that funnel's, exactly as before.
  // When omitted, every leg out of the step is in scope and the campaign bought for it is matched
  // on (offer, leg).
  funnelKey: z.string().min(1).optional(),
  // The step the lead just REACHED — features-service's step key, carried verbatim and never
  // parsed. A step it does not publish is a 400, never an empty answer.
  step: z.string().min(1, "step is required"),
}).openapi("TriggerForStepBody");

export const TriggerForStepResponse = z.object({
  /** The canonical funnel the request named; null when it named none. */
  funnelKey: z.string().nullable(),
  step: z.string(),
  /** The legs OUT of that step (on the named funnel, when one was named), as features-service names them. */
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
}).openapi("TriggerForStepResponse");

/**
 * WHICH CAMPAIGN RAN THE LEG THAT ENDS WHERE THIS ONE BEGINS.
 *
 * A funnel is several legs and this service mints one campaign per leg, so a campaign bought for a
 * leg that CONTINUES another cannot, on its own, find what it is continuing — while the person, the
 * thread and the record of what is owed them are all filed under the campaign that ran the leg
 * before. This is that lookup, over state this service already holds.
 *
 * `absence` is non-null exactly when `predecessor` is null, and it NAMES why: a campaign at the
 * first leg of its funnel has no predecessor and says so, rather than being handed the closest
 * sibling. "There is none" and "it could not be worked out" stay different answers — the second is
 * a 409 or a 502, never a null.
 */
export const PredecessorCampaignResponse = z.object({
  campaignId: z.string(),
  legKey: z.string().nullable(),
  funnelKey: z.string().nullable(),
  offerId: z.string().nullable(),
  brandId: z.string().nullable(),
  /** The step this campaign's leg takes a lead OUT of — where its predecessor must end. */
  fromStepKey: z.string().nullable(),
  /** Every published leg ending at that step on this funnel, as features-service names them. */
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
   * `entry_leg` | `campaign_states_no_leg` | `campaign_states_no_funnel` |
   * `campaign_states_no_offer` | `campaign_states_no_brand` | `no_campaign_for_preceding_leg`
   */
  absence: z.string().nullable(),
}).openapi("PredecessorCampaignResponse");

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
