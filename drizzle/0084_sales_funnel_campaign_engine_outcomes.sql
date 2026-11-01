-- ENGINE-PER-OUTCOME-SWITCH (owner 2026-11-01, GTM Factory v10 "one Engine per outcome"): the RESULTS (catalogue step
-- keys) whose workflow pick this funnel campaign hands to features-service's Engine (Thompson on value per dollar),
-- one result at a time. Empty = every pick stays the service path (every row before). Purely additive, idempotent.
ALTER TABLE "sales_funnel_campaigns" ADD COLUMN IF NOT EXISTS "engine_outcomes" text[] NOT NULL DEFAULT '{}';
