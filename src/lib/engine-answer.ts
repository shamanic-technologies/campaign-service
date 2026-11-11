/**
 * NEXT-STEPS-TRUE-REASON-1111 (prod 2026-11-11, campaign 3cfc2aaa): the client and the assistant read one campaign's
 * next steps (features-service) to learn why nothing goes out. features-service records the refusals IT gives the
 * Engine runner; a run campaign-service holds for its OWN reason (a budget spent, an Engine state it cannot read, any
 * other dispatch hold) was invisible there, the read said "nothing queued" with no reason and the assistant invented one.
 *
 * So every hold of ours is STATED on features-service `POST /internal/campaign-engine-answers {campaignId (the unit),
 * outcome (the Engine), heldReason}`, and every Engine dispatch states `heldReason: null` (it ran: clears the hold).
 * The latest answer per (unit, Engine) within the last hour counts there.
 *
 * ONE code path, never a branch per reason: the scheduler's holds (`reportTurnHolds`), the step trigger's holds
 * (`isCampaignHold`), a gate refusal of an Engine run, and the Engine dispatch all call `stateEngineAnswer`.
 * A queue turn (a run of the campaign or its cohort in flight) is not a hold: the Engine is running.
 *
 * Fail-SOFT: never awaited by a dispatcher, never throws, a failed statement is `console.error`ed. It never changes
 * whether, when or what a campaign runs.
 */
import { campaignEngineOf } from "./engine-dispatch.js";
import { siblingReadSignal } from "./sibling-read-timeout.js";
import { OWED_UNTIL_ROOM_SKIPS } from "./trigger-person.js";

/** The gate's refusal of a run while another of the campaign runs: a queue turn, never a hold. */
export const RUN_IN_PROGRESS_REASON = "A run is already in progress";

/** Step-trigger skips that are a TURN in a moving queue (a run in flight), not a hold of the campaign. */
const QUEUE_TURN_SKIPS: ReadonlySet<string> = new Set(["run_in_flight", "cohort_run_in_flight", RUN_IN_PROGRESS_REASON]);

/**
 * A step-trigger skip that HOLDS the campaign's run for a reason of ours (money, pacing, state unreadable): the
 * owed-until-room set minus queue turns. A skip about the event or the person (another person, suppressed...) is not.
 */
export function isCampaignHold(reason: string): boolean {
  return OWED_UNTIL_ROOM_SKIPS.has(reason) && !QUEUE_TURN_SKIPS.has(reason);
}

/** A gate refusal that holds the campaign (every refusal but a queue turn). */
export function isGateHold(reason: string): boolean {
  return !QUEUE_TURN_SKIPS.has(reason);
}

export interface EngineAnswerCampaign {
  id: string;
  featureSlug?: string | null;
  legKey?: string | null;
  workflowSlug?: string | null;
}

/**
 * State that the campaign's Engine run was held (`heldReason`) or ran (null). `outcome` = the Engine when the caller
 * knows it (a dispatch, an Engine run's callback), else read off the campaign's leg. Resolves once stated or logged.
 */
export async function stateEngineAnswer(campaign: EngineAnswerCampaign, heldReason: string | null, outcome?: string | null): Promise<void> {
  try {
    const engineOutcome = outcome ?? (await campaignEngineOf(campaign))?.outcome ?? null;
    // A campaign with no Engine (no leg, a leg the catalogue does not publish) has nothing to state.
    if (!engineOutcome) return;
    const url = process.env.FEATURES_SERVICE_URL;
    const apiKey = process.env.FEATURES_SERVICE_API_KEY;
    if (!url || !apiKey) {
      console.error(`[campaign-service] Engine ${engineOutcome} of campaign ${campaign.id} ${heldReason ? `held (${heldReason})` : "ran"}: not stated, FEATURES_SERVICE_URL/API_KEY not configured`);
      return;
    }
    const res = await fetch(`${url.replace(/\/$/, "")}/internal/campaign-engine-answers`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({ campaignId: campaign.id, outcome: engineOutcome, heldReason }),
      signal: siblingReadSignal(),
    });
    if (!res.ok) {
      const body = (await res.text().catch(() => "")).slice(0, 200);
      console.error(`[campaign-service] Engine ${engineOutcome} of campaign ${campaign.id} ${heldReason ? `held (${heldReason})` : "ran"}: features-service refused the statement (HTTP ${res.status} ${body})`);
    }
  } catch (err) {
    console.error(`[campaign-service] Engine answer of campaign ${campaign.id} (${heldReason ?? "ran"}) could not be stated:`, err);
  }
}
