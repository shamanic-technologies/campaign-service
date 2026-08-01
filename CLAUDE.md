## CRITICAL RULE — Read-only by default

When the user shares logs, errors, or bug reports: **ONLY diagnose and explain**. NEVER write code, create branches, open PRs, or make any changes unless the user explicitly asks you to implement a fix. The user often shares the same logs with multiple agents in parallel just for analysis — acting on them without permission wastes time and creates mess to clean up.

**Before making ANY structural or architectural change** (new endpoints, new DAG nodes, new services, schema changes, workflow changes): stop and ask the user for approval first. Never assume the fix belongs in this repo — the root cause may be in another service.

# Project: campaign-service

Campaign CRUD and orchestration service for MCP Factory. Manages campaign lifecycle, budget tracking, and run coordination.

## Log level: expected business states are NOT warnings — and high-frequency routine events are NOT logged at all

A gate block caused by a **normal, expected** business state — out of credits, budget window exceeded, max leads reached — must trace/log at `info`, never `warn`/`error`. Running out of credit happens; it is not an anomaly and it is not campaign-service's job to flag it loudly (billing's dunning engine owns the "out of credit" story). Reserve `warn`/`error` for genuine fail-OPEN/fail-closed anomalies (misconfig, non-2xx from a sibling, unexpected throw). When adding a new gate-check block, decide its trace level by "is this an expected outcome or a fault?" — expected → info. (Set 2026-06-14, credit-affordability gate PR #171: the gate-check-result trace hard-coded `warn` for every BLOCKED result; out-of-credit blocks were surfacing as warnings.)

**Downgrading warn→info is NOT always enough — for a HIGH-FREQUENCY routine event, the right level is NO LOG.** Decide level on TWO axes: (1) expected-vs-fault → picks warn vs info; (2) frequency → a routine event that fires on a per-tick / per-minute cadence for **every** campaign × **every** client (scheduler dedup skips, "still in-flight, rescheduled", poll heartbeats) must not be logged at all — even `info` spams the logs minute-by-minute across the fleet and buries real signal. Ask "how often, across how many entities, does this line fire?" before logging it; if the answer is "every tick for everyone," drop it. The decision is already observable in durable state (persisted `nextRunAt` in DB, trace events) — a per-minute log is the wrong observability mechanism. (Set 2026-06-14, scheduler in-flight skip v0.26.1: first instinct was to downgrade the `console.warn` to `console.log`; Kevin: "tu ne vas pas faire un bip toutes les minutes pour toutes les campagnes, pour tous les clients… ça n'a aucun sens" — the log was deleted, not downgraded.)

## Two distinct "goal" concepts — `activeGoalId` (attribution) vs `campaigns.goal` (pacing). Do NOT conflate.

- **`activeGoalId`** (text, nullable) is an OPAQUE attribution id, threaded downstream as the `x-active-goal-id` header and returned on reads. It **never drives pacing** — no gate-check, workflow pick, or audience selection reads it.
- **`campaigns.goal`** (nullable — added Campaign v2, migration 0039) is the campaign's OWN optimization goal and IS the pacing lever. At `/start-run` and in the scheduler's workflow greedy pick, the runtime goal is `campaign.goal ?? brandRuntimeContext.currentGoal` — the campaign's own goal overrides the brand's `currentGoal` when set, else inherits it (NULL). Exposed on reads + `/start-run`, so display and runtime agree.
- The brief for Campaign v2 asserted "per-campaign goal runtime is already implemented" — it was NOT. Before 0039, ALL pacing used the brand `currentGoal`; there was no per-campaign goal override. If a future task claims per-campaign goal already paces, verify against `runtimeGoal` resolution in `src/routes/internal.ts` /start-run, not the presence of `activeGoalId`. (Set 2026-07-17, Campaign v2 PR #276.)

## The goal is an OPAQUE STRING — this service does NOT own the goal vocabulary, and must never re-introduce an enum for it

`RuntimeGoal` is `string` (`src/lib/brand-runtime-client.ts`) and `RuntimeGoalSchema` is `z.string().min(1)` (`src/schemas.ts`). Not an oversight — a deliberate removal of `z.enum(["signup","meetingBooked","purchase"])`.

Two services own this concept and neither is this one: **brand-service** owns which goals a brand authorizes (its `brands.current_goal` check constraint already permits `websiteVisit`, `positiveReply`, `whatsappConversation`, `combinedSales` on top of the three we had names for), and **features-service** owns the spelling — it normalises every fleet spelling and returns **400 on a goal it cannot resolve**, which is the fail-loud boundary. campaign-service only carries the value from one to the other.

The enum was never a real constraint, and that is the point: **the brand-goal path never passed through it.** `fetchBrandRuntimeContext` returns `await res.json() as BrandRuntimeContext` — a bare cast, no Zod — so a brand set to `combinedSales` already flowed end-to-end untouched. The enum only capped what a CALLER could ask for on `campaign.goal`, i.e. it made the brand's own goal unrepresentable per-campaign while the brand-level path carried it fine.

**Non-empty is the one rule that stays, and it is fail-loud, not taste**: features-service reads an ABSENT goal as "default to meeting-booked", so `""` would forward as a silent default instead of an error. Never relax `.min(1)`.

Forward the value VERBATIM. Do not map, alias, collapse or "normalise" a goal on the way through — features-service ranks workflows and audiences on the goal it is given, so rewriting one silently returns a different outcome's winner. (Related trap, dashboard side: `runtimeGoalForOptimizationGoal` in distribute.you squashes 8 brand goals into the old 3 — lossy, and currently uncalled. Do not mirror that mapping here.)

(Set 2026-07-31, T1 of the per-run goal arbitration.)

## Per-brand configuration is per (org, brand) — every brand-service read NAMES the org

A `brands` row is a shared global identity: any org claiming the same domain gets the same
brand id. Everything a customer configures on top of it — the goal, the confirmed profile
fields, the sales economics, the funnels, the click destination — belongs to the **(org,
brand)** pair, not to the brand. So "the runtime context of brand X" has no single answer.

brand-service resolves the org from **`x-org-id`**: that header when sent, else the single
claiming org when exactly one exists, else `400 ORG_REQUIRED`. 21 production brands are
claimed by more than one org.

`fetchBrandRuntimeContext` (`src/lib/brand-runtime-client.ts`) — this service's ONLY
brand-service read — therefore treats `identity.orgId` as **load-bearing, not tracking**,
and throws before the call when it is missing rather than let brand-service pick an org for
us. The org is always the CAMPAIGN's org (`req.orgId` / `campaign.orgId`) on all three legs:
`/start-run`, the `/end-run` stop-guard, and the scheduler's trigger. A stand-in org would be
the cross-org read this scoping closes. Pinned by `tests/unit/brand-runtime-client.test.ts`
(header on the wire) plus per-leg identity assertions in the scheduler + internal-routes
tests, so the header cannot be dropped silently by a refactor of the shared header builder.

Billing's `/internal/brands/:id/daily-budget` reads (`gate-check.ts`,
`transactional-email.ts`) are a different service and already carry `x-org-id` too.
(Set 2026-08-01.)

## The GOAL is arbitrated by features-service — three levers, and we deduce none of them

`GET /features/:slug/goal-arbitration?brandId=` answers, in ONE call: which of the goals the brand AUTHORIZES returns the most per dollar, that goal's best workflow, and the pairing's audience rows. `fetchGoalArbitration` consumes it and the two decision points take their share:

```
TRIGGER   (scheduler)  : elected goal → its elected workflow           ← greedy, features-owned
START-RUN (internal.ts): elected goal → Thompson over the pairing rows ← explore, ours
```

**Why the ranking is not ours to do.** A cost-per-outcome is denominated in each goal's OWN outcome — a click, a reply, a booked meeting — so comparing two goals' cost-per-outcome compares two different things. Only features-service can normalise each goal through its own funnel to the same terminal unit (a paying client's lifetime revenue). Ranking goals here would mean re-deriving their economics. Do NOT add a consumer-side argmin over per-goal calls.

**Both legs elect the SAME goal without threading anything through the DAG.** features-service's election is deterministic (argmax return-per-dollar, canonical tie-break) and both calls hit the same shared evidence snapshot, so the trigger and `/start-run` converge on their own. The elected goal is NOT persisted on the campaign row — it is a per-run decision, not config.

**The rows come back in the SAME `ProjectionRow` shape as `/workflow-projection`** (features-service serves them that way on purpose), so the audience bandit parses them unchanged — `normalizeProjectionRows` is shared by both fetchers precisely so the bandit cannot behave differently depending on which endpoint fed it.

**A campaign that states its OWN `campaign.goal` is NEVER arbitrated.** That is a manual override the customer set on purpose; arbitration only fills the inherit (NULL) case.

**Snapshot drift at `/start-run`**: if the elected workflow is not the DAG actually running (the shared snapshot rolled between trigger and start-run), keep the elected GOAL but re-read the rows for the workflow that IS running. Never Thompson-pick an audience from another workflow's rows.

**Fail-soft, and SILENT on the expected path.** Any arbitration failure → fall back to `campaign.goal ?? brand.currentGoal` and the existing workflow greedy, i.e. exactly the pre-arbitration behaviour: a selection optimization must never block a run. features-service 502s with `reason: "authorized_goals_unavailable"` for as long as brand-service has not declared the brand's authorized set — that is THEIR fail-loud, but for US it is an expected business state that fires on every tick for every campaign of every client, so it is **not logged at all** (per the log-discipline section above). Any OTHER failure still warns. Do not "fix" that silence into a warn.

`hasServeableAudience` (the `/end-run` stop-guard) deliberately does NOT arbitrate: audience membership is goal-independent (every active audience is enumerated per dynasty whatever the goal), so it returns the same set, and if that ever stopped holding the guard would see a SUPERSET — the safe direction for a fail-safe stop.

STILL TO DO (T4b, gated on brand-service declaring the authorized set): `findOrCreate` a campaign per `(org, brand, feature, goal)` so the elected goal selects WHICH campaign runs, which moves the scheduler's claim grain from campaign to brand. Three known snags: `brandIds` is a `text[]` (no unique index can span it), `uniq_campaigns_org_name` forces a deterministic generated name, and the lazy create must be `INSERT ... ON CONFLICT DO NOTHING` then `SELECT`. (Set 2026-07-31, T4a.)

The per-campaign audience SUBSET (`campaigns.audience_ids`, Campaign v2) is a HARD filter on the audience bandit (`requiredAudienceIds` in `selectAudienceFromProjection`): a campaign never contacts an audience outside its targeted subset (no fallback). NULL/empty → inherit the brand's full active audience set. (The old workflow-conditioning `eligibleAudienceIds` soft-filter was REMOVED in v0.44.1 — see the single-endpoint note below.) Distinct from the singular `audienceId` column (per-campaign attribution; the per-RUN chosen audience is re-selected fresh at /start-run).

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

**`db:push` HANGS on a column RENAME against an existing `campaign_test`.** drizzle-kit `push` can't tell a rename from a drop+create, so it prompts interactively ("is `audience_id` a rename of `customer_profile_id`?") — in a non-interactive/background shell it blocks forever (produces 0B output, never exits). When a schema change RENAMES a column, don't rely on `db:push` to materialize it on the test DB: apply the `ALTER TABLE … RENAME COLUMN` directly (`psql postgresql://test:test@localhost/campaign_test -c '…'`), mirroring the prod migration. `db:push` is still fine for additive changes (new column/table). (Set 2026-06-20, customer_profile_id → audience_id rename.)

**`db:generate` is DEAD in this repo — migrations are HAND-AUTHORED idempotent SQL, do NOT try drizzle-kit generate.** The `drizzle/meta/` snapshots froze at `0023_snapshot.json`; every migration `0024+` was hand-written without updating the snapshot. So `drizzle-kit generate` diffs `schema.ts` against the stale `0023` snapshot and prompts interactively for ~12 migrations' worth of phantom rename/create decisions (e.g. "is `parent_run_id` a rename of `workflow_name`?") — it can never emit a clean single-change migration. When a brief says "generate with drizzle-kit," ignore it for this repo. **To author a new migration: (1) hand-write `drizzle/NNNN_<desc>.sql` mirroring the latest one's boot-safe idempotent style** — `ALTER TABLE … DROP COLUMN IF EXISTS` (see `0036`) or a `DO $$ … information_schema … IF EXISTS` guard for renames (see `0035`); **(2) append a journal entry** to `drizzle/meta/_journal.json` with the next sequential `idx`, the matching `tag`, and a synthetic `when` (prior cadence: +100000000 ms per migration). `src/lib/migrations-validator.ts` enforces journal↔sql parity + gap-free sequential `idx` + no dup idx/tag, so both files must be added together. Boot runs `migrate(db, { migrationsFolder: "./drizzle" })`; idempotent guards make every migration re-runnable. (Set 2026-06-20, customer_persona_id DROP / migration 0036.)

## Raw-`sql` list params need `sql.join`, NOT a bare JS array — and workflow dynasties live in the DB, not src

**Interpolating a JS array into a drizzle raw `sql` template does NOT expand it into a param list.** `sql\`... IN (${arr})\`` binds the whole array as ONE composite → `operator does not exist: text = record`; `= ANY(${arr})` → `op ANY/ALL (array) requires array on right side`. Neither works. To expand a small in-code list (e.g. the sales-outreach feature family in `brand-pause.ts notPausedBrandClause`), use `sql.join([...set].map((v) => sql\`${v}\`), sql\`, \`)` inside `IN (...)`. Caught only by the integration tests (unit tests mock the DB), so run `pnpm test:integration` after any raw-`sql` list change. (Set 2026-07-24, sales-crm feature-family pause clause.)

**Workflow dynasties/slugs are DB-resident (workflow-service `workflows` table), NOT seeded in workflow-service `src`.** To answer "does feature X have a workflow dynasty / which slugs exist / has it ever run," query the workflow-service Neon DB (`workflows` grouped by `feature_slug, workflow_dynasty_slug`; runs via `workflow_runs`), do NOT `git grep` workflow-service src — a src grep returns only test fixtures and misses every real dynasty. Cost 2026-07-24: grepped workflow-service src, wrongly concluded `sales-crm-email-outreach` had no dynasty (blocking a plan); the DB showed 5 active CRM dynasties seeded the day before. features-service also cannot resolve "which feature is a brand on" — all 31 of its endpoints take `featureSlug` as INPUT; the feature identity comes from the caller (`x-feature-slug`), never from features-service.

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

## Campaign status enum — a RUNNING campaign is `ongoing`, NOT `active`

`campaigns.status` uses **`ongoing`** for a live/running campaign and **`stopped`** for a halted one. There is NO `active` value. When diagnosing "which campaigns are running / did I stop them all", filter `status='ongoing'` — a query on `status='active'` returns EMPTY and falsely reads as "nothing is running". The scheduler's `reRunDueCampaigns` claims rows where `status='ongoing' AND nextRunAt <= now()`. (Set 2026-07-07: first diagnostic pass filtered `active`, wrongly reported all campaigns stopped while 9 were `ongoing`.)

## `/end-run` `stopCampaign=true` is AUDIENCE-scoped, NOT campaign-scoped — never blindly set `status='stopped'` on it

The workflow DAG sends `stopCampaign=true` whenever a run's SINGLE bandit-picked audience returns no leads (`fetch-lead.found == false`) — it's a **hardcoded literal on the `end-run-no-lead` DAG node** (`stopCampaign == !found`), evaluated on the ONE audience `/start-run` chose for that run. It does NOT mean "the whole campaign is done": the bandit narrows each run to one audience, so one audience running dry says nothing about the campaign's OTHER audiences. Obeying it literally (the old `status='stopped'` on any `stopCampaign=true`) wrongly halted multi-audience campaigns the instant their one exhausted audience got picked, while other audiences still had tens of thousands of reachable leads (prod incident brand `75d7e3e8`, 2026-07-21: stopped at 14:01 on audience `729e06f0` while 7 others were `exhausted=false`).

So `/end-run` REINTERPRETS `stopCampaign=true` as audience-scoped: it marks `req.audienceId` exhausted in **`campaign_audience_exhaustion`** (migration 0040) and auto-stops the campaign ONLY when `hasServeableAudience()` finds no serveable, non-exhausted audience left (all targeted audiences exhausted = the sole legitimate campaign-wide stop). Otherwise it falls through to the normal reschedule so the next tick re-draws from the remaining audiences. The bandit (`selectAudienceForRun`) takes `excludedAudienceIds` and `/start-run` passes the fresh exhausted set so it never re-picks a known-dry audience. **Fail-SAFE**: any error in the exhaustion check does NOT stop the campaign (a false stop is the exact bug this fixes). The exhaustion mark expires after a **24h TTL** (`getFreshExhaustedAudienceIds`) — audiences are re-probed daily because Apollo can add new matching leads over time, so exhaustion is never permanent. The `done`/exhaustion signals from apollo/human/lead-service are all HONEST and per-audience; the campaign-wide escalation was purely the DAG's literal + campaign-service obeying it. Do NOT move the stop decision back into a blanket `stopCampaign=true → stopped`. (Set 2026-07-21, PR #281.)

At that all-audiences-exhausted auto-stop point (and ONLY there) `/end-run` also fires a **fire-and-forget extend-audience lifecycle email** (`maybeSendExtendAudienceEmail`, `src/lib/transactional-email.ts`) nudging the user to extend an audience so outreach can resume. It sends via **transactional-email-service** (`POST /send`, eventType `audience_fully_contacted`; template registered at boot via `PUT /platform-templates`) ONLY when ALL hold: sales-cold-email-outreach feature, `campaign.createdByUserId` present (recipient), brand not paused, a daily budget `> 0` (campaign `dailyBudgetCents` else the brand's billing daily budget), and org `has_auto_topup` (billing `GET /internal/accounts/by-org/{orgId}/balance`, user-less). The **1×/month-per-brand cap is owned by transactional-email dedup** (its `audience_fully_contacted` monthly-per-brand cadence), NOT a local table. Every guard read is **fail-SAFE** (any error/absent field → treat as OFF → no email) and the whole call is fire-and-forget after the response, so it NEVER blocks or fails run finalization. When refactoring `/end-run`, keep this call at the exhausted-stop branch — do not drop it. (Set 2026-07-22, PR #292.)

## Scheduler in-flight guard — check ANY live run for the campaign, never the campaign-service marker

The `campaign-service / <campaignId>` parent run (created by the workflow DAG's start-run) is an **ephemeral ~2s marker** — `start-run → end-run` within seconds — NOT an enclosing span. The genuinely-long work (lead-service `buffer/next`, observed up to **755s**) runs in a separate `lead-service / lead-serve` run that is **not linked** under the marker via `parent_run_id`. So `src/lib/scheduler.ts`'s "is a flow still alive?" check MUST query `listRuns` scoped to **`campaignId` + `status=running` + `startedAfter=freshnessCutoff`** (any service) via `hasLiveRunForCampaign()` — **never** `(serviceName="campaign-service", taskName=campaignId)`, which only sees the 2s corpse and re-fires mid-fill → `lead-service` `409 Concurrent buffer/next` storm. `STUCK_RUN_FRESHNESS_THRESHOLD_MS` must stay **strictly greater than** lead-service's max fill (`PULL_NEXT_TIMEOUT` 600s; observed 755s) — currently 15min. `reRunDueCampaigns` and `claimStuckCampaigns` MUST share the same helper. (Set 2026-06-13, v0.25.1 / DIS-277.)

## Execution run tree + audience attribution — propagate forward from /start-run, do NOT root-stamp

Verified prod shape of one execution's run tree (single common ancestor):
```
workflow / execute-workflow      ← ROOT (created by workflow-service at /execute)
 ├─ campaign-service / <campaignId>   (the ~2s marker, parent = execute-workflow)
 └─ lead-service / lead-serve         (the expensive work, parent = execute-workflow)
```
The marker and `lead-serve` are **siblings** — both chain to the `execute-workflow` root. (`lead-serve` is "not linked under the **marker**" per the scheduler note above, but it IS chained to the **root**.) So the per-execution attribution anchor is the `execute-workflow` root, NOT campaign-service's marker — stamping the marker would NOT attribute `lead-serve` (the bulk of spend) via inheritance.

**Audience attribution is FORWARD-PROPAGATED, not root-stamped.** The priority audience (`audience.id` — a human-service saved-filter-set UUID; == the persona/profile id returned by features-service `persona-stats`) is **re-decided every run** inside `/start-run` (`fetchBestCustomerPersona`), which runs AFTER the root is created. So `/start-run`: (1) selects the audience BEFORE `createRun`, stamps `x-audience-id` on its own marker run; (2) returns top-level `audienceId` on its response. workflow-service reads that `audienceId` and threads `x-audience-id` into every downstream node call (`lead-serve`, email, …); runs-service stores `audience_id` per run + cost and exposes `groupBy=audienceId`. Header is byte-equal `x-audience-id` across campaign/workflow/runs services. `customerProfileId`/`x-customer-profile-id` is the deprecated alias for the SAME id — do not use for new work. (Set 2026-06-20, campaign-service#204 + workflow-service#307 + runs-service#154.)

## Per-run selection: GREEDY workflow + Thompson audience — both from `/workflow-projection` alone. Two levers, two decision points.

**Feature scope (2026-07-07): workflow rotation is ENABLED ONLY for `sales-cold-email-outreach`.** `resolveWorkflowSlugForTrigger` gates on `isWorkflowRotationEnabled(featureSlug)` (allowlist `WORKFLOW_ROTATION_FEATURE_SLUGS` in `features-workflow-projection-client.ts`); any other feature (pr-expert-quote-outreach, pr-expert-quote-opportunities, hiring/vc/pr cold-email, etc.) returns `campaign.workflowSlug` immediately — no features-service call, no greedy pick, same workflow every run. The GREEDY-vs-Thompson description below applies to the sales-cold-email-outreach path; for every other feature the workflow leg is a no-op passthrough. (Kevin: "restreint la rotation à la feature sales cold email outreach".)

The campaign picks, per run, WHICH audience to contact and WHICH workflow to run. **The two legs use DIFFERENT policies — that asymmetry is intentional** (`src/lib/bandit.ts` holds both):
- **Workflow leg = GREEDY (exploit-only).** `greedyArgminCost` — score each workflow by its EXPECTED cost-per-success using the posterior MEAN rate `(successes+1)/(trials+2)`, pick `argmin(costPerTrial / meanRate)` deterministically. No exploration: the campaign always runs its current best workflow. (Was Thompson until 2026-06-23; Kevin asked to "take the max instead of a random Thompson".) Cold workflows score at the prior mean 0.5; ties → first index. Do NOT revert to "take features-service rank #1" — greedy over the SAME evidence is the equivalent honest pick; rank-#1 ignores the cost lever.
- **Audience leg = Thompson (still explores), scored on the chosen workflow's rows.** `thompsonArgminCost` samples `Beta(successes+1, trials−successes+1)` per arm, picks `argmin(costPerTrial / sampledRate)` — keeps exploring so no audience stays shadowed. The candidate SET is the chosen workflow's audience rows from `/workflow-projection`, which (features-service#638, 2026-07-22) enumerate EVERY active audience of the brand per dynasty (floored to brand/crossOrg when an audience never ran that workflow → a COLD arm that still gets explored). A never-run audience is NOT dropped; it is a cold arm.

**Cardinality (verified prod): 1 `/execute` = 1 start-run = 1 `lead-serve`.** The DAG does NOT loop start-run; each run is a brand-new `/execute` (scheduler `/end-run` → `nextRunAt` → next tick re-executes). So "vary the workflow per run" = pass a different slug to the NEXT execute — never a mid-flight DAG switch.

**The two levers live at DIFFERENT code points, and that split is load-bearing:**
- **Workflow** is chosen at the TRIGGER (`scheduler.ts reRunDueCampaigns`, before `executeCampaignWorkflow`) because the workflow is the DAG identity in the `/execute` URL — start-run is too late (the DAG is already running). `resolveWorkflowSlugForTrigger` greedy-picks (`selectWorkflowGreedy`) over features-service `/workflow-projection` `rows[]` (per-workflow evidence; ranks on `row.resolved.costPerOutcomeUsd`). **Fail-soft**: falls back to `campaign.workflowSlug` when there's no evidence or features-service is down — a selection optimization must never block a run. Only `reRunDueCampaigns` triggers (not `claimStuckCampaigns`); campaign create/activate keep the configured slug for the seed run, the scheduler varies it from run 2.
- **Audience** is chosen at `/start-run` (`selectAudienceFromProjection` Thompson over `/workflow-projection` rows for the run's chosen workflow `req.workflowSlug`) because workflow-service threads `x-audience-id` to downstream nodes from **start-run's RESPONSE** (`results.startRun.audienceId` in `dag-to-openflow.ts`), NOT from the execute input. start-run MUST keep returning `audienceId`. **Single-endpoint (2026-07-22, v0.44.1)**: campaign-service consumes `/workflow-projection` ALONE — one fetch supplies BOTH the workflow greedy pick AND every active audience's per-workflow send-tagged evidence. **`/audience-stats` is no longer consumed** and the old `eligibleAudienceIds` soft-filter (via a removed `audienceIdsForWorkflow`) is gone. Selection filters the rows to the chosen dynasty; if that dynasty has no rows (cold/fallback slug) it falls back to one row per audience across all workflows. `requiredAudienceIds` (hard subset) + `excludedAudienceIds` (fresh-exhausted) apply, no fallback → empty = null. **Fail-soft**: any features-service error → `audienceId=null` for the run (the run still proceeds + reschedules). The full audience object (filters) is NOT passed downstream — lead-service resolves filters from human-service by `x-audience-id`, workflow-service reads only `audienceId` (verified: no consumer in workflow / lead / content-generation / chat reads `searchParams.audience`).

**Downstream honors the choice — already correct, don't rebuild:** lead-service `buffer/next` uses the passed `x-audience-id` and does NOT re-select; human-service suppression is **per-brand atomic, cross-audience** (the serve cursor is per-audience) so overlapping audiences never double-contact. `workflowSlug == workflowDynastySlug` (v1) so the projection row's dynasty slug is executable by `/by-slug/{slug}/execute`.

**Per-workflow outcome tagging + full active-audience enumeration SHIPPED (features-service#638, prod v0.101.2, 2026-07-22).** The projection audience grain is now per `(audienceId × workflowDynastySlug)`, send-tagged (real per-workflow outcomes — the old "byte-identical to `/audience-stats`, same across couples" caveat is DEAD), AND the handler emits a row for EVERY active audience × every active dynasty (audiences with no couple floor brand→crossOrg via the cascade). This is what enables the single-endpoint audience Thompson above: the chosen workflow's rows already ARE the brand's active-audience candidate set with workflow-discriminated evidence, so campaign-service needs no separate `/audience-stats` call. Coverage is forward-only (send-tags from workflow-service#333 / email-gateway#168-170); the cascade floors history.

**Endpoint migration (2026-07-06):** features-service DELETED `/features/:slug/candidates` and folded its evidence into the reshaped `GET /features/:slug/workflow-projection` (`rows[]` grain-ladder + `resolved`). campaign-service reads `rows[]`, ranks on `row.resolved.costPerOutcomeUsd`, scopes audiences via `row.audienceId`. Client: `src/lib/features-workflow-projection-client.ts` (was `features-candidates-client.ts`). Sends `brandId` + `goal` only (brandProfileId dropped — the new endpoint derives economics from brandId).

**Spin deadlock fixed by the single-endpoint move (v0.44.1, 2026-07-22).** BEFORE: the workflow-conditioning soft-filter narrowed the audience candidate set (from `/audience-stats`) to the audiences that had RUN the chosen workflow. When the greedy workflow locked onto a dynasty whose only run-attributed audience was exhausted (prod brand `75d7e3e8`, workflow `granite` → sole audience `729e06f0`, exhausted), the soft-filter collapsed the set to that one exhausted audience, then the exhaustion exclusion emptied it → `/start-run` picked NO audience (`audience_id` NULL) → empty `lead-serve` → ~20s spin, while the stop-guard `hasServeableAudience` (which used a DIFFERENT, unscoped eligibility) saw the brand's OTHER active audiences and refused to stop. The two legs used mismatched eligibility, so they never agreed. The producer-side enumeration fix (features#638) + the consumer-side single-endpoint move (this repo) both close it: the chosen workflow's rows now include every active audience, so exhausting one leaves the others serveable and `selectAudienceFromProjection` picks among them. Do NOT reintroduce a workflow-scoped candidate filter that can collapse to a subset the stop-guard doesn't see.
