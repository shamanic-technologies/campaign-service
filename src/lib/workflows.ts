export interface WorkflowExecutionInputs {
  campaignId: string;
  orgId: string;
  brandId: string;
  userId: string;
  runId: string;
  featureSlug: string;
  activeGoalId?: string | null;
  brandProfileId?: string | null;
  customerPersonaId?: string | null;
  audienceId?: string | null;
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
): Promise<void> {
  const url = process.env.WORKFLOW_SERVICE_URL;
  const apiKey = process.env.WORKFLOW_SERVICE_API_KEY;

  if (!url || !apiKey) {
    console.warn("[campaign-service] WORKFLOW_SERVICE_URL or WORKFLOW_SERVICE_API_KEY not set, skipping workflow execution");
    return;
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
  if (inputs.customerPersonaId) headers["x-customer-persona-id"] = inputs.customerPersonaId;
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
        customerPersonaId: inputs.customerPersonaId ?? null,
        audienceId: inputs.audienceId ?? null,
      },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error(`[campaign-service] Execution failed (${res.status}): ${body}`);
    return;
  }

  await res.json();
}
