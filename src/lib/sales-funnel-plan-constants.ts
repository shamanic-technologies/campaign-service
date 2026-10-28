/**
 * How long a unit whose pipe LEFT its funnel campaign's plan (lib/sales-funnel-plan.ts, `plan_role = 'draining'`) and
 * that answers no trigger is parked per claim: it takes no new people. Own module so the scheduler does not import
 * the plan follower (and its catalogue clients).
 */
export const PLAN_DRAINING_RECHECK_MS = 10 * 60_000;
