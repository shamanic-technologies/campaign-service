-- Was this campaign EARNING on a given past day?
--
-- This service knew a campaign's status and whether an audience had run dry, and kept only the
-- CURRENT answer. So nobody could replay a past day: a monthly run-rate had to count money
-- sitting behind campaigns that were paused, and one month's self-serve figure came out NEGATIVE
-- and had to be published as "we could not measure this". Paused is not MRR, and a campaign
-- holding budget with no audience left to work is not MRR either — but only this service can say
-- which campaign was in which state on the 14th.
--
-- Three pieces, all append-only, all recording what the writer ALREADY held at write time:
--
--   1. campaign_status_transitions  — every status change, forever. The status column keeps the
--      current answer; this keeps how it got there.
--   2. campaign_audience_exhaustion — gains an END. It recorded a beginning and nothing else, so
--      a replay could see a campaign go dry and never see it come back.
--   3. campaign_audience_availability — the CAMPAIGN-level "could it reach anybody" verdict
--      /end-run already computes and throws away. An audience-level mark cannot answer it: a
--      campaign with three audiences and one dry one was working fine, and which audiences a
--      campaign targeted on a past day is not recorded anywhere.
--
-- NOTHING IS BACKFILLED. A day before a campaign's record begins is answered "not recorded", never
-- guessed and never zero. The one row this migration writes per existing campaign states the
-- PRESENT (its status right now, at the migration's own timestamp) — that is an observation made
-- today, not a claim about yesterday, and it is tagged `record_opened` so it can never be mistaken
-- for a transition that happened.
--
-- Idempotent throughout (IF NOT EXISTS / IF EXISTS / NOT EXISTS guards), so a partial-apply replay
-- is safe and a second run writes nothing.

-- 1 ── Every status change leaves a trace ------------------------------------------------------
--
-- from_status NULL = the campaign was born (or its record was opened here). A transition is never
-- updated and never deleted: it is what happened.
--
-- `id` is stated explicitly on every insert below. The drizzle column mints it in APPLICATION code
-- ($defaultFn), so the table has no database default and a raw-SQL insert that omits it dies on a
-- not-null violation — at BOOT, before the port binds.
CREATE TABLE IF NOT EXISTS "campaign_status_transitions" (
	"id" text PRIMARY KEY NOT NULL,
	"campaign_id" text NOT NULL,
	"org_id" text NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"reason" text,
	"source" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- Serves the whole read: "what was this campaign's status at the end of day D" is the newest row
-- at or before that instant, and "when does this campaign's record begin" is the oldest row.
CREATE INDEX IF NOT EXISTS "idx_cst_campaign_occurred_at"
  ON "campaign_status_transitions" USING btree ("campaign_id","occurred_at");
CREATE INDEX IF NOT EXISTS "idx_cst_org_occurred_at"
  ON "campaign_status_transitions" USING btree ("org_id","occurred_at");

-- Open the record for every campaign that exists today, at TODAY's timestamp.
--
-- Deliberately NOT created_at or updated_at: a campaign created in June and stopped in August has
-- an updated_at that says nothing about which of the two states it held on the 14th of July, and
-- reading either as a transition time would invent exactly the history this feature refuses to
-- invent. So the record begins now, every earlier day reads "not recorded", and every later day is
-- answered from what actually happened.
INSERT INTO "campaign_status_transitions" ("id", "campaign_id", "org_id", "from_status", "to_status", "reason", "source", "occurred_at")
SELECT gen_random_uuid()::text, c."id"::text, c."org_id", NULL, c."status", c."stop_reason", 'record_opened', now()
FROM "campaigns" c
WHERE NOT EXISTS (
  SELECT 1 FROM "campaign_status_transitions" t WHERE t."campaign_id" = c."id"::text
);

-- 2 ── Exhaustion becomes a PERIOD -------------------------------------------------------------
--
-- It was one row per (campaign, audience) whose `exhausted_at` was overwritten on every fresh
-- observation: a beginning, repeatedly restated, with no end. The bandit only ever asked "is this
-- audience dry right now", so that was enough for the live path and useless for a replay.
--
-- A period now says when the dryness STARTED (`exhausted_at`, untouched from here on), when it was
-- last CONFIRMED (`last_observed_at`, the value the live TTL read uses — byte-identical behaviour
-- to the overwritten `exhausted_at` it replaces), and when it ENDED (`ended_at`).
--
-- An OPEN period with no `ended_at` is not open forever: the live rule is that a mark older than
-- the 24h TTL stops excluding the audience, so such a period ends at `last_observed_at + 24h`.
-- That is not a guess — it is the same rule the bandit runs on, read backwards.
ALTER TABLE "campaign_audience_exhaustion" ADD COLUMN IF NOT EXISTS "id" text;
ALTER TABLE "campaign_audience_exhaustion" ADD COLUMN IF NOT EXISTS "last_observed_at" timestamp with time zone;
ALTER TABLE "campaign_audience_exhaustion" ADD COLUMN IF NOT EXISTS "ended_at" timestamp with time zone;
ALTER TABLE "campaign_audience_exhaustion" ADD COLUMN IF NOT EXISTS "end_reason" text;

-- Every existing mark is an OPEN period last confirmed when it was written. Nothing is invented:
-- that instant is exactly what the row already said.
UPDATE "campaign_audience_exhaustion" SET "id" = gen_random_uuid()::text WHERE "id" IS NULL;
UPDATE "campaign_audience_exhaustion" SET "last_observed_at" = "exhausted_at" WHERE "last_observed_at" IS NULL;

ALTER TABLE "campaign_audience_exhaustion" ALTER COLUMN "id" SET NOT NULL;
ALTER TABLE "campaign_audience_exhaustion" ALTER COLUMN "last_observed_at" SET NOT NULL;
ALTER TABLE "campaign_audience_exhaustion" ALTER COLUMN "last_observed_at" SET DEFAULT now();

-- The old primary key was (campaign_id, audience_id), which is precisely what stops a second
-- period ever existing for a pair that went dry twice. Replaced by a surrogate key plus a PARTIAL
-- unique index holding the invariant that actually matters: at most ONE OPEN period per pair.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'campaign_audience_exhaustion_pk') THEN
    ALTER TABLE "campaign_audience_exhaustion" DROP CONSTRAINT "campaign_audience_exhaustion_pk";
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'campaign_audience_exhaustion_id_pk') THEN
    ALTER TABLE "campaign_audience_exhaustion" ADD CONSTRAINT "campaign_audience_exhaustion_id_pk" PRIMARY KEY ("id");
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_cae_open_period"
  ON "campaign_audience_exhaustion" USING btree ("campaign_id","audience_id")
  WHERE "ended_at" IS NULL;

