## CRITICAL RULE — Read-only by default

When the user shares logs, errors, or bug reports: **ONLY diagnose and explain**. NEVER write code, create branches, open PRs, or make any changes unless the user explicitly asks you to implement a fix. The user often shares the same logs with multiple agents in parallel just for analysis — acting on them without permission wastes time and creates mess to clean up.

**Before making ANY structural or architectural change** (new endpoints, new DAG nodes, new services, schema changes, workflow changes): stop and ask the user for approval first. Never assume the fix belongs in this repo — the root cause may be in another service.

# Project: campaign-service

Campaign CRUD and orchestration service for MCP Factory. Manages campaign lifecycle, budget tracking, and run coordination.

## Log level: expected business states are NOT warnings — and high-frequency routine events are NOT logged at all

A gate block caused by a **normal, expected** business state — out of credits, budget window exceeded, max leads reached — must trace/log at `info`, never `warn`/`error`. Running out of credit happens; it is not an anomaly and it is not campaign-service's job to flag it loudly (billing's dunning engine owns the "out of credit" story). Reserve `warn`/`error` for genuine fail-OPEN/fail-closed anomalies (misconfig, non-2xx from a sibling, unexpected throw). When adding a new gate-check block, decide its trace level by "is this an expected outcome or a fault?" — expected → info. (Set 2026-06-14, credit-affordability gate PR #171: the gate-check-result trace hard-coded `warn` for every BLOCKED result; out-of-credit blocks were surfacing as warnings.)

**Downgrading warn→info is NOT always enough — for a HIGH-FREQUENCY routine event, the right level is NO LOG.** Decide level on TWO axes: (1) expected-vs-fault → picks warn vs info; (2) frequency → a routine event that fires on a per-tick / per-minute cadence for **every** campaign × **every** client (scheduler dedup skips, "still in-flight, rescheduled", poll heartbeats) must not be logged at all — even `info` spams the logs minute-by-minute across the fleet and buries real signal. Ask "how often, across how many entities, does this line fire?" before logging it; if the answer is "every tick for everyone," drop it. The decision is already observable in durable state (persisted `nextRunAt` in DB, trace events) — a per-minute log is the wrong observability mechanism. (Set 2026-06-14, scheduler in-flight skip v0.26.1: first instinct was to downgrade the `console.warn` to `console.log`; Kevin: "tu ne vas pas faire un bip toutes les minutes pour toutes les campagnes, pour tous les clients… ça n'a aucun sens" — the log was deleted, not downgraded.)

## The credit pre-filter is fail-OPEN, and it SAYS which of the two things happened

`readCreditAffordability` (`src/lib/gate-check.ts`, block 3b) allows the run on every failure —
unconfigured billing, non-2xx, a network throw, a 200 whose body states no `affordable`. That is
deliberate and stays: a billing blip must not freeze every campaign of every client, and
chat-service's own authorize is the hard gate downstream. What was wrong is that the fail-open path
was indistinguishable from an authorization: both reached the run trace as the single word `PASSED`,
so during an incident nobody could tell "billing said this org can pay" from "billing could not be
asked and we let it through" — which is the only question worth asking about this gate.

- **The ANSWER travels with the decision.** `GateCheckResult.creditCheck` is
  `affordable | unaffordable | unreadable` (+ `creditCheckDetail` naming why billing could not be
  read), and it rides the `gate-check-result` trace event that is **already emitted once per gate
  check** — no new event, no new log line, no volume at all on the healthy path. The log-discipline
  rule above is why: a `console` line here would fire per campaign per tick across the fleet.
- **`unreadable` traces at `warn`, and it is the ONE outcome of this block that does.** A fail-OPEN
  default-allow is a genuine anomaly (the class this repo reserves warn for); running out of credit
  is an expected business state and stays `info`.
- **Nothing about the gate's behaviour changed.** Same fail-open, same `Insufficient credits` block
  with a 30-minute backoff, same silence on the expected path.
- **Verified against the 2026-08-29 incident** (org `b645207b`): the last PASSED gate-check was
  02:52:18 and the first `Insufficient credits` 02:53:28, 70 seconds later, and it has blocked every
  ~30 minutes since. The pre-filter did its job; the burst of declined charges hours later was
  Stripe invoice retries, with zero campaign runs behind it. The gap was that no artifact could
  prove the PASSED verdicts had been authorizations. (Set 2026-08-29, issue #421.)

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
SQL and `SALES_FUNNEL_FEATURE_SLUGS`: every slug in the SQL is a sales one (true forever) AND
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
  `SALES_FUNNEL_FEATURE_SLUGS` (`src/lib/sales-outreach-campaign.ts`) plus its
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
- **THE STATEMENT IS NESTED UNDER THE FEATURE THE REQUEST NAMED — `{ feature: { …, salesFunnels } }`
  — and reading it a level up looks EXACTLY like a channel that declares nothing.** features-service
  answers 200 with the envelope; the client read `salesFunnels` at the top level, found nothing, and
  reported that the service had stated none, so every funded pair fleet-wide was passed over as
  unevaluatable for the whole life of the feature. Nothing contradicted it because every test mocked
  the shape the client expected — a client agreeing with itself and with nothing else — which is why
  `tests/unit/feature-sales-funnels-client.test.ts` pins the read to the nested level AND asserts a
  TOP-LEVEL payload is REFUSED. A payload assumption that no test states against the DEPLOYED
  contract is not an assumption anything can catch. The sibling read (workflow-service `GET
  /workflows` → `workflows`) really is top-level; check the contract per endpoint rather than
  assuming one envelope for the fleet. (2026-08-20.)
- **Which funnels a channel may be SOLD THROUGH is features-service's statement, asked per feature**
  (`GET /features/{slug}` → `feature.salesFunnels`, `src/lib/feature-sales-funnels-client.ts`). The feedback
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

## A channel the CUSTOMER operates gets its campaign with NO workflow — the absence of a DAG is the statement

A sales chain is sold LEG BY LEG, and the legs the platform does not automate are performed by a
human at the customer's side: they work the replies, they run the meeting, they close the deal.
There is no DAG for that and there must not be one — the work happens off-platform and the customer
reports what happened, lead by lead (declared per lead against lead-service). So provisioning's rule
"a channel with no active workflow is not provisioned, because a campaign with no DAG would sit
ongoing and produce nothing" is right for a channel the PLATFORM operates and wrong for one the
CUSTOMER operates, where funding used to produce nothing at all, forever, with nothing erroring.

- **WHO operates a channel is features-service's statement, asked and never held.** Its public
  acquisition-channel catalogue (`GET /public/channels` -> `channels[].operatedBy`,
  `src/lib/channel-operator-client.ts`) publishes `platform` | `customer` for every channel, and a
  customer-operated one states a daily operating cost of 0 because the platform spends nothing on
  it. No list of manual slugs exists here and none is to be introduced: the ninth customer-operated
  channel published upstream works with no change in this repo. `tests/unit/no-legacy.test.ts` fails
  on such a literal in src and on a second reader of `operatedBy`.
- **The read carries NO identity, because that path carries none** — the marketing site is generated
  from the same catalogue. It is made at most once per provisioning pass, and only when a pair
  actually needs deciding.
- **A slug the catalogue does not publish, and a catalogue that cannot be READ, both answer
  "platform"** — i.e. today's behaviour exactly. That direction is deliberate in both halves: an
  outage of this read must never stop a platform channel being provisioned, and it must never stand
  up a workflow-less campaign on a guess. The customer-operated pair waits for the next sweep, and
  the failure warns rather than passing in silence.
- **`campaigns.workflow_slug` is NULLABLE (migration 0054)**, and NULL means "this campaign has no
  DAG". Inventing a no-op workflow to satisfy the old NOT NULL would be a second, false
  representation of the same fact — the same translation table this service keeps deleting. The
  create/update API still REQUIRES a slug: only provisioning writes NULL, for a channel the
  catalogue states the customer operates.
- **Such a campaign is never scheduled, never triggered and never spends.** The scheduler states it
  on the ROW, not on a list of slugs: `workflow_slug IS NOT NULL` on the due-campaign claim, on
  `claimStuckCampaigns` (whose `(ongoing, nextRunAt=NULL)` is this campaign's PERMANENT resting
  state — nothing is stuck) and on the cadence snapshot (or it would read as in-flight and pin the
  60s active cadence forever). Never claimed means never planned, so it takes no turn either.
  `/start-run` 400s for it, and activation makes it ongoing and triggers nothing.
- **It exists so the customer's own work has something to be attributed to**: a budget line, a scope
  for stats, a thing they can pause. It holds its own (org, brand, funnel, channel) identity, so it
  never collides with the platform campaign working the same funnel.
- **A PLATFORM channel with no active workflow still produces nothing, with the same log line.**
  Nothing else changed: the funnels a channel may sell, the funding, the ceilings, the turn planner,
  the identity and the existing campaigns are all untouched.

(Set 2026-08-27.)

## Google Ads is a channel like any other — PAID REACH joins the funnel-funded family, and only the three behaviours that are genuinely about MAILBOXES stay outbound-only

A channel IS a features-service feature slug, so the first paid-reach channel is one line in the
family constant plus its `CHANNEL_BY_FEATURE` token, and NOT a second mechanism. Everything already
true of a provisioned campaign is true of it: it states its (offer, funnel, channel) identity at
birth, is provisioned one per funded pair off billing's `channels`/`offers` grains, is HELD when the
customer funds nothing for it, takes its turn on its own fill ratio, is gated and paced on the
ceiling that binds IT, and refuses a `maxBudget*` of its own.

- **Membership in `SALES_FUNNEL_FEATURE_SLUGS` is a MONEY statement, not a medium one** — "this
  campaign's ceiling is billing's, per (funnel, channel, offer), read live on every plan." Google
  Ads answers that identically to a cold email, which is why it is a member and not a family of its
  own. `isSalesFunnelFeature` is what every gate keyed on that question tests (gate-check's
  `isSalesFeature`, the `maxBudget*` refusal, the create-time funnel requirement, the turn planner,
  the funding sweep).
- **`OUTBOUND_SALES_FEATURE_SLUGS` is the narrower question — "does this share the brand's LEADS and
  SENDING ACCOUNTS?"** — and exactly three behaviours ask it, because all three are about contacting
  named people: the per-brand serialization cohort, the greedy workflow rotation (which prices a DAG
  on send-tagged outcome evidence a paid channel does not produce), and the extend-audience
  lifecycle email (which asks a customer for more PEOPLE to contact — nonsense for a campaign that
  buys impressions). A fourth, the legacy per-campaign `daily_budget_cents` MIRROR written by
  `PATCH /brands/:brandId/daily-budget`, is outbound-scoped for the same reason it exists at all:
  stamping a brand-level number on a paid-reach row would bind it AHEAD of the offer ceiling it was
  funded on, i.e. a second representation of one fact.
- **WHICH funnels it may sell is features-service's statement, asked per feature, never held here.**
  Google Ads states the three VISIT-led chains: an ad buys a click, and the conversation chain
  starts with a reply it has no way to sell. A funded pair the channel may not sell gets no
  campaign, exactly as before, and `tests/unit/no-legacy.test.ts` fails on a feature slug and a
  funnel key on one line of code outside the client that ASKS.
- **Only Google Ads.** features-service publishes a dozen paid-reach channels; workflow-service has
  a dynasty for none of them, and `fetchActiveWorkflowSlugForFeature` fail-CLOSES on that, so
  nothing would be provisioned even if they were swept in. They are still not swept in: a campaign
  for a channel nothing can execute would sit ongoing and produce nothing forever. Adding the next
  one is one line, once something can run it. **At the time of writing workflow-service has no
  `google-ads` workflow either** — the provisioning says so per sweep and stands the campaign up the
  moment the dynasty ships, which is the same fail-closed the feedback-request channel shipped under.
- **Each candidate's spend is read under ITS OWN feature.** The turn planner used to ask
  runs-service for every candidate's spend under the SEED's slug; the read filters on it, so a
  campaign of another channel answered ZERO, read as perfectly empty and took every turn. Harmless
  while a brand's campaigns were all cold email in practice, a live overspend the moment one brand
  mixes channels.
- **Nothing is special-cased anywhere else**: no new column, table, vocabulary or accumulator, and
  no branch in gate-check, campaign-funding, the offer/funnel adoption or the resume sweep.

(Set 2026-08-26.)

## A channel that ANSWERS a reply joins the same family — `ai-meeting-booking` is one line, and the closed set is WIDENED rather than DERIVED

`ai-meeting-booking` books the meeting out of a lead's stated sales interest instead of reaching a
new person. features-service publishes it (platform-operated, performing the leg out of a sales
interest), workflow-service holds its dynasty, sales-lead-service holds the follow-up queue the
workflow drains, and instantly-service asks this service to run it the moment a reply is qualified.
The missing link was here: a funded pair on it got a billing ceiling and no campaign.

- **It is one line in `SALES_FUNNEL_FEATURE_SLUGS` plus its `CHANNEL_BY_FEATURE` token
  (`ai_meeting_booking`), and nothing else.** No column, table, vocabulary, accumulator or branch.
  Everything already true of a provisioned campaign is true of it: it states its (offer, funnel,
  channel, leg) identity at birth, is provisioned one per funded pair, is HELD when the customer
  funds nothing for it, takes its turn on its own fill ratio, is gated and paced on the ceiling
  that binds IT, and refuses a `maxBudget*` of its own.
- **It is NOT in `OUTBOUND_SALES_FEATURE_SLUGS`, and that is the whole point of the narrower set.**
  It contacts nobody new, so it shares no lead population and no sending accounts (its own
  serialization cohort, `ai_meeting_booking`), produces no send-tagged outcome evidence for the
  greedy workflow rotation to price a DAG on, and must never receive the extend-audience email —
  asking for more PEOPLE to contact is nonsense for a channel whose whole input is people who
  already answered.
- **The family set is WIDENED, not DERIVED from the catalogue, and the reason is what membership
  MEANS.** It is a statement about whose ceiling paces this campaign — which features-service does
  not publish: its catalogue says which channels exist, who operates them, which funnels they may
  sell and which legs they perform, all of which this service already ASKS rather than holds. The
  set is also read synchronously on gate-check's money path and inside SQL, so deriving it would
  make an unreadable catalogue silently change whether a per-campaign budget column binds, in
  either direction. And auto-adopting every published channel would stand up campaigns for the
  dozen paid-reach slugs nothing can execute — campaigns that sit ongoing and produce nothing
  forever.
- **What replaces the silence is a REFUSAL that names the pair.** A funded pair on a
  PLATFORM-operated channel the family does not name is not provisioned and warns, saying that
  campaign-service does not pace it. Before this it was inserted anyway: outside the family,
  gate-check reads it as a non-sales campaign and enforces the (null) `maxBudget*` windows instead
  of billing's ceiling, the turn planner never ranks it and the funding hold never holds it — a
  campaign running a DAG against a ceiling nothing enforces. Fail-CLOSED, because the money is
  real; visible, because a channel that ships upstream should surface here the first sweep after a
  customer funds it.
- **A CUSTOMER-operated channel outside the family is untouched.** It has no DAG, is never claimed
  and never spends, so there is no ceiling for it to escape — that path is unchanged. The operator
  is only asked for a channel the family does not name, so the family's own channels cost no extra
  read.

(Set 2026-09-02.)

## A sales campaign row states the money that governs it — `maxBudget*` is REFUSED for the family

`gate-check` runs the whole campaign-budget-windows block under `if (!isSalesFeature)`, so a
`max_budget_daily_usd` / `weekly` / `monthly` / `total` on a sales-family row is inert BY
CONSTRUCTION: the family paces on billing's per-(funnel, channel, offer) ceiling, read live on
every plan. Correct behaviour, silent presentation — the row shows a dollar ceiling that decides
nothing, and it already cost a live diagnosis a detour (#396: `max_budget_daily_usd | 10.00` on a
campaign whose real ceiling was $50 read as a stale mirror).

- **`POST /campaigns` and `PATCH /campaigns/:id` 400 a sales-family campaign that STATES one**
  (`salesMaxBudgetRefusal`, `src/lib/sales-outreach-campaign.ts`), naming every field stated and
  where the ceiling belongs. The update leg tests the feature the update LEAVES the campaign on
  (the body's when it restates one, the row's otherwise). Presence is what is refused — the
  schema does not accept null there, so there is no "clear it" spelling to allow.
- **NON-sales campaigns are untouched and the columns are NEVER dropped**: every other feature
  family paces on them and `gate-check` enforces them. The `!isSalesFeature` branch is correct
  and is not to be touched.
- **No per-campaign ceiling is ever introduced for the sales family.** `daily_budget_cents` is a
  different thing (the funding mirror `fundingFromBudgets` prefers over billing) and is untouched
  by any of this — it was verified null on all 22 live sales campaigns.
- **Migration 0053** nulls the legacy values, scoped to the three sales slugs, auditing each row's
  previous four values in `campaign_max_budget_decisions` with the migration tag. It touched 20
  ongoing and 348 stopped rows in prod. Idempotent (a second run selects nothing) and reversible
  by the audit table. The values were legacy from before the funnel model: provisioning inserts
  sales campaigns with the columns null and the dashboard writes billing, so nothing was writing
  them even before the guard. (Set 2026-08-24, issue #398.)

## The ceiling a campaign paces on is its OWN OFFER's — the pair figure holds a sibling's money too

billing states daily ceilings at THREE grains on one read (`GET /internal/brands/:id/funnel-budgets`):
`funnels[]`, `channels[]` (per funnel × channel) and `offers[]` (per funnel × channel × OFFER, the
STORED grain — one row per campaign). The first two are SUMS of the third, so a funnel worked
through one channel for TWO offers is one summed `channels` row, and pacing both campaigns on it
lets each spend what the other was funded for. That is the exact failure the pair grain closed one
level up, re-opened one level down.

- **Precedence, one line, shared by the gate and the turn planner**: the campaign's own
  `dailyBudgetCents` → its (funnel, channel, OFFER) ceiling → its (funnel, channel) PAIR ceiling →
  its funnel ceiling → the brand pot. `offerCeilingCents` (`src/lib/funnel-budget-client.ts`) sits
  one notch below `channelCeilingCents` and answers the same three-way shape.
- **WHICH ROWS AN OFFER MAY CLAIM IS BILLING'S RULE, READ FROM BILLING** (`offerBudgetRows` /
  `resolveEntryOfferId`, billing `src/lib/brand-funnel-budgets.ts`): a ceiling that NAMES the offer
  always counts, and an UNSCOPED one (`offerId: null`, every ceiling written before offers existed)
  counts only when this offer is the brand's SOLE named one — then the money has exactly one
  campaign-owner. A brand naming two offers has no honest owner for an unscoped remainder, so it
  belongs to neither. Do not invent a second rule here; the two services would drift the day
  billing changes theirs.
- **Four cases answer `grain: "none"` and fall through to the pair figure, byte-identical to
  before**: a billing deploy that serves no `offers` field, a campaign stating NO offer (the
  pre-offer population — an offer is never fabricated for it), a brand whose stored ceilings name
  no offer AT ALL (20 of the fleet's 21 rows the day this shipped), and a funnel billing states no
  row for. The third is load-bearing: campaigns DO carry `offer_id` on brands billing still funds
  unscoped, and reading billing's per-offer rule literally there would unfund every one of them.
- **An offer the brand's money is not scoped to is UNFUNDED** (`cents: null`) — never a fallback to
  the pair, funnel or brand total. That is the whole point of the grain.
- **A channel mismatch resolves the same way one grain up**: an offer whose funnel is worked through
  exactly ONE channel binds whatever feature the campaign states (billing's default-channel
  attribution); a funnel SPLIT across channels funds only the channels it names.
- Nothing new is stored, cached or summed here: `channels` stays billing's own sum and provisioning,
  identity and the turn planner are untouched. (Set 2026-08-24.)

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

## The OFFER is part of what ONE campaign IS — a brand funding two offers on one (funnel, channel, leg) gets two campaigns

A customer funds their money PER OFFER: billing-service has keyed a daily ceiling on
(org, brand, funnel, channel, OFFER, leg) since its migration 0037, and the dashboard lets each
offer's ceiling be set separately on Offer Settings. This service carried `offer_id` (migration
0050) but the offer was in NONE of the three places that decide whether a funded thing already has
a campaign: not in the uniqueness Postgres polices, not in the existing-campaign lookup, and not in
the grain the funded pairs are derived at — which deduplicated two stored ceilings differing only
by offer into ONE provisioning question, on purpose. So a brand selling two offers through one
(funnel, channel, leg) had two ceilings and ONE campaign: the second offer was funded and never
provisioned, with no error, no log and no failing test. Verified in prod the day this shipped: 194
offers across 144 brands, 22 brands holding two or more, and no brand yet funding two offers on one
identity — armed, never fired.

- **`fundedPairs` reads billing's OFFER grain**, between `channels` and `legs`: `legs` first (it
  carries both the offer and the leg), then `offers`, then `channels`, then `funnels`. Each
  fallback keeps the population below it byte-identical, and a row whose `offerId` is null is an
  UNSCOPED ceiling — money written before a ceiling could name an offer — which provisions exactly
  as it always did.
- **Migration 0056 widens `uniq_campaigns_org_brand_funnel_channel` with `coalesce(offer_id, '')`.**
  A pure LOOSENING, the same shape as 0055's leg: every row that states no offer keys byte-identically
  to before, so no currently-valid state becomes invalid and no existing pair can start colliding.
  The index NAME still says funnel_channel, for the same reason it did after the leg: the funnel is
  still part of this identity and the ship that removes it renames the index.
- **THE LOOKUP GIVES THE SAME ANSWER BILLING GIVES ABOUT WHICH MONEY IT IS.** A pair whose ceiling
  NAMES an offer matches the campaign OF THAT OFFER. When that finds nothing there are two cases and
  only one is a second campaign to have: a SINGLE offer funded on the identity (every brand alive
  today) means the campaign already doing that work IS this pair's campaign whatever offer it
  states, so it is matched exactly as it always was; SEVERAL offers funded on it means there are
  genuinely two campaigns to have and this pair gets its own. `sharedIdentity` on the pair is that
  count, and it is what makes the widening a loosening at runtime rather than only in the index.
- **NOTHING IS EVER STAMPED ON A CAMPAIGN THAT STATES NO OFFER.** Only brand-service knows which
  offer a live campaign belongs to (`adoptOfferForPairSafely` writes one, and only where the (org,
  brand) pair holds exactly one), and guessing from a ceiling would move real money onto the wrong
  proposition. That is why the single-funded-offer case LEAVES the campaign alone instead of
  adopting it the way the leg did — the leg identifier came from the same customer statement the
  campaign was already working; the offer does not.
- **WHICH funnels a funded offer may be sold through is asked OF THAT OFFER.** A brand that funds a
  NEW offer has no campaign stating it, so its declaration was never read by
  `resolveDeclaredFunnels` — `funnelsByOffer` returns what that pass already read and the funded
  offer is asked directly otherwise. An unreadable declaration provisions nothing and warns; an
  offer that does not declare the funnel provisions nothing and says so. The `contested` refusal
  (several offers declare one funnel, none outranks another) is now only reached by a pair whose
  ceiling names NO offer — when the money names one, there is nothing ambiguous left to wait on.
- **The deterministic NAME appends the offer when the pair states one**, before the leg. Two offers
  of one (funnel, channel, leg) would otherwise collide on `uniq_campaigns_org_name` and the second
  insert would be swallowed as a race — the funded-and-never-provisioned failure one layer down. An
  offer-less campaign keeps the name it has always had, byte for byte.
- **The create route matches the same way, in two steps**: the campaign of THIS offer wins, and only
  when there is none does an offer-LESS incumbent match — which is what happened before the field
  was part of the key, and is how such a campaign learns the offer it sells from a caller that now
  states one. A create stating a DIFFERENT offer is a new campaign, and a `23505` hands back the
  winner of the same offer rather than a campaign selling another one. A `PATCH` that moves a
  campaign onto an identity another live campaign holds is a 409.
- **Nothing about pacing, scheduling or serialization changed.** `offerCeilingCents` already paced
  on the offer and `spendable-budget` already reported at that grain; what was missing was only that
  a second campaign could not EXIST to be paced. No column, table, vocabulary or accumulator was
  added, and no live campaign changed id, status, money or history.

(Set 2026-09-06.)


## A campaign states the single funnel LEG it is bought for — features-service's identifier, carried and never parsed

A sales funnel is a chain of steps, and the thing a customer actually BUYS is one of its **LEGS**:
the leg that takes a lead sitting at one step and moves it to the next. Until now a campaign stated
a FUNNEL and the leg it performs was derived downstream, by intersecting that funnel with the legs
its acquisition channel can produce. That derivation cannot survive the funnel leaving a campaign's
identity — and it is leaving, because a leg belongs to SEVERAL funnels at once and a customer buys
the leg, not the funnel. Two different legs can land on the SAME step (a booked meeting is reached
from a positive reply AND from a website visit), so the step a leg lands on does not identify it.
`campaigns.leg_key` (migration **0055**) is the statement that does.

- **features-service OWNS the vocabulary and MINTS the identifier** (`lib/funnel-legs.ts`,
  published on its `GET /public/channels` catalogue as `legs[].legKey`). This column carries that
  value and nothing else. No leg vocabulary, enum, list or matrix exists here and none is to be
  introduced — the same posture this service holds for the goal, the offer and the channel.
- **OPAQUE, and NEVER PARSED.** The two steps a leg connects ride BESIDE the identifier on the
  catalogue (`fromStep` / `toStep`), so a consumer that wants them READS them there. A well-formed
  `a_to_b` that no catalogue names is still not a leg, so splitting the string can only ever invent
  one. `tests/unit/no-legacy.test.ts` fails on a leg-key LITERAL anywhere in `src` and on any
  `split`/`slice`/`match`/`startsWith` of a `legKey`.
- **AN ENTRY LEG IS AN ORDINARY LEG.** A leg that STARTS a funnel — the lead was on no funnel
  before — carries a plain identifier like every other one (`start_to_conversation`). It is the
  special case in features-service's DATA, never in the vocabulary, so there is no branch here.
- **NEVER derived.** Not from the funnel (several legs sell one funnel and one leg belongs to
  several funnels, which is the whole reason this word exists), not from the channel, not from the
  workflow. It is stated by the creator or it is NULL.
- **OPTIONAL, deliberately and temporarily.** Requiring it is a breaking request-contract change,
  so a create that states no leg behaves EXACTLY as it did before the column existed and callers
  state it as they migrate. `PATCH` sets or clears it, which is how a campaign created before it
  could state a leg says which one it buys, without a second campaign.
- **It decided no MONEY question at first, and now it decides the FINEST one** — see the section
  below. `idx_campaigns_org_leg` still serves the per-leg attribution read it was added for.
- **It IS part of the uniqueness, because a campaign bought for one leg is not the campaign bought
  for another.** `uniq_campaigns_org_brand_funnel_channel` gained `coalesce(leg_key, '')`, and the
  create route's incumbent lookup and its `23505` winner lookup gained the same clause — without
  that, a brand working ONE channel for TWO legs cannot hold two live campaigns at all: the second
  create is read as a restatement of the first, which is precisely the pair the leg exists to tell
  apart. **The widening is a pure LOOSENING**: `coalesce` collapses every row that states no leg
  onto the value it had before the column existed, so every campaign alive today keys
  byte-identically and no existing pair can start colliding. A `PATCH` that moves a campaign onto an
  identity another live campaign holds is a **409**, not an internal error.
- **The NAME of that index still says `funnel_channel` on purpose** — the funnel is still part of
  this identity. Removing the funnel from a campaign, and renaming the index with it, is the LATER
  ship; this one adds the leg beside it and changes nothing about what is required at create.

(Set 2026-08-30.)

## The LEG is what a campaign is PROVISIONED, FOUND and PACED on — the sales funnel becomes a way of READING legs

Stating the leg was half of it: the funnel was still what this service provisioned on, keyed its
existing-campaign lookup on, and asked other services about. A leg belongs to SEVERAL funnels at
once, so a funnel can never say which of them the customer bought — and a (funnel, channel, offer)
worked for TWO legs was one provisioning question, one identity and one summed ceiling, i.e. one
campaign doing two jobs on money funded for two.

- **billing's LEG grain is the finest it stores and the unit ONE campaign is provisioned per**
  (`legs[]` on `GET /internal/brands/:id/funnel-budgets`: funnel, channel, offer, `legKey`). Every
  coarser grain billing serves is a SUM of these rows, so nothing is added up here — `fundedPairs`
  reads `legs` first, falls back to `channels`, then to `funnels`. **A row whose `legKey` is null
  is a ceiling written before legs existed and provisions a leg-less campaign byte-identically to
  what the pair grain provisioned for it**, which is why every brand alive today is untouched.
- **`legCeilingCents` is one notch below `offerCeilingCents`**, in gate-check and in
  `campaign-funding`, on the one shared precedence: own `dailyBudgetCents` → LEG → offer → pair →
  funnel → brand pot. Same three answers and the same reasons as every grain above it, so a
  campaign that states no leg — and a brand whose ceilings name none — answers `none` and paces
  exactly as it always did. The offer half of the match is billing's own rule, mirrored rather
  than re-invented. A leg the brand's money is not scoped to is UNFUNDED, never a fallback to the
  offer or pair figure: that is the whole point of the grain.
- **WHAT A CHANNEL CAN DO IS ASKED IN THE VOCABULARY OF WHAT WAS BOUGHT.** A pair that states a
  LEG asks "does this channel perform this leg?" and names NO funnel — features-service publishes
  every channel's legs as `channels[].stepTransitions[].legKey` on the same public catalogue this
  pass already reads for who operates them, so one read answers both and the identifier is joined
  verbatim. A pair that states no leg keeps asking the per-feature FUNNEL question, unchanged: that
  IS the question for a ceiling written before a campaign could state a leg. An unreadable
  catalogue provisions nothing for that leg and says so — a funded pair we failed to EVALUATE is
  not a pair we evaluated and rejected.
- **The existing-campaign lookup keys on the leg**, so a brand working ONE channel for TWO legs
  gets two campaigns instead of finding the first one for the second pair and never provisioning
  it. The insert states the leg, and the deterministic NAME appends it — two legs of one (funnel,
  channel) would otherwise collide on `uniq_campaigns_org_name` and the second insert would be
  swallowed as a race. **A leg-less campaign keeps the name it has always had, byte for byte.**
- **A campaign already doing the work is ADOPTED, never twinned.** When a pair states a leg and no
  campaign of that leg exists, the LEG-LESS campaign of the same (org, brand, funnel, channel) is
  that pair's campaign — it has been doing exactly this work since before a campaign could say
  which leg it was bought for — so the leg is stamped on it. Leaving it alone inserts a twin
  beside it: two live campaigns doing one job, splitting one identity's history and spending on two
  ceilings, which is the funnel-less-ancestor recurrence one word along. Nothing else about the row
  moves (id, status, schedule, spend and history are untouched) and the money is the same money
  restated at the grain it was funded at. Guarded on the row still stating no leg, so a re-run
  writes nothing and a race with a live create cannot overwrite it; a `23505` leaves the row alone
  and says so.
- **`spendable-budget` counts at the LEG grain too**, or a (funnel, channel, offer) funding two
  legs would give one campaign the whole summed figure and report the other as running on nothing —
  a secondary surface contradicting the ceiling the gate actually binds. `legKey` rides on the row
  and the campaign line; the grain enum gained `leg`.
- **Nothing about pacing, scheduling or serialization changed.** The turn planner still ranks on
  spent ÷ own ceiling (that ceiling is simply the leg's when one binds), the cohorts are still the
  acquisition channel's, the cadences are the same, and no campaign changed id, status, money or
  history because of this.
- **The funnel COLUMN stays.** It is still part of the identity index, still what billing's rows
  and brand-service's declarations are keyed on, and still what a leg-less campaign is provisioned
  by. Dropping it is a later, separate step once nothing reads it.

(Set 2026-08-31.)

## A campaign that CAN state its leg states it — the backfill is a SCRIPT, and it derives nothing new

The write path states the leg, so every campaign created since migration 0055 carries one. Every
campaign that predates it does not: 234 rows carry a funnel and a channel and no leg. While the
column is blank, every consumer resolving what such a campaign buys falls back to DERIVING the leg
from its funnel and its channel — the derivation the column exists to replace — per-leg attribution
answers about one campaign in 235, and a ceiling stated at the leg grain cannot find the campaign it
paces.

- **`scripts/backfill-campaign-leg.ts` writes down the answer the consumers already compute.**
  features-service publishes, on the ONE public catalogue this service reads
  (`channel-operator-client.ts`), which legs each CHANNEL performs and which funnels each LEG is a
  leg of. The leg a campaign is bought for is the one in BOTH sets. Nothing new is decided, so a
  backfilled campaign reads identically to the way it read before — this makes explicit what is
  already inferred and changes no campaign's meaning.
- **The identifier is features-service's, read from what it publishes.** Nothing is minted, nothing
  is parsed, no list of legs exists here — the same posture this service holds for the goal, the
  offer and the channel.
- **A campaign that does not resolve to EXACTLY ONE leg is LEFT ALONE**: no leg, several legs (the
  funnel genuinely does not say which was bought), a channel the catalogue does not publish, a
  funnel token no catalogue names. Each is reported with its reason, grouped by the (funnel,
  channel) pair. An unreadable catalogue writes NOTHING at all and throws — "the catalogue states no
  leg" and "the catalogue could not be asked" are different answers.
- **Idempotent, reversible, previewable.** It selects and writes only rows whose `leg_key` is still
  NULL and restates that guard in the UPDATE, so a second run writes nothing and a run racing a live
  create cannot overwrite a leg a caller just stated; the previous value is NULL by construction, so
  the undo is exactly the ids it prints (which it emits as a statement); and it DRY-RUNS by default,
  `--apply` being the only way to write.
- **A row whose leg would COLLIDE with a live sibling's identity is left alone, per row.** A
  campaign is unique on (org, brand, funnel, offer, leg, channel) among `ongoing` rows and a
  leg-less row keys as the empty string, so stating a leg can land a row exactly on top of a live
  campaign that already states it — Postgres saying the two are the same campaign. That is a real
  answer about the data, reported like any other left-alone reason. Caught PER ROW, because
  unhandled it aborts the whole run on the first collision and leaves every later campaign
  unwritten (observed in the production run: two campaigns provisioned mid-run, one of them a twin).
  Any OTHER write error still throws.
- **`leg_key` is the only column that moves** (plus `updated_at`). No campaign is created or
  deleted, and no status, money, schedule, history or other word of the identity is touched.
- **Not a migration, because SQL cannot make the read** — the same reason the offer backfill is a
  script. It is RE-RUNNABLE rather than one-shot: a channel that gains a leg upstream, or a campaign
  that becomes resolvable later, is picked up by running it again, never by widening what it is
  willing to guess.

(Set 2026-09-06.)

## A lead reaching a STEP runs the campaign bought for the leg OUT of it, NOW — an event entry point beside the clock

Everything this service schedules is on a clock: the tick claims what is due, `/end-run` reschedules
what just finished. Nothing could say "this just happened, run the campaign responsible for it", so
a prospect who states a sales interest waited for that campaign's next daily tick before anyone
answered them — which is the whole problem the leg they bought exists to solve.

`POST /internal/campaigns/trigger-for-step` (`src/lib/step-trigger.ts`) is that entry point. The
caller names the scope its lead is on — brand, offer, funnel — plus the STEP just reached, and the
campaign bought for the leg OUT of that step runs immediately.

- **It is a LOOKUP over state already held, not a new model.** A campaign states its (org, brand,
  offer, funnel, channel) and the single LEG it was bought for; features-service publishes which leg
  leaves which step. Joining the two is the whole resolution — no column, table, vocabulary,
  accumulator or second scheduler.
- **THE LEG IS ASKED, NEVER DERIVED, AND NEVER PARSED.** The legs out of a step come from the public
  catalogue this service already reads (`GET /public/channels` -> `legs[]`, each carrying `legKey`,
  `fromStep` and the funnels it is a leg of), joined VERBATIM against `campaigns.leg_key`. The steps
  ride beside the identifier precisely so nobody splits it, and a well-formed `a_to_b` no catalogue
  names is still not a leg. `channel-operator-client.ts` stays the ONE reader of that catalogue.
- **The FUNNEL is part of the question because a leg belongs to several.** `conversation ->
  meeting_booked` is a leg of more than one chain, and only the customer's funding says which one
  they bought — so it is named by the caller rather than derived from the leg. (`conversation` is
  the step key every customer-facing surface labels "sales interest"; the label is not the token.)
- **THE GATE IS UNTOUCHED.** The dispatch is the SCHEDULER'S OWN — same anchor run
  (`ensureCampaignRunId`), same greedy workflow pick, same `/execute` — so the run starts at
  `gate-check`, the first node of every DAG, and is refused there exactly as a scheduled run is.
  Before dispatching it applies the same two CORRECTNESS guards the scheduler applies (never two
  runs of one campaign, never two of one brand COHORT — the outbound channels share a lead
  population and a set of sending accounts) and the one shared funding definition
  (`campaignFunding`, fail-CLOSED). A reply must never make a defunded, held or stopped campaign
  spend.
- **THE SCOPE FAILS LOUD; THE ANSWER IS OFTEN A NAMED NOTHING.** A step no catalogue publishes, a
  funnel naming none of the four, and a catalogue that cannot be READ are a 400/400/502 — answering
  them with "nothing to do" would make an unreachable feature indistinguishable from a brand that
  simply has no campaign for this leg. Everything else is a 200: no campaign performs the leg
  (the common case, empty), or one does and was skipped for a NAMED reason (`no_workflow` — the
  customer operates that channel, so there is no DAG; `unfunded`; `run_in_flight`;
  `cohort_run_in_flight`; `incomplete_campaign`; `dispatch_refused`). A caller can tell those from
  an outage, which is the whole point.
- **The OFFER is matched exactly and never inferred.** A campaign stating none is not the campaign
  of the offer the caller named — the same posture the column has had since it was added.
- **The time-based path is byte-identical.** No claim, cadence, defer, turn or reschedule changed;
  this only adds a second way in.
- **The downstream needed NO new payload.** A run names its campaign (`x-campaign-id`), and
  `GET /campaigns/:id` already serves that row's `offerId`, `funnelKey` and `legKey` — so a node
  that must read the funnel's own configuration from brand-service resolves it from the campaign.
  Nothing was added to the `/start-run` response, which already re-serves several campaign fields
  and at least one retired vocabulary; another copy would make that worse.

(Set 2026-09-02.)

## A run that had NOTHING TO DO waits on the reason's timescale — the workflow SAYS so, and it is not exhaustion

Everything on the `/end-run` path assumed a completed run had done work, so it rescheduled on the
RUN cadence (`RERUN_GRACE_MS`, 10s). A channel that answers ONE interested prospect per run breaks
that assumption: its DAG asks another service for the next person owed an answer, and when nobody
is owed one the run legitimately does nothing, completes normally, and is re-fired eleven seconds
later — forever. Measured in prod over 24h on ONE such campaign that had answered nobody: **14,841
run rows attributed to it against 28,336 across the WHOLE fleet**, i.e. one idle campaign was 52%
of the platform's entire run ledger (2.3 GB table), plus one affordability gate-check per turn for
a run that would do nothing.

- **The workflow SAYS it had nothing to do** — `noWorkAvailable` on the `/end-run` body
  (`EndRunBody`, `src/schemas.ts`). OPTIONAL, and ABSENT means "this run did work": every caller
  that does not send it behaves byte-identically to before the field existed, which is why cold
  email is untouched without a single branch on a feature slug. This service cannot infer it —
  only the DAG knows its branch was the empty one — and inferring it from an empty result would be
  the same "empty remainder reads as a verdict" mistake the exhaustion gate already closed.
- **It changes exactly ONE thing: the reschedule delay** (`NO_WORK_RECHECK_MS`, 10 min,
  `src/lib/idle-run.ts`). It never stops a campaign, never marks anything exhausted, never touches
  the stop reason, and no other decision reads it. The campaign is funded and correct; it simply
  has nobody to answer this minute.
- **DELIBERATELY NOT the audience-exhaustion recheck**, though both are ten minutes for the same
  reason. `NO_SERVEABLE_AUDIENCE_RECHECK_MS` is reached through `stopCampaign=true`, whose whole
  vocabulary is a cold-email AUDIENCE running out of PEOPLE, and it gates a STOP. Routing this
  channel through it would conflate two different facts and put a campaign one evidence-check away
  from `audience_exhausted`, which is sticky. Same figure, separate constant, separate reason.
- **A FAILED run's claim is ignored** — the failure backoff (60s) still wins, because a run that
  failed says nothing trustworthy about whether there was work to do.
- **This is the idle BACKSTOP, not the reactivity.** When a prospect actually shows interest the
  responsible campaign is run IMMEDIATELY through `POST /internal/campaigns/trigger-for-step`,
  which dispatches without consulting `nextRunAt` at all — pinned by a test that parks a campaign
  ten minutes out and asserts the event still fires it. The slow cadence is what happens when
  nothing has happened, so ten minutes is the ceiling on IDLE latency, never on answering somebody.
- **workflow-service half**: the DAG for that channel must send `noWorkAvailable: true` on its
  nothing-to-do branch. Until it does, this field is never set and behaviour is exactly today's.

(Set 2026-09-05.)

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
- **It IS part of the identity key since 2026-09-06** (migration 0056 — see the section above).
  `uniq_campaigns_org_brand_funnel_channel` spans `coalesce(offer_id, '')`, which is what lets a
  brand funding two offers on one (funnel, channel, leg) hold two live campaigns. The `coalesce` is
  load-bearing exactly as it is for the funnel and the leg: without it a brand could grow unlimited
  offer-less campaigns on one (funnel, channel), and with it every row that states no offer keys
  byte-identically to the way it did before. The field stays OPTIONAL; making it required is a later
  wave and this widening did not need it.
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
- **A campaign that ALREADY EXISTS with no offer is ADOPTED on the tick — the script is not the
  loop.** A campaign attributed to no offer is invisible on every offer-scoped surface: the
  dashboard's offer page lists the campaigns OF THAT OFFER, so an unattributed one belongs to none
  of them and appears nowhere, while it runs and spends. Provisioning found a live campaign for the
  triple and moved on, so the row stayed unattributed forever and only a hand-run script closed it.
  Prod 2026-08-24: org `100ed4eb` / brand `fbe3ce77`, campaign `16705a37` ongoing on
  `sales_meetings_from_conversation`, no offer — the pair's one offer `231bb036` was created 28
  minutes BEFORE it. Resolvable at create time, resolvable now, and nothing on this service's own
  cadence was ever going to state it. `adoptOfferForPairSafely`
  (`src/lib/campaign-offer-adoption.ts`) applies the SAME rule the script states, from
  `ensureFundedFunnelCampaigns` — asked FIRST, before every early return there, because a pair whose
  funnel declaration is empty or unreadable still has a live campaign the customer cannot see.
  Same argument as the funnel-less-ancestor adoption (#377): an invariant a migration can only ever
  state once is not an invariant, so this is NOT shipped as a one-shot migration and adds no table,
  column or accumulator.
  - **The rule is NOT widened**: exactly one offer on the (org, brand) PAIR, or nothing is written.
    `x-org-id` on `GET /internal/brands/{brandId}/offers` (`src/lib/brand-offers-client.ts`) and
    `org_id` on both statements are load-bearing — a brand row carries one offer per claiming org,
    so resolving by brand alone writes another org's offer onto this org's campaign, inside the very
    grouping the column exists to make correct. Pinned by `tests/unit/no-legacy.test.ts`.
  - **Nothing is read unless something is missing.** The pre-check selects the pair's offer-less
    campaigns; none → no brand-service read, no log, on every tick of every brand. A pair that IS
    missing one is asked at most once per `OFFER_ADOPTION_RECHECK_MS` (10 min, the same figure and
    argument as `FUNDING_RECHECK_MS` — an offer comes into being when a person creates one).
  - **Zero or several offers is SAID, not silent — but only when a LIVE campaign is affected.** A
    live campaign nobody can see on their offer page is the customer-visible harm. A pair whose only
    unattributed rows are stopped is the pre-offers population the script proved permanently
    unattributable (145 rows, most belonging to orgs brand-service does not know at all), and
    repeating that every ten minutes forever would bury the signal.
  - **A stopped row IS written when its own pair genuinely resolves** — it decides whose offer
    totals its history lands in, exactly as its funnel does. Only `offer_id` moves: status, stop
    reason, funnel, schedule and budget are untouched, and the offer still decides no money
    question. Idempotent (the `offer_id IS NULL` guard is restated in the UPDATE, so a re-run
    writes nothing and a race with a live create cannot overwrite it) and fail-SOFT (an attribution
    correction must never hold up the provisioning that called it).

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

## Brand serialization counts the runs of the SAME COHORT — a brand's PR run, and its ad run, are not its cold email's business

`hasLiveRunForBrandCohort` asks runs-service campaign by campaign, over the brand's `ongoing`
sales-family campaigns **of one cohort**. It must NOT be a brand-wide `listRuns({ brandId })`: runs of the brand's PR,
AI-visibility, hiring and VC campaigns carry the same brand, so a brand whose PR outreach ticks
continuously (736 completed runs in one morning, one always in flight) reads as permanently busy and
EVERY sales campaign of that brand is deferred 60s, every tick, forever. That is a full stop, and it
appears in no log at all because the defer is the routine path. The candidate set is read from the
DB, not from the campaigns claimed this tick — the one actually running is precisely the one NOT
claimed (its `nextRunAt` is null while in flight). (Set 2026-08-02.)

**A cohort is what genuinely SHARES something** (`serializationCohort`, funnel-campaigns.ts): the
three OUTBOUND cold-email channels are one cohort — same lead population, same sending accounts, so
two of their runs at once would contact the same people from the same mailboxes — and every other
channel is its own, keyed on the acquisition channel it already states. A paid-reach campaign is
therefore serial against ITSELF (one live run per external ad account per brand, the same
conservatism) and against nothing else. Holding a funded Google Ads campaign behind a cold-email run
would be the identical mistake one level down from the PR one above: a defer that fires every tick,
for a reason that is not true of it, appearing in no log at all. The TURN is per cohort too, so a
brand working one funnel by cold email and another by ads fires one of each rather than one in
total. (Set 2026-08-26.)

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
    `completed` count, `hasLiveRunForCampaign`, `hasLiveRunForBrandCohort`) filters on it, so
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
