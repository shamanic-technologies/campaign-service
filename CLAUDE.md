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
- **`campaigns.goal`** (nullable) is LEGACY and READ-ONLY since 2026-08-12. It is still SERVED wherever
  it is stored (the dashboard reads it on three surfaces and migrates next) and the column is
  **scheduled for removal** — but nothing writes it: it is absent from the create/update bodies and
  from every insert/update payload, pinned by `tests/unit/no-legacy.test.ts`. It is NOT a pacing
  lever any more: a campaign says what it sells with its **sales funnel** (`funnelKey`), which is
  what pricing, arbitration and provisioning all read. A goal is still consulted for exactly ONE
  case — a campaign that states NO funnel, i.e. a feature that sells through no sales funnel (PR,
  hiring, VC, AI-visibility) — and then it is the BRAND's `currentGoal`, never the column.

## The goal is an OPAQUE STRING — this service does NOT own the goal vocabulary, and must never re-introduce an enum for it

`RuntimeGoal` is `string` (`src/lib/brand-runtime-client.ts`) and `RuntimeGoalSchema` is `z.string().min(1)` (`src/schemas.ts`). Not an oversight — a deliberate removal of `z.enum(["signup","meetingBooked","purchase"])`.

Two services own this concept and neither is this one: **brand-service** owns which goals a brand authorizes (its `brands.current_goal` check constraint already permits `websiteVisit`, `positiveReply`, `whatsappConversation`, `combinedSales` on top of the three we had names for), and **features-service** owns the spelling — it normalises every fleet spelling and returns **400 on a goal it cannot resolve**, which is the fail-loud boundary. campaign-service only carries the value from one to the other.

**The goal→funnel map and the funnel→goal alias are DELETED (2026-08-12), not moved.** A campaign
states its funnel; nothing derives one word from the other in either direction, and
`tests/unit/no-legacy.test.ts` fails if `funnelForGoal` / `goalForFunnel` / `readBrandGoal` /
`resolveCampaignFunnelKey` reappear. The only goal read left anywhere is the brand's `currentGoal`
on `/runtime-context`, consulted for a campaign that states no funnel — brand-service still serves
it, and features-service still needs one word or the other (an ABSENT goal is a silent
"meeting-booked" default there, so `fetchWorkflowProjectionRows` THROWS when given neither).

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

**Since 2026-08-12 arbitration answers ONLY for a campaign that states NO funnel.** A campaign that
states one is priced on that funnel (`?funnel=` on `/workflow-projection`, which WINS over `goal`
there and is the only word separating the two meeting funnels), and which funnel runs is the
customer's funding decision, not a cost ranking. The gate on that is `campaign.funnelKey`, not the
legacy `campaign.goal`, which nothing writes any more.

**Why the ranking is not ours to do.** A cost-per-outcome is denominated in each goal's OWN outcome — a click, a reply, a booked meeting — so comparing two goals' cost-per-outcome compares two different things. Only features-service can normalise each goal through its own funnel to the same terminal unit (a paying client's lifetime revenue). Ranking goals here would mean re-deriving their economics. Do NOT add a consumer-side argmin over per-goal calls.

**Both legs elect the SAME goal without threading anything through the DAG.** features-service's election is deterministic (argmax return-per-dollar, canonical tie-break) and both calls hit the same shared evidence snapshot, so the trigger and `/start-run` converge on their own. The elected goal is NOT persisted on the campaign row — it is a per-run decision, not config.

**The rows come back in the SAME `ProjectionRow` shape as `/workflow-projection`** (features-service serves them that way on purpose), so the audience bandit parses them unchanged — `normalizeProjectionRows` is shared by both fetchers precisely so the bandit cannot behave differently depending on which endpoint fed it.

**A campaign that states its OWN `campaign.goal` is NEVER arbitrated.** That is a manual override the customer set on purpose; arbitration only fills the inherit (NULL) case.

**Snapshot drift at `/start-run`**: if the elected workflow is not the DAG actually running (the shared snapshot rolled between trigger and start-run), keep the elected GOAL but re-read the rows for the workflow that IS running. Never Thompson-pick an audience from another workflow's rows.

**Fail-soft, and SILENT on the expected path.** Any arbitration failure → fall back to `campaign.goal ?? brand.currentGoal` and the existing workflow greedy, i.e. exactly the pre-arbitration behaviour: a selection optimization must never block a run. features-service 502s with `reason: "authorized_goals_unavailable"` for as long as brand-service has not declared the brand's authorized set — that is THEIR fail-loud, but for US it is an expected business state that fires on every tick for every campaign of every client, so it is **not logged at all** (per the log-discipline section above). Any OTHER failure still warns. Do not "fix" that silence into a warn.

`hasServeableAudience` (the `/end-run` stop-guard) deliberately does NOT arbitrate: audience membership is goal-independent (every active audience is enumerated per dynasty whatever the goal), so it returns the same set, and if that ever stopped holding the guard would see a SUPERSET — the safe direction for a fail-safe stop.

**Arbitration now only decides for a brand with ONE pot.** A customer who funds each sales funnel separately has decided which funnels run — see the per-funnel section below. A funnel campaign carries the funnel's own goal, so it is a stated-goal campaign and is never arbitrated. (Set 2026-07-31, T4a; scoped 2026-08-02.)

## A test that pins FROZEN history against a GROWING constant fails the day the constant grows

`tests/unit/funnel-owner-decision.test.ts` asserted both directions between a shipped migration's
SQL and `SALES_OUTREACH_FEATURE_SLUGS`: every slug in the SQL is a sales one (true forever) AND
every sales slug appears in the SQL (true only until the family grows). Adding the second
acquisition channel failed it, on a migration that is correct and can never mention a feature that
did not exist when it ran. Assert the direction that stays true — what the frozen file names is
in-scope — never that a live set is fully covered by it. (Set 2026-08-18.)

## Per (funnel, ACQUISITION CHANNEL) funding — a channel IS a feature slug, and every funded pair runs

A sales funnel can be worked through more than one OFFER at once: the straight sales pitch
(`sales-cold-email-outreach`) and the feedback request
(`feedback-request-cold-email-outreach`), which asks a buyer about the problem we solve
instead of pitching. Same infrastructure, same measurement — only the offer differs, so a brand can
work ONE funnel through BOTH, and each is a campaign of its own.

- **A CHANNEL IS A FEATURES-SERVICE FEATURE SLUG.** There is no channel table, enum or vocabulary
  in this service and none is to be introduced. Adding a further channel is one line in
  `SALES_OUTREACH_FEATURE_SLUGS` (`src/lib/sales-outreach-campaign.ts`) plus its
  `CHANNEL_BY_FEATURE` token — a second offer on the same medium needs its OWN channel token
  (`feedback_request_email`, not `cold_email`), or the two campaigns of one funnel would collide on
  the identity index and only one could exist.
- **One campaign per funded (funnel, channel) PAIR.** billing serves the pair ceiling ADDITIVELY on
  the same read (`channels: [{funnelKey, featureSlug, dailyBudgetCents}]`, `funnels` being its
  per-funnel SUM), so nothing here adds anything up. `fundedPairs` provisions off `channels` when
  billing states any and off `funnels` × the seed's channel when it does not — that fallback is
  what keeps a brand funding one channel per funnel, i.e. every brand today, byte-identical.
- **The ceiling that binds a campaign is its OWN pair's** (`channelCeilingCents`), inserted at one
  place in gate-check's precedence and one in `campaign-funding`: own `dailyBudgetCents` → PAIR
  ceiling → funnel ceiling → brand pot. Ranking two channels of one funnel against the funnel TOTAL
  is how one offer spends the money the other was funded for, and it shows up in no log at all.
  A funnel SPLIT across channels that does not fund this campaign's channel is UNFUNDED — never a
  fallback to the funnel or brand figure.
- **A funnel funded through exactly ONE channel binds whatever feature the campaign states.** That
  mirrors billing's own rule for a write naming no channel, and it is load-bearing: billing's
  migration attributed some brands' single ceiling to the DEFAULT channel while their campaign runs
  another sales feature, and holding those would break a brand that has funded one channel per
  funnel all along.
- **THE PROVISIONING PATH STATES A FULL IDENTITY, RUN ID INCLUDED — its two channel reads are
  REFUSED without one.** features-service `GET /features/{slug}` answers `400 Missing required
  headers: x-run-id` and workflow-service `GET /workflows` answers `400 x-org-id, x-user-id, and
  x-run-id headers are required`, whatever the caller is doing. The provisioning identity is built
  from a CAMPAIGN ROW, which carries no run, so both reads were rejected on every sweep and both
  rejections were laundered into "unknown" and skipped: per-channel funding never worked once in
  production (brand `75d7e3e8` funded the feedback-request channel on 19 Aug and had no campaign
  for it nineteen hours later, with nothing in the logs about any of it). The brand-service read on
  the same path answers 200 without a run id, which is why only this half was dead and why it
  looked like nothing at all. `buildProvisioningIdentity` (`src/lib/provisioning-identity.ts`)
  establishes the campaign's own ancestor via `ensureCampaignRunId` — a run runs-service can
  resolve, never a minted uuid — and `ProvisioningIdentity` makes `userId` and `runId` REQUIRED so
  the two clients cannot go back to attaching them when they happen to have them.
  `tests/unit/no-legacy.test.ts` fails on a conditional identity header in either client.
- **A pair passed over because a statement could not be READ says so, naming the pair.** "This
  channel sells no such funnel" and "features-service would not answer" are different answers and
  are returned as different ones (`FeatureSalesFunnelsRead` / `ActiveWorkflowRead`, both
  `{ok:false, detail}` on a failure). A pair the customer is paying for that we FAILED to evaluate
  is not a pair we evaluated and rejected, and collapsing the two is what let a read that was
  rejected on every sweep look exactly like a channel with no dynasty. Skipping stays correct;
  only the silence was wrong. Fail-SOFT still: an unreadable statement provisions nothing and does
  NOT hold the brand — this decides which questions can be asked, not whether money may be spent.
- **Which funnels a channel may be SOLD THROUGH is features-service's statement, asked per feature**
  (`GET /features/{slug}` → `salesFunnels`, `src/lib/feature-sales-funnels-client.ts`). The feedback
  request states `sales_meetings_from_conversation` alone: its offer buys a CONVERSATION, and the
  other three chains buy their first step with a website click it has no way to sell. A funded pair
  the feature may not sell gets NO campaign, the same way a funnel billing funds but brand-service
  does not declare gets none. An unreadable statement provisions nothing for that channel — a pair
  is never guessed at. `tests/unit/no-legacy.test.ts` fails if a feature slug and a funnel key ever
  appear on one line of code outside the client that ASKS: a local matrix is a second copy of one
  product fact, drifting the day a channel gains or loses a chain.
- **A workflow belongs to a FEATURE, so a new channel's campaign is given its own** (workflow-service
  `GET /workflows?featureSlug=&status=active`). The seed campaign's slug is only right for the
  seed's own channel; handing it to another offer runs the wrong DAG, and a slug of no feature at
  all is refused by workflow-service — a campaign that stays ongoing and produces nothing forever.
  A channel with NO active workflow is not provisioned (fail-closed); the next sweep stands it up
  the moment the dynasty ships.