-- Serves the live TTL read (open periods confirmed inside the window) and the historical overlap
-- read (every period of a campaign, ordered).
CREATE INDEX IF NOT EXISTS "idx_cae_campaign_last_observed_at"
  ON "campaign_audience_exhaustion" USING btree ("campaign_id","last_observed_at");

-- 3 ── The campaign-level "could it reach anybody" state, as effective-dated periods ------------
--
-- /end-run already computes this verdict (hasServeableAudience) on every run that reports its
-- served audience came back empty, and throws it away. It is the only honest campaign-grain answer
-- to "did it have an audience to work": the per-audience marks cannot be summed into one, because
-- the set of audiences a campaign targeted on a past day is recorded nowhere, and a campaign with
-- three audiences and one dry one was working perfectly well.
--
-- BOTH states are stored, not only the droughts. A table of droughts alone cannot tell "this
-- campaign had people all month" from "we were not recording yet" — the absence of a row means
-- both — and a day before the record begins must be legible as not recorded. Storing the state
-- makes that free: a day covered by no period is not recorded, full stop, and nothing is guessed.
--
-- One row per EPISODE, not per observation: a run that restates the current state only moves
-- `last_observed_at`. A run that flips it closes the open period and opens the opposite one, so a
-- campaign that went dry and was later given an audience reads as earning again from that day.
CREATE TABLE IF NOT EXISTS "campaign_audience_availability" (
	"id" text PRIMARY KEY NOT NULL,
	"campaign_id" text NOT NULL,
	"org_id" text NOT NULL,
	"has_audience" boolean NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);

-- At most one CURRENT period per campaign. Partial, so the closed history beside it is
-- unconstrained however long the campaign lives.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_caa_current_period"
  ON "campaign_audience_availability" USING btree ("campaign_id")
  WHERE "ended_at" IS NULL;

CREATE INDEX IF NOT EXISTS "idx_caa_campaign_started_at"
  ON "campaign_audience_availability" USING btree ("campaign_id","started_at");
