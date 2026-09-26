import { OpenAPIRegistry, OpenApiGeneratorV3 } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import { writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  CampaignSchema,
  CreateCampaignBody,
  StartFundedPairBody,
  UpdateCampaignBody,
  CampaignsFilterQuery,
  StatsFilterQuery,
  StatsResponse,
  GroupedStatsResponse,
  BatchBudgetUsageBody,
  ErrorResponse,
  GateCheckResponse,
  StartRunResponse,
  EndRunBody,
  EndRunResponse,
  TransferBrandBody,
  TransferBrandResponse,
  DeleteCampaignsByOrgResponse,
  BrandPauseResponse,
  SetBrandCampaignsDailyBudgetBody,
  SetBrandCampaignsDailyBudgetResponse,
  BrandPauseHistoryResponse,
  SpendableBudgetResponse,
  BatchSpendableBudgetBody,
  BatchSpendableBudgetResponse,
  TriggerForStepBody,
  EarningHistoryQuery,
  EarningHistoryBody,
  EarningHistoryResponse,
  TriggerForStepResponse,
  PredecessorCampaignResponse,
  AnsweringCampaignResponse,
  AnsweringCampaignsBody,
  AnsweringCampaignsResponse,
} from "../src/schemas.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const registry = new OpenAPIRegistry();

// --- Security schemes ---
const apiKeyAuth = registry.registerComponent("securitySchemes", "apiKeyAuth", {
  type: "apiKey",
  in: "header",
  name: "x-api-key",
  description: "Service API key (CAMPAIGN_SERVICE_API_KEY)",
});

// === HEALTH ===

