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
