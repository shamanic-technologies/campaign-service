## CRITICAL RULE — Read-only by default

When the user shares logs, errors, or bug reports: **ONLY diagnose and explain**. NEVER write code, create branches, open PRs, or make any changes unless the user explicitly asks you to implement a fix. The user often shares the same logs with multiple agents in parallel just for analysis — acting on them without permission wastes time and creates mess to clean up.

**Before making ANY structural or architectural change** (new endpoints, new DAG nodes, new services, schema changes, workflow changes): stop and ask the user for approval first. Never assume the fix belongs in this repo — the root cause may be in another service.

# Project: campaign-service

Campaign CRUD and orchestration service for MCP Factory. Manages campaign lifecycle, budget tracking, and run coordination.

## Commands

- `pnpm test` — run all tests (Vitest)
- `pnpm test:unit` — run unit tests only
- `pnpm test:integration` — run integration tests only
- `pnpm run build` — compile TypeScript + generate OpenAPI spec
- `pnpm run dev` — local dev server (tsx watch)
- `pnpm run generate:openapi` — regenerate openapi.json
- `pnpm run db:generate` — generate Drizzle migrations
- `pnpm run db:migrate` — run migrations
- `pnpm run db:push` — push schema directly (dev only)

## Running tests in a fresh workspace

A new Conductor workspace has no built local package and no test DB. Before `pnpm test:integration`:

1. **Build the workspace client first** — `pnpm --filter @distribute/runs-client build`. Without it `tsc`/`vitest` fail with `TS2307 Cannot find module '@distribute/runs-client'` (looks like a code bug, isn't).
2. **Provide a local Postgres** named `campaign_test` — integration tests connect to `postgresql://test:test@localhost/campaign_test` (see `tests/setup.ts`). Create role `test`/`test` + DB, then materialize the schema with **`db:push`, NOT `db:migrate`** — a from-scratch `db:migrate` fails on a historical FK type drift (`campaign_runs.campaign_id uuid` vs `campaigns.id text`, error `42804`). `db:push` uses `schema.ts` (source of truth) directly. Set `CAMPAIGN_SERVICE_DATABASE_URL` for the run.

Unit tests (`pnpm test:unit`) need neither — they fully mock db/runs-client.

## Architecture

- `src/schemas.ts` — Zod schemas (source of truth for validation + OpenAPI)
- `src/routes/campaigns.ts` — Campaign CRUD, stats, batch budget usage endpoints
- `src/routes/runs.ts` — Run status update endpoints
- `src/routes/health.ts` — Health check endpoint
- `src/db/schema.ts` — Drizzle ORM database schema (PostgreSQL)
- `src/db/index.ts` — Database connection
- `src/lib/domain.ts` — Domain logic / utility functions
- `src/middleware/auth.ts` — X-API-Key authentication middleware
- `src/middleware/validate.ts` — Zod request validation middleware
- `src/index.ts` — Express app entry point
- `packages/runs-client/` — HTTP client for runs-service
- `drizzle/` — Database migration files
- `tests/` — Test files (`*.test.ts`)
- `openapi.json` — Auto-generated, do NOT edit manually
