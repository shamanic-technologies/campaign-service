import type { EventPerson } from "./trigger-person.js";
import { WorkflowExecutionRefusedError } from "./workflow-refusal.js";

export interface WorkflowExecutionInputs {
  campaignId: string;
  orgId: string;
  brandId: string;
  userId: string;
  runId: string;
  featureSlug: string;
  activeGoalId?: string | null;
  brandProfileId?: string | null;
  audienceId?: string | null;
  /**
   * The trigger EVENT this run answers, when a detector fired it (a `delay` or `poll` trigger,
   * lib/trigger-detectors.ts): which event, which lead (delay) or which new item (poll). Absent on
   * every other dispatch, and then the body is byte-identical to before.
   */
  trigger?: WorkflowTriggerInput | null;
  /**
   * `reject`: a run of this campaign already reserved at workflow-service = 409 (`WorkflowExecutionRefusedError`,
   * `isRunInFlightRefusal`), never the OTHER run answered as if it were this one. workflow-service's default
   * (`use_existing`) answers the in-flight run with 200, so a trigger dispatch racing another one was told it ran
   * while nothing carried its occurrence (LEAD-EVENT-WHATSAPP-1027). Absent = the body is byte-identical to before.
   */
  conflictPolicy?: "reject";
  /**
   * The PERSON this execution is about (REACTIVE-THROUGHPUT-1028, workflow-service v0.48.189 `executionSubject`):
   * workflow-service then admits one active execution per (campaign, subject) instead of per campaign, so runs
   * about different people go side by side; how many at once is ours (lib/person-runs.ts). Absent = campaign-wide.
   */
  executionSubject?: string;
}

export interface WorkflowTriggerInput {
  eventId: string;
  triggerId: string;
  leadId: string | null;
  item: unknown;
  /** The person an event names by identity (lib/trigger-person.ts); absent otherwise. */
  person?: EventPerson | null;
  /** A composite occurrence (`lead_event`, lib/composite-trigger.ts): the trigger id of the fact it stands for. */
  sourceTriggerId?: string;
}

/** What workflow-service answered: the run it opened, the one whose `/end-run` carries it as `x-run-id`. */
export interface WorkflowExecution {
  runId: string | null;
}

const REQUIRED_FIELDS: (keyof WorkflowExecutionInputs)[] = [
  "campaignId", "orgId", "brandId", "userId", "runId", "featureSlug",
];

/**
 * Validate that all required fields are present for workflow execution.
 * Returns the list of missing field names, or an empty array if all present.
 */
export function validateWorkflowInputs(
  inputs: Partial<WorkflowExecutionInputs>,
): string[] {
  return REQUIRED_FIELDS.filter((k) => !inputs[k]);
}

/**
 * Execute a campaign's workflow by name.
 *
 * Campaign-service no longer defines or deploys DAGs — workflow-service
 * owns workflow definitions. Campaign-service receives a workflowSlug
 * at campaign creation and uses it to trigger execution.
 *
 * All inputs are required — workflow-service rejects calls missing any
 * of the 7 tracking headers (x-org-id, x-user-id, x-run-id, x-brand-id,
 * x-campaign-id, x-workflow-slug, x-feature-slug).
 */
export async function executeCampaignWorkflow(
  workflowSlug: string,
  inputs: WorkflowExecutionInputs,
): Promise<WorkflowExecution> {
  const url = process.env.WORKFLOW_SERVICE_URL;
  const apiKey = process.env.WORKFLOW_SERVICE_API_KEY;

  if (!url || !apiKey) {
    console.warn("[campaign-service] WORKFLOW_SERVICE_URL or WORKFLOW_SERVICE_API_KEY not set, skipping workflow execution");
    return { runId: null };
  }

  // Defense-in-depth: validate all required fields even though callers should check first
  const missing = validateWorkflowInputs(inputs);
  if (missing.length > 0) {
    throw new Error(`[campaign-service] Cannot execute workflow — missing required fields: ${missing.join(", ")}`);
  }

  const executeUrl = `${url}/workflows/by-slug/${workflowSlug}/execute`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
    "x-org-id": inputs.orgId,
    "x-user-id": inputs.userId,
    "x-run-id": inputs.runId,
    "x-brand-id": inputs.brandId,
    "x-campaign-id": inputs.campaignId,
    "x-feature-slug": inputs.featureSlug,
    "x-workflow-slug": workflowSlug,
  };
  if (inputs.activeGoalId) headers["x-active-goal-id"] = inputs.activeGoalId;
  if (inputs.brandProfileId) headers["x-brand-profile-id"] = inputs.brandProfileId;
  if (inputs.audienceId) headers["x-audience-id"] = inputs.audienceId;

  const res = await fetch(executeUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({
      inputs: {
        campaignId: inputs.campaignId,
        orgId: inputs.orgId,
        brandId: inputs.brandId,
        featureSlug: inputs.featureSlug,
        activeGoalId: inputs.activeGoalId ?? null,
        brandProfileId: inputs.brandProfileId ?? null,
        audienceId: inputs.audienceId ?? null,
        ...(inputs.trigger ? { trigger: inputs.trigger } : {}),
      },
      ...(inputs.conflictPolicy ? { conflictPolicy: inputs.conflictPolicy } : {}),
      ...(inputs.executionSubject ? { executionSubject: inputs.executionSubject } : {}),
    }),
  });

  // A refused execution is a campaign that did not run. Returning quietly told every caller the
  // trigger had succeeded, so a campaign whose executions were ALL refused looked healthy from
  // every angle: ongoing, rescheduled, silent. Throwing puts the refusal in front of whoever
  // triggered it — the callers already catch and log against the campaign id.
  if (!res.ok) {
    const body = await res.text();
    throw new WorkflowExecutionRefusedError({ workflowSlug, campaignId: inputs.campaignId, status: res.status, body });
  }

  // workflow-service answers the run row it opened; its `runId` is the run the DAG's `/end-run` names.
  const body = (await res.json()) as { runId?: unknown } | null;
  return { runId: typeof body?.runId === "string" && body.runId ? body.runId : null };
}
