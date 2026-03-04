/**
 * Execute a campaign's workflow by name.
 *
 * Campaign-service no longer defines or deploys DAGs — workflow-service
 * owns workflow definitions. Campaign-service receives a workflowName
 * at campaign creation and uses it to trigger execution.
 */
export async function executeCampaignWorkflow(
  workflowName: string,
  inputs: { campaignId: string; orgId: string; userId?: string; runId?: string },
): Promise<void> {
  const url = process.env.WORKFLOW_SERVICE_URL;
  const apiKey = process.env.WORKFLOW_SERVICE_API_KEY;

  console.log(`[Workflow] executeCampaignWorkflow called: workflowName=${workflowName}, campaignId=${inputs.campaignId}, orgId=${inputs.orgId}`);

  if (!url || !apiKey) {
    console.warn("[Workflow] WORKFLOW_SERVICE_URL or WORKFLOW_SERVICE_API_KEY not set, skipping workflow execution");
    return;
  }

  const executeUrl = `${url}/workflows/by-name/${workflowName}/execute`;
  console.log(`[Workflow] POST ${executeUrl}`);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
    "x-org-id": inputs.orgId,
  };
  if (inputs.userId) headers["x-user-id"] = inputs.userId;
  if (inputs.runId) headers["x-run-id"] = inputs.runId;

  const res = await fetch(executeUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({
      orgId: inputs.orgId,
      inputs: {
        campaignId: inputs.campaignId,
        orgId: inputs.orgId,
      },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error(`[Workflow] Execution failed (${res.status}): ${body}`);
    return;
  }

  const data = await res.json() as { id?: string; status?: string };
  console.log(`[Workflow] ${workflowName} started successfully: workflowRunId=${data.id}, status=${data.status}`);
}
