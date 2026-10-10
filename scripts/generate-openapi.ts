import { OpenAPIRegistry, OpenApiGeneratorV3 } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import { writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  CampaignSchema,
  CreateCampaignBody,
  StartFundedPairBody,
  SourceCampaignsQuery,
  SourceCampaignsMirrorBody,
  OfferSourceCampaignsResponse,
  CampaignSourceCampaignsResponse,
  SourceCampaignsMirrorResponse,
  StoppedCampaignSchema,
  ReactiveDefaultsBody,
  ReactiveDefaultsResponse,
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
  RecurringStatusQuery,
  FailingCampaignsResponse,
  RecurringStatusResponse,
  TriggerForStepResponse,
  RecordTriggerEventBody,
  RecordTriggerEventResponse,
  OfferTriggerEventsSummaryQuery,
  OfferTriggerEventsSummaryResponse,
  OfferTriggerEventsListQuery,
  OfferTriggerEventsListResponse,
  PredecessorCampaignResponse,
  AnsweringCampaignResponse,
  AnsweringCampaignsBody,
  AnsweringCampaignsResponse,
  CreateSalesFunnelCampaignBody,
  UpdateSalesFunnelCampaignBody,
  SalesFunnelCampaignsQuery,
  SalesFunnelCampaignSchema,
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
  description: "ONE PROACTIVE CAMPAIGN ON PER OFFER (owner 2026-10-05): when the campaign this request turns ON works an ENTRY leg (features-service catalogue leg with no fromStep), every OTHER ongoing campaign of the same offer that works an entry leg is stopped in the SAME transaction, as this person's act (stopReason `manual`, transition source `proactive_switch`, billing signalled). `stoppedCampaigns` lists them ([] when none). Reactive campaigns are never stopped. The catalogue is read only when another campaign of the offer is live; unreadable then = 502 reason `catalogue_unavailable`, nothing written. Nothing else ever switches the proactive campaign. After a proactive start, the offer's reactive campaigns are switched on by default in the background (see POST /offers/{offerId}/reactive-defaults). A PAYMENT HOLD refuses every start: when billing-service cannot charge the org's card (payment-outlook state charge_blocked) the answer is 409 with reason `payment_declined` (a card was tried and refused), or reason `no_payment_method` when billing's blockedReason is `no_chargeable_card` (no card on file at all), plus `blockedReason` (billing's own code, e.g. card_declined, card_country_unsupported, no_chargeable_card) and `error` in customer-facing English to render verbatim; when billing cannot be read it is 502 with reason `billing_unavailable`. Such an org's campaigns are stopped by the scheduler within ten minutes with stopReason `payment_declined` or `no_payment_method` (same split), and can be started again by a person once billing no longer reports the charge as blocked (paid AND a chargeable card on file).",
  security: [{ [apiKeyAuth.name]: [] }],
  request: { body: { content: { "application/json": { schema: CreateCampaignBody } } } },
  responses: {
    201: { description: "Campaign created", content: { "application/json": { schema: z.object({ campaign: CampaignSchema, stoppedCampaigns: z.array(StoppedCampaignSchema) }) } } },
    200: { description: "This identity already had a campaign: handed back started", content: { "application/json": { schema: z.object({ campaign: CampaignSchema, stoppedCampaigns: z.array(StoppedCampaignSchema) }) } } },
    400: { description: "Validation error", content: { "application/json": { schema: ErrorResponse } } },
    409: { description: "Refused — payment_declined | no_payment_method: billing cannot charge this org (see description)", content: { "application/json": { schema: z.object({ error: z.string(), reason: z.string(), blockedReason: z.string().optional() }) } } },
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
    + "ONE PROACTIVE CAMPAIGN ON PER OFFER (owner 2026-10-05): when the campaign this request turns ON works an ENTRY leg (features-service catalogue leg with no fromStep), every OTHER ongoing campaign of the same offer that works an entry leg is stopped in the SAME transaction, as this person's act (stopReason `manual`, transition source `proactive_switch`, billing signalled). `stoppedCampaigns` lists them ([] when none). Reactive campaigns are never stopped. The catalogue is read only when another campaign of the offer is live; unreadable then = 502 reason `catalogue_unavailable`, nothing written. Nothing else ever switches the proactive campaign. After a proactive start, the offer's reactive campaigns are switched on by default in the background (see POST /offers/{offerId}/reactive-defaults). "
    + "A pair that cannot be started is refused with `error` in customer-facing English (render it verbatim) and `reason` as a code: leg_required, channel_not_paced_here, unknown_channel, leg_not_performed (400); not_funded, no_workflow, payment_declined, no_payment_method (409); catalogue_unavailable, billing_unavailable, workflow_unavailable (502, try again). "
    + "SOURCE CAMPAIGNS: featureSlug may be a sourcing ORIGIN slug with legKey `start_to_lead_found` (see GET /internal/offers/{offerId}/source-campaigns): no funding read, no workflow, ceilingCents null, stops no other campaign; a retired origin is 400 unknown_channel, another leg 400 leg_not_performed. "
    + "A PAYMENT HOLD refuses every start: when billing-service cannot charge the org's card (payment-outlook state charge_blocked) the answer is 409 with reason `payment_declined` (a card was tried and refused), or reason `no_payment_method` when billing's blockedReason is `no_chargeable_card` (no card on file at all), plus `blockedReason` (billing's own code, e.g. card_declined, card_country_unsupported, no_chargeable_card) and `error` in customer-facing English to render verbatim; when billing cannot be read it is 502 with reason `billing_unavailable`. Such an org's campaigns are stopped by the scheduler within ten minutes with stopReason `payment_declined` or `no_payment_method` (same split), and can be started again by a person once billing no longer reports the charge as blocked (paid AND a chargeable card on file).",
  security: [{ [apiKeyAuth.name]: [] }],
  request: { body: { content: { "application/json": { schema: StartFundedPairBody } } } },
  responses: {
    201: {
      description: "Campaign created and started",
      content: { "application/json": { schema: z.object({ campaign: CampaignSchema, started: z.boolean(), alreadyRunning: z.boolean(), ceilingCents: z.number().nullable(), stoppedCampaigns: z.array(StoppedCampaignSchema) }) } },
    },
    200: {
      description: "This pair already had a campaign — handed back, started if it had been stopped",
      content: { "application/json": { schema: z.object({ campaign: CampaignSchema, started: z.boolean(), alreadyRunning: z.boolean(), ceilingCents: z.number().nullable().optional(), stoppedCampaigns: z.array(StoppedCampaignSchema) }) } },
    },
    400: { description: "Refused — the reason is customer-facing English", content: { "application/json": { schema: ErrorResponse } } },
    409: { description: "Refused — nothing funds this pair, or nothing can run the channel yet", content: { "application/json": { schema: ErrorResponse } } },
    502: { description: "A sibling service could not be read — try again", content: { "application/json": { schema: ErrorResponse } } },
  },
});