- **A feature slug RENAMED upstream must be renamed here the same day, and it is renamed in ONE
  spelling.** `CHANNEL_BY_FEATURE` is total by construction — an unrecognised slug falls through to
  `featureSlug.replace(/-/g, "_")` — which is right for a feature nobody has named a token for and
  WRONG for one that was renamed: the campaign is filed under a channel nothing else uses, silently,
  with no error anywhere and no failing test, and it collides with nothing so the identity index
  never complains. So the total-by-construction default is exactly what makes an upstream rename
  invisible, and the map is not the only site: the family constant, the docs and every fixture
  carry the literal. Never accept both spellings, alias them or normalise one onto the other — a
  translation table is what this service keeps deleting, and two names for one channel is how a
  brand grows two identities for one offer. (`sales-feedback-request-cold-email-outreach` →
  `feedback-request-cold-email-outreach`, 2026-08-18.)
- Everything below — the turn-taking, the fail-closed hold, the per-brand serialization, which
  stopped campaigns funding may resume — is UNCHANGED and applies per campaign, so it applies per
  pair without a special case. (Set 2026-08-18.)

## Per-funnel funding: every funded funnel runs, each paced on its OWN ceiling

billing-service lets a customer fund each of a brand's SALES FUNNELS separately. Its brand-level
`GET /internal/brands/:id/daily-budget` still answers the SUM, so nothing reading the brand total
changes — but "which funnel is best by ROI, run that one" is no longer the right question. Both
funded funnels get worked, each spending up to its own ceiling and stopping there.

- **One campaign per funded funnel** (`campaigns.funnel_key`, migration 0041). The cost ledger is
  already keyed on campaignId, so a funnel's spend today IS its campaign's spend today — no new
  attribution dimension. Reconciled by the scheduler (`src/lib/funnel-campaigns.ts`) from
  billing's `GET /internal/brands/:id/funnel-budgets` ∩ brand-service's
  `GET /internal/brands/:id/sales-funnels`. A funnel billing funds but brand-service does not
  declare ACTIVE is never provisioned.
- **A campaign cannot be CREATED without stating its funnel, so nothing is ever adopted or
  inferred.** `POST /campaigns` 400s a sales-outreach create with no `funnelKey` (and on a token no
  catalogue names); the creator provisions per funded funnel, so it already knows the answer. Every
  other feature sells through no sales funnel and states none. Nothing SEEDS a campaign for a brand
  that has none except the per-funnel step, which provisions one campaign per funded, declared
  funnel (`ensureRunnableSalesOutreachCampaign`, the old un-pause seeder, is DELETED with the
  pause route that called it). The goal-based adoption of a funnel-less incumbent (`findIncumbentForFunnel`, `isRemovableStandIn`)
  is DELETED with the goal vocabulary — provisioning adds, it never re-labels an existing campaign.