registry.registerPath({
  method: "get",
  path: "/health",
  tags: ["Health"],
  summary: "Health check",
  responses: {
    200: {
      description: "Service is healthy",
      content: { "application/json": { schema: z.object({ status: z.string(), service: z.string() }) } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/health/debug",
  tags: ["Health"],
  summary: "Debug health check with DB status",
  responses: {
    200: {
      description: "Debug info",
      content: { "application/json": { schema: z.object({ dbUrlConfigured: z.boolean(), dbStatus: z.string() }) } },
    },
  },
});

// === PUBLIC CAMPAIGNS ===

registry.registerPath({
  method: "get",
  path: "/campaigns",
  tags: ["Campaigns"],
  summary: "List campaigns for org",
  description:
    "Filterable by brandId, status, workflowSlug and featureSlug. `status` takes the stored vocabulary — `ongoing` (running) or `stopped`; any other value is a 400 rather than an unfiltered list. `limit` is optional: omit it and every match comes back, as it always has; state one and the response carries `hasMore`.",
  security: [{ [apiKeyAuth.name]: [] }],
  request: { query: CampaignsFilterQuery },
  responses: {
    200: { description: "List of campaigns", content: { "application/json": { schema: z.object({ campaigns: z.array(CampaignSchema), hasMore: z.boolean().optional() }) } } },
    400: { description: "Unrecognised filter value (e.g. a status outside ongoing/stopped)", content: { "application/json": { schema: ErrorResponse } } },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorResponse } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/campaigns/{id}",
  tags: ["Campaigns"],
  summary: "Get a specific campaign",
  security: [{ [apiKeyAuth.name]: [] }],
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    200: { description: "Campaign details", content: { "application/json": { schema: z.object({ campaign: CampaignSchema }) } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorResponse } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/campaigns",
  tags: ["Campaigns"],
  summary: "Create a new campaign",
  description: "A PAYMENT HOLD refuses every start: when billing-service cannot charge the org's card (payment-outlook state charge_blocked) the answer is 409 with reason `payment_declined`, `blockedReason` (billing's own code, e.g. card_declined, card_country_unsupported) and `error` in customer-facing English to render verbatim; when billing cannot be read it is 502 with reason `billing_unavailable`. Such an org's campaigns are stopped by the scheduler within ten minutes with stopReason `payment_declined`, and can be started again by a person once billing no longer reports the charge as blocked (paid AND a chargeable card on file).",
  security: [{ [apiKeyAuth.name]: [] }],
  request: { body: { content: { "application/json": { schema: CreateCampaignBody } } } },
  responses: {
    201: { description: "Campaign created", content: { "application/json": { schema: z.object({ campaign: CampaignSchema }) } } },
    400: { description: "Validation error", content: { "application/json": { schema: ErrorResponse } } },
    409: { description: "Refused — payment_declined: billing cannot charge this org's card (see description)", content: { "application/json": { schema: z.object({ error: z.string(), reason: z.string(), blockedReason: z.string().optional() }) } } },
    502: { description: "Refused — billing_unavailable: the org's payment state could not be read, nothing was started", content: { "application/json": { schema: ErrorResponse } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/campaigns/start-funded-pair",
  tags: ["Campaigns"],
  summary: "Start the campaign for a pair the customer already funds",
  description:
    "The CUSTOMER starting an acquisition channel they fund for one (offer, leg). Money still starts nothing on its own: this runs only when a person asks, and there is no sweep behind it. "
    + "The caller states only what their own screen knows (brand, offer, leg, acquisition channel) and CANNOT state a workflow, a name or a budget: the workflow is re-picked every run here so a slug frozen in a browser goes stale, the name is derived from the identity, and the money is billing's per (offer x leg x channel) and is already set. The body is strict, so a caller reaching for any of the three is told so. "
    + "offerId and legKey are both required; the campaign is resolved and funded at (offer, leg, channel). "
    + "The started campaign is paced, gated and held by billing's ceiling exactly as every other sales-family campaign is. A pair that ALREADY has a campaign never gets a second one: a live campaign is handed back untouched (200, started=false), and a stopped one is started (200, started=true). "
    + "A pair that cannot be started is refused with `error` in customer-facing English (render it verbatim) and `reason` as a code: leg_required, channel_not_paced_here, unknown_channel, leg_not_performed (400); not_funded, no_workflow, payment_declined (409); catalogue_unavailable, billing_unavailable, workflow_unavailable (502, try again). "
    + "A PAYMENT HOLD refuses every start: when billing-service cannot charge the org's card (payment-outlook state charge_blocked) the answer is 409 with reason `payment_declined`, `blockedReason` (billing's own code, e.g. card_declined, card_country_unsupported) and `error` in customer-facing English to render verbatim; when billing cannot be read it is 502 with reason `billing_unavailable`. Such an org's campaigns are stopped by the scheduler within ten minutes with stopReason `payment_declined`, and can be started again by a person once billing no longer reports the charge as blocked (paid AND a chargeable card on file).",
  security: [{ [apiKeyAuth.name]: [] }],
  request: { body: { content: { "application/json": { schema: StartFundedPairBody } } } },
  responses: {
    201: {
      description: "Campaign created and started",
      content: { "application/json": { schema: z.object({ campaign: CampaignSchema, started: z.boolean(), alreadyRunning: z.boolean(), ceilingCents: z.number() }) } },
    },
    200: {
      description: "This pair already had a campaign — handed back, started if it had been stopped",
      content: { "application/json": { schema: z.object({ campaign: CampaignSchema, started: z.boolean(), alreadyRunning: z.boolean(), ceilingCents: z.number().optional() }) } },
    },
    400: { description: "Refused — the reason is customer-facing English", content: { "application/json": { schema: ErrorResponse } } },
    409: { description: "Refused — nothing funds this pair, or nothing can run the channel yet", content: { "application/json": { schema: ErrorResponse } } },
    502: { description: "A sibling service could not be read — try again", content: { "application/json": { schema: ErrorResponse } } },
  },
});

registry.registerPath({
  method: "patch",
  path: "/campaigns/{id}",
  tags: ["Campaigns"],
  summary: "Update a campaign",
  description: "status=activate starts the campaign. A PAYMENT HOLD refuses every start: when billing-service cannot charge the org's card (payment-outlook state charge_blocked) the answer is 409 with reason `payment_declined`, `blockedReason` (billing's own code, e.g. card_declined, card_country_unsupported) and `error` in customer-facing English to render verbatim; when billing cannot be read it is 502 with reason `billing_unavailable`. Such an org's campaigns are stopped by the scheduler within ten minutes with stopReason `payment_declined`, and can be started again by a person once billing no longer reports the charge as blocked (paid AND a chargeable card on file).",
  security: [{ [apiKeyAuth.name]: [] }],
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: { content: { "application/json": { schema: UpdateCampaignBody } } },
  },
  responses: {
    200: { description: "Campaign updated", content: { "application/json": { schema: z.object({ campaign: CampaignSchema }) } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorResponse } } },
    409: { description: "Refused — payment_declined: billing cannot charge this org's card (see description)", content: { "application/json": { schema: z.object({ error: z.string(), reason: z.string(), blockedReason: z.string().optional() }) } } },
    502: { description: "Refused — billing_unavailable: the org's payment state could not be read, nothing was started", content: { "application/json": { schema: ErrorResponse } } },
  },
});

registry.registerPath({
  method: "delete",
  path: "/campaigns/{id}",
  tags: ["Campaigns"],
  summary: "Delete a campaign",
  security: [{ [apiKeyAuth.name]: [] }],
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    200: { description: "Campaign deleted", content: { "application/json": { schema: z.object({ message: z.string() }) } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorResponse } } },
  },
});

// === BRAND HELD STATE (derived from funding) ===

registry.registerPath({
  method: "get",
  path: "/brands/{brandId}/pause",
  tags: ["Brands"],
  summary: "Is this brand held (funds nothing)?",
  description: "Returns whether the brand's sales campaigns are HELD, derived from what the customer FUNDS in billing-service — there is no stored pause flag any more (it had no writer left in the fleet and was retired in v0.51.0). paused=true ⟺ no campaign ceiling of this (org, brand) is positive AND the brand-level daily budget is not positive either; funding any one campaign releases it with no other step. updatedAt is always null (the state is not stored here). 502 when billing cannot be read — a brand whose funding is unknown is not reported as running. Org-scoped via x-org-id.",
  security: [{ [apiKeyAuth.name]: [] }],
  request: { params: z.object({ brandId: z.string() }) },
  responses: {
    200: { description: "Brand pause state", content: { "application/json": { schema: BrandPauseResponse } } },
    400: { description: "Missing x-org-id", content: { "application/json": { schema: ErrorResponse } } },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorResponse } } },
  },
});

