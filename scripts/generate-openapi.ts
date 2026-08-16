import { OpenAPIRegistry, OpenApiGeneratorV3 } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import { writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  CampaignSchema,
  CreateCampaignBody,
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
  security: [{ [apiKeyAuth.name]: [] }],
  request: { body: { content: { "application/json": { schema: CreateCampaignBody } } } },
  responses: {
    201: { description: "Campaign created", content: { "application/json": { schema: z.object({ campaign: CampaignSchema }) } } },
    400: { description: "Validation error", content: { "application/json": { schema: ErrorResponse } } },
  },
});

registry.registerPath({
  method: "patch",
  path: "/campaigns/{id}",
  tags: ["Campaigns"],
  summary: "Update a campaign",
  security: [{ [apiKeyAuth.name]: [] }],
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: { content: { "application/json": { schema: UpdateCampaignBody } } },
  },
  responses: {
    200: { description: "Campaign updated", content: { "application/json": { schema: z.object({ campaign: CampaignSchema }) } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorResponse } } },
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
  description: "Returns whether the brand's sales campaigns are HELD, derived from what the customer FUNDS in billing-service — there is no stored pause flag any more (it had no writer left in the fleet and was retired in v0.51.0). paused=true ⟺ no sales funnel of this (org, brand) carries a positive daily ceiling AND the brand-level daily budget is not positive either; funding any one funnel releases it with no other step. updatedAt is always null (the state is not stored here). 502 when billing cannot be read — a brand whose funding is unknown is not reported as running. Org-scoped via x-org-id.",
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