const SALES_FUNNEL_CAMPAIGNS_DOC =
  "SALES FUNNEL CAMPAIGNS (owner 2026-10-10, chat first). A campaign is brand x offer x SALES FUNNEL (features-service's sales funnel id, `GET /internal/catalogue/sales-funnels` rows[].id, its combinationKey, carried verbatim). It owns one UNIT per pipe of the funnel (`<channel slug>|<leg key>`): an ordinary campaign row stating `salesFunnelId` + `salesFunnelCampaignId`, run independently like every campaign (proactive pipes prospect, reactive pipes answer). Uniqueness is brand x offer x sales funnel x channel x leg: a pipe two funnels share is two units, one per funnel. A sourcing pipe (Start -> Lead found, a lead-source origin) is a SOURCE campaign unit: no workflow, its origin is ON for the offer while the funnel runs. A funnel with no sourcing pipe gets the offer's default lead source on its start, as every outreach start does. "
  + "RUN / PAUSE ONLY AT THE FUNNEL: the funnel campaign and every unit move together in one transaction (transition source `sales_funnel`); PATCH /campaigns/{id} {status} on a unit moves its WHOLE funnel campaign (a lead source unit keeps its own On/Off); its identity fields and DELETE are refused with 409 reason `sales_funnel_unit` (+ `salesFunnelCampaignId`). Stopping stops new first touches; follow-ups of people already contacted still go out. A payment hold or org teardown that stops the units stops the funnel campaign too, with the same stopReason. "
  + "SHARED REACTIVE PIPE: an event (step reached, trigger event, delay/poll detector) runs at most ONE campaign per pipe, the oldest live one that can run; the others are skipped `pipe_handled_by_another_campaign`. A unit's predecessor (whose people it answers) is resolved inside its own funnel campaign first. "
  + "MONEY: a unit's money is its funnel's caps at billing (GET /internal/brands/{brandId}/offers/{offerId}/sales-funnels/{salesFunnelId}/caps: max budget + max volume, one-off / daily / weekly / monthly), never a per-(offer, leg, channel) ceiling or the brand pot. No max budget stated = every unit held unfunded (`campaign-hold` reason `unfunded`, gate-check `Sales funnel not funded`). Either cap `reached` = EVERY pipe of the funnel, reactive included, stops (owner 2026-10-10: always respect the user budget; gate-check `Sales funnel max budget reached` / `Sales funnel max volume reached`, step trigger skip `sales_funnel_cap`). A consumption billing cannot measure holds every pipe (fail-closed, logged). Caps never change a status. Billing is not signalled per unit (no plan money moves). "
  + "Pre-funnel (leg x channel) campaigns are untouched and keep every route and shape they had.";