- **THE FUNNEL IS THE ONLY WORD. A campaign STATES it, persisted, and a consumer names what the
  campaign buys without a translation table.** The four canonical keys are
  `sales_meetings_from_conversation`, `sales_meetings_from_website`, `website_purchases`,
  `form_magnet`. brand-service retired the goal set and renamed the keys (#434, 2026-08-02): its
  funnel reads carry NO goal, so reading one is what silently stops every funnel campaign being
  provisioned — pinned by `tests/unit/no-legacy.test.ts`. `campaigns.goal` is served as stored and
  never written (see above): it cannot tell the two meeting funnels apart, which is why nothing here
  reads it back and why the column is scheduled for removal.
- **Every spelling in, one canonical token out** — `toFunnelKey` in
  `src/lib/sales-funnel-vocabulary.ts`, the ONE place the vocabulary lives. Load-bearing on THREE
  boundaries, not just history: **billing-service still emits the pre-rename keys today**
  (`reply_meeting`, `visit_meeting`, `visit_signup`, `visit_form`), brand-service emits the
  canonical four, and a campaign row can carry either. Compare raw tokens on any of the three and a
  fully-funded funnel reads as UNFUNDED — the gate blocks it and it silently stops sending. Never
  delete a legacy entry.
- **History was written by four migrations, and no code reads a goal for a funnel any more.** 0042
  wrote the funnel of every campaign stating a goal; 0043 renamed those keys (and the provisioned
  campaign NAME, which carries the same token) to the canonical four; **0047** wrote the last three
  LIVE rows from their (org, brand) pair's DECLARED funnel set, and only where that set names
  exactly one funnel; **0048** wrote the STOPPED ancestors of a live campaign (see below). The boot
  backfill (`src/lib/funnel-backfill.ts`) that read each pair's `currentGoal` is DELETED with the
  map it used. A pair declaring several funnels is left alone rather than guessed at.
- **A STOPPED campaign's funnel is NOT inert history — it decides whose totals its history lands
  in.** 0047 left stopped rows alone on the premise that "a funnel nobody stated for a campaign
  nobody is running changes nothing about what it did". That premise is wrong: features-service
  totals a brand's campaigns into families keyed on (org, brand, funnel, channel), so a stopped
  ancestor carrying NO funnel keys onto a family with no live member — it renders no line at all
  while its runs, spend, leads and replies keep counting at BRAND level. That is the whole gap a
  customer reads between the campaign view and the brand view (prod 2026-08-13, brand 75d7e3e8: 12
  positive replies against 15, $1,246.63 of spend against $2,057.06, the missing $810.43 on 45
  stopped ancestors). **0048** closes it by RULE, not by a list: a stopped row carrying no funnel
  states the funnel of the live campaign of its (org, brand, acquisition channel), and only where
  that triple has EXACTLY ONE live campaign stating one — none, or several, is left alone, and a
  stopped row that already states a funnel is never restated. The partial unique index is on
  `ongoing` rows only, so writing a stopped row can never collide with it. Pinned by
  `tests/integration/stopped-ancestor-funnel-backfill.test.ts`, which applies the file itself to a
  prod-shaped database twice.
- **That rule is an INVARIANT, so it lives on the TICK — a migration can only ever state it once.**
  0048 ran against the fleet of 13 Aug and the bug recurred in nine days, on a brand that was not
  yet eligible: org `d3367008` / brand `b97440f6` / `cold_email` read $53 on the offer and $1.81 on
  the offer's one live campaign, $51.68 of it on an ancestor stating no funnel. The sequence is the
  whole argument — on 13 Aug that ancestor was still LIVE and stated none, so 0048 correctly
  declined it; on 16 Aug the funnel was funded and provisioning INSERTED a twin (a row at
  `funnel_key NULL` can never match `eq(campaigns.funnelKey, …)`); on 19 Aug it stopped, becoming
  eligible the same moment, with nothing left to apply the rule. `adoptFunnellessAncestors`
  (`src/lib/funnel-ancestor-adoption.ts`) now applies it, scoped to one (org, brand, acquisition
  channel), whenever a funnel campaign is provisioned OR confirmed for that triple. Migration
  **0051** is the same rule re-stated for the one row eligible on 20 Aug, and is the last time it is
  written as a migration. Same exclusions, same audit table, same idempotence in both halves;
  `tests/integration/stopped-ancestor-funnel-rerun.test.ts` runs the file and the runtime rule over
  ONE seed and asserts they reach the same verdict on every row, which is what stops the two copies
  drifting. **The call site is collected into `adoptFor` and drained AFTER the loop on purpose**:
  the existing-campaign check returns early with `continue`, so an adoption written inside it would
  never run for a brand whose twin already exists — which is every brand this recurs on. The other
  470 stopped funnel-less rows across 17 brands are NOT backfilled: the rule does not select them
  (no live sibling stating a funnel on their triple), and the runtime half covers each the moment
  its brand funds a funnel again.
- **The live campaign of a (funnel, channel) wins the existing-campaign lookup over a stopped one,
  whatever their creation dates.** Ordering on `created_at` alone answers "the newest row", a
  different question: a stopped ancestor created after the incumbent — or one that only just became
  findable because its funnel was folded onto this identity — is returned instead, and the resume
  branch then brings it back alongside the incumbent. That is a `23505` on the partial unique index,
  thrown INSIDE `planFunnelTurns`, which fail-closes and holds the whole brand every tick, forever,
  for a brand whose campaign is running fine. It appears in no customer-visible state at all.
- **The gate paces on that funnel's own ceiling** (`gate-check.ts`, block a2), fail-CLOSED like
  the brand ceiling. Precedence: campaign's own `dailyBudgetCents` → `funnelKey` ceiling → brand
  daily budget. A funnel funded at ZERO, or absent from billing while the brand funds OTHER
  funnels, blocks (`Funnel not funded`) — it NEVER falls back to the brand total, which would let
  it spend another funnel's money. The ONE case that reads the funnel as a label rather than a
  ceiling: a brand billing reports NO per-funnel ceilings for at all (`funnels: []`) still has one
  pot, so the campaign paces on the brand daily budget exactly as it did before every campaign
  stated a funnel. Without that, stamping the funnel fleet-wide would have blocked every brand
  that never split its budget.
- **Serial, for now: one run in flight per BRAND** (`hasLiveRunForBrand` in funnel-campaigns.ts).
  Running funnels concurrently needs an audit of lead de-duplication and of sending-account load
  that nobody has done. Deleting that one block is what unlocks parallelism; nothing else has to
  be undone.
- **The turn goes to the lowest spent-today ÷ own-ceiling ratio** (`selectLowestFillRatio`),
  never a fixed order and never "the primary first". A fixed order starves whatever sits last —
  if the first funnel can absorb the whole day the others never run, and that shows up in no log
  at all. A funnel at its ceiling yields with no special case (ratio ≥ 1 → not a candidate); all
  funnels full → parked, but on the FUNDING cadence (`min(nextDayStart, now + FUNDING_RECHECK_MS)`),
  never on the day rollover alone. That defer is written ONCE from the ceiling current at that
  instant and nothing re-checks an ongoing campaign due tomorrow — not the claim
  (`next_run_at <= now()`), not `claimStuckCampaigns` (`next_run_at IS NULL`), not the resume sweep
  (stopped rows only) — so a customer who RAISES a ceiling mid-day saw the money spent the next day
  (prod 2026-08-23, brand `75d7e3e8`: $39.13 of a $40 ceiling, raised to $50 at 14:57, zero runs
  after 13:24). `FUNDING_RECHECK_MS` already carries that promise for a campaign funded from ZERO;
  one funded MORE is the same rule, missing branch. A brand still at its ceiling simply re-ranks and
  defers again — no run, no spend, gate untouched. EVERY alive campaign of the brand is a candidate
  every tick — one that states no funnel is ranked on the brand daily budget, the ceiling the gate
  actually binds it to. No campaign is ever held out of the running because another one covers its
  funnel; there is no superseded state, and `tests/unit/no-legacy.test.ts` fails if the concept
  returns.
- **Fail-SOFT in the scheduler, fail-CLOSED in the gate.** An unreadable budget/funnel set leaves
  the brand on today's behaviour (turn-taking is an optimization); the gate is what refuses to
  spend past a cap it cannot read.
- A brand that never set per-funnel ceilings grows no funnel campaigns and behaves exactly as
  before: its campaigns state their funnel (a label) and keep pacing on the brand-level pot.
- The brand-level PAUSE FLAG is GONE — funding is the only thing that holds a campaign. See the
  next section.
(Set 2026-08-02; adoption + fleet-wide funnel statement, same day; pause retired 2026-08-16.)

## Funding a sales funnel is what makes its campaigns eligible — there is no pause flag any more

"Is this brand paused" used to live here, in `brand_pause`, while "is this brand funded" lives in
billing as a per-funnel daily ceiling. Two representations of one fact, and they disagreed. The
product decided months ago that a customer stops a chain by dropping its ceiling to zero, and the
brand-wide pause control was deleted from the customer dashboard along with its writer — but the
flag was still READ, so 27 brands sat stored-paused with no API path back, 10 of them funded,
holding 11 `ongoing` campaigns the scheduler would never claim. The flag is retired (migration
0049 drops the table) and the money says it instead.

- **ONE definition, `src/lib/campaign-funding.ts`.** A campaign is funded when a POSITIVE ceiling
  exists for it, on gate-check's exact precedence: its own `dailyBudgetCents` (the mirror of its
  funnel ceiling) → its `funnelKey`'s ceiling → the brand-level pot. Shared by the leg that HOLDS
  an ongoing campaign (`planFunnelTurns`) and the leg that RESUMES a stopped one
  (`campaign-resume`), for the same reason `serveableAudienceIdsForCampaign` is shared: two legs
  on two definitions is how a campaign gets held by one and never picked up by the other.
- **A ceiling nobody ever stated is UNFUNDED, not unbounded.** `brandDailyBudgetBlock` used to
  read a null brand budget as "no cap this tick" and let the campaign run. That is how two brands
  funding nothing at all (`8ea87a06…` org `d46ba002…`, `d7d25db9…` org `21bbec7f…`) kept sending
  against no ceiling while 27 brands that DID state a zero were held by a flag nobody could
  write. The gate now answers `Brand not funded`. It is only ever reached for a sales-outreach
  campaign — every other feature family is untouched by funding, exactly as the pause was
  sales-scoped.
