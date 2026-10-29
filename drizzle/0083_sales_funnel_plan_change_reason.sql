-- PLAN-SWITCH-OFF-1029: a plan-change history row says WHY it moved. 'plan' = a plan applied (every row before);
-- 'switched_off' = the switch turned off, back to its own funnel; 'switched_off_by_hand' = the same restore written
-- by hand in the database (2026-10-29 Definitejobs). Purely additive, idempotent, boot-safe.
ALTER TABLE "sales_funnel_plan_changes" ADD COLUMN IF NOT EXISTS "reason" text NOT NULL DEFAULT 'plan';
