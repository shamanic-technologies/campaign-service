import { OpenAPIRegistry, OpenApiGeneratorV3 } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import { writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  CampaignSchema,
  CreateCampaignBody,
  UpdateCampaignBody,
  StatsFilterBody,
  StatsResponse,
  BatchBudgetUsageBody,
  RunStatusUpdate,
  ErrorResponse,
} from "../src/schemas.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const registry = new OpenAPIRegistry();

// --- Security schemes ---
const bearerAuth = registry.registerComponent("securitySchemes", "bearerAuth", {
  type: "http",
  scheme: "bearer",
  bearerFormat: "JWT",
  description: "Clerk JWT token",
});

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
  security: [{ [bearerAuth.name]: [] }],
  request: { query: z.object({ brandId: z.string().optional() }).openapi("CampaignsQuery") },
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
  security: [{ [bearerAuth.name]: [] }],
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
  security: [{ [bearerAuth.name]: [] }],
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
  security: [{ [bearerAuth.name]: [] }],
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
  security: [{ [bearerAuth.name]: [] }],
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    200: { description: "Campaign deleted", content: { "application/json": { schema: z.object({ message: z.string() }) } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorResponse } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/campaigns/stats",
  tags: ["Campaigns"],
  summary: "Campaign stats from own DB",
  description: "Returns campaign counts, status breakdown, and budget totals. Requires API key.",
  security: [{ [apiKeyAuth.name]: [] }],
  request: { body: { content: { "application/json": { schema: StatsFilterBody } } } },
  responses: {
    200: { description: "Campaign stats", content: { "application/json": { schema: StatsResponse } } },
    400: { description: "Validation error", content: { "application/json": { schema: ErrorResponse } } },
  },
});

// === PUBLIC RUNS ===

const RunSchema = z.object({
  id: z.string().uuid(),
  status: z.string(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  createdAt: z.string(),
}).openapi("Run");

registry.registerPath({
  method: "get",
  path: "/campaigns/{campaignId}/runs",
  tags: ["Runs"],
  summary: "List runs for a campaign",
  security: [{ [bearerAuth.name]: [] }],
  request: { params: z.object({ campaignId: z.string().uuid() }) },
  responses: {
    200: { description: "List of runs", content: { "application/json": { schema: z.object({ runs: z.array(RunSchema) }) } } },
    404: { description: "Campaign not found", content: { "application/json": { schema: ErrorResponse } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/campaigns/{campaignId}/runs/{runId}",
  tags: ["Runs"],
  summary: "Get a specific run",
  security: [{ [bearerAuth.name]: [] }],
  request: { params: z.object({ campaignId: z.string().uuid(), runId: z.string().uuid() }) },
  responses: {
    200: { description: "Run details", content: { "application/json": { schema: z.object({ run: RunSchema }) } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorResponse } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/campaigns/{campaignId}/runs",
  tags: ["Runs"],
  summary: "Create a new run",
  security: [{ [apiKeyAuth.name]: [] }],
  request: { params: z.object({ campaignId: z.string().uuid() }) },
  responses: {
    201: { description: "Run created", content: { "application/json": { schema: z.object({ run: RunSchema }) } } },
    404: { description: "Campaign not found", content: { "application/json": { schema: ErrorResponse } } },
  },
});

registry.registerPath({
  method: "patch",
  path: "/runs/{runId}",
  tags: ["Runs"],
  summary: "Update run status",
  security: [{ [apiKeyAuth.name]: [] }],
  request: {
    params: z.object({ runId: z.string().uuid() }),
    body: { content: { "application/json": { schema: RunStatusUpdate } } },
  },
  responses: {
    200: { description: "Run updated", content: { "application/json": { schema: z.object({ run: RunSchema }) } } },
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
    200: { description: "All campaigns with org info", content: { "application/json": { schema: z.object({ campaigns: z.array(CampaignSchema.extend({ clerkOrgId: z.string(), brandDomain: z.string().nullable(), brandName: z.string().nullable() })) }) } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/campaigns/{campaignId}/runs/list",
  tags: ["Scheduler"],
  summary: "Get campaign runs (no org scoping)",
  security: [{ [apiKeyAuth.name]: [] }],
  request: { params: z.object({ campaignId: z.string().uuid() }) },
  responses: {
    200: { description: "List of runs", content: { "application/json": { schema: z.object({ runs: z.array(RunSchema) }) } } },
    404: { description: "Campaign or org not found", content: { "application/json": { schema: ErrorResponse } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/campaigns/batch-budget-usage",
  tags: ["Scheduler"],
  summary: "Get cost and run data for multiple campaigns",
  description: "Returns budget usage (totalCostInUsdCents) and run counts per campaign",
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
              runs: z.object({
                total: z.number(),
                completed: z.number(),
                failed: z.number(),
                running: z.number(),
              }).optional(),
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

// --- Generate ---

const generator = new OpenApiGeneratorV3(registry.definitions);
const spec = generator.generateDocument({
  openapi: "3.0.0",
  info: {
    title: "Campaign Service",
    description: "API for managing marketing campaigns and runs",
    version: "1.0.0",
  },
  servers: [{ url: process.env.SERVICE_URL || "http://localhost:3003" }],
});

const outputPath = join(__dirname, "..", "openapi.json");
writeFileSync(outputPath, JSON.stringify(spec, null, 2));
console.log(`OpenAPI spec written to ${outputPath}`);