- **The hold is at the TURN, not the claim.** There is no SQL clause any more: the claim
  `UPDATE … RETURNING` cannot call billing, and mirroring the ceiling into a column would rebuild
  the same second-representation problem one layer down. A held campaign is claimed, held by
  `planFunnelTurns`, and given `nextRunAt = now + FUNDING_RECHECK_MS` (10 min) — not the 1-minute
  turn cadence, because it is not waiting its turn, it is waiting for money. That interval IS the
  feature's latency: fund a funnel and its campaign runs within ten minutes, with no manual step.
- **Fail-CLOSED here, unlike the rest of the turn planner.** An unreadable budget holds the brand.
  Turn-taking is fail-soft because it only reorders work already allowed; this decides whether to
  spend, and the gate refuses the same run on the same unreadable read anyway — firing it could
  only burn a run.
- **A brand nothing will CLAIM soon is swept, and "soon" is the selection — not "has nothing
  running".** `provisionFundedPairsForQuietBrands` (own 10-min cadence) reads the (org, brand)
  pairs that have sales campaigns and none of them in flight or due within the sweep interval,
  and stands up one campaign per funded, DECLARED pair. Selecting on "no `ongoing` campaign" was
  right for the brand whose campaigns are all STOPPED (27 of 44 the day it shipped) and blind to
  the brand PARKED AT ITS CEILING: the turn planner defers it to the day rollover, so the claim
  path — where provisioning otherwise lives — does not look at it again until midnight UTC, and a
  channel funded in the meantime waits for the rollover. That brand is too alive for an
  idle-selection sweep and too quiet for the claim path, and it fell between them for nineteen
  hours in prod (brand `75d7e3e8`, second channel funded 2026-08-19 13:59, no campaign until the
  next day — issue #386). Read volume is unchanged for a brand that is working: it is EXCLUDED
  here precisely because the claim path reaches it sooner, so the cost is one billing read per
  QUIET brand per ten minutes — the same cadence and the same argument as `FUNDING_RECHECK_MS`.
  The scheduler's idle sleep is capped at that interval for the same reason the resume sweep
  needed it: a brand with nothing ongoing yields an empty snapshot and would otherwise be looked
  at hourly. The seed prefers an `ongoing` row (it carries the current owner, workflow and offer),
  and the declared-funnel question is asked over every offer the pair's sales campaigns state, not
  just the seed's. (Widened 2026-08-23.)
- **Funding brings back the campaign that was HELD, never the campaign that stopped for a reason
  of its own.** A row carrying `audience_exhausted`, `max_leads_reached`, `manual` or
  `org_teardown` said why it stopped and money answers none of them (the exhaustion sweep owns the
  first — it asks the audience owner, the only honest test). A NULL reason is the pre-column
  population, i.e. the workflow-version churn, so it is the campaign rather than a decision about
  it, and funding resumes it.
- **`GET /brands/:brandId/pause` STAYS and answers from the money**: held ⟺ no funnel carries a
  positive ceiling AND the brand pot is not positive. `updatedAt` is always null (nothing stores
  it) and an unreadable billing is a **502**, never a cheerful `paused:false`. **`PATCH
  /brands/:brandId/pause` is DELETED** — re-adding a writer is the contradiction wearing a
  different hat, and `tests/unit/no-legacy.test.ts` fails on any route that writes a pause.
  api-service still proxies the PATCH; that proxy is now dead (it had no caller).
- **`brand_pause_transitions` is KEPT as a CLOSED history.** No new row can be written (its writer
  was the PATCH), but the flips that happened are real and features-service's Customer Success
  board reads them via `/pause-history`. Dropping it would lose history to answer nothing.
- **Consumer note (features-service):** its account triage reads this route as one of
  paused → active → inactive. `paused` now means "funds nothing", which SUBSUMES the old
  `inactive` (budget 0 or unset), so those two collapse into one for a sales brand. Money sums are
  unaffected — both were already excluded from spend/MRR/ARR.
- **Verified at ship**: all 27 stored-paused brands answer zero on every funnel and null on the
  brand pot, so every one of them is still held after this ships, by the new rule. (Set
  2026-08-16.)

## A campaign is unique on (org, brand, sales funnel, acquisition channel) — the WORKFLOW is not part of it

Nothing else is part of that identity. A campaign changes workflow whenever selection picks a
better one; it is not replaced by a second campaign each time it does. Treating the workflow as
identity is what grew brand `f4d73dab` **137 stopped rows**, one per workflow version (`Aurora`,
`Aurora V2`, `V3`, `Hassium` ×12, `Tributary` ×5 …), each holding a slice of a history nobody could
read as one campaign.

- **Two of the four were not stored facts** until migration 0044. `brand_id` (scalar) exists
  because no unique index can span `brand_ids text[]` — the reality is one brand per campaign, and
  every `ongoing` row in prod carries exactly one. `acquisition_channel` exists because consumers
  derived the channel from the WORKFLOW SLUG, i.e. from the one attribute that legitimately
  changes. Both are written once at creation by `campaignIdentityColumns`
  (`src/lib/campaign-identity.ts`) — every `insert(campaigns)` goes through it, so a new write site
  cannot leave a row Postgres will not police. Nothing re-derives either at read time.
- **The channel is named per FEATURE FAMILY, not per medium alone.** `cold_email` for the sales
  funnels; every other product family names its own (`pr_cold_email`, `expert_quote_outreach`, …).
  A bare `cold_email` for all of them would make a brand's PR cold-email campaign and its SALES
  cold-email campaign one identity, so the second could never exist. An unknown feature gets its
  own slug with `-` as `_` — a feature shipped later can never silently share another's identity.
- **`uniq_campaigns_org_brand_funnel_channel`** enforces it, partial on `status='ongoing'`: a
  stopped row is history, not a competitor for the brand's turn. `coalesce(funnel_key,'')` is
  load-bearing — Postgres treats NULLs as distinct, so without it a brand could grow unlimited
  funnel-less campaigns on one channel.
- **`POST /campaigns` on an identity already alive UPDATES that campaign** to the requested
  workflow + configuration and returns it `200`, instead of inserting a second row. The NAME is
  deliberately left alone (it is the campaign's own label, unique per org, not a restatement of
  which workflow runs). A create that loses a race on the index gets the winner back, not an error.
- **Still open**: the 134 historical stopped rows that DO carry runs cannot be collapsed from here
  — their history lives in runs-service, keyed on `campaign_id`, and repointing it is runs-service's
  own ledger to move. Deleting them would orphan the history, which is the one thing never allowed.

## The OFFER a campaign sells is brand-service's UUID, carried and never derived

A new level sits between the brand and the campaign: **Org > Brand > Offer > Campaign**. An offer is
one distinct thing a brand sells — its value proposition plus the sales funnels it sells through —
so a brand selling a $200 self-serve plan and a $20k enterprise contract has two. A campaign sells
exactly ONE, which makes a campaign **(offer × sales funnel × acquisition channel)**: it already
stated the funnel (0041) and the channel (0044), and `campaigns.offer_id` (migration **0050**) is the
missing third word. Without it, two campaigns of one brand on the same funnel through the same
channel for two different offers are the same row to every reader — in the data, in the money
attribution and on the customer's screen.

- **brand-service OWNS the entity; this column carries its id.** No offer table, enum or vocabulary
  exists here and none is to be introduced — the same posture this service holds for the goal and
  the channel. It is not validated against brand-service on write, exactly as `funnelKey` and
  `audienceIds` are not.
- **NEVER derived.** Not from the funnel (several offers legitimately sell through one funnel, which
  is the entire reason the dimension exists), not from the goal, not from the workflow. It is stated
  by the creator or it is NULL.
- **OPTIONAL on create, deliberately and temporarily.** Requiring it is a breaking request-contract
  change, so a create that states no offer behaves EXACTLY as it did before the column existed and
  callers state it as they migrate. It becomes required in a later wave, and only then. `PATCH` sets
  or clears it, which is how a campaign created before it could state one says which offer it runs.
- **It is NOT part of the identity key.** `uniq_campaigns_org_brand_funnel_channel` is untouched:
  widening it while the field is optional would let one brand grow unlimited offer-less campaigns on
  one (funnel, channel). Widening it is the same later wave that makes the field required.
- **It decides no MONEY question** — no pacing, funding, gate or ranking decision reads it, and
  `idx_campaigns_org_offer` serves the per-offer attribution read it exists for. Since 2026-08-19 it
  decides exactly ONE thing: WHICH QUESTION this service asks brand-service about the funnels sold
  here (next section). That is a grain, not a lever — no campaign runs, stops, or spends differently
  because of the value.
- **AN OFFER BELONGS TO THE (ORG, BRAND) PAIR, NOT TO THE BRAND** — the same rule as every other
  per-brand configuration this service reads. brand-service's `brand_offers` is keyed on
  `(org_id, brand_id, name)`, so a brand claimed by ten orgs carries TEN offers, one per claiming
  org, frequently all named the same thing. "This brand has an offer" is therefore not a question
  this service can act on: resolving a campaign's offer by brand alone would write ANOTHER org's
  offer id onto this org's campaign, a cross-org attribution inside the very per-offer grouping the
  column exists to make correct. `makeOfferResolver` names `x-org-id` for exactly that reason, and
  it is load-bearing, not tracking.
- **The 145 campaigns that state no offer in prod are not a backfill that missed them.** Re-run
  2026-08-19 after brand-service finished creating its offers (last one 09:22Z): NOT ONE is
  attributable. 38 name no brand at all. The other 107 name a brand that does have offers — but
  their OWN org claims that brand in brand-service for none of them, and 143 of the 145 belong to
  two orgs (`8c734aed`, `dff98ee0`) brand-service does not know at all: no claim, no offer, nobody
  to ask. Every one of them is stopped, and no ongoing campaign is unattributed. So the offer grain
  under-counting against the brand headline for those brands is a brand-service claim gap, not a
  coverage gap here, and the honest answer stays NULL until their pair gets an offer.
- **The backfill is a SCRIPT, not the migration** (`scripts/backfill-campaign-offer.ts`): resolving a
  campaign's brand to its offer is a brand-service READ and SQL cannot make one, so migration 0050
  adds the column and backfills nothing. The script resolves once per (org, brand) pair, writes only
  rows still NULL (so a re-run is a no-op and it can never overwrite an offer a live create just
  stated), **dry-runs by default** (`--apply` writes), and LEAVES ALONE + reports any pair that does
  not resolve to exactly one offer. Nothing is guessed for those. The previous value is NULL by
  construction, so the undo is exactly the ids the run prints, which it emits as a statement.
  It is **RE-RUNNABLE, not one-shot** — brand-service keeps creating offers, so a campaign
  unattributable today becomes attributable the day its pair gets one, and the fix for that is to
  run this again, never to widen what it is willing to guess. Two things it refuses to guess:
  a campaign naming SEVERAL brands (the array fallback fires only when it names exactly one — a
  bare `brand_ids[1]` reads a multi-brand campaign as a campaign of whichever brand sorted first),
  and a pair with no single offer. Only the SECOND exits non-zero: a campaign that names no single
  brand is the permanent honest answer and never changes, so failing the run on it would make this
  job red forever and teach everyone to ignore its exit code.

## "Which funnels are sold here?" is asked of the OFFER — the only grain with ONE answer

An offer owns its own value proposition AND its own declared sales funnels with their own
economics, so "the funnels of brand X" stopped having one answer the day a brand could sell
several. brand-service says so itself: it REFUSES a brand-keyed
`GET /internal/brands/:id/sales-funnels` on a brand holding more than one offer rather than guessing
which one the caller meant. A campaign already STATES the offer it sells, so the unambiguous
question is `GET /internal/offers/:offerId/sales-funnels` — keyed on the offer alone, one answer per
offer, ten answers on the brand ten orgs claim.

- **Three outcomes, never one `null`.** `SalesFunnelsRead`
  (`src/lib/brand-sales-funnels-client.ts`) is `{ok, funnels}` | `{ok:false, reason:
  "ambiguous" | "unavailable" | "unknown_offer"}`. Collapsing them is what made the offer level
  SILENT rather than merely broken: any non-2xx read as "declares nothing", so the day a customer
  creates their second offer the brand's campaigns simply stop being provisioned, with nothing
  crashing and nothing logged about an offer anywhere. An EMPTY list stays a truthful answer and is
  NOT logged (it is the routine state of a brand that has declared nothing); a REFUSAL warns that it
  is a refusal, in those words. `tests/unit/no-legacy.test.ts` fails on a nullable return here.
- **`ambiguous` is matched on the STATUS and on the CODE.** 409 is enough on its own, and
  `OFFER_REQUIRED` / `MULTIPLE_OFFERS` / `AMBIGUOUS_OFFER` / `ORG_REQUIRED` are matched whatever
  status they arrive dressed in — a refusal read as an empty set is the whole failure mode, so it
  must not depend on brand-service keeping one status forever.
- **Asked over the WHOLE claimed group, once per distinct offer.** `resolveDeclaredFunnels`
  (`funnel-campaigns.ts`) reads one offer at a time and unions the answers, keeping which offer
  declared each funnel. The brand-keyed read is made ONLY when a campaign of the group states no
  offer — so a campaign that states none behaves exactly as it did before offers existed, and a
  brand whose campaigns all state one never makes the read that would be refused.
- **A funnel SEVERAL offers of one brand declare is provisioned for NEITHER, loudly.** They are
  equals and none outranks another, so there is no offer to file a new campaign under; picking one
  would rank it on another product's economics. It waits for a caller that says which offer it
  means. Same rule, same reason, as never resolving a brand to one of its offers.
- **A campaign provisioned from an offer's declaration CARRIES that offer** (`offerId` on the
  insert). Still carried, never derived: the value comes from the campaign whose declaration put the
  funnel in scope, not from the funnel, the goal or the workflow.
