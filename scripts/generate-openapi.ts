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
  GateCheckBody,
  GateCheckResponse,
  StartRunBody,
  StartRunResponse,
  EndRunBody,
  EndRunResponse,
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
  security: [{ [apiKeyAuth.name]: [] }],
  request: { query: CampaignsFilterQuery },
  responses: {
    200: { description: "List of campaigns", content: { "application/json": { schema: z.object({ campaigns: z.array(CampaignSchema) }) } } },
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

// === STATS ===

registry.registerPath({
  method: "get",
  path: "/stats",
  tags: ["Stats"],
  summary: "Campaign stats from own DB (query params)",
  description: "Returns campaign counts, status breakdown, and configured budget totals. Supports filtering by workflowSlug, featureSlug, workflowDynastySlug, featureDynastySlug, and groupBy for aggregation by slug or dynasty slug. When groupBy is set, returns groupedStats keyed by the group value. Requires API key.",
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

const TrackingHeaders = z.object({
  "x-campaign-id": z.string().uuid().optional().openapi({ description: "Campaign ID (injected by workflow-service)" }),
  "x-brand-id": z.string().optional().openapi({ description: "Comma-separated brand UUIDs (e.g. 'uuid1,uuid2,uuid3'). Single UUID for single-brand campaigns.", example: "550e8400-e29b-41d4-a716-446655440000,6ba7b810-9dad-11d1-80b4-00c04fd430c8" }),
  "x-workflow-slug": z.string().optional().openapi({ description: "Workflow slug (injected by workflow-service)" }),
}).openapi("TrackingHeaders");

registry.registerPath({
  method: "post",
  path: "/gate-check",
  tags: ["Pipeline"],
  summary: "Check if a campaign can run a new iteration",
  description: "Validates budget limits (daily/weekly/monthly/total) via runs-service stats/budget, volume limits (maxLeads), campaign status, and consecutive failures. Auto-stops the campaign if total budget or maxLeads is exceeded. Called as the first DAG node.",
  security: [{ [apiKeyAuth.name]: [] }],
  request: {
    headers: TrackingHeaders,
    body: { content: { "application/json": { schema: GateCheckBody } } },
  },
  responses: {
    200: { description: "Gate check result", content: { "application/json": { schema: GateCheckResponse } } },
    404: { description: "Campaign or org not found", content: { "application/json": { schema: ErrorResponse } } },
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
    headers: TrackingHeaders,
    body: { content: { "application/json": { schema: StartRunBody } } },
  },
  responses: {
    200: { description: "Run created, campaign data returned", content: { "application/json": { schema: StartRunResponse } } },
    400: { description: "Missing brandIds", content: { "application/json": { schema: ErrorResponse } } },
    404: { description: "Campaign or org not found", content: { "application/json": { schema: ErrorResponse } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/end-run",
  tags: ["Pipeline"],
  summary: "Finalize run and re-trigger workflow if campaign is ongoing",
  description: "Finds any running runs for the campaign and marks them as completed or failed. Then re-triggers the workflow if the campaign is still ongoing. Does not require runId — finds running runs via runs-service.",
  security: [{ [apiKeyAuth.name]: [] }],
  request: {
    headers: TrackingHeaders,
    body: { content: { "application/json": { schema: EndRunBody } } },
  },
  responses: {
    200: { description: "Run finalized", content: { "application/json": { schema: EndRunResponse } } },
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