registry.registerPath({
  method: "patch",
  path: "/brands/{brandId}/daily-budget",
  tags: ["Brands"],
  summary: "Set the daily budget for ALL of a brand's sales campaigns at once",
  description: "Propagates a brand-page daily budget edit down to every sales-cold-email-outreach campaign of the brand (cents), so per-campaign pacing enforces it immediately. dailyBudgetCents:null clears each campaign's own budget → they fall back to the brand daily budget. Org-scoped via x-org-id; only this org's campaigns for the brand are touched.",
  security: [{ [apiKeyAuth.name]: [] }],
  request: {
    params: z.object({ brandId: z.string() }),
    body: { content: { "application/json": { schema: SetBrandCampaignsDailyBudgetBody } } },
  },
  responses: {
    200: { description: "Updated campaigns count + applied budget", content: { "application/json": { schema: SetBrandCampaignsDailyBudgetResponse } } },
    400: { description: "Validation error", content: { "application/json": { schema: ErrorResponse } } },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorResponse } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/brands/{brandId}/pause-history",
  tags: ["Brands"],
  summary: "Get a brand's pause on/off transition timeline (closed history)",
  description: "Per-(org, brand) history of the flips of the retired brand pause flag (oldest first) for the Customer Success health board. CLOSED: the flag and the PATCH route that wrote it were removed in v0.51.0, so no new transition can be recorded — the timeline is kept because it is a true record of what happened. Each transition's `paused` is the new state after that flip. No transitions → empty array. Org-scoped via x-org-id. Unrelated to GET /brands/{brandId}/pause, which now answers from funding.",
  security: [{ [apiKeyAuth.name]: [] }],
  request: { params: z.object({ brandId: z.string() }) },
  responses: {
    200: { description: "Brand pause transition timeline", content: { "application/json": { schema: BrandPauseHistoryResponse } } },
    400: { description: "Missing x-org-id", content: { "application/json": { schema: ErrorResponse } } },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorResponse } } },
  },
});