- The quiet-brand funding sweep asks the same way, over the offers its pair's campaigns state.
(Set 2026-08-19.)

## Nothing can be unattributable — so nothing holds a brand's provisioning back

The rule that used to live here held a brand's per-funnel provisioning back while ANY alive campaign
of it could not be attributed to a funnel (a goal like `combinedSales` names several, so it named
none). It was correct while a funnel could be unknown, and it cost exactly what it was protecting:
a customer funded a funnel and never got a campaign for it — 2 of 18 live campaigns were in that
state on 2026-08-12, and the empty column in the dashboard was only where it showed.

A funnel cannot be unknown any more: **creation refuses a sales campaign that states none**, so the
condition the rule tested can no longer arise. It is DELETED, along with the stand-in cleanup that
existed to undo the duplicates it prevented. **A brand that funds a funnel gets a campaign for that
funnel, full stop** — `tests/unit/funnel-campaigns.test.ts` pins that even a campaign carrying no
funnel (a row older than the rule) does not hold provisioning back, and nothing is re-labelled or
deleted when it happens: provisioning only adds.

**An owner answer about a campaign's funnel is still written through `campaign_funnel_owner_decisions`**
— one row per campaign written, holding the value it replaced and the migration tag that wrote it,
so every such write is auditable, re-runnable and undoable by that tag. Nothing in the runtime reads
the table. Two answers exist: migration **0045** (org `f0420eb5` / brand `f4d73dab`, Kevin
2026-08-02 — the live campaign `d5a759bf` states `sales_meetings_from_conversation`, its 51 stopped
sales campaigns state `website_purchases`; a run-date split was declined, so 33,229 of `d5a759bf`'s
54,809 runs predate the July 19 switch and sit under the meeting funnel, one-directional and NOT to
be "fixed"), migration **0047** (the three live rows above, taken from each pair's declared
funnel set), and migration **0048** (the 45 stopped ancestors of the one live campaign of org
`b645207b` / brand `75d7e3e8` / `cold_email`, taken from that campaign's own stated funnel). Note
that a brand row is claimed by several orgs — the stopped campaigns other orgs hold on `f4d73dab`
are other customers' and keep a NULL funnel, and 0048's rule joins on the org for the same reason.

## Brand serialization counts SALES runs only — a brand's PR run is not its sales outreach's business

`hasLiveSalesRunForBrand` asks runs-service campaign by campaign, over the brand's `ongoing`
sales-family campaigns. It must NOT be a brand-wide `listRuns({ brandId })`: runs of the brand's PR,
AI-visibility, hiring and VC campaigns carry the same brand, so a brand whose PR outreach ticks
continuously (736 completed runs in one morning, one always in flight) reads as permanently busy and
EVERY sales campaign of that brand is deferred 60s, every tick, forever. That is a full stop, and it
appears in no log at all because the defer is the routine path. The candidate set is read from the
DB, not from the campaigns claimed this tick — the one actually running is precisely the one NOT
claimed (its `nextRunAt` is null while in flight). (Set 2026-08-02.)

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

**`pnpm` via corepack dies on Node 20.19.1** with `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING` thrown from `corepack/v1/pnpm/.../bin/pnpm.cjs` — before any install work happens. That failure looks like a broken lockfile or a bad workspace, and it is neither: it is the corepack shim, not pnpm. Use `npx --yes pnpm@10 <cmd>` (install, `--filter … build`, `test:unit`, `run build`) and everything works first try. (Set 2026-08-02.)

**`db:push` HANGS on a column RENAME against an existing `campaign_test`.** drizzle-kit `push` can't tell a rename from a drop+create, so it prompts interactively ("is `audience_id` a rename of `customer_profile_id`?") — in a non-interactive/background shell it blocks forever (produces 0B output, never exits). When a schema change RENAMES a column, don't rely on `db:push` to materialize it on the test DB: apply the `ALTER TABLE … RENAME COLUMN` directly (`psql postgresql://test:test@localhost/campaign_test -c '…'`), mirroring the prod migration. `db:push` is still fine for additive changes (new column/table). (Set 2026-06-20, customer_profile_id → audience_id rename.)

**`db:generate` is DEAD in this repo — migrations are HAND-AUTHORED idempotent SQL, do NOT try drizzle-kit generate.** The `drizzle/meta/` snapshots froze at `0023_snapshot.json`; every migration `0024+` was hand-written without updating the snapshot. So `drizzle-kit generate` diffs `schema.ts` against the stale `0023` snapshot and prompts interactively for ~12 migrations' worth of phantom rename/create decisions (e.g. "is `parent_run_id` a rename of `workflow_name`?") — it can never emit a clean single-change migration. When a brief says "generate with drizzle-kit," ignore it for this repo. **To author a new migration: (1) hand-write `drizzle/NNNN_<desc>.sql` mirroring the latest one's boot-safe idempotent style** — `ALTER TABLE … DROP COLUMN IF EXISTS` (see `0036`) or a `DO $$ … information_schema … IF EXISTS` guard for renames (see `0035`); **(2) append a journal entry** to `drizzle/meta/_journal.json` with the next sequential `idx`, the matching `tag`, and a synthetic `when` (prior cadence: +100000000 ms per migration). `src/lib/migrations-validator.ts` enforces journal↔sql parity + gap-free sequential `idx` + no dup idx/tag, so both files must be added together. Boot runs `migrate(db, { migrationsFolder: "./drizzle" })`; idempotent guards make every migration re-runnable. (Set 2026-06-20, customer_persona_id DROP / migration 0036.)

## Raw-`sql` list params need `sql.join`, NOT a bare JS array — and workflow dynasties live in the DB, not src

**Interpolating a JS array into a drizzle raw `sql` template does NOT expand it into a param list.** `sql\`... IN (${arr})\`` binds the whole array as ONE composite → `operator does not exist: text = record`; `= ANY(${arr})` → `op ANY/ALL (array) requires array on right side`. Neither works. To expand a small in-code list (e.g. the sales-outreach feature family in `funnel-campaigns.ts`'s idle-brand sweep), use `sql.join([...set].map((v) => sql\`${v}\`), sql\`, \`)` inside `IN (...)`. Caught only by the integration tests (unit tests mock the DB), so run `pnpm test:integration` after any raw-`sql` change. **Same template, second trap: a JS `Date` parameter is REFUSED outright** — postgres.js binds raw-`sql` params itself and throws `The "string" argument must be of type string ... Received an instance of Date`. Pass `d.toISOString()` and cast (`::timestamptz`). (2026-08-23, the quiet-brand sweep's due-soon bound.) (Set 2026-07-24, sales-crm feature-family pause clause; the clause itself is gone, the trap is not.)

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

**`GET /campaigns?status=` serves that same vocabulary, and an unrecognised value is a 400 — never
an unfiltered list.** The filter did not exist until 2026-08-16: the query schema declared brand,
workflow and feature only, the handler destructured exactly those, and a `status` a caller sent
was accepted by api-service's query whitelist, forwarded, and dropped here without a word. A 200
with all 134 of an org's campaigns reads as "this org really does have 134 running", not "your
filter was ignored" — which is why it survived unnoticed, and why `CampaignStatusEnum`
(`ongoing` | `stopped`) is a Zod enum rather than a free string: `status=running` must be told it
is wrong. No aliasing — a translation table is the thing this service keeps deleting, and one
400 teaches the caller in a single round. The three older filters were verified to work.

**`limit` is OPTIONAL and absent means every match** — that is what every existing consumer gets
and it does not change. It exists because the filter alone does not make the big slice askable: an
org's 682 stopped campaigns are a bigger response than the 134 that already broke the MCP client
at 54KB. It is a limit and not a cursor because no caller pages today, and it reads one row past
the cap so the response can carry `hasMore` — a truncated list that cannot say it is truncated is
the same silent lie as the dropped filter. A caller that needs to WALK the stopped set will need a
cursor; nothing has asked. (Set 2026-08-16.)

## `/end-run` `stopCampaign=true` is AUDIENCE-scoped, NOT campaign-scoped — never blindly set `status='stopped'` on it

The workflow DAG sends `stopCampaign=true` whenever a run's SINGLE bandit-picked audience returns no leads (`fetch-lead.found == false`) — it's a **hardcoded literal on the `end-run-no-lead` DAG node** (`stopCampaign == !found`), evaluated on the ONE audience `/start-run` chose for that run. It does NOT mean "the whole campaign is done": the bandit narrows each run to one audience, so one audience running dry says nothing about the campaign's OTHER audiences. Obeying it literally (the old `status='stopped'` on any `stopCampaign=true`) wrongly halted multi-audience campaigns the instant their one exhausted audience got picked, while other audiences still had tens of thousands of reachable leads (prod incident brand `75d7e3e8`, 2026-07-21: stopped at 14:01 on audience `729e06f0` while 7 others were `exhausted=false`).

So `/end-run` REINTERPRETS `stopCampaign=true` as audience-scoped: it marks `req.audienceId` exhausted in **`campaign_audience_exhaustion`** (migration 0040) and auto-stops the campaign ONLY when `hasServeableAudience()` finds no serveable, non-exhausted audience left (all targeted audiences exhausted = the sole legitimate campaign-wide stop). Otherwise it falls through to the normal reschedule so the next tick re-draws from the remaining audiences. The bandit (`selectAudienceForRun`) takes `excludedAudienceIds` and `/start-run` passes the fresh exhausted set so it never re-picks a known-dry audience. **Fail-SAFE**: any error in the exhaustion check does NOT stop the campaign (a false stop is the exact bug this fixes). The exhaustion mark expires after a **24h TTL** (`getFreshExhaustedAudienceIds`) — audiences are re-probed daily because Apollo can add new matching leads over time, so exhaustion is never permanent. The `done`/exhaustion signals from apollo/human/lead-service are all HONEST and per-audience; the campaign-wide escalation was purely the DAG's literal + campaign-service obeying it. Do NOT move the stop decision back into a blanket `stopCampaign=true → stopped`. (Set 2026-07-21, PR #281.)

At that all-audiences-exhausted auto-stop point (and ONLY there) `/end-run` also fires a **fire-and-forget extend-audience lifecycle email** (`maybeSendExtendAudienceEmail`, `src/lib/transactional-email.ts`) nudging the user to extend an audience so outreach can resume. It sends via **transactional-email-service** (`POST /send`, eventType `audience_fully_contacted`; template registered at boot via `PUT /platform-templates`) ONLY when ALL hold: sales-cold-email-outreach feature, `campaign.createdByUserId` present (recipient), a daily budget `> 0` (which IS "the brand is funded", and since 2026-08-16 is also the only statement that it is running at all) (campaign `dailyBudgetCents` else the brand's billing daily budget), and org `has_auto_topup` (billing `GET /internal/accounts/by-org/{orgId}/balance`, user-less). The **1×/month-per-brand cap is owned by transactional-email dedup** (its `audience_fully_contacted` monthly-per-brand cadence), NOT a local table. Every guard read is **fail-SAFE** (any error/absent field → treat as OFF → no email) and the whole call is fire-and-forget after the response, so it NEVER blocks or fails run finalization. When refactoring `/end-run`, keep this call at the exhausted-stop branch — do not drop it. (Set 2026-07-22, PR #292.)

**"Everyone has been contacted" is a claim about people we actually contacted, so it needs a real
audience to have run out** — `hasExhaustedAudience(campaign.id)`, ANY row in
`campaign_audience_exhaustion` for the campaign, TTL ignored (this asks whether outreach ever ran
out of people, not whether an audience is dry right now). Every other guard asked whether the brand
is set up to keep spending; none asked whether anybody was ever contacted, so a brand with NO
audience and NO contacts reached the same auto-stop branch and was told its outreach had finished:
zero out of zero read as everyone. That brand writes no exhaustion row precisely because its stop
carries no audience id — the case `/end-run` already logs as "no audience ran" — so the mark IS
the evidence, and no new state was needed to tell the two apart. **Since 2026-08-20 that same
evidence gates the STOP itself, not only the claim** (next section): withholding the email while
still stopping was half the fix. Verified in prod 2026-08-16: the three campaigns
that ever received this email hold 11, 3 and **0** exhaustion rows — the zero is Lux Projects Bali
(`cb965e9d`, brand `ccc29ba2`, emailed twice, 0 contacts and 0 audiences ever); the other two are
unaffected.

**The email NAMES the brand and links to that brand's own audiences page.** It used to carry no
identity at all and point at the dashboard root, so a customer with several brands could not tell
which one paused. `{{audiencesUrl}}` is
`https://dashboard.distribute.you/orgs/<orgId>/brands/<brandId>/audiences` (the campaign's primary
brand) and `{{brandFooterHtml}}` / `{{brandFooter}}` carry the name as a quiet grey line at the
foot, HTML and text respectively — transactional-email interpolates a variable RAW into the HTML
body, so the name is escaped here. The name comes from brand-service `/runtime-context`, the read
this service already makes; if it cannot be resolved the footer is EMPTY and the email reads exactly
as it did before. Never substitute a placeholder or an id for a name a customer will read.
(Set 2026-08-16.)

## A campaign that served NOTHING has exhausted nothing — the terminal verdict rests on POSITIVE evidence, never on an empty remainder

The auto-stop asked ONE question: is there a serveable audience left? "None left" is equally true
of a campaign that never had one, so a campaign that had contacted nobody took the same branch as
one that had genuinely worked its audiences to the end — 0 of 0 read as 100%. The verdict is now
gated on evidence that work HAPPENED through that campaign: `isExhaustionStopWarranted`
(`src/lib/audience-exhaustion.ts`) is `!serveable && hasExhaustedAudience(campaignId)`, the SAME
mark the extend-audience email is gated on, and it is only ever written for a run that named a
real audience.

- **Without that evidence the campaign is NOT stopped at all.** It stays `ongoing` and falls
  through to the normal reschedule, so the next tick looks at it again. Nothing new decides
  whether it may spend: the turn planner holds it if its pair is unfunded and the gate refuses a
  run it cannot price. The alternative — stopping it — is STICKY: funding deliberately resumes a
  campaign that was HELD but never one that stopped for a reason of its own, so
  `audience_exhausted` parks a funded channel indefinitely with no manual path back, and the
  funding sweep says exactly that on every pass.
- **The degenerate branch states its decision.** `stopCampaign=true` with no `x-audience-id` used
  to log that it could not mark an audience and then proceed to the stop anyway; it now says no
  audience ran, and the gate says it is therefore not concluding exhaustion.
- **The exhaustion stop itself is untouched.** A campaign that HAS served and then genuinely
  exhausts still stops, still emails, still resumes through the sweep. Money is not an answer to
  exhaustion; only the zero-evidence case was wrong.
- **Migration 0052** applies the same rule to the rows already carrying the verdict — stopped for
  `audience_exhausted` with zero exhaustion marks, and no live twin holding their identity — and
  returns them to `ongoing` / no reason / due now, auditing each in
  `campaign_stop_reason_decisions`. It selected the whole stopped-for-exhaustion population in
  prod, two rows: `4769db14` (the first campaign the per-channel provisioner ever created, dead
  ten seconds after birth on a channel funded at $10/day) and `cb965e9d` (Lux Projects Bali, the
  0-audience brand above). Pinned by `tests/integration/unpark-never-served-migration.test.ts`,
  which applies the file itself twice.
- **It WAITS on the reason's cadence, it does not retry on the run's.** Rescheduling that campaign
  on `RERUN_GRACE_MS` (10s) fired a workflow every eleven seconds, forever, for a campaign whose
  situation cannot change in eleven seconds — 33 runs in the first minutes on `4769db14` and the
  same on `cb965e9d`, each unable to reach anything, flooding every service in the chain. "Nobody
  to contact" is the MONEY kind of wait, not the TURN kind: it moves when a customer edits their
  audiences or when a never-run channel finally accumulates evidence, hours or days apart. So it
  reschedules at `NO_SERVEABLE_AUDIENCE_RECHECK_MS` (10 min, the same figure and the same argument
  as `FUNDING_RECHECK_MS`), which IS the latency — the campaign runs within ten minutes of having
  somebody, with no manual step. The wait is a RESCHEDULE, never a stop: it stays `ongoing`, so
  nothing has to be undone when the audience appears. One line says it is waiting and why, on that
  cadence; the generic reschedule line is suppressed under it and the no-audience-ran line is
  `info`, not `warn` — an expected business state.
- WHY that campaign's first serve came back empty on a brand whose sibling served 109 leads the
  same day is a separate lead-service investigation. This service's job was to stop reading an
  empty answer as a finished one. (Set 2026-08-20.)

## A campaign that ran out of people to contact comes BACK on its own — the customer's action is the trigger, and they were told so

The auto-stop above emails the customer asking them to extend or add an audience. Nothing closed
that loop: they did exactly what the email asked and the campaign stayed stopped forever, because
no path anywhere turned a stopped campaign back on. The dashboard made it worse — it lists only
live campaigns, so the brand saw an empty table and no reason. Prod, brand
`a179bbd9-8eed-4dba-9338-78125922b0c6`: auto-stopped 2026-08-05 for exhaustion, owner activated
three fresh audiences 2026-08-10, five days of a funded brand produced nothing.

- **WHY a campaign stopped is a stored fact** — `campaigns.stop_reason` (migration 0046), written
  at every one of the four places this service stops a campaign: `audience_exhausted` (/end-run,
  all audiences exhausted), `max_leads_reached` (gate-check), `manual` (PATCH status=stop),
  `org_teardown`. The vocabulary lives in ONE place, `src/lib/stop-reason.ts`. Without it the
  campaign that ran out of people and the campaign a person switched off are the same row.
- **ONLY `audience_exhausted` resumes. NULL never does.** Every row stopped before the column
  existed keeps NULL and is invisible to the sweep — deliberately, and it is why there is no
  backfill: a stop nobody wrote a reason for is not evidence of exhaustion, and a
  timestamp-correlation guess would resurrect campaigns a person stopped on purpose. The loop
  closes forward. The reason is CLEARED whenever a campaign becomes ongoing again (resume,
  activate, funding provisioning), so the column always describes the CURRENT stop.
- **The candidate population is the narrow one, never "every stopped campaign".** 682 stopped
  rows against 17 ongoing — a stopped campaign is a large and mostly permanent population, so
  `resumeServeableCampaigns` (`src/lib/campaign-resume.ts`) reads only `status='stopped' AND
  stop_reason='audience_exhausted'`, served by a partial index. Nothing else is looked at.
- **The signal is the audience owner's answer, not our guess.** features-service's projection
  enumerates every ACTIVE audience of the brand, so a newly-activated audience appears the moment
  the customer activates it. `serveableAudienceIdsForCampaign` (`src/lib/serveable-audience.ts`)
  is the ONE definition of "has somebody to contact", shared by the leg that STOPS (/end-run) and
  the leg that RESUMES. Two legs on two definitions is how a campaign gets stopped by one and
  never picked up by the other.
- **Own cadence, not the tick's.** `RESUME_SWEEP_INTERVAL_MS` = 10 min. A tick fires as often as
  every 60s; asking features-service about every exhausted campaign at that rate would be a
  per-minute fan-out for a state that changes when a customer edits their audiences. The
  scheduler never sleeps past that interval — otherwise a brand whose ONLY campaign is stopped
  has an empty ongoing snapshot, sleeps the full idle hour, and the sweep runs hourly however
  willing it is. (Unconditional since 2026-08-16: the funding sweep needs the same floor, and one
  snapshot query per ten minutes on an idle service is cheaper than the precondition read it
  replaced.)
- **Fail-CLOSED, unlike the scheduler's other reads.** Funding is checked on gate-check's exact
  precedence (own `dailyBudgetCents` → funnel ceiling → brand daily budget) and an unreadable
  budget, an unreadable audience set or a zero/absent ceiling all leave the campaign stopped. Turn-taking is fail-SOFT because it only reorders work already allowed; this decides
  whether to START spending again, which is the gate's stance. **Every refusal is logged with its
  reason** — a resume that cannot be decided safely is not a resume, and it says so.
- **AT MOST one ongoing campaign per identity still holds.** The sweep checks for an incumbent on
  (org, brand, funnel, channel) AND the write is conditional on the row still being
  stopped-for-exhaustion; a `23505` from the partial unique index leaves it stopped. Belt and
  braces on purpose: the index is the guarantee, the read is the reason we can explain.
- The resumed campaign is `ongoing` with `nextRunAt=now`, i.e. exactly the state a live campaign
  is in — the very next tick claims it like any other. Nothing about the auto-stop itself
  changed: stopping when there is nobody left to contact is correct; never coming back was the bug.
(Set 2026-08-10.)

## EVERY `listRuns` states a status AND a bound — an unfiltered read costs more with every run the campaign has ever done

runs-service serves `runs` as a VIEW over `run_lifecycle_events` (6.2M rows), so a `listRuns` with no
bound replays the whole event log, LEFT JOINs a second view and GROUP BYs 19 columns — no index can
help. The row count is the campaign's entire history, `workflow_context` JSONB included. Because
gate-check is the FIRST node of EVERY run, that made each new run raise the price of every run after
it: 83,064 calls / month at **21,216 rows per call** = 1.76 BILLION rows, essentially the whole Neon
bill's public network transfer plus a large share of its compute, on a curve that had gone
$139 → $204 → $337 → $476 → $701.

The gate needs three things and each is now asked for on its own terms (`src/lib/gate-check.ts`):

- **Stale cleanup + the one-run-at-a-time guard** read `status: "running"` with `RUNNING_RUNS_LIMIT`.
  The invariant is ONE live run per campaign, so 200 is not a tuning knob — it exists so an
  unbounded read can never come back. Rows arrive newest-first: past the bound the newest still
  block the tick (guard correct) and the oldest are cleaned on a later pass.
- **The `completed` count is a LIFETIME total** — `Math.max(leadStats.totalServed, completedRuns.length)`
  is what enforces `maxLeads`, so a recency window would let a campaign run past its cap forever.
  It is bounded by the CAP instead: the count is only ever compared `>= maxLeads`, so asking for at
  most `maxLeads` rows answers that question EXACTLY (fewer back → exact count; exactly `maxLeads`
  back → the cap is reached whatever the true total). Read only when a cap exists.

runs-service exposes **no per-campaign run COUNT** (`GET /v1/runs` returns rows, `/public/stats/runs`
is cross-tenant), which is why the lifetime total is still read as bounded rows rather than a scalar.
Do not reconstruct a count locally — a counting/`total` capability is runs-service's to add.

The other three call sites were already bounded (`scheduler.ts hasLiveRunForCampaign`,
`funnel-campaigns.ts` ×2, all `limit: 1`); `/end-run` carries one too. A new `listRuns` without a
status and a limit is a regression, and `tests/unit/gate-check.test.ts` fails on one.
(Set 2026-08-07.)

## A run id this service hands another service MUST EXIST — never mint one

`x-run-id` is not a correlation string. workflow-service turns the one we send into the
`parentRunId` of the run it creates, and `runs.parent_run_id` carries a foreign key to `runs.id`,
so a freshly minted uuid is refused by runs-service and the whole execution 502s **before the DAG
runs a single node**. Nothing about that is visible from the campaign: it stays `ongoing`, its
`nextRunAt` is set as normal, and it produces nothing forever. Prod 2026-08-18: 3,593 refusals in
six hours, a different minted id on every line, one live customer campaign silent for two days
(`9570e3ce`, created by the per-funnel provisioner) and 313 stopped rows one resume away from the
same branch.

- **A campaign's `parentRunId` is its ANCESTOR run**, written once at creation from the creator's
  `x-run-id`, and every execution's run tree chains under it. A creator carrying no run of its own
  — the per-funnel provisioner, the quiet-brand sweep — leaves it NULL, which is where the minting
  came from.
- **`ensureCampaignRunId` (`src/lib/trigger-run.ts`) is the ONE place a missing ancestor is
  filled**, shared by the leg that TRIGGERS (scheduler) and the leg that RESUMES
  (campaign-resume) for the same reason `campaignFunding` is: two legs minting differently is how
  one of them ships an id nothing can resolve. It creates a real root run and **persists it on the
  campaign**, so it is established once rather than per tick and every later trigger takes the
  same branch as a campaign born with one.
- **The anchor states only what is true of the campaign for its WHOLE LIFE** — org, user, brands,
  feature — and is `completed` immediately. Nothing per-execution, for two different reasons that
  both end in a silent full stop:
  - No **`campaignId`**: every campaign-scoped read here (gate-check's stale cleanup and lifetime
    `completed` count, `hasLiveRunForCampaign`, `hasLiveSalesRunForBrand`) filters on it, so
    tagging the anchor recreates exactly the orphan run that stopped this service creating runs at
    trigger time in the first place.
  - No **`workflowSlug`**: the workflow is re-picked EVERY run by the greedy bandit, and
    runs-service refuses a child whose `workflowSlug` differs from its parent's (`409 Parent-child
    field conflict`). A permanent ancestor stating one workflow therefore blocks every run that
    picks another — the same invisible halt one layer along, which is how it was found (v0.55.1
    anchored `9570e3ce` correctly and the execution still 502'd, now loudly).
  The persist happens BEFORE the finalize, so a failed finalize reuses the run instead of throwing
  it away.
- **Fail-CLOSED: an anchor that cannot be established means no dispatch.** The scheduler's
  per-campaign catch logs it and the campaign is re-claimed by `claimStuckCampaigns`; the resume
  sweep leaves the campaign stopped. And `executeCampaignWorkflow` now **throws** on a non-2xx
  from workflow-service instead of logging and returning — a refused execution is a campaign that
  did not run, and returning quietly is what let this hide.
- `tests/unit/no-legacy.test.ts` fails on `randomUUID` in `scheduler.ts`, `campaign-resume.ts` or
  `transactional-email.ts`. The extend-audience email's `?? crypto.randomUUID()` fallback is gone
  too: `/end-run` requires `x-run-id` (`requirePipelineHeaders`), so it was a stand-in that could
  only ever name a run that does not exist.
(Set 2026-08-18, issue #352.)

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

**The projection's audience grain is `(audienceId × workflowDynastySlug)`, send-tagged, and it emits a row for EVERY active audience × every active dynasty** (features-service#638) — audiences with no couple floor brand→crossOrg via the cascade. That is what makes the single-endpoint Thompson above possible: the chosen workflow's rows already ARE the brand's active-audience candidate set with workflow-discriminated evidence. `/features/:slug/candidates` no longer exists; its evidence lives in the reshaped `workflow-projection` (`rows[]` grain-ladder + `resolved`), read via `src/lib/features-workflow-projection-client.ts`, which sends `brandId` + `goal` only.

**Never reintroduce a workflow-scoped audience filter that can collapse to a subset the stop-guard doesn't see.** The removed soft-filter narrowed the candidates to audiences that had RUN the chosen workflow; when greedy locked onto a dynasty whose only run-attributed audience was exhausted, the exhaustion exclusion then emptied the set → `/start-run` picked NO audience → empty `lead-serve` → ~20s spin, while `hasServeableAudience` (unscoped) saw the brand's other audiences and refused to stop. Two legs on mismatched eligibility never agree.