registry.registerPath({
  method: "post",
  path: "/sales-funnel-campaigns",
  tags: ["Sales funnel campaigns"],
  summary: "Launch a sales funnel as one campaign (brand x offer x sales funnel)",
  description: SALES_FUNNEL_CAMPAIGNS_DOC + " Headers: x-org-id, x-user-id, x-run-id (required). `status` is REQUIRED: `stopped` creates the funnel campaign and every unit switched off; `ongoing` launches it (payment hold refusal first, like every start). A funnel campaign that exists is never created again: 200 hands it back (`created: false`), started when `ongoing` was asked and it was stopped (`started: true`), untouched otherwise. Refusals (`error` customer-facing English, `reason` code): 400 unknown_sales_funnel | no_pipe | pipe_not_runnable; 409 no_workflow | payment_declined | no_payment_method; 502 catalogue_unavailable | workflow_unavailable | billing_unavailable.",
  security: [{ [apiKeyAuth.name]: [] }],
  request: { body: { content: { "application/json": { schema: CreateSalesFunnelCampaignBody } } } },
  responses: {
    201: { description: "Created (and started when status=ongoing)", content: { "application/json": { schema: z.object({ salesFunnelCampaign: SalesFunnelCampaignSchema, created: z.boolean(), started: z.boolean() }) } } },
    200: { description: "This identity already had a funnel campaign: handed back", content: { "application/json": { schema: z.object({ salesFunnelCampaign: SalesFunnelCampaignSchema, created: z.boolean(), started: z.boolean() }) } } },
    400: { description: "Refused", content: { "application/json": { schema: z.object({ error: z.string(), reason: z.string().optional() }) } } },
    409: { description: "Refused", content: { "application/json": { schema: z.object({ error: z.string(), reason: z.string(), blockedReason: z.string().optional() }) } } },
    502: { description: "A sibling could not be read — try again", content: { "application/json": { schema: z.object({ error: z.string(), reason: z.string() }) } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/internal/sales-funnel-campaigns/convert",
  tags: ["Sales funnel campaigns"],
  summary: "Convert the live (leg x channel) campaigns into sales funnel campaigns (staff, dry run by default)",
  description: "Owner GO 2026-10-10. Body {apply?: boolean (default false = dry run), orgId?: string}. Per offer: ONE proactive funnel campaign (the offer's live lead sources + its live proactive pipe; funnel = its ticked sales path starting with that pipe, else the best-ROI catalogue path; max budget DAILY = the sum of those campaigns' current billing ceilings) and ONE reactive-only funnel campaign per live reactive pipe (catalogue funnel starting at that pipe whose pipes are all reactive; daily max budget = its ceiling). A reactive campaign with no ceiling, or with no reactive-only funnel in the catalogue yet, is left exactly as it is and listed (`skipped`). Apply, per group: billing cap PUT, rows linked as units (no status move, nothing starts, nothing emailed), then the per-pipe ceilings they no longer use set to 0 at billing (an offer-less ceiling is not addressable there: listed in `ceilingsLeft`). Idempotent. Header x-email = the person who ordered it (rides billing's writes).",
  security: [{ [apiKeyAuth.name]: [] }],
  request: { body: { content: { "application/json": { schema: z.object({ apply: z.boolean().optional(), orgId: z.string().optional() }) } } } },
  responses: {
    200: { description: "The plan (or what was applied), per group", content: { "application/json": { schema: z.object({ applied: z.boolean(), groups: z.array(z.record(z.string(), z.unknown())), counts: z.object({ campaigns: z.number(), converted: z.number(), skipped: z.number() }) }) } } },
    502: { description: "The channel catalogue could not be read", content: { "application/json": { schema: ErrorResponse } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/sales-funnel-campaigns",
  tags: ["Sales funnel campaigns"],
  summary: "List the org's sales funnel campaigns, each with its units",
  description: SALES_FUNNEL_CAMPAIGNS_DOC + " Header x-org-id. Filters are exact matches.",
  security: [{ [apiKeyAuth.name]: [] }],
  request: { query: SalesFunnelCampaignsQuery },
  responses: {
    200: { description: "Funnel campaigns, newest first", content: { "application/json": { schema: z.object({ salesFunnelCampaigns: z.array(SalesFunnelCampaignSchema) }) } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/sales-funnel-campaigns/{id}",
  tags: ["Sales funnel campaigns"],
  summary: "One sales funnel campaign with its units",
  description: "Header x-org-id. The units' campaign ids are what spend, outcomes and runs are filed under: sum them for the funnel.",
  security: [{ [apiKeyAuth.name]: [] }],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { description: "The funnel campaign", content: { "application/json": { schema: z.object({ salesFunnelCampaign: SalesFunnelCampaignSchema }) } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorResponse } } },
  },
});

registry.registerPath({
  method: "patch",
  path: "/sales-funnel-campaigns/{id}",
  tags: ["Sales funnel campaigns"],
  summary: "Run or pause the whole sales funnel",
  description: "Body {status: activate | stop}. Every unit moves with the funnel in one transaction (transition source `sales_funnel`, stopReason `manual` on stop). activate requires x-user-id + x-run-id and meets the payment hold (409 payment_declined | no_payment_method, 502 billing_unavailable). Units become due at once; the scheduler decides, on the funnel's money, whether they may spend.",
  security: [{ [apiKeyAuth.name]: [] }],
  request: { params: z.object({ id: z.string() }), body: { content: { "application/json": { schema: UpdateSalesFunnelCampaignBody } } } },
  responses: {
    200: { description: "The funnel campaign after the move", content: { "application/json": { schema: z.object({ salesFunnelCampaign: SalesFunnelCampaignSchema }) } } },
    400: { description: "Missing headers", content: { "application/json": { schema: ErrorResponse } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorResponse } } },
    409: { description: "Payment hold", content: { "application/json": { schema: z.object({ error: z.string(), reason: z.string(), blockedReason: z.string().optional() }) } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/offers/{offerId}/reactive-defaults",
  tags: ["Campaigns"],
  summary: "Switch on the reactive campaigns the offer's ticked sales paths use",
  description:
    "REACTIVE CAMPAIGNS ARE ON BY DEFAULT (owner 2026-10-05). Call when a PERSON saved the offer's sales paths (brand-service selected-sales-paths). The ticked paths are brand-service's stated combinationKeys; never stated = the paths with roi > 1 in features-service GET /offers/{offerId}/sales-paths?scope=catalogue (`basis` says which). Every reactive leg of a ticked path worked by a platform channel we run and pace (sales family) that has NO campaign yet is created ON (`started`, transition source `reactive_default`, billing signalled). A campaign already ON is left (`alreadyOn`); a STOPPED one stays stopped whatever stopped it (`keptOff`): a person's off is never re-enabled. Nothing is ever stopped. `skipped` names pairs nothing can run (reason: channel_not_paced_here, unknown_channel, leg_not_performed, no_workflow, workflow_unavailable). Funding is not checked: an unfunded campaign is held on every run and spends nothing. Also applied in the background after a person turns the offer's proactive campaign ON. Payment hold: 409 like every start. Unreadable sales paths / catalogue: 502 reason `sales_paths_unavailable`, nothing written.",
  security: [{ [apiKeyAuth.name]: [] }],
  request: {
    params: z.object({ offerId: z.string() }),
    body: { content: { "application/json": { schema: ReactiveDefaultsBody } } },
  },
  responses: {
    200: { description: "Applied", content: { "application/json": { schema: ReactiveDefaultsResponse } } },
    400: { description: "Validation error or missing x-user-id / x-run-id", content: { "application/json": { schema: ErrorResponse } } },
    409: { description: "Payment hold", content: { "application/json": { schema: ErrorResponse } } },
    502: { description: "Sales paths, selected paths or channel catalogue unreadable; nothing written", content: { "application/json": { schema: ErrorResponse } } },
  },
});

registry.registerPath({
  method: "patch",
  path: "/campaigns/{id}",
  tags: ["Campaigns"],
  summary: "Update a campaign",
  description: "status=activate starts the campaign. ONE PROACTIVE CAMPAIGN ON PER OFFER (owner 2026-10-05): when the campaign this request turns ON works an ENTRY leg (features-service catalogue leg with no fromStep), every OTHER ongoing campaign of the same offer that works an entry leg is stopped in the SAME transaction, as this person's act (stopReason `manual`, transition source `proactive_switch`, billing signalled). `stoppedCampaigns` lists them ([] when none). Reactive campaigns are never stopped. The catalogue is read only when another campaign of the offer is live; unreadable then = 502 reason `catalogue_unavailable`, nothing written. Nothing else ever switches the proactive campaign. After a proactive start, the offer's reactive campaigns are switched on by default in the background (see POST /offers/{offerId}/reactive-defaults). `stoppedCampaigns` is present only on status=activate. A PAYMENT HOLD refuses every start: when billing-service cannot charge the org's card (payment-outlook state charge_blocked) the answer is 409 with reason `payment_declined` (a card was tried and refused), or reason `no_payment_method` when billing's blockedReason is `no_chargeable_card` (no card on file at all), plus `blockedReason` (billing's own code, e.g. card_declined, card_country_unsupported, no_chargeable_card) and `error` in customer-facing English to render verbatim; when billing cannot be read it is 502 with reason `billing_unavailable`. Such an org's campaigns are stopped by the scheduler within ten minutes with stopReason `payment_declined` or `no_payment_method` (same split), and can be started again by a person once billing no longer reports the charge as blocked (paid AND a chargeable card on file).",
  security: [{ [apiKeyAuth.name]: [] }],
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: { content: { "application/json": { schema: UpdateCampaignBody } } },
  },
  responses: {
    200: { description: "Campaign updated", content: { "application/json": { schema: z.object({ campaign: CampaignSchema, stoppedCampaigns: z.array(StoppedCampaignSchema).optional() }) } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorResponse } } },
    409: { description: "Refused — payment_declined | no_payment_method: billing cannot charge this org (see description)", content: { "application/json": { schema: z.object({ error: z.string(), reason: z.string(), blockedReason: z.string().optional() }) } } },
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
  description: "Called as the first DAG node of every run. Validates campaign status, daily budget pacing, legacy non-sales budget windows via runs-service stats/budget, credit affordability and volume limits (maxLeads). A refusal blocks the RUN only, never the campaign's status. Sales money follows billing's sales-budget mode for the brand: `campaigns` (each campaign on its own (offer, leg, channel) ceiling), `global` (one daily pot for every sales campaign of the brand, reason `Global sales budget reached`), or `items` (served for a brand holding a subscriber's monthly campaign budgets, one budget per (offer, leg, channel) campaign: each campaign spends ONLY its own item, a daily budget against today, a monthly budget paced over the billing period (a reactive item, by billing's stated role, is a MAX on the period, spent only when a lead reached its step); an existing per-campaign ceiling stays an upper bound; a campaign no item funds is refused `Campaign not funded`, a spent item `Item budget reached`, an unreadable one `Item budget unavailable`; one item never blocks another; an item on a channel we do not run (`managed: false`) funds nothing, and one billing cannot classify (`managed: null`) holds that campaign only).",
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
  summary: "Move everything this service holds for a brand from one org to another, with its history",
  description: "One transaction, idempotent. Moves to targetOrgId every row tied to sourceBrandId under sourceOrgId: campaigns naming that brand alone, their status transitions and audience-availability periods, the brand's pause transitions, and the migration rollback snapshots. When targetBrandId is given, the brand id is rewritten on the moved rows only (never on another org's rows). Co-branded campaigns (two or more brands) are left in place and counted in coBrandedSkipped. campaign_audience_exhaustion has no org column and follows its campaign id, which never changes. 409 when a moved campaign's name collides with one the target org already holds (nothing is moved).",
  security: [{ [apiKeyAuth.name]: [] }],
  request: {
    body: { content: { "application/json": { schema: TransferBrandBody } } },
  },
  responses: {
    200: { description: "Transfer result", content: { "application/json": { schema: TransferBrandResponse } } },
    400: { description: "Validation error", content: { "application/json": { schema: ErrorResponse } } },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorResponse } } },
    409: { description: "A moved campaign collides with one the target org already holds; nothing moved", content: { "application/json": { schema: ErrorResponse } } },
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
    "A lead reached a step on a (brand, offer); this runs the campaign bought for the leg OUT of that step immediately, instead of waiting for its next tick. The leg is features-service's statement (GET /public/channels -> legs[]) and the campaign is the one already stating that leg — nothing is inferred. The affordability/budget gate is untouched: the dispatch is the scheduler's own, so the run starts at gate-check like any other. A scope that cannot be resolved (unknown step, unreadable catalogue) fails loudly; a scope with no such campaign, or one that is stopped, held for money, already running or operated by the customer's own team, is an ordinary 200 with a NAMED skip. Skip reasons: `no_workflow`, `unfunded`, `run_in_flight`, `global_sales_budget_reached` (global mode: the brand's one pot is spent), `item_budget_reached` (items mode: this campaign's own item budget allows nothing more for now, or cannot be read), `cohort_run_in_flight`, `incomplete_campaign`, `dispatch_refused`, `failure_backoff`. In items mode the campaign is funded by its own (offer, leg, channel) item only, capped on the item's period (a step-triggered leg is reactive). A skipped lead is never dropped: it stays due and the first run the money can pay for works it. The org rides on x-org-id. Every call is RECORDED as one trigger event (see POST /internal/trigger-events), typed with the trigger whose `fromStep` is this step; the answer adds `eventId` and `triggerId`, everything else is unchanged.",
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

const TRIGGER_EVENTS_DOC =
  "TRIGGER EVENTS (owner 2026-10-09): every leg is PROACTIVE (ticked on its budget, no trigger) or REACTIVE (runs ON DEMAND when exactly one TRIGGER asks: a positive reply received, a lead requested, a meeting booked...). The trigger TYPES are features-service's (GET /public/channels `triggers[]`, each reactive leg naming one on `channels[].stepTransitions[].triggerId`); each campaign's On/Off is its status; THIS service records the EVENTS, one per occurrence, with what each did: `ran` (`ranCampaignIds`) or `skipped` with one named `skipReason` (a campaign's own skip such as `unfunded` / `run_in_flight` / `no_workflow`, else `campaign_off` = a campaign is bought for the leg and is OFF, `no_campaign` = nobody bought it, `no_leg` = no published leg answers the trigger, `trigger_not_declared`). The campaigns a trigger runs are the ones of (org, brand, offer) bought for a (channel, leg) whose reactive transition names it, dispatched exactly like the scheduler's (same funding, budget, in-flight and cohort guards; the run starts at gate-check).";

registry.registerPath({
  method: "post",
  path: "/internal/trigger-events",
  tags: ["Internal"],
  summary: "Record one occurrence of a declared trigger, and fire it now, later, or record it as already performed",
  description: TRIGGER_EVENTS_DOC + " WRITE CONTRACT: name a declared `triggerId` (unknown = 400 `unknown_trigger`, nothing recorded; trigger list unreadable = 502 `catalogue_unavailable`, nothing recorded). Due now (no `dueAt`, or `dueAt` <= now) = fired in this call, the outcome is on the returned event. `dueAt` later = recorded `pending` and fired by the scheduler when due (a planned event, e.g. 3h before a meeting), same rules. `performed` = the caller already did the work in-process (lead-service serving a lead on `lead_requested`): `{outcome: \"ran\", campaignId}` (a campaign of the org, else 400 `unknown_campaign`) or `{outcome: \"skipped\", reason, detail?}`; recorded as is, nothing dispatched. `idempotencyKey` (unique per org) makes a retry return the first event with `replayed: true` (200). The org rides on x-org-id.",
  security: [{ [apiKeyAuth.name]: [] }],
  request: {
    headers: z.object({ "x-org-id": z.string().openapi({ description: "Internal org UUID from client-service" }) }),
    body: { content: { "application/json": { schema: RecordTriggerEventBody } } },
  },
  responses: {
    201: { description: "Recorded (and fired when due now)", content: { "application/json": { schema: RecordTriggerEventResponse } } },
    200: { description: "Idempotent replay: the event already recorded under this key", content: { "application/json": { schema: RecordTriggerEventResponse } } },
    400: { description: "No org, malformed body, `unknown_trigger` or `unknown_campaign` (`reason` names it)", content: { "application/json": { schema: ErrorResponse } } },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorResponse } } },
    502: { description: "`catalogue_unavailable`: the trigger list could not be read", content: { "application/json": { schema: ErrorResponse } } },
    500: { description: "Internal error", content: { "application/json": { schema: ErrorResponse } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/internal/offers/{offerId}/trigger-events/summary",
  tags: ["Internal"],
  summary: "Per trigger, over a window: how many events occurred, ran, were skipped (by reason), are pending",
  description: TRIGGER_EVENTS_DOC + " This read groups the offer's events on `occurred_at` in [from, to] (to absent = now) by trigger type; a type with no event in the window is absent (join with features-service `triggers[]` to show it at zero). `recordedSince` = the first event this service ever recorded: before it, absence means not recorded. Requires header x-org-id.",
  security: [{ [apiKeyAuth.name]: [] }],
  request: {
    params: z.object({ offerId: z.string() }),
    query: OfferTriggerEventsSummaryQuery,
    headers: z.object({ "x-org-id": z.string() }),
  },
  responses: {
    200: { description: "Per-trigger counts", content: { "application/json": { schema: OfferTriggerEventsSummaryResponse } } },
    400: { description: "Missing x-org-id or a malformed query", content: { "application/json": { schema: ErrorResponse } } },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorResponse } } },
    500: { description: "Internal error", content: { "application/json": { schema: ErrorResponse } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/internal/offers/{offerId}/trigger-events",
  tags: ["Internal"],
  summary: "The latest trigger events of an offer, newest first",
  description: TRIGGER_EVENTS_DOC + " limit 1-200, absent = 50. Requires header x-org-id.",
  security: [{ [apiKeyAuth.name]: [] }],
  request: {
    params: z.object({ offerId: z.string() }),
    query: OfferTriggerEventsListQuery,
    headers: z.object({ "x-org-id": z.string() }),
  },
  responses: {
    200: { description: "The events", content: { "application/json": { schema: OfferTriggerEventsListResponse } } },
    400: { description: "Missing x-org-id or a malformed query", content: { "application/json": { schema: ErrorResponse } } },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorResponse } } },
    500: { description: "Internal error", content: { "application/json": { schema: ErrorResponse } } },
  },
});

const SOURCE_CAMPAIGNS_DOC =
  "SOURCE CAMPAIGNS (owner 2026-10-07; vocabulary owned by features-service, `src/routes/CLAUDE.md` \"Source campaigns\"): an offer's lead SOURCES are campaigns keyed (offerId, featureSlug = <origin slug>, legKey = \"start_to_lead_found\"), live origins `sourcing-apollo-cold-filters`, `sourcing-apollo-buying-signals`, `sourcing-linkedin-engagement-signals`, `sourcing-crm-contacts` (`sourcing-apify-search` retired: served when a row exists, never startable). "
  + "A source campaign has NO workflow (lead-service finds leads inside the outreach campaign's run and files that work under the source campaign's id), so it is never scheduled, triggered or gate-checked. Several may be ON at once and they are never part of the one-proactive-campaign rule: turning a source on stops nothing, and turning the outreach campaign on stops no source. "
  + "On/Off: first On = POST /campaigns/start-funded-pair {brandId, offerId, featureSlug: <origin>, legKey: \"start_to_lead_found\"} (201 created ON, 200 an existing one handed back / restarted; ceilingCents null; no funding read); then PATCH /campaigns/{id} {status: \"stop\" | \"activate\"} with x-brand-id + x-feature-slug = <origin>. POST /campaigns refuses an origin slug (400 `source_campaign_via_start_pair`). "
  + "An outreach campaign of a sourced channel (cold email, feedback request, CRM email) keeps its key and works every lead its offer's ON sources found; its spend reads (daily budget, global pot, item pacing) also count the sourcing filed under those source campaigns, so what it may spend is unchanged. The offer's first outreach start with no source row at all creates the channel's default source ON (Apollo Cold Filters; CRM Contacts for CRM email; transition source `source_default`).";

registry.registerPath({
  method: "get",
  path: "/internal/offers/{offerId}/source-campaigns",
  tags: ["Internal"],
  summary: "An offer's lead sources (source campaigns) and which are running",
  description: SOURCE_CAMPAIGNS_DOC + " This read lists one entry per live origin (campaignId/status null = no campaign yet = OFF) plus a retired origin that has a row; `runningSourceCampaigns` = the sources that may find leads for the offer now, with the campaign id to file that work under. Requires header x-org-id (an offer belongs to one (org, brand) pair).",
  security: [{ [apiKeyAuth.name]: [] }],
  request: {
    params: z.object({ offerId: z.string() }),
    query: SourceCampaignsQuery,
    headers: z.object({ "x-org-id": z.string() }),
  },
  responses: {
    200: { description: "The offer's source campaigns", content: { "application/json": { schema: OfferSourceCampaignsResponse } } },
    400: { description: "Missing brandId or x-org-id", content: { "application/json": { schema: ErrorResponse } } },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorResponse } } },
    500: { description: "Internal error", content: { "application/json": { schema: ErrorResponse } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/internal/campaigns/{campaignId}/source-campaigns",
  tags: ["Internal"],
  summary: "The source campaigns that feed one outreach campaign",
  description: SOURCE_CAMPAIGNS_DOC + " This read takes the OUTREACH campaign a serve run carries and answers the source campaigns of the same (org, brand, offer) whose origin serves its channel (`servedOrigins`), any status, `running` = may find leads now. A channel that sources nothing, or a campaign stating no offer, answers `sourced: false`.",
  security: [{ [apiKeyAuth.name]: [] }],
  request: { params: z.object({ campaignId: z.string() }) },
  responses: {
    200: { description: "The feeding source campaigns", content: { "application/json": { schema: CampaignSourceCampaignsResponse } } },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorResponse } } },
    404: { description: "No such campaign", content: { "application/json": { schema: ErrorResponse } } },
    500: { description: "Internal error", content: { "application/json": { schema: ErrorResponse } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/internal/source-campaigns/mirror",
  tags: ["Internal"],
  summary: "Staff migration: create each offer's source campaigns mirroring its outreach campaign",
  description: SOURCE_CAMPAIGNS_DOC + " MIGRATION (re-runnable, idempotent, dry run unless apply=true): for every offer with an outreach campaign of a sourced channel on an entry leg, creates the channel's default source plus every live origin that spent under one of the offer's outreach campaigns in the last 14 days, each ON iff an outreach campaign it serves is ON, else OFF with that campaign's stop reason (transition source `source_mirror`). An origin already holding a row is never touched. Never starts spend that was not running. Unreadable catalogue = 502.",
  security: [{ [apiKeyAuth.name]: [] }],
  request: { body: { content: { "application/json": { schema: SourceCampaignsMirrorBody } } } },
  responses: {
    200: { description: "The plan (and what was created when applied)", content: { "application/json": { schema: SourceCampaignsMirrorResponse } } },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorResponse } } },
    502: { description: "Catalogue unreadable", content: { "application/json": { schema: ErrorResponse } } },
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

registry.registerPath({
  method: "get",
  path: "/internal/campaigns/recurring-status",
  tags: ["Internal"],
  summary: "Which campaigns of a brand or org count toward recurring daily spend right now",
  description:
    "One row per campaign of the brand (`brandId`) or org (`orgId`, both may be combined; at least one is required), stopped ones included. Each row carries the campaign identity (offer, leg, channel), whether it is running (`status = ongoing`), whether it is platform-executed (a campaign with no workflow is customer-operated: never scheduled, never spends), whether it is PROACTIVE (bought for an entry leg that starts from nothing, as published by features-service's catalogue) or REACTIVE (a leg that fires from a step a lead already reached), and whether ALL its audiences are exhausted right now, read from the campaign's current audience-availability period (the verdict /end-run records and the scheduler reschedules on). `not_recorded` is never collapsed to available: `allAudiencesExhausted` is null then. `recurring` = running AND platform-executed AND proactive AND not exhausted; it is null only when the answer turns on an unknown axis, naming it. No money figure and no payment state: both are billing-service's. Nothing is written.",
  security: [{ [apiKeyAuth.name]: [] }],
  request: { query: RecurringStatusQuery },
  responses: {
    200: { description: "One row per campaign", content: { "application/json": { schema: RecurringStatusResponse } } },
    400: { description: "Neither orgId nor brandId stated", content: { "application/json": { schema: ErrorResponse } } },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorResponse } } },
    502: { description: "The acquisition-channel catalogue could not be read", content: { "application/json": { schema: ErrorResponse } } },
    500: { description: "Internal error", content: { "application/json": { schema: ErrorResponse } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/internal/campaigns/failing",
  tags: ["Internal"],
  summary: "Every ongoing campaign whose last run failed, with its run health",
  description:
    "Fleet-wide. One row per ONGOING campaign with at least one failed run since its last success, ordered by streak length. `runHealth.state` is `retrying` below the alert threshold and `failing` at or above it (staff were alerted once for the episode). `retryIntervalMs` is the delay /end-run applied after the latest failure: 60s for the first few failures, doubling to a ceiling. `thresholds` states the constants that produced it. A failing campaign is never stopped by this and the customer is never emailed by it. Nothing is written.",
  security: [{ [apiKeyAuth.name]: [] }],
  responses: {
    200: { description: "Failing and retrying campaigns", content: { "application/json": { schema: FailingCampaignsResponse } } },
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