// === SPENDABLE BUDGET (configured vs running) ===

registry.registerPath({
  method: "get",
  path: "/brands/{brandId}/spendable-budget",
  tags: ["Brands"],
  summary: "Configured vs actually-running daily budget for a brand",
  description: "Answers, for one (org, brand), BOTH figures: configuredDailyBudgetCents (every ceiling the customer set in billing-service) and runningDailyBudgetCents (the part of it attached to a campaign that is ongoing right now). Both are always served — a paused campaign's settings screen must still show the amount the customer set. The answer is decomposed in the SAME response by offer (`offers`), by campaign (`campaigns`) and by individual ceiling (`rows`, each naming the campaign standing behind it and whether it is running), so a consumer never sums anything and can tell which campaigns contributed and which did not. `grain` names which billing width the figures were computed at: `campaign` (per offer, leg and channel), `brand` (one pot) or `none`. A ceiling written before the offer or leg level (offerId / legKey null) counts as running when the campaign billing's rule attributes it to is ongoing. 502 when billing cannot be read — never a smaller figure. Org-scoped via x-org-id.",
  security: [{ [apiKeyAuth.name]: [] }],
  request: { params: z.object({ brandId: z.string() }) },
  responses: {
    200: { description: "Configured and running daily budget", content: { "application/json": { schema: SpendableBudgetResponse } } },
    400: { description: "Missing x-org-id", content: { "application/json": { schema: ErrorResponse } } },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorResponse } } },
    502: { description: "Billing could not be read", content: { "application/json": { schema: ErrorResponse } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/brands/spendable-budget",
  tags: ["Brands"],
  summary: "Configured vs actually-running daily budget for MANY brands",
  description: "The same answer as GET /brands/{brandId}/spendable-budget, for up to 500 (org, brand) pairs in one request — a staff audit walks every account and cannot afford one request per brand. The pairs are stated in the body because the answer is per (org, brand): one brand row is claimed by several orgs and each claim configures its own money. A pair whose billing ceilings cannot be read is listed in `unavailable` and carries NO figures at all — never a zero, which would silently shrink a fleet total. Same computation as the per-brand route, so the two cannot disagree.",
  security: [{ [apiKeyAuth.name]: [] }],
  request: { body: { content: { "application/json": { schema: BatchSpendableBudgetBody } } } },
  responses: {
    200: { description: "Configured and running daily budget per brand", content: { "application/json": { schema: BatchSpendableBudgetResponse } } },
    400: { description: "Validation error", content: { "application/json": { schema: ErrorResponse } } },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorResponse } } },
  },
});

// === STATS ===

