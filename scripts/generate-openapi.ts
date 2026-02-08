import { OpenAPIRegistry, OpenApiGeneratorV3 } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import { writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  CampaignSchema,
  CreateCampaignBody,
  CreateCampaignInternalBody,
  UpdateCampaignBody,
  StatsFilterBody,
  StatsResponse,
  BatchStatsBody,
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

const serviceAuth = registry.registerComponent("securitySchemes", "serviceAuth", {
  type: "apiKey",
  in: "header",
  name: "x-clerk-org-id",
  description: "Clerk org ID for service-to-service auth",
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
  method: "post",
  path: "/campaigns/{id}/activate",
  tags: ["Campaigns"],
  summary: "Activate a campaign",
  security: [{ [bearerAuth.name]: [] }],
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    200: { description: "Campaign activated", content: { "application/json": { schema: z.object({ campaign: CampaignSchema }) } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorResponse } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/campaigns/{id}/pause",
  tags: ["Campaigns"],
  summary: "Pause a campaign",
  security: [{ [bearerAuth.name]: [] }],
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    200: { description: "Campaign paused", content: { "application/json": { schema: z.object({ campaign: CampaignSchema }) } } },
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
  path: "/stats",
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
  request: {
    params: z.object({ runId: z.string().uuid() }),
    body: { content: { "application/json": { schema: RunStatusUpdate } } },
  },
  responses: {
    200: { description: "Run updated", content: { "application/json": { schema: z.object({ run: RunSchema }) } } },
    400: { description: "Validation error", content: { "application/json": { schema: ErrorResponse } } },
  },
});

// === INTERNAL ===

registry.registerPath({
  method: "get",
  path: "/internal/campaigns",
  tags: ["Internal"],
  summary: "List campaigns for org (service-to-service)",
  security: [{ [serviceAuth.name]: [] }],
  request: { query: z.object({ brandId: z.string().optional() }).openapi("InternalCampaignsQuery") },
  responses: {
    200: { description: "List of campaigns", content: { "application/json": { schema: z.object({ campaigns: z.array(CampaignSchema) }) } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/internal/campaigns/all",
  tags: ["Internal"],
  summary: "List all campaigns across all orgs (scheduler)",
  security: [{ [apiKeyAuth.name]: [] }],
  responses: {
    200: { description: "All campaigns with org info", content: { "application/json": { schema: z.object({ campaigns: z.array(CampaignSchema.extend({ clerkOrgId: z.string(), brandDomain: z.string().nullable(), brandName: z.string().nullable() })) }) } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/internal/campaigns/{id}",
  tags: ["Internal"],
  summary: "Get a specific campaign (service-to-service)",
  security: [{ [serviceAuth.name]: [] }],
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    200: { description: "Campaign details", content: { "application/json": { schema: z.object({ campaign: CampaignSchema }) } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorResponse } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/internal/campaigns",
  tags: ["Internal"],
  summary: "Create a campaign (service-to-service)",
  security: [{ [serviceAuth.name]: [] }],
  request: { body: { content: { "application/json": { schema: CreateCampaignInternalBody } } } },
  responses: {
    201: { description: "Campaign created", content: { "application/json": { schema: z.object({ campaign: CampaignSchema }) } } },
    400: { description: "Validation error", content: { "application/json": { schema: ErrorResponse } } },
  },
});

registry.registerPath({
  method: "patch",
  path: "/internal/campaigns/{id}",
  tags: ["Internal"],
  summary: "Update a campaign (service-to-service)",
  security: [{ [serviceAuth.name]: [] }],
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
  method: "post",
  path: "/internal/campaigns/{id}/stop",
  tags: ["Internal"],
  summary: "Stop a campaign",
  security: [{ [serviceAuth.name]: [] }],
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    200: { description: "Campaign stopped", content: { "application/json": { schema: z.object({ campaign: CampaignSchema }) } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorResponse } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/internal/campaigns/{id}/resume",
  tags: ["Internal"],
  summary: "Resume a stopped campaign",
  security: [{ [serviceAuth.name]: [] }],
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    200: { description: "Campaign resumed", content: { "application/json": { schema: z.object({ campaign: CampaignSchema }) } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorResponse } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/internal/campaigns/{id}/runs",
  tags: ["Internal"],
  summary: "Get campaign runs (service-to-service)",
  security: [{ [serviceAuth.name]: [] }],
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    200: { description: "List of runs", content: { "application/json": { schema: z.object({ runs: z.array(RunSchema) }) } } },
    404: { description: "Campaign not found", content: { "application/json": { schema: ErrorResponse } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/internal/campaigns/{id}/runs/all",
  tags: ["Internal"],
  summary: "Get campaign runs (scheduler, API key auth)",
  security: [{ [apiKeyAuth.name]: [] }],
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    200: { description: "List of runs", content: { "application/json": { schema: z.object({ runs: z.array(RunSchema) }) } } },
    404: { description: "Campaign or org not found", content: { "application/json": { schema: ErrorResponse } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/internal/campaigns/{id}/runs",
  tags: ["Internal"],
  summary: "Create a campaign run (scheduler)",
  security: [{ [apiKeyAuth.name]: [] }],
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    200: { description: "Run created", content: { "application/json": { schema: z.object({ run: RunSchema }) } } },
    404: { description: "Campaign or org not found", content: { "application/json": { schema: ErrorResponse } } },
  },
});

registry.registerPath({
  method: "patch",
  path: "/internal/runs/{id}",
  tags: ["Internal"],
  summary: "Update a run status",
  security: [{ [apiKeyAuth.name]: [] }],
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: { content: { "application/json": { schema: RunStatusUpdate } } },
  },
  responses: {
    200: { description: "Run updated", content: { "application/json": { schema: z.object({ run: RunSchema }) } } },
    400: { description: "Validation error", content: { "application/json": { schema: ErrorResponse } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/internal/campaigns/{id}/debug",
  tags: ["Internal"],
  summary: "Get detailed debug info for a campaign",
  security: [{ [serviceAuth.name]: [] }],
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    200: {
      description: "Debug info with campaign details, runs, and summary",
      content: {
        "application/json": {
          schema: z.object({
            campaign: z.object({
              id: z.string().uuid(),
              name: z.string(),
              status: z.string(),
              createdAt: z.string(),
              updatedAt: z.string(),
              targeting: z.object({
                personTitles: z.array(z.string()).nullable(),
                locations: z.array(z.string()).nullable(),
                industries: z.array(z.string()).nullable(),
              }),
              budget: z.object({
                daily: z.string().nullable(),
                weekly: z.string().nullable(),
                monthly: z.string().nullable(),
                total: z.string().nullable(),
              }),
            }),
            runs: z.array(z.object({
              id: z.string().uuid(),
              status: z.string(),
              startedAt: z.string().nullable(),
              completedAt: z.string().nullable(),
              createdAt: z.string(),
            })),
            summary: z.object({
              totalRuns: z.number(),
              completed: z.number(),
              failed: z.number(),
              running: z.number(),
              lastRunAt: z.string().nullable(),
            }),
          }),
        },
      },
    },
    404: { description: "Not found", content: { "application/json": { schema: ErrorResponse } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/internal/campaigns/{id}/stats",
  tags: ["Internal"],
  summary: "Campaign stats from own DB + runs-service",
  security: [{ [serviceAuth.name]: [] }],
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    200: {
      description: "Campaign stats with budget and run counts",
      content: {
        "application/json": {
          schema: z.object({
            campaignId: z.string().uuid(),
            status: z.string(),
            maxLeads: z.number().nullable(),
            budget: z.object({
              daily: z.string().nullable(),
              weekly: z.string().nullable(),
              monthly: z.string().nullable(),
              total: z.string().nullable(),
            }),
            runs: z.object({
              total: z.number(),
              completed: z.number(),
              failed: z.number(),
              running: z.number(),
            }),
            totalCostInUsdCents: z.string().nullable(),
            createdAt: z.string(),
            updatedAt: z.string(),
          }),
        },
      },
    },
    404: { description: "Not found", content: { "application/json": { schema: ErrorResponse } } },
  },
});

const LeadSchema = z.object({
  id: z.string(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  email: z.string().nullable(),
  title: z.string().nullable(),
  organizationName: z.string().nullable(),
  linkedinUrl: z.string().nullable(),
  enrichmentRunId: z.string().nullable(),
  status: z.string(),
  createdAt: z.string(),
}).openapi("Lead");

registry.registerPath({
  method: "get",
  path: "/internal/campaigns/{id}/leads",
  tags: ["Internal"],
  summary: "Get all leads for a campaign",
  security: [{ [serviceAuth.name]: [] }],
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    200: { description: "List of leads", content: { "application/json": { schema: z.object({ leads: z.array(LeadSchema) }) } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorResponse } } },
  },
});

const CompanySchema = z.object({
  id: z.string(),
  name: z.string(),
  domain: z.string().nullable(),
  industry: z.string().nullable(),
  employeeCount: z.string().nullable(),
  leadsCount: z.number(),
  enrichmentRunIds: z.array(z.string()),
}).openapi("Company");

registry.registerPath({
  method: "get",
  path: "/internal/campaigns/{id}/companies",
  tags: ["Internal"],
  summary: "Get all companies for a campaign",
  security: [{ [serviceAuth.name]: [] }],
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    200: { description: "List of companies", content: { "application/json": { schema: z.object({ companies: z.array(CompanySchema) }) } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorResponse } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/internal/campaigns/batch-stats",
  tags: ["Internal"],
  summary: "Get stats for multiple campaigns",
  description: "Returns campaign DB data + run counts for each campaign",
  security: [{ [apiKeyAuth.name]: [] }],
  request: { body: { content: { "application/json": { schema: BatchStatsBody } } } },
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
    description: "API for managing marketing campaigns, runs, and internal service-to-service communication",
    version: "1.0.0",
  },
  servers: [{ url: process.env.SERVICE_URL || "http://localhost:3003" }],
});

const outputPath = join(__dirname, "..", "openapi.json");
writeFileSync(outputPath, JSON.stringify(spec, null, 2));
console.log(`OpenAPI spec written to ${outputPath}`);
