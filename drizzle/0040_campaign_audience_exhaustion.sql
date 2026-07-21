-- Per-(campaign, audience) exhaustion marks. Written by POST /internal/end-run when a run's
-- single bandit-picked audience returns no leads (the DAG's stopCampaign=true, reinterpreted
-- as AUDIENCE-scoped exhaustion rather than a whole-campaign stop). The audience bandit
-- excludes any audience with a mark fresher than the 24h TTL; the campaign is auto-stopped
-- only when EVERY targeted audience is exhausted. The 24h TTL re-probes each audience daily
-- because Apollo can add new matching leads to an audience over time, so an exhaustion is
-- never permanent. Idempotent (IF NOT EXISTS) so a partial-apply replay is safe.
CREATE TABLE IF NOT EXISTS "campaign_audience_exhaustion" (
	"campaign_id" text NOT NULL,
	"audience_id" text NOT NULL,
	"exhausted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "campaign_audience_exhaustion_pk" PRIMARY KEY("campaign_id","audience_id")
);
CREATE INDEX IF NOT EXISTS "idx_cae_campaign_exhausted_at" ON "campaign_audience_exhaustion" USING btree ("campaign_id","exhausted_at");
