-- A campaign's OWN root run (HOTFIX ANCESTOR-1015).
--
-- Every execution used to be dispatched under `parent_run_id`, the creator's `x-run-id`. That run
-- can belong to ANOTHER campaign's tree: prod 2026-10-12, Doc Dinners' "Affection" funnel units were
-- born under a chat-service judgment run stamped with the Apollo sourcing unit of another funnel
-- campaign, so runs-service refused every run of the AI Meeting Booking unit (409 Parent-child field
-- conflict) and a Meta Ads form waited 14 h. Executions now hang under a root run campaign-service
-- mints once and keeps here; `parent_run_id` stays as provenance. NULL = minted at the next dispatch.
ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "anchor_run_id" text;
