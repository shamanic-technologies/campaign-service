## CRITICAL RULE — Read-only by default

When the user shares logs, errors, or bug reports: **ONLY diagnose and explain**. NEVER write code, create branches, open PRs, or make any changes unless the user explicitly asks you to implement a fix. The user often shares the same logs with multiple agents in parallel just for analysis — acting on them without permission wastes time and creates mess to clean up.

**Before making ANY structural or architectural change** (new endpoints, new DAG nodes, new services, schema changes, workflow changes): stop and ask the user for approval first. Never assume the fix belongs in this repo — the root cause may be in another service.

# Project: campaign-service

Campaign CRUD and orchestration service for MCP Factory. Manages campaign lifecycle, budget tracking, and run coordination.

## Log level: expected business states are NOT warnings — and high-frequency routine events are NOT logged at all

A gate block caused by a **normal, expected** business state — out of credits, budget window exceeded, max leads reached — must trace/log at `info`, never `warn`/`error`. Running out of credit happens; it is not an anomaly and it is not campaign-service's job to flag it loudly (billing's dunning engine owns the "out of credit" story). Reserve `warn`/`error` for genuine fail-OPEN/fail-closed anomalies (misconfig, non-2xx from a sibling, unexpected throw). When adding a new gate-check block, decide its trace level by "is this an expected outcome or a fault?" — expected → info. (Set 2026-06-14, credit-affordability gate PR #171: the gate-check-result trace hard-coded `warn` for every BLOCKED result; out-of-credit blocks were surfacing as warnings.)

**Downgrading warn→info is NOT always enough — for a HIGH-FREQUENCY routine event, the right level is NO LOG.** Decide level on TWO axes: (1) expected-vs-fault → picks warn vs info; (2) frequency → a routine event that fires on a per-tick / per-minute cadence for **every** campaign × **every** client (scheduler dedup skips, "still in-flight, rescheduled", poll heartbeats) must not be logged at all — even `info` spams the logs minute-by-minute across the fleet and buries real signal. Ask "how often, across how many entities, does this line fire?" before logging it; if the answer is "every tick for everyone," drop it. The decision is already observable in durable state (persisted `nextRunAt` in DB, trace events) — a per-minute log is the wrong observability mechanism. (Set 2026-06-14, scheduler in-flight skip v0.26.1: first instinct was to downgrade the `console.warn` to `console.log`; Kevin: "tu ne vas pas faire un bip toutes les minutes pour toutes les campagnes, pour tous les clients… ça n'a aucun sens" — the log was deleted, not downgraded.)

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

## Scheduler in-flight guard — check ANY live run for the campaign, never the campaign-service marker

The `campaign-service / <campaignId>` parent run (created by the workflow DAG's start-run) is an **ephemeral ~2s marker** — `start-run → end-run` within seconds — NOT an enclosing span. The genuinely-long work (lead-service `buffer/next`, observed up to **755s**) runs in a separate `lead-service / lead-serve` run that is **not linked** under the marker via `parent_run_id`. So `src/lib/scheduler.ts`'s "is a flow still alive?" check MUST query `listRuns` scoped to **`campaignId` + `status=running` + `startedAfter=freshnessCutoff`** (any service) via `hasLiveRunForCampaign()` — **never** `(serviceName="campaign-service", taskName=campaignId)`, which only sees the 2s corpse and re-fires mid-fill → `lead-service` `409 Concurrent buffer/next` storm. `STUCK_RUN_FRESHNESS_THRESHOLD_MS` must stay **strictly greater than** lead-service's max fill (`PULL_NEXT_TIMEOUT` 600s; observed 755s) — currently 15min. `reRunDueCampaigns` and `claimStuckCampaigns` MUST share the same helper. (Set 2026-06-13, v0.25.1 / DIS-277.)