registry.registerPath({
  method: "get",
  path: "/stats",
  tags: ["Stats"],
  summary: "Campaign stats from own DB (query params)",
  description: "Returns campaign counts, status breakdown, and configured budget totals. Supports filtering by workflowSlug, featureSlug, and groupBy for aggregation by slug. When groupBy is set, returns groupedStats keyed by the group value. Requires API key.",
  security: [{ [apiKeyAuth.name]: [] }],
  request: { query: StatsFilterQuery },
  responses: {
    200: {
      description: "Campaign stats (flat or grouped)",
      content: {
        "application/json": {
          schema: z.union([StatsResponse, GroupedStatsResponse]),
        },
      },
    },
    400: { description: "Validation error", content: { "application/json": { schema: ErrorResponse } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/stats/batch-budget",
  tags: ["Stats"],
  summary: "Get cost data for multiple campaigns",
  description: "Returns budget usage (totalCostInUsdCents) per campaign via runs-service.",
  security: [{ [apiKeyAuth.name]: [] }],
  request: { body: { content: { "application/json": { schema: BatchBudgetUsageBody } } } },
  responses: {
    200: {
      description: "Stats per campaign",
      content: {
        "application/json": {
          schema: z.object({
            results: z.record(z.string(), z.object({
              status: z.string().optional(),
              maxLeads: z.number().nullable().optional(),
              maxBudgetTotalUsd: z.string().nullable().optional(),
              totalCostInUsdCents: z.string().nullable().optional(),
              error: z.string().optional(),
            })),
          }),
        },
      },
    },
    400: { description: "Validation error", content: { "application/json": { schema: ErrorResponse } } },
  },
});

// === SCHEDULER (API-key authed, cross-org) ===

registry.registerPath({
  method: "get",
  path: "/campaigns/list",
  tags: ["Scheduler"],
  summary: "List all campaigns across all orgs",
  security: [{ [apiKeyAuth.name]: [] }],
  responses: {
    200: { description: "All campaigns with org info", content: { "application/json": { schema: z.object({ campaigns: z.array(CampaignSchema) }) } } },
  },
});

// === PIPELINE (called by DAG via workflow-service) ===

const PipelineHeaders = z.object({
  "x-org-id": z.string().openapi({ description: "Organization UUID (required)" }),
  "x-campaign-id": z.string().uuid().openapi({ description: "Campaign UUID (required)" }),
  "x-user-id": z.string().openapi({ description: "User UUID (required)" }),
  "x-run-id": z.string().openapi({ description: "Parent run UUID (required)" }),
  "x-brand-id": z.string().optional().openapi({ description: "Comma-separated brand UUIDs (e.g. 'uuid1,uuid2,uuid3'). Optional — resolved from campaign DB if absent.", example: "550e8400-e29b-41d4-a716-446655440000,6ba7b810-9dad-11d1-80b4-00c04fd430c8" }),
  "x-workflow-slug": z.string().openapi({ description: "Workflow slug (required, injected by workflow-service)" }),
  "x-feature-slug": z.string().openapi({ description: "Feature slug (required)" }),
  "x-active-goal-id": z.string().optional().openapi({ description: "Active goal identity for attributed campaigns. Optional; absent means unattributed." }),
  "x-brand-profile-id": z.string().optional().openapi({ description: "Brand profile identity for attributed campaigns. Optional; absent means unattributed." }),
  "x-customer-profile-id": z.string().optional().openapi({ description: "Customer profile identity for attributed campaigns. Optional; absent means unattributed." }),
}).openapi("PipelineHeaders");

registry.registerPath({
  method: "post",
  path: "/gate-check",
  tags: ["Pipeline"],
  summary: "Check if a campaign can run a new iteration",
  description: "Validates brand-level daily budget pacing, legacy non-daily budget limits via runs-service stats/budget, volume limits (maxLeads), campaign status, and consecutive failures. Auto-stops the campaign if total budget or maxLeads is exceeded. Called as the first DAG node.",
  security: [{ [apiKeyAuth.name]: [] }],
  request: {
    headers: PipelineHeaders,
  },
  responses: {
    200: { description: "Gate check result", content: { "application/json": { schema: GateCheckResponse } } },
    400: { description: "Missing required headers", content: { "application/json": { schema: ErrorResponse } } },
    404: { description: "Campaign not found", content: { "application/json": { schema: ErrorResponse } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/start-run",
  tags: ["Pipeline"],
  summary: "Create a run and return campaign data for downstream nodes",
  description: "Creates a new run in runs-service and returns all campaign data needed by downstream DAG nodes (brand-profile, fetch-lead, email-generate, etc.).",
  security: [{ [apiKeyAuth.name]: [] }],
  request: {
    headers: PipelineHeaders,
  },
  responses: {
    200: { description: "Run created, campaign data returned", content: { "application/json": { schema: StartRunResponse } } },
    400: { description: "Missing required headers or brandIds", content: { "application/json": { schema: ErrorResponse } } },
    404: { description: "Campaign not found", content: { "application/json": { schema: ErrorResponse } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/end-run",
  tags: ["Pipeline"],
  summary: "Finalize run and optionally stop or re-trigger campaign",
  description: "Marks running runs as completed or failed. If stopCampaign=true, auto-stops the campaign. Otherwise re-triggers the workflow if the campaign is still ongoing. Body requires { success: boolean, stopCampaign: boolean }.",
  security: [{ [apiKeyAuth.name]: [] }],
  request: {
    headers: PipelineHeaders,
    body: { content: { "application/json": { schema: EndRunBody } } },
  },
  responses: {
    200: { description: "Run finalized", content: { "application/json": { schema: EndRunResponse } } },
  },
});

// === INTERNAL: BRAND TRANSFER ===

registry.registerPath({
  method: "post",
  path: "/internal/transfer-brand",
  tags: ["Internal"],
  summary: "Transfer solo-brand campaigns from one org to another",
  description: "Updates org_id on all campaigns where brand_ids contains exactly one element matching brandId and org_id matches sourceOrgId. Skips co-branding rows. Idempotent.",
  security: [{ [apiKeyAuth.name]: [] }],
  request: {
    body: { content: { "application/json": { schema: TransferBrandBody } } },
  },
  responses: {
    200: { description: "Transfer result", content: { "application/json": { schema: TransferBrandResponse } } },
    400: { description: "Validation error", content: { "application/json": { schema: ErrorResponse } } },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorResponse } } },
  },
});

registry.registerPath({
  method: "delete",
  path: "/internal/campaigns/by-org/{orgId}",
  tags: ["Internal"],
  summary: "Disable campaign-owned state for an org teardown",
  description: "Idempotently stops org campaigns, clears queued scheduler candidates, and removes campaign-service-owned org state that can affect future campaign scheduling/execution. Called by client-service during org teardown. No cross-service fan-out.",
  security: [{ [apiKeyAuth.name]: [] }],
  request: {
    params: z.object({
      orgId: z.string().openapi({ description: "Internal org UUID from client-service" }),
    }),
  },
  responses: {
    200: { description: "Org campaign state disabled", content: { "application/json": { schema: DeleteCampaignsByOrgResponse } } },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorResponse } } },
    500: { description: "Teardown failed", content: { "application/json": { schema: ErrorResponse } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/internal/campaigns/trigger-for-step",
  tags: ["Internal"],
  summary: "Run the campaign bought for the leg out of the step a lead just reached",
  description:
    "A lead reached a step on a (brand, offer); this runs the campaign bought for the leg OUT of that step immediately, instead of waiting for its next tick. The leg is features-service's statement (GET /public/channels -> legs[]) and the campaign is the one already stating that leg — nothing is inferred. The affordability/budget gate is untouched: the dispatch is the scheduler's own, so the run starts at gate-check like any other. A scope that cannot be resolved (unknown step, unreadable catalogue) fails loudly; a scope with no such campaign, or one that is stopped, held for money, already running or operated by the customer's own team, is an ordinary 200 with a NAMED skip. The org rides on x-org-id.",
  security: [{ [apiKeyAuth.name]: [] }],
  request: {
    headers: z.object({
      "x-org-id": z.string().openapi({ description: "Internal org UUID from client-service" }),
    }),
    body: { content: { "application/json": { schema: TriggerForStepBody } } },
  },
  responses: {
    200: { description: "What ran and what did not", content: { "application/json": { schema: TriggerForStepResponse } } },
    400: { description: "No org, malformed body or unknown step", content: { "application/json": { schema: ErrorResponse } } },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorResponse } } },
    502: { description: "The acquisition-channel catalogue could not be read", content: { "application/json": { schema: ErrorResponse } } },
    500: { description: "Internal error", content: { "application/json": { schema: ErrorResponse } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/internal/campaigns/{campaignId}/predecessor",
  tags: ["Internal"],
  summary: "Which campaign ran the leg that ends where this one begins",
  description:
    "A journey is several LEGS and this service mints one campaign per leg, so a campaign bought for a leg that CONTINUES another cannot find what it is continuing — while the lead, the thread and the record of what is owed them are filed under the campaign that ran the previous leg. This resolves that sibling: same org, brand and offer, on the leg whose toStep is this campaign's fromStep (features-service's own statement, GET /public/channels -> legs[]; the identifier is carried verbatim and never parsed). The LIVE campaign of the preceding leg wins; when none is live, the most recently created stopped one does. Nothing is written and nothing about funding, gating, scheduling or triggering changes. A campaign at the FIRST leg of a journey answers `predecessor: null` with `absence: entry_leg` — never a sibling that merely looks close; same for a campaign stating no leg, offer or brand. `There is none` is kept apart from `it could not be worked out`: an unreadable catalogue is a 502 and a leg the catalogue no longer publishes, or two live siblings, are a 409.",
  security: [{ [apiKeyAuth.name]: [] }],
  request: {
    params: z.object({ campaignId: z.string() }),
  },
  responses: {
    200: { description: "The predecessor, or a named absence", content: { "application/json": { schema: PredecessorCampaignResponse } } },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorResponse } } },
    404: { description: "No such campaign", content: { "application/json": { schema: ErrorResponse } } },
    409: { description: "A leg features-service does not publish, or two live siblings on the preceding leg", content: { "application/json": { schema: ErrorResponse } } },
    502: { description: "The acquisition-channel catalogue could not be read", content: { "application/json": { schema: ErrorResponse } } },
    500: { description: "Internal error", content: { "application/json": { schema: ErrorResponse } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/internal/campaigns/{campaignId}/answerer",
  tags: ["Internal"],
  summary: "Which campaign answers the people this campaign holds",
  description:
    "The inverse of /predecessor. A campaign whose leg ends at a step (a prospect asked for a meeting) holds the people owed the next action in lead-service's follow-up queue; they are answered only by a LIVE campaign on a leg that starts at that step (features-service's own statement, GET /public/channels -> legs[]) whose predecessor resolves to THIS campaign — the claim path's own rule, applied through the same resolver, so this cannot disagree with who actually claims. When nobody does, `answeredBy` is null and `absence` names why: `no_answering_campaign` (nobody bought one on this offer — `startableFeatureSlugs` lists the sales-family channels that could), `answering_campaign_stopped`, `answering_campaign_serves_another` (a live one answers a different campaign's people — `candidate` + `candidateAnswersCampaignId` name them), `no_leg_continues`, or `campaign_states_no_leg`/`_no_offer`/`_no_brand`. Nothing is written, started or funded: money starts nothing, and starting the answering leg stays the customer's decision. An unreadable catalogue is a 502 and a leg the catalogue does not publish is a 409 — never a null.",
  security: [{ [apiKeyAuth.name]: [] }],
  request: {
    params: z.object({ campaignId: z.string() }),
  },
  responses: {
    200: { description: "The answering campaign, or a named absence", content: { "application/json": { schema: AnsweringCampaignResponse } } },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorResponse } } },
    404: { description: "No such campaign", content: { "application/json": { schema: ErrorResponse } } },
    409: { description: "A leg features-service does not publish, or a candidate whose own predecessor is ambiguous", content: { "application/json": { schema: ErrorResponse } } },
    502: { description: "The acquisition-channel catalogue could not be read", content: { "application/json": { schema: ErrorResponse } } },
    500: { description: "Internal error", content: { "application/json": { schema: ErrorResponse } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/internal/campaigns/answerers",
  tags: ["Internal"],
  summary: "Which campaign answers the people each of these campaigns holds",
  description:
    "The batch form of /answerer: one catalogue read for every campaign asked, one entry per id in the order asked. An id that could not be resolved (no such campaign, a leg the catalogue does not publish) comes back `ok: false` with its status and reason — never dropped, since a missing entry would read as answered. An unreadable catalogue fails the whole batch with a 502.",
  security: [{ [apiKeyAuth.name]: [] }],
  request: {
    body: { content: { "application/json": { schema: AnsweringCampaignsBody } } },
  },
  responses: {
    200: { description: "One entry per requested campaign", content: { "application/json": { schema: AnsweringCampaignsResponse } } },
    400: { description: "Empty or oversized id list", content: { "application/json": { schema: ErrorResponse } } },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorResponse } } },
    502: { description: "The acquisition-channel catalogue could not be read", content: { "application/json": { schema: ErrorResponse } } },
    500: { description: "Internal error", content: { "application/json": { schema: ErrorResponse } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/internal/campaigns/{campaignId}/earning-history",
  tags: ["Internal"],
  summary: "Was this campaign earning on each day of a past UTC range",
  description:
    "Answers, per UTC day, whether the customer was running this campaign and whether it had anybody to contact — from RECORDED HISTORY, not from current state. A day is evaluated at its END (or at now, for a day still in progress): the state a campaign finished the day in is the one a daily run-rate counts. `not_recorded` is a first-class answer and is never collapsed to `stopped` — nothing is backfilled, so a day before this campaign's record begins says so, and `statusRecordedSince`/`audienceRecordedSince` say when each axis started being answerable. `earning` is true only when the campaign was running AND could reach somebody; it is null, never false, when either axis is unknown. No money figure is exposed or computed here: budget amounts are billing-service's.",
  security: [{ [apiKeyAuth.name]: [] }],
  request: {
    params: z.object({ campaignId: z.string() }),
    query: EarningHistoryQuery,
  },
  responses: {
    200: { description: "One row per day", content: { "application/json": { schema: EarningHistoryResponse } } },
    400: { description: "Malformed or oversized range", content: { "application/json": { schema: ErrorResponse } } },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorResponse } } },
    500: { description: "Internal error", content: { "application/json": { schema: ErrorResponse } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/internal/campaigns/earning-history",
  tags: ["Internal"],
  summary: "Was each of these campaigns earning, day by day",
  description:
    "The batch form of the read above — the shape a consumer reconstructing a past month actually needs, since a per-campaign fan-out over a fleet is hundreds of round trips for a question that is two bounded reads. A campaign id nothing is recorded for is still RETURNED, with every day `not_recorded`: an absent row would be indistinguishable from a campaign that was not earning, which is the exact conflation this endpoint exists to end. Entries come back in the order asked.",
  security: [{ [apiKeyAuth.name]: [] }],
  request: {
    body: { content: { "application/json": { schema: EarningHistoryBody } } },
  },
  responses: {
    200: { description: "One entry per requested campaign", content: { "application/json": { schema: EarningHistoryResponse } } },
    400: { description: "Malformed or oversized range or id list", content: { "application/json": { schema: ErrorResponse } } },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorResponse } } },
    500: { description: "Internal error", content: { "application/json": { schema: ErrorResponse } } },
  },
});

// --- Generate ---

const generator = new OpenApiGeneratorV3(registry.definitions);
const spec = generator.generateDocument({
  openapi: "3.0.0",
  info: {
    title: "Campaign Service",
    description: "API for managing marketing campaigns",
    version: "1.0.0",
  },
  servers: [{ url: process.env.SERVICE_URL || "http://localhost:3003" }],
});

const outputPath = join(__dirname, "..", "openapi.json");
writeFileSync(outputPath, JSON.stringify(spec, null, 2));
console.log(`OpenAPI spec written to ${outputPath}`);
